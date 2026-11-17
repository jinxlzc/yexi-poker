import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';
import { Store } from './store.js';
import { RuleError, requireRule } from './engine.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export const isLoopback = ip => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
const localHost = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
function isPrivate(ip) { return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip); }
export function lanAddresses() {
  return [...new Set(Object.values(networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal && isPrivate(i.address)).map(i => i.address))];
}
export async function createServer({ file = process.env.DATA_FILE || path.join(root, 'data/table.sqlite'), port = Number(process.env.PORT || 8787), host = process.env.HOST || '0.0.0.0', rateLimit = true } = {}) {
  const store = new Store(file), clients = new Set();
  // 每个来源地址允许突发 60 次，持续每秒 10 次；写接口与新 WS 连接共享配额。
  // 只存有限个来源，普通只读请求不消耗配额。
  const budgets = new Map();
  // 截图等本机脚本可传 rateLimit: false；正常启动始终开启。
  function takeBudget(req) {
    if (!rateLimit) return;
    const key = req.socket.remoteAddress, now = Date.now();
    const old = budgets.get(key) || { tokens: 60, at: now };
    const tokens = Math.min(60, old.tokens + (now - old.at) / 100);
    if (!budgets.has(key) && budgets.size >= 1024) budgets.delete(budgets.keys().next().value);
    budgets.set(key, { tokens: Math.max(0, tokens - 1), at: now });
    requireRule(tokens >= 1, '操作太频繁，请稍后再试。', 429);
  }
  let actualPort = port;
  const network = () => lanAddresses().map(ip => `http://${ip}:${actualPort}`);
  const joinUrl = code => network()[0] ? `${network()[0]}/join?room=${code}` : null;
  function online(code) { const record = store.peek(code); return [...new Set([...clients].filter(c => c.code === code && c.readyState === WebSocket.OPEN).map(c => store.identity(record, c.token).playerId).filter(Boolean))]; }
  function view(code, token, connected = online(code)) { return { ...store.view(code, token, connected), joinUrl: joinUrl(code) }; }
  function broadcast(code) {
    const connected = online(code);
    for (const c of clients) if (c.code === code && c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'state', ...view(code, c.token, connected) }));
  }
  function sameOrigin(req) {
    if (req.headers.origin) requireRule(req.headers.origin === `http://${req.headers.host}`, '请从这台牌桌的地址操作。', 403);
    if (req.headers['sec-fetch-site']) requireRule(req.headers['sec-fetch-site'] !== 'cross-site', '请从这台牌桌的地址操作。', 403);
  }
  function requestHost(req) {
    let url;
    try { url = new URL(`http://${req.headers.host}`); } catch { throw new RuleError('地址无效。', 403); }
    requireRule(url.host === req.headers.host?.toLowerCase() && !url.username && !url.password && url.pathname === '/' && (localHost(url.hostname) || lanAddresses().includes(url.hostname)), '请使用本机或局域网地址访问。', 403);
    return url;
  }
  const server = http.createServer(async (req, res) => {
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const authority = requestHost(req);
      const url = new URL(req.url, authority);
      requireRule(url.origin === authority.origin, '地址无效。', 403);
      const local = isLoopback(req.socket.remoteAddress) && localHost(authority.hostname);
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1] || '';
      let body = {};
      if (req.method === 'POST') {
        sameOrigin(req);
        takeBudget(req);
        requireRule((req.headers['content-type'] || '').startsWith('application/json'), '需要 JSON 请求。', 415);
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; requireRule(bytes <= 32_768, '请求过大。', 413); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RuleError('请求格式不正确。'); }
        requireRule(body && typeof body === 'object' && !Array.isArray(body), '请求格式不正确。');
      }
      if (url.pathname === '/api/network' && req.method === 'GET') return json(200, { local, addresses: network(), rooms: local ? store.list() : [] });
      if (url.pathname === '/api/rooms' && req.method === 'POST') {
        requireRule(local, '请在运行服务的电脑上，用 localhost 地址创建房间。', 403);
        return json(201, store.create(body));
      }
      const match = /^\/api\/rooms\/([A-Z2-9]{4})(?:\/(join|command|qr\.svg|transfer|accept-transfer|claim|decide-claim|ask|decide-ask|reclaim-host|rematch|log|hands|summary))?$/.exec(url.pathname);
      if (match) {
        const [, code, action] = match;
        if (!action && req.method === 'GET') return json(200, view(code, token));
        if (action === 'log' && req.method === 'GET') return json(200, { logs: store.logs(code) });
        if (action === 'hands' && req.method === 'GET') return json(200, store.hands(code));
        if (action === 'summary' && req.method === 'GET') return json(200, store.summary(code));
        if (action === 'qr.svg' && req.method === 'GET') {
          store.get(code); const link = joinUrl(code);
          requireRule(!!link, '还没有局域网地址。确认电脑已连上 Wi-Fi，然后刷新。');
          const svg = await QRCode.toString(link, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, color: { dark: '#1a211e', light: '#f3f1ea' } });
          res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }); return res.end(svg);
        }
        if (req.method === 'POST') {
          if (action === 'join') { store.join(code, body); broadcast(code); return json(200, view(code, body.token)); }
          if (action === 'command') { const result = store.command(code, token, body, { online: online(code) }); broadcast(code); return json(200, { ...view(code, token), ...result }); }
          if (action === 'transfer') {
            const secret = store.transfer(code, token), link = `${network()[0] || `http://localhost:${actualPort}`}/transfer?room=${code}#${secret}`;
            const qr = await QRCode.toString(link, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, color: { dark: '#1a211e', light: '#f3f1ea' } });
            return json(200, { url: link, qr });
          }
          if (action === 'claim') { store.claim(code, body); broadcast(code); return json(200, view(code, body.token)); }
          if (action === 'decide-claim') { const result = store.decideClaim(code, token, body); broadcast(code); return json(200, { ...view(code, token), ...result }); }
          if (action === 'ask') { store.ask(code, token); broadcast(code); return json(200, view(code, token)); }
          if (action === 'decide-ask') { store.decideAsk(code, token, body); broadcast(code); return json(200, view(code, token)); }
          if (action === 'reclaim-host') { requireRule(local, '只能在运行服务的这台电脑上，用 localhost 地址接回主持。', 403); const fresh = store.reclaimHost(code); broadcast(code); return json(200, { token: fresh }); }
          if (action === 'rematch') { requireRule(local, '请在运行服务的电脑上，用 localhost 地址开新桌。', 403); const created = store.rematch(code, token); broadcast(code); return json(201, created); }
          if (action === 'accept-transfer') { const newToken = store.acceptTransfer(code, body.secret); broadcast(code); return json(200, { token: newToken }); }
        }
      }
      if (url.pathname.startsWith('/api/')) return json(404, { error: '没有这个接口。' });
      requireRule(req.method === 'GET' || req.method === 'HEAD', '请求方法不支持。', 405);
      let filePath;
      if (url.pathname.startsWith('/shared/')) filePath = path.join(root, 'server', url.pathname.slice(8));
      else filePath = path.join(root, 'public', url.pathname === '/' || !path.extname(url.pathname) ? 'index.html' : url.pathname);
      const shared = new Set(['engine.js', 'cards.js']);
      const permitted = filePath.startsWith(path.join(root, 'public') + path.sep) || (filePath.startsWith(path.join(root, 'server') + path.sep) && shared.has(path.basename(filePath)));
      requireRule(permitted, '文件不存在。', 404);
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4' };
      const data = await readFile(filePath);
      const headers = { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': filePath.includes('/fonts/') || filePath.endsWith('.woff2') ? 'public, max-age=86400' : 'no-cache', 'Accept-Ranges': 'bytes' };
      // iOS Safari 播放视频（屏幕常亮的后备方案）必须支持 Range 请求。
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range && (range[1] || range[2])) {
        let start = range[1] ? Number(range[1]) : Math.max(0, data.length - Number(range[2]));
        let end = range[1] && range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
        if (start >= data.length || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }); res.end(); return; }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
        res.end(req.method === 'HEAD' ? undefined : data.subarray(start, end + 1)); return;
      }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (!(error instanceof RuleError) && error.code !== 'ENOENT') console.error('Request failed:', error.message);
      json(error.status || (error.code === 'ENOENT' ? 404 : 500), { error: error instanceof RuleError ? error.message : error.code === 'ENOENT' ? '文件不存在。' : '服务暂时无法完成这一步，筹码没有改变。' });
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (req, socket, head) => {
    try {
      sameOrigin(req);
      requestHost(req);
      requireRule(req.url === '/ws', '接口不存在。');
      takeBudget(req);
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
    } catch { socket.destroy(); }
  });
  wss.on('connection', ws => {
    ws.alive = true;
    const authTimeout = setTimeout(() => ws.close(1008, '请加入房间'), 5000);
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw);
        requireRule(!ws.code && message.type === 'subscribe', '连接已经加入房间。');
        requireRule(typeof message.code === 'string' && typeof message.token === 'string' && message.token.length <= 64, '身份无效。');
        store.get(message.code);
        ws.code = message.code; ws.token = message.token;
        clients.add(ws); clearTimeout(authTimeout); broadcast(ws.code);
      } catch (error) { ws.send(JSON.stringify({ type: 'error', error: error instanceof RuleError ? error.message : '无法恢复连接。' })); ws.close(1008); }
    });
    ws.on('close', () => { clearTimeout(authTimeout); clients.delete(ws); if (ws.code) broadcast(ws.code); });
    ws.on('error', () => {});
  });
  // 心跳只更新在线提示，绝不推进手牌、倒计时或代弃牌。
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
  }, 15_000);
  heartbeat.unref();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  actualPort = server.address().port;
  return { server, store, port: actualPort, broadcast, async close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    store.close();
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createServer();
  console.log(`\n夜席 · 仅娱乐积分，无充值提现或真钱兑换\n电脑创建房间：http://localhost:${app.port}\n${lanAddresses().map(ip => `同一 Wi-Fi 手机：http://${ip}:${app.port}`).join('\n') || '还没有局域网地址，请连接 Wi-Fi。'}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
