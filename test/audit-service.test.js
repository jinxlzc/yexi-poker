import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createServer } from '../server/index.js';
import { freshToken } from '../server/store.js';
import { makeDeck, setNextDeck } from '../server/cards.js';
import { legalActions, potTotal } from '../server/engine.js';

function fixture(app, config = {}) {
  const host = app.store.create(config), tokens = [freshToken(), freshToken()];
  tokens.forEach((token, i) => app.store.join(host.code, { token, name: `玩家${i + 1}`, seat: i + 1 }));
  const state = () => app.store.get(host.code).state;
  const command = (type, args = {}, token = host.token) => app.store.command(host.code, token, { type, args, version: state().version, requestId: randomUUID() });
  return { ...host, tokens, state, command, ids: state().players.map(p => p.id) };
}
function rawRequest(port, { path = '/api/network', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, text: data, headers: res.headers }));
    }); req.on('error', reject); req.end(body);
  });
}
const post = (port, path, body, headers = {}) => rawRequest(port, { path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
function socket(app, code, token = '', extra = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { origin: `http://127.0.0.1:${app.port}`, ...extra });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('snapshot timeout')), 3000);
    ws.once('open', () => ws.send(JSON.stringify({ type: 'subscribe', code, token })));
    ws.once('message', raw => { clearTimeout(timeout); resolve(JSON.parse(raw)); });
    ws.once('error', e => { clearTimeout(timeout); reject(e); });
  });
  return { ws, ready };
}

test('audit: HTTP rejects malformed actions as 4xx without mutating state or exposing internals', async () => {
  const app = await createServer({ file: ':memory:', port: 0, host: '127.0.0.1' });
  try {
    const f = fixture(app, { dealMode: 'digital' }), before = app.store.text(f.code);
    for (const [type, args] of [['settle', { selections: null }], ['preview', { selections: { 'pot-0': 1 } }]]) {
      const r = await post(app.port, `/api/rooms/${f.code}/command`, { type, args, version: f.state().version, requestId: randomUUID() }, { Authorization: `Bearer ${f.token}` });
      assert.ok(r.status >= 400 && r.status < 500, `${type}: ${r.status}`); assert.doesNotMatch(r.text, /TypeError|\.js:\d|stack/);
    }
    assert.equal(app.store.text(f.code), before);
    const secret = app.store.transfer(f.code, f.token);
    for (const value of [null, {}, [], 7]) {
      const r = await post(app.port, `/api/rooms/${f.code}/accept-transfer`, { secret: value });
      assert.ok(r.status >= 400 && r.status < 500);
    }
    assert.ok(app.store.acceptTransfer(f.code, secret));
  } finally { await app.close(); }
});

test('audit: room A credentials cannot operate room B or obtain B hole cards', async () => {
  const app = await createServer({ file: ':memory:', port: 0, host: '127.0.0.1' });
  try {
    const a = fixture(app), b = fixture(app, { dealMode: 'digital' }); b.command('start');
    const before = app.store.text(b.code);
    for (const token of [a.token, ...a.tokens, '', freshToken()]) {
      for (const type of ['start', 'next', 'settle', 'preview', 'undo', 'rebuy', 'rebuySetting', 'move', 'seat', 'setDealMode', 'timeout', 'pause', 'level', 'settings', 'end', 'leave', 'sitOut', 'act', 'show']) {
        assert.throws(() => b.command(type, { playerId: b.ids[0] }, token), e => e.status === 403);
      }
      assert.equal(app.store.view(b.code, token).hole, null);
      for (const action of ['transfer', 'decide-claim', 'decide-ask', 'ask', 'rematch']) {
        const r = await post(app.port, `/api/rooms/${b.code}/${action}`, {}, { Authorization: `Bearer ${token}` });
        assert.equal(r.status, 403);
      }
    }
    assert.equal(app.store.text(b.code), before);
  } finally { await app.close(); }
});

