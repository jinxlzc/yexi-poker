import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, freshToken } from '../server/store.js';
import { makeDeck, setNextDeck } from '../server/cards.js';
import { assertConservation, potTotal, legalActions, normalizeRoom } from '../server/engine.js';

function fixture(store, config = {}) {
  const host = store.create({ rebuy: true, ...config });
  const tokens = [freshToken(), freshToken(), freshToken()];
  tokens.forEach((token, i) => store.join(host.code, { token, name: `玩家${i + 1}`, seat: i + 1 }));
  const state = () => store.get(host.code).state;
  const command = (type, args = {}, token = host.token) => store.command(host.code, token, { type, args, version: state().version, requestId: randomUUID() });
  return { ...host, tokens, state, command, ids: state().players.map(p => p.id) };
}

test('audit: undo end restores the entire table plus pending claims and rebuy requests', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store);
    store.ask(f.code, f.tokens[0]);
    store.claim(f.code, { token: freshToken(), playerId: f.ids[1] });
    f.command('pause', { on: true });
    const before = store.get(f.code);
    f.command('end'); f.command('undo');
    const after = store.get(f.code);
    assert.deepEqual({ ...after.state, version: before.state.version }, before.state);
    assert.deepEqual(after.claims, before.claims); assert.deepEqual(after.asks, before.asks);
  } finally { store.close(); }
});

test('audit: an expired claim cannot revoke the seated player credential', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store), token = freshToken();
    store.claim(f.code, { token, playerId: f.ids[0] });
    const raw = store.get(f.code); raw.claims[0].at -= 16 * 60_000; store.save(raw);
    const before = store.text(f.code);
    assert.throws(() => store.decideClaim(f.code, f.token, { claimId: raw.claims[0].id, approve: true }), /过期/);
    assert.equal(store.text(f.code), before);
    assert.equal(store.view(f.code, f.tokens[0]).role, 'player');
  } finally { store.close(); }
});

test('audit: a claimant who joined another seat cannot overwrite that seat credential', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store), token = freshToken();
    store.claim(f.code, { token, playerId: f.ids[0] });
    const id = store.get(f.code).claims[0].id;
    store.join(f.code, { token, name: '新人', seat: 4 });
    const before = store.text(f.code);
    assert.throws(() => store.decideClaim(f.code, f.token, { claimId: id, approve: true }));
    assert.equal(store.text(f.code), before);
    assert.notEqual(store.view(f.code, token).playerId, f.ids[0]);
  } finally { store.close(); }
});

test('audit: claim lookup rejects inherited object keys and malformed identifiers', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store);
    for (const playerId of ['__proto__', 'constructor', ['__proto__'], null, {}]) {
      assert.throws(() => store.claim(f.code, { token: freshToken(), playerId }));
    }
    assert.equal(store.get(f.code).claims.length, 0);
  } finally { store.close(); }
});

test('audit: one corrupt persisted row does not prevent listing and opening healthy rooms', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store);
    store.db.prepare('INSERT INTO rooms VALUES (?, ?)').run('BAD1', '{broken');
    store.db.prepare('INSERT INTO rooms VALUES (?, ?)').run('BAD2', JSON.stringify({ state: { players: null } }));
    const list = store.list();
    assert.ok(list.some(r => r.code === f.code));
    assert.ok(list.some(r => r.code === 'BAD1' && r.status === 'unavailable'));
    assert.throws(() => store.get('BAD1'), e => e.status === 503 && /损坏/.test(e.message));
    assert.equal(store.view(f.code, f.token).role, 'host');
    assert.equal(store.db.prepare('SELECT record FROM rooms WHERE code = ?').get('BAD1').record, '{broken');
  } finally { store.close(); }
});

test('audit: missing optional persistence fields recover without dropping chips or authorization', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store), raw = store.get(f.code);
    for (const key of ['history', 'requests', 'claims', 'asks', 'transfer']) delete raw[key];
    for (const key of ['records', 'logs', 'paused']) delete raw.state[key];
    store.db.prepare('UPDATE rooms SET record = ? WHERE code = ?').run(JSON.stringify(raw), f.code); store.cache.clear();
    const loaded = store.get(f.code);
    assert.deepEqual(loaded.state.players, raw.state.players);
    assert.equal(store.view(f.code, f.token).role, 'host');
    assert.deepEqual(store.logs(f.code), []);
    f.command('start'); assertConservation(f.state());
  } finally { store.close(); }
});

test('audit: invalid persisted chip totals and missing digital cards fail closed', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, { dealMode: 'digital' }); f.command('start');
    const original = store.get(f.code);
    for (const damage of [r => { r.state.total++; }, r => { delete r.state.hand.deck; }, r => { r.state.players[0].stack = -1; }]) {
      const raw = structuredClone(original); damage(raw);
      store.db.prepare('UPDATE rooms SET record = ? WHERE code = ?').run(JSON.stringify(raw), f.code); store.cache.clear();
      assert.throws(() => store.view(f.code, f.token), e => e.status === 503);
    }
  } finally { store.close(); }
});

