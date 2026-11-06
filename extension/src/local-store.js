'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { displayValue, historyResult } = require('./history');
const { contentAttachments, generatedImageAttachment } = require('./attachments');

function validId(id) { return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(id); }
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(c => {
    if (c && typeof c.text === 'string') return c.text;
    if (c?.type === 'image' || c?.type === 'input_image' || c?.type === 'localImage') return '[Изображение]';
    return '';
  }).filter(Boolean).join('\n');
}
function timeSeconds(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v / 1000 : v;
  const n = Date.parse(v); return Number.isFinite(n) ? n / 1000 : 0;
}
function usablePrompt(s) {
  return Boolean(s?.trim() && !/^\s*(?:# AGENTS\.md|<environment_context>|<permissions instructions>|<INSTRUCTIONS>)/i.test(s));
}
async function* jsonLines(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try { yield JSON.parse(line); } catch { /* A live append may leave an incomplete final line. */ }
    }
  } finally { lines.close(); stream.destroy(); }
}

async function listRolloutFiles(home, includeArchived, signal) {
  const out = [];
  async function walk(dir, archived) {
    if (signal?.aborted) throw new Error('Загрузка отменена.');
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const entry of entries) {
      // Ignore symlinks: do not accidentally crawl directories outside the chosen store.
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), archived);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push({ file: path.join(dir, entry.name), archived });
    }
  }
  await walk(path.join(home, 'sessions'), false);
  if (includeArchived) await walk(path.join(home, 'archived_sessions'), true);
  return out;
}
async function readTitleIndex(home) {
  const titles = {};
  try {
    for await (const line of jsonLines(path.join(home, 'session_index.jsonl'))) {
      if (validId(line.id) && typeof line.thread_name === 'string') titles[line.id] = line.thread_name;
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return titles;
}
async function summarizeRollout(file, archived, titles) {
  let meta, preview = '', count = 0;
  for await (const row of jsonLines(file)) {
    count++;
    if (row.type === 'session_meta') meta = row.payload;
    const p = row.payload;
    if (!preview && row.type === 'response_item' && p?.type === 'message' && p.role === 'user') {
      const text = contentText(p.content); if (usablePrompt(text)) preview = text;
    }
    if (!preview && row.type === 'event_msg' && p?.type === 'user_message' && usablePrompt(p.message)) preview = p.message;
    if (meta && preview || count >= 250) break;
  }
  if (!meta || !validId(meta.id)) return null;
  const stat = await fsp.stat(file);
  return { id: meta.id, cwd: meta.cwd || '',
    name: titles[meta.id] || meta.name || meta.title || '', preview: preview.slice(0, 200),
    createdAt: timeSeconds(meta.timestamp), updatedAt: stat.mtimeMs / 1000,
    source: meta.source || 'unknown', originator: meta.originator || null, threadSource: meta.thread_source || meta.threadSource || null,
    archived, file, origin: 'localFiles', gitInfo: meta.git || null, projectId: meta.project_id || meta.projectId || null };
}

async function scanLocal(home, includeArchived = false, { signal, titles = {}, onProgress, cache = {} } = {}) {
  const titleIndex = { ...titles, ...await readTitleIndex(home) };
  const files = await listRolloutFiles(home, includeArchived, signal);
  const threads = []; const errors = []; const nextCache = {};
  let readFiles = 0, cachedFiles = 0;
  // Small pool: many conversations should not exhaust Windows file handles.
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(6, files.length) }, async () => {
    while (index < files.length) {
      if (signal?.aborted) throw new Error('Загрузка отменена.');
      const n = index++, item = files[n];
      try {
        const stat = await fsp.stat(item.file), old = cache[item.file];
        let t;
        if (old && old.size === stat.size && old.mtimeMs === stat.mtimeMs && old.ctimeMs === stat.ctimeMs &&
          (old.thread === null || (validId(old.thread?.id) && old.thread.file === item.file && old.thread.archived === item.archived))) {
          t = old.thread; cachedFiles++;
        } else {
          t = await summarizeRollout(item.file, item.archived, {}); readFiles++;
        }
        nextCache[item.file] = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, thread: t ? { ...t, gitInfo: undefined } : null };
        if (t) threads.push({ ...t, name: titleIndex[t.id] || t.name });
      }
      catch (e) { errors.push(`Сессия ${path.basename(item.file)}: ${e.message}`); }
      onProgress?.(n + 1, files.length);
    }
  }));
  return { threads, files: files.length, errors, cache: nextCache, readFiles, cachedFiles };
}

