'use strict';
const crypto = require('node:crypto');
async function loadCatalog(rpc, cwd) {
  const result = [], errors = [];
  const requests = await Promise.allSettled([
    rpc.request('skills/list', { cwds: cwd ? [cwd] : [], forceReload: false }, 15000),
    rpc.request('plugin/list', { cwds: cwd ? [cwd] : [], forceRefetch: false }, 15000)
  ]);
  if (requests[0].status === 'fulfilled') {
    for (const entry of requests[0].value.data || []) {
      for (const skill of entry.skills || []) if (skill.enabled && typeof skill.path === 'string') result.push({ id: crypto.randomUUID(), kind: 'skill', name: skill.interface?.displayName || skill.name, description: skill.shortDescription || skill.description || '', input: { type: 'skill', name: skill.name, path: skill.path } });
      if (entry.errors?.length) errors.push('Некоторые скиллы не удалось загрузить.');
    }
  } else errors.push('Скиллы: ' + requests[0].reason.message);
  if (requests[1].status === 'fulfilled') {
    for (const market of requests[1].value.marketplaces || []) for (const plugin of market.plugins || []) {
      if (plugin.installed && plugin.enabled) result.push({ id: crypto.randomUUID(), kind: 'plugin', name: plugin.interface?.displayName || plugin.name, description: plugin.interface?.shortDescription || '', input: { type: 'mention', name: plugin.name, path: 'plugin://' + plugin.id } });
    }
    if (requests[1].value.marketplaceLoadErrors?.length) errors.push('Часть каталогов плагинов недоступна.');
  } else errors.push('Плагины: ' + requests[1].reason.message);
  const unique = new Map(); for (const item of result) unique.set(item.input.type + '\0' + item.input.path, item);
  return { items: [...unique.values()], errors };
}
module.exports = { loadCatalog };