test('audit: WAL restart preserves an active digital deck, private cards, raise rights and deterministic continuation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'night-audit-'));
  const file = path.join(dir, 'night.sqlite'); let store = new Store(file);
  try {
    const f = fixture(store, { dealMode: 'digital' }); f.command('start');
    f.command('act', { action: 'raise', to: 100 }, f.tokens[0]);
    const before = store.get(f.code), holes = before.state.hand.holes;
    assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    store.close(); store = new Store(file);
    assert.deepEqual(store.get(f.code), before);
    for (let i = 0; i < 3; i++) assert.deepEqual(store.view(f.code, f.tokens[i]).hole, holes[f.ids[i]]);
    for (let guard = 0; store.get(f.code).state.hand.phase !== 'showdown'; guard++) {
      assert.ok(guard < 100); const s = store.get(f.code).state;
      const next = s.hand.phase === 'roundEnd'; const l = next ? null : legalActions(s, s.hand.actor);
      store.command(f.code, next ? f.token : f.tokens[f.ids.indexOf(s.hand.actor)], { type: next ? 'next' : 'act', args: next ? {} : { action: l.check ? 'check' : l.canCall ? 'call' : 'allin' }, version: s.version, requestId: randomUUID() });
    }
    const s = store.get(f.code).state, deck = before.state.hand.deck;
    assert.deepEqual(s.hand.board, [deck[1], deck[2], deck[3], deck[5], deck[7]]);
    store.command(f.code, f.token, { type: 'settle', args: { selections: s.hand.selections, expectedTotal: potTotal(s) }, version: s.version, requestId: randomUUID() });
    assert.equal(store.summary(f.code).balance.ok, true);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('audit: VPIP excludes the checked big blind, best hand excludes mucked cards, and undo removes a voluntary show', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, { dealMode: 'digital' }); f.command('leave', { playerId: f.ids[2] });
    const prefix = ['As', 'Kh', 'Ad', 'Kd', '4c', '2c', '7d', '9h', '5c', 'Js', '6c', '3s'];
    setNextDeck([...prefix, ...makeDeck().filter(c => !prefix.includes(c))]); f.command('start');
    while (f.state().hand.phase !== 'showdown') {
      const s = f.state();
      if (s.hand.phase === 'roundEnd') f.command('next');
      else { const l = legalActions(s, s.hand.actor); f.command('act', { action: l.check ? 'check' : 'call' }, f.tokens[f.ids.indexOf(s.hand.actor)]); }
    }
    f.command('settle', { selections: f.state().hand.selections, expectedTotal: potTotal(f.state()) });
    const before = f.state(), stats = Object.fromEntries(store.summary(f.code).players.map(p => [p.id, p]));
    assert.equal(stats[f.ids[0]].vpip, 100); assert.equal(stats[f.ids[1]].vpip, 0);
    assert.equal(stats[f.ids[0]].best, null); assert.equal(stats[f.ids[0]].won, 0);
    assert.deepEqual([stats[f.ids[1]].won, stats[f.ids[1]].biggest, stats[f.ids[1]].allins, stats[f.ids[1]].showdowns], [1, 40, 0, 1]);
    f.command('show', {}, f.tokens[0]);
    assert.deepEqual(store.summary(f.code).players.find(p => p.id === f.ids[0]).best.cards, ['Kh', 'Kd']);
    assert.equal(store.hands(f.code).records[0].actions.filter(a => a.a === 'show').length, 1);
    f.command('undo'); assert.deepEqual({ ...f.state(), version: before.version }, before);
    assert.doesNotMatch(JSON.stringify(store.hands(f.code)), /"Kh"|"Kd"/);
  } finally { store.close(); }
});

test('audit: a token from an undone join can still claim a seat as a spectator', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store); f.command('undo');
    assert.equal(store.view(f.code, f.tokens[2]).role, 'spectator');
    store.claim(f.code, { token: f.tokens[2], playerId: f.ids[0] });
    store.decideClaim(f.code, f.token, { claimId: store.get(f.code).claims[0].id, approve: true });
    assert.equal(store.view(f.code, f.tokens[2]).playerId, f.ids[0]);
    assert.equal(store.view(f.code, f.tokens[0]).role, 'spectator');
  } finally { store.close(); }
});

test('audit: an expired claim leaves the waiting view so the phone can request again', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store), token = freshToken();
    store.claim(f.code, { token, playerId: f.ids[0] });
    const raw = store.get(f.code); raw.claims[0].at -= 16 * 60_000; store.save(raw);
    assert.equal(store.view(f.code, token).claim.status, 'expired');
    store.claim(f.code, { token, playerId: f.ids[0] });
    assert.equal(store.view(f.code, token).claim.status, 'pending');
  } finally { store.close(); }
});