async function readRollout(file) {
  const responseMessages = [], eventMessages = [], tools = [];
  const calls = new Map();
  let position = 0;
  for await (const row of jsonLines(file)) {
    position++;
    const p = row.payload;
    if (row.type === 'response_item' && p?.type === 'message' && ['user', 'assistant'].includes(p.role)) {
      const text = contentText(p.content);
      const attachments = contentAttachments(p.content);
      if ((text || attachments.length) && (p.role !== 'user' || usablePrompt(text) || attachments.length)) responseMessages.push({ kind: 'message', id: `legacy-message-${position}`, role: p.role, text, ...(attachments.length ? { attachments } : {}), timestamp: row.timestamp, position });
    } else if (row.type === 'event_msg' && ['user_message', 'agent_message'].includes(p?.type)) {
      const text = typeof p.message === 'string' ? p.message : '';
      const attachments = contentAttachments([...(Array.isArray(p.local_images) ? p.local_images.filter(v => typeof v === 'string').map(file => ({ type: 'localImage', path: file })) : []), ...(Array.isArray(p.images) ? p.images.filter(v => typeof v === 'string').map(url => ({ type: 'image', url })) : [])]);
      if ((text || attachments.length) && (p.type !== 'user_message' || usablePrompt(text) || attachments.length)) eventMessages.push({ kind: 'message', id: `legacy-event-${position}`, role: p.type === 'user_message' ? 'user' : 'assistant', text, ...(attachments.length ? { attachments } : {}), timestamp: row.timestamp, position });
    } else if (row.type === 'response_item' && p?.type === 'image_generation_call') {
      if (p.result || p.file_id || p.saved_path || p.savedPath) responseMessages.push({ kind: 'message', id: `legacy-image-${position}`, role: 'assistant', text: '', attachments: [generatedImageAttachment(p)], timestamp: row.timestamp, position });
    } else if (row.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p?.type)) {
      const type = /(?:exec_command|shell_command|run_command|terminal)/i.test(p.name || '') ? 'commandExecution'
        : /apply_patch|file_change/i.test(p.name || '') ? 'fileChange' : /web.?search/i.test(p.name || '') ? 'webSearch' : 'toolCall';
      const callId = p.call_id || p.id || `at-${position}`;
      const tool = { kind: 'tool', id: `legacy-tool-${callId}`, type, status: 'recorded',
        text: `${p.name || 'Вызов инструмента'}\n${displayValue(p.arguments ?? p.input)}`, timestamp: row.timestamp, position };
      tools.push(tool); calls.set(callId, tool);
    } else if (row.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(p?.type)) {
      const call = calls.get(p.call_id || p.id), output = displayValue(p.output);
      if (call) { call.text += output ? '\n\nВывод:\n' + output : ''; call.status = 'completed'; }
      else if (output) tools.push({ kind: 'tool', id: `legacy-result-${position}`, type: 'toolCall', status: 'completed', text: output, timestamp: row.timestamp, position });
    }
  }
  // Match occurrences, not a global unique-text set: repeated user requests are real messages.
  // Retain event-only messages in mixed legacy formats while removing mirrored pairs.
  const key = m => JSON.stringify([m.role, m.attachments?.length ? m.text.replace(/\n?\[Изображение\]/g, '').trim() : m.text]);
  const responsesByKey = new Map();
  for (const m of responseMessages) { const k = key(m); if (!responsesByKey.has(k)) responsesByKey.set(k, []); responsesByKey.get(k).push(m); }
  const eventCounts = new Map(); const unmatchedEvents = [];
  for (const m of eventMessages) {
    const k = key(m), occurrence = (eventCounts.get(k) || 0) + 1;
    eventCounts.set(k, occurrence);
    const response = responsesByKey.get(k)?.[occurrence - 1];
    if (!response) unmatchedEvents.push(m);
    else { if (!response.attachments?.length && m.attachments?.length) response.attachments = m.attachments; if (m.position < response.position) { response.position = m.position; response.timestamp = m.timestamp; } }
  }
  let turn = 0;
  const timeline = [...responseMessages, ...unmatchedEvents, ...tools].sort((a, b) => a.position - b.position).map(({ position: _, ...item }) => {
    if (item.kind === 'message' && item.role === 'user') turn++;
    return { ...item, turnId: `legacy-turn-${turn}` };
  });
  return historyResult(timeline, 'История прочитана из локального JSONL. Для просмотра вложений нужен доступ к исходным файлам. Внутренние инструкции и скрытые рассуждения не выводятся.');
}
module.exports = { validId, contentText, timeSeconds, usablePrompt, jsonLines, scanLocal, readRollout, summarizeRollout, readTitleIndex };
