'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function expand(value) {
  return String(value || '').replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/%([^%]+)%/g, (m, key) => process.env[key] || m)
    .replace(/\$\{env:([^}]+)\}/g, (m, key) => process.env[key] || m);
}
async function isFile(p) { try { return (await fs.stat(p)).isFile(); } catch { return false; } }
async function findExecutable(configured, extensionPath) {
  if (configured) {
    const executable = expand(configured);
    if (/\.(?:cmd|bat|ps1)$/i.test(executable)) throw new Error('Укажите бинарный codex.exe, а не .cmd/.bat/.ps1. Он обычно есть в папке официального расширения.');
    if (!path.isAbsolute(executable) || !await isFile(executable)) throw new Error('Указанный codexExecutable должен быть полным путём к существующему файлу codex.exe / codex.');
    return executable;
  }
  // Prefer the native binary shipped with the installed official extension.
  const wanted = process.platform === 'win32' ? 'codex.exe' : 'codex';
  if (extensionPath) {
    const candidates = [];
    async function visit(dir, depth) {
      if (depth > 5) return;
      let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isFile() && e.name === wanted) candidates.push(path.join(dir, e.name));
        else if (e.isDirectory() && !['node_modules', '.git', 'dist', 'webview'].includes(e.name)) await visit(path.join(dir, e.name), depth + 1);
      }
    }
    await visit(extensionPath, 0);
    const platform = process.platform === 'win32' ? /windows|win32|pc-windows/i : process.platform === 'darwin' ? /darwin|apple|macos/i : /linux/i;
    const arch = process.arch === 'arm64' ? /aarch64|arm64/i : /x86_64|x64|amd64/i;
    candidates.sort((a, b) => Number(platform.test(b)) + Number(arch.test(b)) - Number(platform.test(a)) - Number(arch.test(a)));
    const match = candidates.find(p => platform.test(p) && arch.test(p)) || (candidates.length === 1 ? candidates[0] : undefined);
    if (match) return match;
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir.replace(/^"|"$/g, ''), wanted);
    if (await isFile(candidate)) return candidate;
  }
  return '';
}
function codexHome(configured) { return path.resolve(expand(configured || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))); }
module.exports = { expand, findExecutable, codexHome };
