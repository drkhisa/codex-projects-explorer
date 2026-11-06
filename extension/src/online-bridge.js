'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const hex = () => crypto.randomBytes(32).toString('hex');
function equal(a, b) { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && crypto.timingSafeEqual(x, y); }
class OnlineBridge {
  constructor(onSnapshot, { onPair = async () => {} } = {}) { this.onSnapshot = onSnapshot; this.onPair = onPair; this.pending = null; this.peer = null; this.server = null; this.lastSeen = 0; }
  get connected() { return !!this.peer && Date.now() - this.lastSeen < 90000; }
  async listen(port = 0) {
    if (this.server) return;
    const server = http.createServer((req, res) => this.handle(req, res));
    server.headersTimeout = 5000; server.requestTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    this.server = server; server.unref();
  }
  async restore(saved) {
    if (!EXTENSION_ORIGIN.test(saved?.origin || '') || !/^[a-f0-9]{64}$/.test(saved?.key || '') || !Number.isInteger(saved?.port) || saved.port < 1024 || saved.port > 65535) return false;
    await this.listen(saved.port); this.peer = { origin: saved.origin, key: saved.key, token: hex() }; return true;
  }
  async start() {
    await this.listen(); this.peer = null; this.lastSeen = 0;
    this.pending = { token: hex(), launchId: crypto.randomBytes(24).toString('hex'), expires: Date.now() + 5 * 60000 };
    return Buffer.from(JSON.stringify({ v: 1, port: this.server.address().port, token: this.pending.token })).toString('base64url');
  }
  launchUrl() { if (!this.pending) throw new Error('Начните подключение заново'); return `http://127.0.0.1:${this.server.address().port}/connect/${this.pending.launchId}`; }
  pairingPage() {
    const payload = JSON.stringify({v:1,port:this.server.address().port,token:this.pending.token});
    return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>ChatGPT → VS Code</title><style>body{font:16px/1.7 system-ui;max-width:660px;margin:12vh auto;padding:24px;color:#eee;background:#202020}h1{font-size:28px}p{color:#ccc}strong{color:white}.card{padding:20px;border:1px solid #555;border-radius:16px}</style><h1>ChatGPT → VS Code</h1><div class="card"><strong id="state">Подключаю браузер…</strong><p id="details">Если браузерный компонент установлен, подключение произойдёт автоматически и откроется ChatGPT. Коды копировать не нужно.</p></div><p>Если подключения нет: один раз установите браузерный компонент из инструкции в VS Code, затем обновите эту страницу. После сопряжения соединение восстанавливается автоматически.</p><p>Подключение разрешает передавать отображённые проекты и переписки из вкладок ChatGPT этого профиля в локальный VS Code. Переписка не отправляется третьим лицам. Полнота истории аккаунта пока не подтверждена.</p><script id="codex-bridge-pair" type="application/json">${payload}</script></html>`;
  }
  async handle(req, res) {
    const origin = req.headers.origin || '', host = `127.0.0.1:${this.server?.address()?.port}`;
    const reply = (status, value) => { if (res.destroyed) return; res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.headers.host !== host) return reply(403,{error:'host'});
    // An unguessable, expiring, local-only page opens in the user's browser.
    // It contains a single-use pairing capability, no account credentials.
    if (req.method === 'GET' && this.pending && this.pending.expires > Date.now() && req.url === `/connect/${this.pending.launchId}`) {
      const site = req.headers['sec-fetch-site']; if (site && !['none','same-origin'].includes(site)) return reply(403,{error:'navigation'});
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
        'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});res.end(this.pairingPage());return;
    }
    if (!EXTENSION_ORIGIN.test(origin) || (this.peer && origin !== this.peer.origin)) return reply(403, { error: 'origin' });
    res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST' || !['/pair', '/snapshot', '/ping', '/hello', '/restore'].includes(req.url)) return reply(404, { error: 'route' });
    if (req.headers['content-type'] !== 'application/json') return reply(415, { error: 'content-type' });
    const pairing = req.url === '/pair', restoring = ['/hello','/restore'].includes(req.url);
    if (pairing ? (!this.pending || this.pending.expires < Date.now()) : !this.peer || (!restoring && !equal(req.headers.authorization, `Bearer ${this.peer.token}`))) return reply(401, { error: 'Reconnect in VS Code' });
    let size = 0; const chunks = []; let tooLarge = false;
    req.on('data', b => { size += b.length; if (size > 2 * 1024 * 1024) { if (!tooLarge) { tooLarge = true; reply(413, { error: 'Snapshot exceeds 2 MiB' }); } } else chunks.push(b); });
    req.on('end', async () => {
      if (tooLarge) return;
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (pairing) {
          if (!this.pending || this.pending.expires < Date.now() || !equal(data.token, this.pending.token)) return reply(401, { error: 'Invalid pairing code' });
          this.peer = { origin, token: hex(), key: hex() }; this.pending = null; this.lastSeen = Date.now();
          let remembered = true; try { await this.onPair({origin, key:this.peer.key,port:this.server.address().port}); } catch { remembered = false; }
          return reply(200, { token: this.peer.token, key: this.peer.key, remembered });
        }
        if (req.url === '/hello') { this.challenge = {value:hex(),expires:Date.now()+30000}; return reply(200,{challenge:this.challenge.value}); }
        if (req.url === '/restore') {
          const challenge=this.challenge;this.challenge=null;
          const proof=challenge && crypto.createHmac('sha256',Buffer.from(this.peer.key,'hex')).update('codex-bridge:'+challenge.value).digest('hex');
          if(!challenge || challenge.expires<Date.now() || !equal(data.proof,proof)) return reply(401,{error:'pairing required'});
          this.peer.token=hex();this.lastSeen=Date.now();return reply(200,{token:this.peer.token});
        }
        this.lastSeen = Date.now(); if (req.url === '/snapshot') await this.onSnapshot(data);
        reply(200, { ok: true });
      } catch { reply(400, { error: 'Snapshot rejected; check bridge format' }); }
    });
  }
  dispose() { this.pending = this.peer = this.challenge = null; this.server?.closeAllConnections?.(); this.server?.close(); this.server = null; }
}
module.exports = { OnlineBridge };
