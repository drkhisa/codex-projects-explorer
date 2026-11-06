'use strict';

function displayValue(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
function toolView(item) {
  let text;
  if (item.type === 'commandExecution') text = `${item.command || ''}\n${item.aggregatedOutput || ''}`.trim();
  else if (item.type === 'fileChange') text = (item.changes || []).map(c => `${c.path}\n${c.diff || ''}`).join('\n');
  else if (item.type === 'mcpToolCall') text = `${item.server || ''} · ${item.tool || ''}\n${displayValue(item.arguments)}${item.result ? '\n' + displayValue(item.result) : ''}${item.error ? '\n' + displayValue(item.error) : ''}`.trim();
  else if (item.type === 'webSearch') text = item.query || displayValue(item.action) || 'Поиск в интернете';
  else if (item.type === 'dynamicToolCall') text = `${item.tool || ''}\n${displayValue(item.arguments)}\n${displayValue(item.contentItems)}`.trim();
  else if (item.type === 'collabToolCall') text = `${item.tool || ''}\n${displayValue(item.agentStatus)}`.trim();
  else if (item.type === 'imageGeneration') text = item.failure ? displayValue(item.failure) : item.savedPath || 'Генерация изображения';
  else text = item.text || item.type || 'Действие';
  return { id: item.id, type: item.type, status: item.status || 'recorded', text,
    ...(item.type === 'fileChange' ? {changes:(item.changes||[]).filter(c=>typeof c.path==='string' && typeof c.diff==='string').map(c=>({path:c.path,diff:c.diff,kind:c.kind}))} : {}),
    ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}) };
}
function historyResult(timeline, note = '') {
  return { timeline,
    messages: timeline.filter(e => e.kind === 'message').map(({ kind, ...e }) => e),
    tools: timeline.filter(e => e.kind === 'tool').map(({ kind, ...e }) => ({ ...e, role: 'tool' })), note };
}
module.exports = { displayValue, toolView, historyResult };
