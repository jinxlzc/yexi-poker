import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { WebSocket } from 'ws';
import { Store, freshToken } from '../server/store.js';
import { createServer } from '../server/index.js';
import { assertConservation, clipView } from '../server/engine.js';

function fixture(store) {
  const host = store.create({});
  const tokens = [freshToken(), freshToken(), freshToken()];
  tokens.forEach((token, i) => store.join(host.code, { token, name: `玩家${i + 1}`, seat: i + 1 }));
  const command = (type, args = {}, token = host.token, overrides = {}) => store.command(host.code, token, { type, args, version: store.get(host.code).state.version, requestId: randomUUID(), ...overrides });
  return { ...host, tokens, command, state: () => store.get(host.code).state };
}
test('host authorization: players and spectators cannot start, settle, preview, undo, move, rebuy, toggle or remove others', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store), original = f.state();
    for (const token of [f.tokens[0], '', freshToken()]) for (const action of ['start', 'settle', 'preview', 'undo', 'move', 'rebuy', 'rebuySetting']) assert.throws(() => f.command(action, {}, token), /主持权限/);
    assert.throws(() => f.command('act', { action: 'call' }), /自己的座位/);
    assert.deepEqual(f.state(), original);
    const otherId = store.view(f.code, f.tokens[1]).playerId;
    assert.throws(() => f.command('leave', { playerId: otherId }, f.tokens[0]), /自己的座位/);
    assert.ok(f.state().players.some(p => p.id === otherId)); // player request cannot spoof playerId
    assert.deepEqual(f.state(), original);
  } finally { store.close(); }
});
test('tokens separate, private credentials absent from snapshots; join retry reuses exact seat', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store), before = f.state();
    store.join(f.code, { token: f.tokens[0], name: '玩家1', seat: 1 });
    assert.deepEqual(f.state(), before);
    assert.equal(store.view(f.code, f.token).role, 'host');
    assert.equal(store.view(f.code, f.tokens[0]).role, 'player');
    for (const token of [f.token, ...f.tokens]) assert.ok(!JSON.stringify(store.view(f.code, '')).includes(token));
    assert.ok(!JSON.stringify(store.view(f.code, '')).includes('Hash'));
  } finally { store.close(); }
});
test('atomic undo restores settled pools, actions, blinds and configuration with monotonically increasing version', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store), before = f.state();
    f.command('start');
    const started = f.state();
    f.command('act', { action: 'fold' }, f.tokens[0]);
    const oneFold = f.state();
    f.command('act', { action: 'fold' }, f.tokens[1]);
    const showdown = f.state(), view = store.view(f.code, f.token);
    f.command('settle', { selections: Object.fromEntries(view.pots.map(p => [p.id, p.eligible])), expectedTotal: view.pots.reduce((sum, p) => sum + p.amount, 0) });
    assert.equal(f.state().hand.phase, 'settled');
    for (const expected of [showdown, oneFold, started, before]) {
      const version = f.state().version;
      f.command('undo'); const actual = f.state(); assert.ok(actual.version > version);
      assert.deepEqual({ ...actual, version: expected.version }, expected); assertConservation(actual);
    }
  } finally { store.close(); }
});
test('duplicate delivery is idempotent; simultaneous stale commands fail without mutation', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store); f.command('start');
    const original = f.state(), requestId = randomUUID();
    f.command('act', { action: 'call' }, f.tokens[0], { requestId });
    const once = f.state();
    f.command('act', { action: 'call' }, f.tokens[0], { requestId, version: original.version });
    assert.deepEqual(f.state(), once);
    assert.throws(() => f.command('undo', {}, f.token, { version: original.version }), /牌桌已经变了/);
    assert.deepEqual(f.state(), once);
  } finally { store.close(); }
});
test('single-use host transfer revokes old host, preserves history and does not grant player privileges', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store); f.command('start');
    assert.throws(() => store.transfer(f.code, f.tokens[0]), /权限/);
    const secret = store.transfer(f.code, f.token), token = store.acceptTransfer(f.code, secret);
    assert.equal(store.view(f.code, f.token).role, 'spectator');
    assert.equal(store.view(f.code, token).role, 'host');
    assert.throws(() => store.acceptTransfer(f.code, secret), /无效/);
    assert.throws(() => f.command('undo'), /权限/);
    f.command('undo', {}, token); assert.equal(f.state().hand, null);
  } finally { store.close(); }
});
test('SQLite restart restores active hand, tokens, logs and undo history', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'night-table-')), file = path.join(dir, 'rooms.sqlite');
  let store = new Store(file);
  try {
    const f = fixture(store); f.command('start'); f.command('act', { action: 'raise', to: 100 }, f.tokens[0]);
    const before = f.state(), id = store.view(f.code, f.tokens[0]).playerId;
    store.close(); store = new Store(file);
    assert.deepEqual(store.get(f.code).state, before);
    assert.equal(store.view(f.code, f.tokens[0]).playerId, id);
    assert.equal(store.view(f.code, f.token).role, 'host');
    store.command(f.code, f.token, { type: 'undo', args: {}, requestId: randomUUID(), version: before.version });
    assert.equal(store.get(f.code).state.hand.actor, id); assertConservation(store.get(f.code).state);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
function subscribe(port, code, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
  const messages = [];
  const waiters = [];
  ws.on('message', raw => {
    const message = JSON.parse(raw); messages.push(message);
    for (const waiter of [...waiters]) if (waiter.test(message)) { clearTimeout(waiter.timeout); waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
  });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', code, token })));
  const wait = predicate => new Promise((resolve, reject) => {
    const found = messages.find(predicate); if (found) return resolve(found);
    const waiter = { test: predicate, resolve, timeout: setTimeout(() => reject(new Error('WebSocket snapshot timeout')), 3000) }; waiters.push(waiter);
  });
  return { ws, wait };
}
test('real HTTP and WebSocket: disconnected actor stays put, reconnect and server restart restore seat', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'night-table-ws-')), file = path.join(dir, 'table.sqlite');
  let app = await createServer({ file, port: 0, host: '127.0.0.1' });
  const sockets = [];
  try {
    const f = fixture(app.store), host = subscribe(app.port, f.code, f.token); sockets.push(host.ws);
    await host.wait(m => m.type === 'state');
    const phone = subscribe(app.port, f.code, f.tokens[0]); sockets.push(phone.ws);
    const initial = await phone.wait(m => m.role === 'player');
    const id = initial.playerId; assert.ok(initial.online.includes(id));
    f.command('start'); app.broadcast(f.code);
    await phone.wait(m => m.state.hand?.actor === id);
    const before = f.state();
    phone.ws.close();
    await host.wait(m => m.state.version === before.version && !m.online.includes(id));
    assert.deepEqual(f.state(), before); // no automatic folding
    const reconnected = subscribe(app.port, f.code, f.tokens[0]); sockets.push(reconnected.ws);
    const recovered = await reconnected.wait(m => m.playerId === id);
    assert.deepEqual(recovered.state, clipView(before, { role: 'player', playerId: id }).state); assert.ok(recovered.legal);
    const bad = await fetch(`http://127.0.0.1:${app.port}/api/rooms/${f.code}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.tokens[0]}` }, body: JSON.stringify({ type: 'undo', version: before.version, requestId: randomUUID() }) });
    assert.equal(bad.status, 403);
    await app.close();
    app = await createServer({ file, port: 0, host: '127.0.0.1' });
    const afterRestart = subscribe(app.port, f.code, f.tokens[0]); sockets.push(afterRestart.ws);
    const restored = await afterRestart.wait(m => m.playerId === id);
    assert.deepEqual(restored.state, clipView(before, { role: 'player', playerId: id }).state); assert.ok(restored.legal);
  } finally { sockets.forEach(ws => ws.terminate()); await app.close(); await rm(dir, { recursive: true, force: true }); }
});
test('HTTP validation: only loopback may create; same-origin mutation and no private files', async () => {
  const app = await createServer({ file: ':memory:', port: 0, host: '127.0.0.1' });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const local = await (await fetch(`${base}/api/network`)).json(); assert.equal(local.local, true);
    const rejected = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' }); assert.equal(rejected.status, 403);
    const invalidHost = await new Promise(resolve => { http.get(`${base}/api/network`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }); }); assert.equal(invalidHost, 403);
    for (const url of ['/shared/store.js', '/server/store.js', '/data/table.sqlite', '/package.json']) assert.equal((await fetch(`${base}${url}`)).status, 404);
    const create = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(create.status, 201);
    const { code } = await create.json(); assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    assert.equal((await fetch(`${base}/`)).status, 200);
  } finally { await app.close(); }
});