test('audit: Host and Origin validation also rejects absolute request targets and WebSocket cross-origin upgrades', async () => {
  const app = await createServer({ file: ':memory:', port: 0, host: '127.0.0.1' });
  try {
    for (const host of ['evil.example', 'localhost.evil.example', 'localhost@evil.example']) {
      const r = await rawRequest(app.port, { path: `http://127.0.0.1:${app.port}/api/network`, headers: { Host: host } });
      assert.equal(r.status, 403);
    }
    for (const headers of [{ Origin: 'null' }, { Origin: 'http://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await post(app.port, '/api/rooms', {}, headers)).status, 403);
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { origin: 'http://evil.example' });
    await new Promise(resolve => { ws.on('open', () => { assert.fail('cross-origin upgrade accepted'); }); ws.on('error', resolve); });
    for (const path of ['/shared/../store.js', '/shared/%2e%2e/store.js', '/%2e%2e/server/store.js', '/shared/%2e%2e%2fstore.js', '/server/engine.js', '/data/table.sqlite', '/package.json']) {
      const r = await rawRequest(app.port, { path }); assert.equal(r.status, 404, path); assert.doesNotMatch(r.text, /hostHash|DatabaseSync/);
    }
  } finally { await app.close(); }
});

test('audit: malformed, oversized JSON and non-integer numeric inputs are bounded and atomic', async () => {
  const app = await createServer({ file: ':memory:', port: 0, host: '127.0.0.1' });
  try {
    const f = fixture(app), before = app.store.text(f.code);
    for (const amount of [null, -1, 0, 1.5, 1e100, '10', {}, []]) {
      const r = await post(app.port, `/api/rooms/${f.code}/command`, { type: 'rebuy', args: { playerId: f.ids[0], amount }, version: f.state().version, requestId: randomUUID() }, { Authorization: `Bearer ${f.token}` });
      assert.equal(r.status, 400);
    }
    for (const body of ['null', '[]', '{', '{"bigBlind":NaN}']) assert.equal((await rawRequest(app.port, { path: '/api/rooms', method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 400);
    assert.equal((await post(app.port, '/api/rooms', { name: '字'.repeat(12000) })).status, 413);
    assert.equal((await rawRequest(app.port, { path: '/api/rooms', method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal(app.store.text(f.code), before);
  } finally { await app.close(); }
});

test('audit: WebSocket payload and message floods close without changing the hand', async () => {
  const app = await createServer({ file: ':memory:', port: 0, host: '127.0.0.1' });
  try {
    const f = fixture(app); f.command('start'); const before = f.state();
    for (const payload of ['x'.repeat(4097), JSON.stringify({ type: 'act', action: 'fold' })]) {
      const { ws, ready } = socket(app, f.code, f.tokens[0]); await ready;
      const closed = new Promise(resolve => ws.on('close', code => resolve(code)));
      ws.send(payload); assert.ok([1009, 1008].includes(await closed));
    }
    const { ws, ready } = socket(app, f.code); await ready;
    let messages = 0; ws.on('message', () => messages++);
    const closed = new Promise(resolve => ws.once('close', resolve));
    for (let i = 0; i < 100; i++) ws.send('{');
    await closed; assert.ok(messages <= 1, `flood generated ${messages} error responses`);
    assert.deepEqual(f.state(), before);
  } finally { await app.close(); }
});

test('audit: hidden losing cards stay out of logs, hands, summary, snapshots and revoked reconnects', async () => {
  const app = await createServer({ file: ':memory:', port: 0, host: '127.0.0.1' });
  const sockets = [];
  try {
    const f = fixture(app, { dealMode: 'digital' });
    const prefix = ['As', 'Kh', 'Ad', 'Kd', '4c', '2c', '7d', '9h', '5c', 'Js', '6c', '3s'];
    setNextDeck([...prefix, ...makeDeck().filter(c => !prefix.includes(c))]); f.command('start');
    while (f.state().hand.phase !== 'showdown') {
      const s = f.state();
      if (s.hand.phase === 'roundEnd') f.command('next');
      else { const l = legalActions(s, s.hand.actor); f.command('act', { action: l.check ? 'check' : 'call' }, f.tokens[f.ids.indexOf(s.hand.actor)]); }
    }
    f.command('settle', { selections: f.state().hand.selections, expectedTotal: potTotal(f.state()) }); f.command('end');
    for (const suffix of ['', '/log', '/hands', '/summary']) {
      const r = await rawRequest(app.port, { path: `/api/rooms/${f.code}${suffix}` });
      assert.equal(r.status, 200); assert.doesNotMatch(r.text, /"Kh"|"Kd"|"holes"|"deck"|"burned"|hostHash|playerHashes/);
    }
    f.command('undo'); const fresh = freshToken();
    app.store.claim(f.code, { token: fresh, playerId: f.ids[0] });
    app.store.decideClaim(f.code, f.token, { claimId: app.store.get(f.code).claims[0].id, approve: true });
    for (const token of [f.token, f.tokens[0], f.tokens[1], '']) {
      const { ws, ready } = socket(app, f.code, token); sockets.push(ws);
      const snap = await ready;
      assert.doesNotMatch(JSON.stringify(snap), /"Kh"|"Kd"|"holes"|"deck"|"burned"/);
    }
    assert.deepEqual(app.store.view(f.code, fresh).hole, ['Kh', 'Kd']);
  } finally { sockets.forEach(ws => ws.terminate()); await app.close(); }
});

test('audit: a UTF-8 name split across HTTP chunks is decoded intact', async () => {
  const app = await createServer({ file: ':memory:', port: 0, host: '127.0.0.1' });
  try {
    const f = fixture(app), bytes = Buffer.from(JSON.stringify({ name: '夜猫', seat: 3, token: freshToken() }));
    const offset = bytes.indexOf(Buffer.from('夜')) + 1;
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: app.port, path: `/api/rooms/${f.code}/join`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
        let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
      });
      req.on('error', reject); req.write(bytes.subarray(0, offset));
      setTimeout(() => req.end(bytes.subarray(offset)), 20);
    });
    assert.equal(r.status, 200);
    assert.equal(f.state().players[2].name, '夜猫');
  } finally { await app.close(); }
});

test('audit: bursts of mutation requests and new WebSocket connections are rate limited', async () => {
  const app = await createServer({ file: ':memory:', port: 0, host: '127.0.0.1' });
  try {
    const f = fixture(app); const before = f.state(); let limited = false;
    for (let i = 0; i < 90; i++) {
      const r = await post(app.port, `/api/rooms/${f.code}/claim`, { token: freshToken(), playerId: 'missing' });
      if (r.status === 429) { limited = true; break; }
    }
    assert.equal(limited, true);
    assert.deepEqual(f.state(), before);
    // 同一地址的连接风暴也使用相同配额，不能通过换连接绕过。
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { origin: `http://127.0.0.1:${app.port}` });
    let opened = false;
    await new Promise(resolve => { ws.once('open', () => { opened = true; ws.close(); resolve(); }); ws.once('error', resolve); });
    assert.equal(opened, false);
    assert.equal((await rawRequest(app.port)).status, 200);
  } finally { await app.close(); }
});

test('audit: malformed electronic showdown selections cannot cause a server error', async () => {
  const app = await createServer({ file: ':memory:', port: 0, host: '127.0.0.1' });
  try {
    const f = fixture(app, { dealMode: 'digital' }); f.command('start'); f.command('act', { action: 'fold' }, f.tokens[0]);
    const before = f.state();
    for (const selections of [{ 'pot-0': 1 }, { 'pot-0': {} }, { 'pot-0': 'x' }, [], true]) {
      const r = await post(app.port, `/api/rooms/${f.code}/command`, { type: 'settle', args: { selections, expectedTotal: potTotal(before) }, version: before.version, requestId: randomUUID() }, { Authorization: `Bearer ${f.token}` });
      assert.equal(r.status, 400);
    }
    assert.deepEqual(f.state(), before);
  } finally { await app.close(); }
});

test('audit: 160-hand broadcasts stay bounded and do not reparse full history per connected viewer', async t => {
  const app = await createServer({ file: ':memory:', port: 0, host: '127.0.0.1' }); const sockets = [];
  try {
    const f = fixture(app, { dealMode: 'digital' });
    let earlyBytes;
    for (let hand = 1; hand <= 160; hand++) {
      f.command('start'); f.command('act', { action: 'fold' }, f.tokens[f.ids.indexOf(f.state().hand.actor)]);
      f.command('settle', { selections: f.state().hand.selections, expectedTotal: potTotal(f.state()) });
      if (hand === 5) earlyBytes = Buffer.byteLength(JSON.stringify(app.store.view(f.code, '')));
    }
    for (let i = 0; i < 10; i++) { const c = socket(app, f.code); sockets.push(c.ws); await c.ready; }
    const snapshot = app.store.view(f.code, ''), bytes = Buffer.byteLength(JSON.stringify(snapshot));
    assert.ok(bytes < earlyBytes + 3000); assert.ok(bytes < 20_000);
    assert.equal(snapshot.state.records, undefined); assert.ok(snapshot.state.logs.length <= 60);
    assert.equal(app.store.hands(f.code).records.length, 160);
    // 计数实际解析工作；包装器始终调用真实实现，不伪造返回值。
    let parses = 0; const original = app.store.parse.bind(app.store);
    app.store.parse = (...args) => { parses++; return original(...args); };
    const start = performance.now(); app.broadcast(f.code); const ms = performance.now() - start;
    t.diagnostic(JSON.stringify({ hands: 160, viewers: 10, earlyBytes, bytes, broadcastMs: +ms.toFixed(2), parses }));
    assert.ok(parses <= 1, `broadcast parsed the entire room ${parses} times`);
  } finally { sockets.forEach(ws => ws.terminate()); await app.close(); }
});
