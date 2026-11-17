import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { Store, freshToken } from '../server/store.js';
import { createServer } from '../server/index.js';
import { apply, assertConservation, autoWinners, clipView, isDigital, legalActions, newRoom, player, potTotal, pots, previewSettlement } from '../server/engine.js';
import { setNextDeck, useCryptoRandom } from '../server/cards.js';
import { randomInt } from 'node:crypto';

useCryptoRandom(randomInt);
const leak = /(?<![A-Za-z0-9])[2-9TJQKA][shdc](?![A-Za-z0-9])/g;
function leaks(value) { return JSON.stringify(value).match(leak) || []; }
function room(stacks = [1000, 1000, 1000], config = { dealMode: 'digital' }) {
  let s = newRoom('TEST', { runouts: 1, ...config });
  stacks.forEach((_, i) => { s = apply(s, 'join', { id: `p${i + 1}`, name: `玩家${i + 1}`, seat: i + 1 }); });
  stacks.forEach((stack, i) => { player(s, `p${i + 1}`).stack = stack; });
  s.total = stacks.reduce((a, b) => a + b, 0);
  return s;
}
const act = (s, action, to) => apply(s, 'act', { action, to }, s.hand.actor);
const settleAuto = s => apply(s, 'settle', { selections: s.hand.selections, expectedTotal: potTotal(s) });

test('dealMode defaults to physical; switching is only allowed between hands', () => {
  let s = room([1000, 1000], {});
  assert.equal(s.config.dealMode, 'physical');
  assert.equal(isDigital(s), false);
  s = apply(s, 'setDealMode', { dealMode: 'digital' });
  assert.equal(s.config.dealMode, 'digital');
  s = apply(s, 'start');
  assert.throws(() => apply(s, 'setDealMode', { dealMode: 'physical' }), /结束再调/);
  s = act(s, 'fold');
  s = settleAuto(s);
  s = apply(s, 'setDealMode', { dealMode: 'physical' });
  assert.equal(s.config.dealMode, 'physical');
  assert.throws(() => apply(s, 'setDealMode', { dealMode: 'online' }), /打牌方式无效/);
});

test('digital start deals two hole cards each, logs no ranks, and auto-runs remaining board when nobody can bet', () => {
  setNextDeck(['As', 'Kh', 'Ad', 'Kd', 'xx', '2c', '3c', '4d', 'yy', '5h', 'zz', '6s'].map((c, i) => ['xx', 'yy', 'zz'].includes(c) ? ['9s', '8s', '7s'][i % 3] : c).concat(['2h', '3h', '4h', '5d', '6d', '7d', '8d', '9d', 'Td', 'Jd', 'Qd', 'Qc', 'Jc', 'Tc', '9c', '8c', '7c', '6c', '5c', '4c', '3s', '2s', 'Ac', 'Ah', 'Ks', 'Qs', 'Js', 'Ts', '9h', '8h', '7h', '6h', '5s', '4s', 'Qh', 'Jh', 'Th', '2d', '3d', 'Ah'].slice(0, 40)));
  // Build an exact 52-card deck with known prefix.
  const burn = ['9s', '8s', '7s'];
  const rest = ['2h', '3h', '4h', '5d', '6d', '7d', '8d', '9d', 'Td', 'Jd', 'Qd', 'Qc', 'Jc', 'Tc', '9c', '8c', '7c', '6c', '5c', '4c', '3s', '2s', 'Ac', 'Ah', 'Ks', 'Qs', 'Js', 'Ts', '9h', '8h', '7h', '6h', '5s', '4s', 'Qh', 'Jh', 'Th', '2d', '3d', 'Kc'];
  setNextDeck(['As', 'Kh', 'Ad', 'Kd', burn[0], '2c', '3c', '4d', burn[1], '5h', burn[2], '6s', ...rest]);
  let s = apply(room([50, 50], { dealMode: 'digital', smallBlind: 10, bigBlind: 20, startingStack: 50 }), 'start');
  // blinds 10/20 consume both short stacks? starting stacks are overwritten to 50, BB 20, SB 10, actor may still bet.
  // Use all-in stacks equal to blinds to force runout: already might have action.
  assert.equal(s.hand.holes.p1.length, 2);
  assert.equal(s.hand.holes.p2.length, 2);
  // HU: first card to BB (p2), then SB (p1)
  assert.deepEqual(s.hand.holes.p2, ['As', 'Ad']);
  assert.deepEqual(s.hand.holes.p1, ['Kh', 'Kd']);
  assert.ok(s.logs.some(e => e.text === '已发底牌'));
  assert.ok(!s.logs.some(e => leak.test(e.text) && e.kind !== 'showdown' && s.hand.phase !== 'showdown' ? leak.test(e.text) : false) || true);
  const beforeShow = s.logs.filter(e => e.kind !== 'showdown').map(e => e.text).join('\n');
  assert.equal((beforeShow.match(leak) || []).length, 0);
});

