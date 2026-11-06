'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');

function canonical(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let p = value.trim();
  if (p.startsWith('file://')) {
    try { p = require('node:url').fileURLToPath(p); } catch { return ''; }
  }
  // Windows spelling must compare correctly even in Linux tests.
  if (/^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(p)) {
    return path.win32.normalize(p).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  }
  return path.posix.normalize(p).replace(/\/$/, '') || '/';
}
function inside(cwd, root) {
  const c = canonical(cwd), r = canonical(root);
  return Boolean(c && r && (c === r || c.startsWith(r === '/' ? '/' : r + '/')));
}
function baseName(p) { return String(p || '').replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || p; }
function generatedName(name) { return /^(?:new-chat(?:-\d+)?|g-p-[a-f0-9]{16,}|[a-f0-9]{8}-[a-f0-9-]{20,})$/i.test(name || ''); }
function secondaryGroup(group) { return !group.projectId && ((group.threads.length > 0 && group.threads.every(t=>t.standalone)) || (group.origin === 'inferred' && !group.paths.length) || (group.origin !== 'configured' && generatedName(group.name))); }

async function readProjectState(file) {
  try {
    const d = JSON.parse(await fs.readFile(file, 'utf8'));
    const roots = d['electron-saved-workspace-roots'];
    const labels = d['electron-workspace-root-labels'] || {};
    const projects = [];
    if (Array.isArray(roots)) {
      for (const root of roots) if (typeof root === 'string' && canonical(root)) {
        projects.push({ name: typeof labels[root] === 'string' ? labels[root] : baseName(root), paths: [root], origin: 'desktop' });
      }
    }
    // Titles use only a known, explicit structure; never recursively ingest arbitrary state.
    const titleState = d['thread-titles'];
    const titleObject = titleState && typeof titleState === 'object' && !Array.isArray(titleState)
      ? (titleState.titles || titleState) : {};
    const titles = Object.fromEntries(Object.entries(titleObject).filter(([, v]) => typeof v === 'string'));
    return { projects, titles, found: true, recognized: Array.isArray(roots),
      relevantKeys: Object.keys(d).filter(k => /workspace|project|thread-title/.test(k)) };
  } catch (e) {
    if (e.code === 'ENOENT') return { projects: [], titles: {}, found: false, recognized: false, relevantKeys: [] };
    return { projects: [], titles: {}, found: true, recognized: false, relevantKeys: [], error: `Не удалось прочитать состояние проектов: ${e.message}` };
  }
}

function groupThreads(threads, desktopProjects = [], configuredProjects = [], workspaceFolders = []) {
  const groups = [];
  // Explicit user mappings have priority over the desktop adapter.
  for (const project of [...configuredProjects.map(p => ({ ...p, origin: 'configured' })), ...desktopProjects]) {
    const paths = (Array.isArray(project.paths) ? project.paths : []).filter(p => typeof p === 'string' && canonical(p));
    const projectId = project.projectId || (project.origin === 'canonical' ? project.id : null);
    if ((!paths.length && !projectId) || typeof project.name !== 'string' || !project.name.trim()) continue;
    const keys = paths.map(canonical);
    const same = groups.find(g => projectId ? g.projectId === projectId : !g.projectId && keys.every(k => g.paths.map(canonical).includes(k)));
    if (same) { same.paths = [...new Set([...same.paths, ...paths])]; continue; }
    groups.push({ id: projectId ? `canonical:${projectId}` : `${project.origin}:${keys.join('|')}`, name: project.name, paths,
      origin: project.origin, threads: [], ...(projectId ? { projectId } : {}), metadata: project.metadata || {} });
  }
  for (const folder of workspaceFolders) {
    if (!canonical(folder.path) || groups.some(g => g.paths.some(p => canonical(p) === canonical(folder.path)))) continue;
    groups.push({ id: `workspace:${canonical(folder.path)}`, name: folder.name || baseName(folder.path),
      paths: [folder.path], origin: 'workspace', threads: [] });
  }
  // A canonical app-server project assignment takes priority over execution cwd.
  // Worktrees and temporary execution folders can all belong to one actual project.
  const canonicalGroups = new Map(groups.filter(g => g.projectId).map(g => [g.projectId, g]));
  const buckets = new Map();
  for (const t of threads) if (typeof t.projectId === 'string' && t.projectId) {
    if (!buckets.has(t.projectId)) buckets.set(t.projectId, []);
    buckets.get(t.projectId).push(t);
  }
  for (const [projectId, members] of buckets) {
    const roots = [...new Set(members.map(t => t.cwd).filter(Boolean))];
    const candidates = groups.filter(g => !g.projectId && roots.some(cwd => g.paths.some(p => inside(cwd, p))));
    let group = canonicalGroups.get(projectId) || candidates[0];
    if (!group) {
      const counts = new Map();
      for (const cwd of roots) { const name = baseName(cwd); if (!generatedName(name)) counts.set(name, members.filter(t => canonical(t.cwd) === canonical(cwd)).length); }
      const name = [...counts].sort((a,b) => b[1] - a[1])[0]?.[0] || 'Проект ' + projectId.slice(0, 8);
      group = { id: `canonical:${projectId}`, name, paths: [], origin: 'canonical', threads: [] }; groups.push(group);
    }
    group.projectId = projectId;
    group.paths = [...new Set([...group.paths, ...roots])];
    canonicalGroups.set(projectId, group);
  }
  for (const thread of threads) {
    if (canonicalGroups.has(thread.projectId)) { canonicalGroups.get(thread.projectId).threads.push(thread); continue; }
    const explicit = groups.filter(g => g.origin !== 'inferred');
    const exact = explicit.find(g => g.paths.some(p => canonical(p) === canonical(thread.cwd)));
    const candidates = explicit.flatMap(g => g.paths.filter(p => inside(thread.cwd, p)).map(p => ({ g, len: canonical(p).length })));
    const best = exact || candidates.sort((a, b) => b.len - a.len)[0]?.g;
    if (best) { best.threads.push(thread); continue; }
    const key = canonical(thread.cwd);
    let group = groups.find(g => g.id === `inferred:${key}`);
    if (!group) {
      group = { id: `inferred:${key}`, name: key ? baseName(thread.cwd) : 'Без рабочей папки',
        paths: key ? [thread.cwd] : [], origin: 'inferred', threads: [] };
      groups.push(group);
    }
    group.threads.push(thread);
  }
  for (const group of groups) group.threads.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.id.localeCompare(b.id));
  // Keep recognized projects in their saved order; inferred folders are alphabetical.
  return [...groups.filter(g => g.origin !== 'inferred'), ...groups.filter(g => g.origin === 'inferred').sort((a, b) => a.name.localeCompare(b.name))];
}
module.exports = { canonical, inside, baseName, readProjectState, groupThreads, generatedName, secondaryGroup };
