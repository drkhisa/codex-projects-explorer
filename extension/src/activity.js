'use strict';
const fs = require('node:fs/promises');
const { timeSeconds } = require('./local-store');

function runtimeActivity(status) {
  if (status?.type === 'active') return { running: true, state: 'active', source: 'runtime',
    label: status.activeFlags?.includes('waitingOnApproval') ? 'Ждёт разрешения' : status.activeFlags?.includes('waitingOnUserInput') ? 'Ждёт ответа' : 'Работает…' };
  if (status?.type === 'idle') return { running: false, state: 'idle', source: 'runtime', label: '' };
  if (status?.type === 'systemError') return { running: false, state: 'error', source: 'runtime', label: 'Ошибка выполнения' };
  return null; // notLoaded describes THIS server, not another app's work.
}

// Read only appended bytes, including when the producer is Codex Desktop, CLI or
// another IDE process. File timestamps alone never turn a chat's spinner on.
class RolloutActivity {
  constructor({ freshnessMs = 120000, maxTail = 1024 * 1024 } = {}) { this.cache = new Map(); this.freshnessMs = freshnessMs; this.maxTail = maxTail; }
  async read(file, now = Date.now()) {
    let handle;
    try {
      handle = await fs.open(file, 'r'); const stat = await handle.stat();
      let c = this.cache.get(file);
      if(c?.anchor){const old=Buffer.from(c.anchor,'base64'),check=Buffer.alloc(old.length);const read=await handle.read(check,0,check.length,c.offset-old.length);if(read.bytesRead!==old.length||!check.equals(old))c=null;}
      if (!c || stat.size < c.offset || c.ino !== stat.ino || (stat.size === c.offset && stat.mtimeMs !== c.mtime)) {
        c = { offset: Math.max(0, stat.size - this.maxTail), ino: stat.ino, carry: '', skip: stat.size > this.maxTail, state: 'unknown', turnId: '', eventAt: 0, lastAt: 0 };
      }
      const length = stat.size - c.offset;
      if (length > this.maxTail) { c.offset = stat.size - this.maxTail; c.carry = ''; c.skip = true; c.state = 'unknown'; }
      const buffer = Buffer.alloc(Math.min(this.maxTail, stat.size - c.offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, c.offset);
      // Decode complete byte lines to preserve UTF-8 split across append operations.
      let data = Buffer.concat([Buffer.from(c.carry, 'base64'), buffer.subarray(0, bytesRead)]);
      c.offset += bytesRead; const lines = []; let start = 0;
      c.anchor=Buffer.concat([Buffer.from(c.anchor||'','base64'),buffer.subarray(0,bytesRead)]).subarray(-128).toString('base64');
      for (let i = 0; i < data.length; i++) if (data[i] === 10) { lines.push(data.subarray(start, i)); start = i + 1; }
      c.carry = data.subarray(start).toString('base64');
      if (c.carry.length > this.maxTail * 2) { c.carry = ''; c.skip = true; }
      for (const bytes of lines) {
        if (c.skip) { c.skip = false; continue; }
        let row; try { row = JSON.parse(bytes.toString('utf8')); } catch { continue; }
        const p = row.payload, at = timeSeconds(row.timestamp) * 1000;
        if (!p || !Number.isFinite(at)) continue;
        if (['event_msg','response_item','turn_context'].includes(row.type)) c.lastAt = Math.max(c.lastAt, at);
        if (row.type !== 'event_msg') continue;
        const id = p.turn_id || p.turnId || '';
        if (p.type === 'task_started') { c.state = 'active'; c.turnId = id; c.eventAt = at; }
        else if (['task_complete','turn_aborted','task_failed','shutdown_complete'].includes(p.type) && (!id || !c.turnId || id === c.turnId)) {
          c.state = p.type === 'task_failed' ? 'error' : 'idle'; c.eventAt = at;
        }
      }
      c.mtime = stat.mtimeMs; this.cache.set(file, c);
      if (c.state === 'active') {
        const fresh = c.lastAt > 0 && now - c.lastAt <= this.freshnessMs && c.lastAt - now <= 30000 && now - stat.mtimeMs <= this.freshnessMs;
        return { state: fresh ? 'active' : 'unknown', running: fresh, source: 'rollout', label: fresh ? 'Работает · по журналу' : 'Статус не подтверждён', turnId: c.turnId, eventAt: c.eventAt, lastAt: c.lastAt };
      }
      return { state: c.state, running: false, source: 'rollout', label: c.state === 'error' ? 'Ошибка выполнения' : '', turnId: c.turnId, eventAt: c.eventAt };
    } catch (e) { this.cache.delete(file); return { running: false, state: 'unknown', source: 'rollout', label: 'Статус недоступен', errorCode: e.code || 'readError' }; }
    finally { await handle?.close(); }
  }
  prune(files) { const live = new Set(files); for (const f of this.cache.keys()) if (!live.has(f)) this.cache.delete(f); }
  clear() { this.cache.clear(); }
}
module.exports = { RolloutActivity, runtimeActivity };