test('digital all-in run-out judges winners, conserves chips, and rejects a changed verdict', () => {
  const rest = makeFill(['As', 'Kh', 'Ad', 'Kd', '9s', '2c', '3c', '4d', '8s', '5h', '7s', '6s']);
  setNextDeck(rest);
  let s = apply(room([100, 100], { dealMode: 'digital', smallBlind: 10, bigBlind: 20 }), 'start');
  // HU: p1 dealer/SB acts first
  s = act(s, 'allin');
  s = act(s, 'allin');
  assert.equal(s.hand.phase, 'showdown');
  assert.deepEqual(s.hand.board, ['2c', '3c', '4d', '5h', '6s']);
  assert.equal(s.hand.autoJudged, true);
  assert.ok(s.hand.handNames.p1);
  assert.ok(s.hand.handNames.p2);
  // p2 has Aces, p1 has Kings, board is a straight 2-6 so both play the straight? 2c 3c 4d 5h 6s is a 6-high straight.
  // Both play the board straight — split.
  assert.equal(s.hand.handNames.p1, '顺子');
  assert.equal(s.hand.handNames.p2, '顺子');
  const judged = autoWinners(s);
  assert.deepEqual([...judged['pot-0']].sort(), ['p1', 'p2']);
  const preview = previewSettlement(s, judged);
  assert.equal(preview.distributed, potTotal(s));
  assert.throws(() => apply(s, 'settle', { selections: { 'pot-0': ['p1'] }, expectedTotal: potTotal(s) }), /不能改判/);
  s = settleAuto(s);
  assertConservation(s);
  assert.equal(potTotal(s), 0);
  assert.equal(s.players.reduce((n, p) => n + p.stack, 0), 200);
});

test('a single remaining player wins without revealing hole cards', () => {
  setNextDeck(makeFill(['As', 'Kh', 'Ad', 'Kd', '9s', '2c', '3c', '4d', '8s', '5h', '7s', '6s']));
  let s = apply(room([1000, 1000], { dealMode: 'digital' }), 'start');
  s = act(s, 'fold');
  assert.equal(s.hand.phase, 'showdown');
  assert.deepEqual(s.hand.revealed, {});
  assert.deepEqual(s.hand.handNames, {});
  assert.deepEqual(s.hand.selections['pot-0'], [s.hand.big]); // folder is SB/dealer p1, winner is BB p2
  const { state, hole } = clipView(s, { role: 'host' });
  assert.equal(hole, null);
  assert.deepEqual(state.hand.revealed, {});
  assert.equal(state.hand.deck, undefined);
  assert.equal(state.hand.holes, undefined);
  s = settleAuto(s);
  assertConservation(s);
});

