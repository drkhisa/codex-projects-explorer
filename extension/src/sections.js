'use strict';
const { canonical } = require('./projects');
const LABELS = { codex: 'Codex', chatgpt: 'ChatGPT', unknown: 'Источник не определён' };
function threadKey(thread) { return `${canonical(thread.home || '')}:${thread.id}`; }
function sourceValue(value) {
  if (typeof value === 'string') { value = value.trim(); try { if (value.startsWith('{')) return sourceValue(JSON.parse(value)); } catch {} return value.toLowerCase(); }
  return typeof value?.custom === 'string' ? value.custom.trim().toLowerCase() : '';
}
function classifyThread(thread, overrides = {}) {
  const override = overrides[threadKey(thread)];
  if (['codex','chatgpt','unknown'].includes(override)) return { section: override, reason: 'Выбрано в расширении' };
  const sources = [sourceValue(thread.source), sourceValue(thread.localSource)];
  const origin = String(thread.originator || '').trim().toLowerCase(), analytics = String(thread.threadSource || '').trim().toLowerCase();
  // Observed in the user's local metadata. This is a client-name inference,
  // not proof of membership in the full ChatGPT account history.
  if (origin === 'codex_work_desktop') return { section: 'chatgpt', reason: 'Локальный Work-клиент codex_work_desktop; предварительно отнесён к ChatGPT по имени клиента' };
  // These chat originators are explicitly identified in OpenAI's default_client.rs.
  const chatSource = sources.some(s => ['chatgpt','atlas'].includes(s)) || ['chatgpt','atlas'].includes(analytics);
  const codexOrigin = ['codex_cli_rs','codex-tui','codex_vscode','codex_desktop','codex_projects_explorer'].includes(origin) || /^codex desktop(?:$|[ /])/.test(origin);
  if (codexOrigin && chatSource) return { section: 'unknown', reason: 'Метки источника и клиента противоречат друг другу. Выберите раздел вручную.' };
  if (chatSource || ['codex_atlas','codex_chatgpt_desktop'].includes(origin) || /^(?:chatgpt)(?:$|[_ -])/.test(origin)) return { section: 'chatgpt', reason: 'Источник ChatGPT в метаданных' };
  if (codexOrigin || sources.some(s => ['cli','exec','codex'].includes(s))) return { section: 'codex', reason: 'Источник Codex в метаданных' };
  // User-confirmed legacy Codex history: older records have source=vscode but
  // no originator. Explicit ChatGPT/Work origins above still take precedence.
  if (sources.includes('vscode') && !origin) return { section: 'codex', reason: 'Старая локальная запись Codex: source=vscode, метка клиента отсутствует' };
  if (sources.includes('vscode')) return { section: 'unknown', reason: 'Неизвестный клиент в метаданных; можно назначить раздел вручную' };
  return { section: 'unknown', reason: 'Недостаточно метаданных источника; папка и модель не определяют приложение' };
}
function sourceReport(threads, overrides = {}) {
  const sections = { codex: 0, chatgpt: 0, unknown: 0 }, buckets = new Map();
  const field = value => typeof value === 'string' ? value.slice(0, 160) : '';
  for (const thread of threads) {
    sections[classifyThread(thread, overrides).section]++;
    const metadata = { source: field(sourceValue(thread.source)), localSource: field(sourceValue(thread.localSource)), originator: field(thread.originator), threadSource: field(thread.threadSource) };
    const key = JSON.stringify(metadata); const row = buckets.get(key) || { ...metadata, count: 0 }; row.count++; buckets.set(key, row);
  }
  return { scope: 'Локальные записи выбранного хранилища Codex; это не весь аккаунт ChatGPT',
    chatgptAccountHistory: { state: 'notConnected', threadCount: null, projectCount: null },
    localThreads: { total: threads.length, sections }, metadataSources: [...buckets.values()] };
}
module.exports = { classifyThread, threadKey, LABELS, sourceReport };
