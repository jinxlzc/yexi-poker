import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, clipView, integer, newRoom, pots, potTotal, RuleError } from '../server/engine.js';
import { createServer } from '../server/index.js';
import { describeHandMessage, evaluate, handNameMessage, makeDeck, setNextDeck } from '../server/cards.js';
import { dictionaries, message } from '../public/i18n/core.js';
import { Store, freshToken } from '../server/store.js';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

test('rule errors expose stable keys and interpolation values without changing the default message', () => {
  assert.throws(() => integer(0, 1, 10), error => {
    assert.ok(error instanceof RuleError);
    assert.equal(error.key, 'server.error.integer');
    assert.deepEqual(error.params, { min: 1, max: 10 });
    assert.equal(error.message, '需要 1–10 之间的整数。');
    return true;
  });
});

test('new logs and pots preserve display text and expose structured descriptions', () => {
  let state = newRoom('TEST');
  for (let i = 1; i <= 2; i++) state = apply(state, 'join', { id: `p${i}`, name: `P${i}`, seat: i });
  assert.equal(state.logs[0].key, 'server.log.join');
  assert.equal(state.logs[0].params.name, 'P1');
  assert.equal(state.logs[0].text, 'P1坐到 1 号位 · 起始 2000');
  state = apply(state, 'start');
  assert.equal(pots(state)[0].nameMessage.key, 'server.pot.main');
  assert.equal(pots(state)[0].name, '主池');
  assert.ok(state.logs.every(entry => entry.key && entry.params && typeof entry.text === 'string'));
});