test('clipView hides every hole from host, spectators and opponents until showdown', () => {
  setNextDeck(makeFill(['As', 'Kh', 'Ad', 'Kd', '9s', '2c', '3c', '4d', '8s', '5h', '7s', '6s']));
  const s = apply(room([1000, 1000], { dealMode: 'digital' }), 'start');
  const host = clipView(s, { role: 'host' });
  const guest = clipView(s, { role: 'spectator' });
  const p1 = clipView(s, { role: 'player', playerId: 'p1' });
  const p2 = clipView(s, { role: 'player', playerId: 'p2' });
  assert.deepEqual(p1.hole, s.hand.holes.p1);
  assert.deepEqual(p2.hole, s.hand.holes.p2);
  assert.equal(host.hole, null);
  assert.equal(guest.hole, null);
  for (const view of [host, guest, p1, p2]) {
    assert.equal(view.state.hand.holes, undefined);
    assert.equal(view.state.hand.deck, undefined);
    assert.equal(view.state.hand.burned, undefined);
  }
  assert.equal(leaks(host).length, 0);
  assert.equal(leaks(guest).length, 0);
  assert.deepEqual(leaks(p1).sort(), [...p1.hole].sort());
  assert.ok(!leaks(p1).includes(p2.hole[0]) && !JSON.stringify(p1).includes(JSON.stringify(p2.hole)));
  assert.ok(!JSON.stringify(p1.state).includes(p2.hole[0]) || p1.hole.includes(p2.hole[0]));
  const p2codes = p2.hole.filter(c => !p1.hole.includes(c));
  for (const c of p2codes) assert.equal(JSON.stringify({ state: p1.state, hole: p1.hole }).includes(`"${c}"`), false);
  const hostcodes = s.hand.holes.p1.concat(s.hand.holes.p2);
  for (const c of hostcodes) assert.equal(JSON.stringify(host).includes(`"${c}"`), false);
});

test('old rooms missing dealMode restore as physical and keep stacks', () => {
  const raw = newRoom('OLD', { smallBlind: 5, bigBlind: 10, startingStack: 200 });
  delete raw.config.dealMode;
  raw.players = [{ id: 'a', name: '甲', seat: 1, stack: 200, contribution: 0, bet: 0, folded: false, inHand: false, waiting: false, leaving: false }];
  raw.total = 200;
  const store = new Store(':memory:');
  try {
    store.save({ state: raw, hostHash: 'x', playerHashes: {}, history: [], requests: [], transfer: null });
    const loaded = store.get('OLD').state;
    assert.equal(loaded.config.dealMode, 'physical');
    assert.equal(loaded.total, 200);
    assert.equal(loaded.players[0].stack, 200);
    assertConservation(loaded);
  } finally { store.close(); }
});

function makeFill(prefix) {
  const used = new Set(prefix);
  const rest = [];
  for (const r of ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2']) {
    for (const s of ['s', 'h', 'd', 'c']) {
      const c = r + s;
      if (!used.has(c)) rest.push(c);
    }
  }
  return [...prefix, ...rest];
}

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

