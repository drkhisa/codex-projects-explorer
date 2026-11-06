'use strict';
const { canonical } = require('./projects');
const MODES = ['project','read','full'];
function projectAccessKey(thread, group, home = '') {
  const store = canonical(thread.home || home);
  const projectId = thread.projectId || group?.projectId;
  if (projectId) return `${store}:project:${projectId}`;
  const root = group?.paths?.[0] || thread.cwd;
  return root ? `${store}:folder:${canonical(root)}` : `${store}:thread:${thread.id}`;
}
function validateAccess(access) { if (!MODES.includes(access)) throw new Error('Выберите режим доступа проекта.'); return access; }
module.exports = { MODES, projectAccessKey, validateAccess };