test('HTTP errors include a localization key, params and the compatible error string', async () => {
  const app = await createServer({ file: ':memory:', port: 0, host: '127.0.0.1', rateLimit: false });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/missing`);
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.equal(body.key, 'server.error.apiMissing');
    assert.deepEqual(body.params, {});
    assert.equal(body.error, '没有这个接口。');
    assert.equal(body.message, body.error);
  } finally { await app.close(); }
});

test('logs resolve nested action descriptions and preserve names in all six languages', () => {
  let state = newRoom('TEST');
  for (let i = 1; i <= 2; i++) state = apply(state, 'join', { id: `p${i}`, name: `P${i}`, seat: i });
  state = apply(state, 'start');
  state = apply(state, 'act', { action: 'call' }, state.hand.actor);
  const entry = state.logs.findLast(item => item.kind === 'action');
  assert.equal(entry.text, 'P1 跟注 10');
  assert.equal(message(entry, 'en'), 'P1 Call 10');
  assert.equal(message(entry, 'ja'), 'P1 コール 10');
  assert.equal(message(entry, 'ko'), 'P1 콜 10');
  assert.equal(message(entry, 'es'), 'P1 Iguala 10');
  assert.equal(message(entry, 'zh-TW'), 'P1 跟注 10');
  assert.equal(message(entry, 'zh-CN'), entry.text);
});

test('raw historical logs are preserved while new undo notices carry descriptions', () => {
  const store = new Store(':memory:');
  try {
    const host = store.create({});
    store.join(host.code, { token: freshToken(), name: 'P1', seat: 1 });
    const record = store.get(host.code);
    const old = { id: 'old', at: record.state.createdAt, hand: 0, text: '旧记录原文', kind: 'settings' };
    record.state.logs.unshift(old);
    store.save(record);
    assert.equal(message(store.logs(host.code)[0], 'es'), old.text);
    const result = store.command(host.code, host.token, { type: 'undo', version: record.state.version, requestId: randomUUID() });
    assert.equal(result.notice, '已撤销：P1入座');
    assert.equal(message(result.noticeMessage, 'en'), 'Undone: P1 took a seat');
  } finally { store.close(); }
});

test('hand descriptions translate ranks without changing the evaluated cards', () => {
  const cards = ['Ks', 'Kh', 'Kd', 'Ts', 'Th'];
  assert.equal(message(handNameMessage(evaluate(cards)), 'en'), 'Full house');
  const detail = describeHandMessage(cards);
  assert.equal(detail.text, '葫芦 · K 带 10');
  assert.equal(message(detail, 'es'), 'Full · K sobre 10');
  assert.deepEqual(cards, ['Ks', 'Kh', 'Kd', 'Ts', 'Th']);
});

test('hidden cards never expose hand descriptions in views, logs or recorded hands', () => {
  const first = ['As', 'Kh', 'Ad', 'Kd', '4c', '2c', '7d', '9h', '5c', 'Js', '6c', '3s'];
  setNextDeck([...first, ...makeDeck().filter(card => !first.includes(card))]);
  let state = newRoom('TEST', { dealMode: 'digital' });
  for (let i = 1; i <= 2; i++) state = apply(state, 'join', { id: `p${i}`, name: `P${i}`, seat: i });
  state = apply(state, 'start');
  for (const identity of [{ role: 'host' }, { role: 'spectator' }, { role: 'player', playerId: 'p2' }]) {
    const view = clipView(state, identity).state.hand;
    assert.deepEqual(view.handNamesMessage, {});
    assert.deepEqual(view.boardHandNamesMessage, [{}]);
  }
  const act = action => { state = apply(state, 'act', { action }, state.hand.actor); };
  act('call'); act('check');
  for (let street = 0; street < 3; street++) { state = apply(state, 'next'); act('check'); act('check'); }
  assert.deepEqual(Object.keys(state.hand.handNamesMessage), ['p2']);
  assert.ok(!JSON.stringify(state.logs).includes('Kh'));
  const stale = structuredClone(state);
  stale.hand.handNamesMessage.p1 = handNameMessage({ rank: [9] });
  stale.hand.boardHandNamesMessage[0].p1 = handNameMessage({ rank: [9] });
  for (const identity of [{ role: 'host' }, { role: 'spectator' }, { role: 'player', playerId: 'p2' }]) {
    const view = clipView(stale, identity).state.hand;
    assert.deepEqual(Object.keys(view.handNamesMessage), ['p2']);
    assert.deepEqual(Object.keys(view.boardHandNamesMessage[0]), ['p2']);
  }
  state = apply(state, 'settle', { selections: state.hand.selections, expectedTotal: potTotal(state) });
  assert.deepEqual(Object.keys(state.records[0].handsMessage), ['p2']);
  assert.deepEqual(Object.keys(state.records[0].boardHandsMessage[0]), ['p2']);
  state = apply(state, 'show', {}, 'p1');
  assert.equal(message(state.records[0].handsMessage.p1, 'en'), 'One pair');
});

test('server dictionaries contain the same keys and interpolation parameters', () => {
  const base = Object.entries(dictionaries['zh-CN']).filter(([key]) => key.startsWith('server.'));
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(hit => hit[1]).sort();
  for (const dictionary of Object.values(dictionaries)) {
    assert.deepEqual(Object.keys(dictionary).filter(key => key.startsWith('server.')).sort(), base.map(([key]) => key).sort());
    for (const [key, text] of base) {
      assert.ok(dictionary[key].trim(), key);
      assert.deepEqual(placeholders(dictionary[key]), placeholders(text), key);
    }
  }
});

test('WebSocket errors use the same localized response contract', async () => {
  const app = await createServer({ file: ':memory:', port: 0, host: '127.0.0.1', rateLimit: false });
  const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
  try {
    const response = await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.once('open', () => socket.send(JSON.stringify({ type: 'subscribe', code: 7, token: '' })));
      socket.once('message', raw => resolve(JSON.parse(raw)));
    });
    assert.equal(response.type, 'error');
    assert.equal(response.key, 'server.error.identity');
    assert.deepEqual(response.params, {});
    assert.equal(response.error, '身份无效。');
    assert.equal(message(response, 'en'), 'Invalid identity.');
  } finally { socket.terminate(); await app.close(); }
});