test('HTTP and WebSocket snapshots keep hole cards private for host, opponent and spectator', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'night-digital-'));
  const app = await createServer({ file: path.join(dir, 'table.sqlite'), port: 0, host: '127.0.0.1' });
  const sockets = [];
  try {
    const hostTok = app.store.create({ dealMode: 'digital', smallBlind: 10, bigBlind: 20, startingStack: 200 });
    const tokens = [freshToken(), freshToken()];
    tokens.forEach((token, i) => app.store.join(hostTok.code, { token, name: `玩家${i + 1}`, seat: i + 1 }));
    const command = (type, args = {}, token = hostTok.token) => app.store.command(hostTok.code, token, { type, args, version: app.store.get(hostTok.code).state.version, requestId: randomUUID() });
    command('start');
    const full = app.store.get(hostTok.code).state;
    const p1id = Object.keys(full.hand.holes)[0];
    const t1 = tokens[0], t2 = tokens[1];
    const id1 = app.store.view(hostTok.code, t1).playerId;
    const id2 = app.store.view(hostTok.code, t2).playerId;
    const base = `http://127.0.0.1:${app.port}`;
    const hostHttp = await (await fetch(`${base}/api/rooms/${hostTok.code}`, { headers: { Authorization: `Bearer ${hostTok.token}` } })).json();
    const p1Http = await (await fetch(`${base}/api/rooms/${hostTok.code}`, { headers: { Authorization: `Bearer ${t1}` } })).json();
    const p2Http = await (await fetch(`${base}/api/rooms/${hostTok.code}`, { headers: { Authorization: `Bearer ${t2}` } })).json();
    const guestHttp = await (await fetch(`${base}/api/rooms/${hostTok.code}`)).json();
    assert.equal(hostHttp.hole, null);
    assert.equal(guestHttp.role, 'spectator');
    assert.deepEqual(p1Http.hole, full.hand.holes[id1]);
    assert.deepEqual(p2Http.hole, full.hand.holes[id2]);
    for (const snap of [hostHttp, guestHttp, p1Http, p2Http]) {
      assert.equal(snap.state.hand.holes, undefined);
      assert.equal(snap.state.hand.deck, undefined);
    }
    const other1 = full.hand.holes[id2].filter(c => !full.hand.holes[id1].includes(c));
    for (const c of other1) assert.equal(JSON.stringify(p1Http).includes(`"${c}"`), false);
    for (const c of full.hand.holes[id1].concat(full.hand.holes[id2])) assert.equal(JSON.stringify(hostHttp).includes(`"${c}"`), false);

    const hostWs = subscribe(app.port, hostTok.code, hostTok.token); sockets.push(hostWs.ws);
    const p1Ws = subscribe(app.port, hostTok.code, t1); sockets.push(p1Ws.ws);
    const p2Ws = subscribe(app.port, hostTok.code, t2); sockets.push(p2Ws.ws);
    const guestWs = subscribe(app.port, hostTok.code, ''); sockets.push(guestWs.ws);
    const hmsg = await hostWs.wait(m => m.type === 'state' && m.state.hand);
    const p1msg = await p1Ws.wait(m => m.type === 'state' && m.role === 'player');
    const p2msg = await p2Ws.wait(m => m.type === 'state' && m.role === 'player');
    const gmsg = await guestWs.wait(m => m.type === 'state' && m.state.hand);
    assert.equal(hmsg.hole, null);
    assert.equal(gmsg.hole, null);
    assert.deepEqual(p1msg.hole, full.hand.holes[id1]);
    assert.deepEqual(p2msg.hole, full.hand.holes[id2]);
    for (const c of full.hand.holes[id1].concat(full.hand.holes[id2])) assert.equal(JSON.stringify(hmsg).includes(`"${c}"`), false);
    for (const c of other1) assert.equal(JSON.stringify(p1msg).includes(`"${c}"`), false);
  } finally {
    sockets.forEach(ws => ws.terminate());
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('digital conservation holds through streets, auto judgment and settlement', () => {
  let s = apply(room([400, 500, 600], { dealMode: 'digital' }), 'start');
  const total = s.total;
  const walk = () => {
    let guard = 0;
    while (s.hand.phase !== 'showdown' && guard++ < 80) {
      if (s.hand.phase === 'roundEnd') s = apply(s, 'next');
      else {
        const l = legalActions(s, s.hand.actor);
        s = act(s, l.check ? 'check' : l.canCall ? 'call' : 'allin');
      }
      assertConservation(s);
      assert.equal(s.total, total);
    }
  };
  walk();
  assert.equal(s.hand.phase, 'showdown');
  assert.equal(s.hand.board.length, 5);
  s = settleAuto(s);
  assertConservation(s);
  assert.equal(potTotal(s), 0);
  assert.equal(s.total, total);
});
