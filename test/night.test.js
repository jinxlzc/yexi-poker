import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { apply, assertConservation, clipView, legalActions, newRoom, player, pots, potTotal, levelBlinds, normalizeRoom } from '../server/engine.js';
import { summarize } from '../server/summary.js';
import { Store, freshToken } from '../server/store.js';
import { setNextDeck } from '../server/cards.js';

const join = (s, i, name = `玩家${i}`) => apply(s, 'join', { id: `p${i}`, name, seat: i });
function table(n = 3, config = {}) { let s = newRoom('TEST', { smallBlind: 10, bigBlind: 20, startingStack: 1000, rebuy: true, ...config }); for (let i = 1; i <= n; i++) s = join(s, i); return s; }
const act = (s, action, to) => apply(s, 'act', { action, to }, s.hand.actor);
const settleFirst = s => apply(s, 'settle', { selections: s.hand.autoJudged ? s.hand.selections : Object.fromEntries(pots(s).map(p => [p.id, [p.eligible[0]]])), expectedTotal: potTotal(s) });
function toShowdown(s) {
  for (let guard = 0; s.hand.phase !== 'showdown'; guard++) {
    assert.ok(guard < 200);
    if (s.hand.phase === 'roundEnd') s = apply(s, 'next');
    else { const l = legalActions(s, s.hand.actor); s = act(s, l.check ? 'check' : l.canCall ? 'call' : 'allin'); }
  }
  return s;
}
function fill(prefix) {
  const used = new Set(prefix), rest = [];
  for (const r of 'AKQJT98765432') for (const u of 'shdc') if (!used.has(r + u)) rest.push(r + u);
  return [...prefix, ...rest];
}
function balanced(s) {
  const sum = summarize(s);
  assert.equal(sum.balance.ok, true, JSON.stringify(sum.balance));
  for (const p of sum.players) assert.equal(p.consistent, true, `${p.name} per-hand nets must equal ledger net`);
  return sum;
}

test('end of night summary: buy-ins with rebuy, final stacks, nets, hands, pots won, biggest pot, VPIP, conservation', () => {
  let s = table(3);
  // 第 1 手：p1 庄，p2 小盲，p3 大盲。p1 加注到 60，p2 弃，p3 跟；翻牌后 p3 过，p1 下 100，p3 弃。p1 赢 10+60+60=130。
  s = apply(s, 'start');
  s = act(s, 'raise', 60); s = act(s, 'fold'); s = act(s, 'call');
  s = apply(s, 'next'); s = act(s, 'check'); s = act(s, 'raise', 100); s = act(s, 'fold');
  assert.equal(s.hand.phase, 'showdown');
  s = settleFirst(s);
  assert.deepEqual(s.players.map(p => p.stack), [1070, 990, 940]);
  // 补码给 p2 500
  s = apply(s, 'rebuy', { playerId: 'p2', amount: 500 });
  // 第 2 手：p2 庄，p3 小盲，p1 大盲。全员跟到摊牌，主持判 p2 赢主池。
  s = apply(s, 'start');
  s = act(s, 'call'); s = act(s, 'call'); s = act(s, 'check');
  s = toShowdown(s);
  s = apply(s, 'settle', { selections: { 'pot-0': ['p2'] }, expectedTotal: 60 });
  assert.throws(() => apply(s, 'end', {}, null) && apply(apply(s, 'start'), 'end'), /结束再调/);
  s = apply(s, 'end');
  assert.equal(s.status, 'ended');
  assert.throws(() => apply(s, 'start'), /已经结束/);
  assert.throws(() => apply(s, 'join', { id: 'x', name: '新人', seat: 6 }), /已经结束/);
  const sum = balanced(s);
  const by = Object.fromEntries(sum.players.map(p => [p.id, p]));
  assert.equal(by.p1.buyIn, 1000); assert.equal(by.p2.buyIn, 1500); assert.equal(by.p2.rebuys, 1);
  assert.equal(by.p1.final, 1050); assert.equal(by.p2.final, 1530); assert.equal(by.p3.final, 920);
  assert.deepEqual([by.p1.net, by.p2.net, by.p3.net], [50, 30, -80]);
  assert.equal(sum.players[0].id, 'p1'); assert.equal(sum.players[0].rank, 1);
  assert.equal(by.p1.hands, 2); assert.equal(by.p1.won, 1); assert.equal(by.p2.won, 1); assert.equal(by.p3.won, 0);
  assert.equal(by.p1.biggest, 130); // 10 + 60 + 60，翻牌圈未被跟注的 100 已退回
  assert.equal(by.p1.vpip, 50); assert.equal(by.p3.vpip, 100); assert.equal(by.p2.vpip, 50); // 大盲过牌、小盲弃牌都不算入池
  assert.equal(sum.room.hands, 2); assert.equal(sum.room.tracked, 2);
  assert.equal(sum.balance.buyIn, 3500); assert.equal(sum.balance.final, 3500);
  assert.equal(sum.highlights[0].kind, 'pot'); assert.equal(sum.highlights[0].value, 130);
  assert.equal(s.records.length, 2);
  assert.ok(s.records.every(r => Object.keys(r.shown).length === 0)); // 实体牌没有任何牌面
});

test('leaving early settles a personal ledger, returning keeps identity and accumulates buy-in', () => {
  let s = table(3);
  s = apply(s, 'start'); s = act(s, 'fold'); s = act(s, 'fold'); s = settleFirst(s); // p3 赢盲注
  s = apply(s, 'leave', { playerId: 'p3' });
  assert.equal(s.players.length, 2);
  assert.equal(s.roster.p3.seated, false); assert.equal(s.roster.p3.cashOut, 1010);
  let sum = balanced(s);
  const p3 = sum.players.find(p => p.id === 'p3');
  assert.equal(p3.status, 'left'); assert.equal(p3.net, 10); assert.equal(p3.final, 0); assert.equal(p3.hands, 1);
  s = apply(s, 'start'); s = act(s, 'fold'); s = settleFirst(s);
  s = apply(s, 'join', { id: 'p3', name: '玩家3', seat: 7 });
  assert.equal(s.roster.p3.buyIn, 2000); assert.equal(s.roster.p3.seated, true);
  s = apply(s, 'end');
  sum = balanced(s);
  assert.equal(sum.players.find(p => p.id === 'p3').net, 10);
  assert.throws(() => apply(table(2), 'join', { id: 'z', name: '玩家1', seat: 5 }), /已经有人/);
});

test('a departed name cannot be reused by somebody else', () => {
  const s = apply(table(3), 'leave', { playerId: 'p3' });
  assert.throws(() => apply(s, 'join', { id: 'q', name: '玩家3', seat: 8 }), /用过这个名字/);
});

test('seeded long nights: joins, leaves, rebuys, sit-outs, antes and level-ups keep table and ledger balanced', () => {
  let seed = 7;
  const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let night = 0; night < 40; night++) {
    let s = newRoom('TEST', { smallBlind: 5, bigBlind: 10, startingStack: 200 + rand(5) * 100, rebuy: true, ante: rand(3) === 0 ? 2 : 0, levelEvery: rand(2) ? 4 : 0, dealMode: rand(2) ? 'digital' : 'physical' });
    let next = 1;
    for (let i = 0; i < 2 + rand(5); i++) { s = apply(s, 'join', { id: `n${next}`, name: `人${next}`, seat: next }); next++; }
    for (let hand = 0; hand < 25; hand++) {
      const roll = rand(10);
      if (roll === 0 && s.players.length < 10 && next <= 10) { s = apply(s, 'join', { id: `n${next}`, name: `人${next}`, seat: next }); next++; }
      if (roll === 1 && s.players.length > 2) s = apply(s, 'leave', { playerId: s.players[rand(s.players.length)].id });
      if (roll === 2) { const p = s.players[rand(s.players.length)]; s = apply(s, 'sitOut', { playerId: p.id, away: !p.sittingOut }); }
      for (const p of s.players) if (p.stack === 0 && rand(2)) s = apply(s, 'rebuy', { playerId: p.id, amount: 100 + rand(3) * 100 });
      if (s.players.filter(p => p.stack > 0 && !p.sittingOut).length < 2) { for (const p of s.players) if (p.sittingOut) s = apply(s, 'sitOut', { playerId: p.id, away: false }); }
      if (s.players.filter(p => p.stack > 0 && !p.sittingOut).length < 2) break;
      s = apply(s, 'start');
      for (let guard = 0; s.hand.phase !== 'showdown'; guard++) {
        assert.ok(guard < 300);
        if (s.hand.phase === 'roundEnd') { s = apply(s, 'next'); continue; }
        const l = legalActions(s, s.hand.actor), r = rand(10);
        if (r === 0) s = act(s, 'fold');
        else if (r === 1 && l.raise) s = act(s, 'raise', l.minRaiseTo + rand(Math.max(1, l.maxRaiseTo - l.minRaiseTo)));
        else if (r === 2 && l.allIn) s = act(s, 'allin');
        else s = act(s, l.check ? 'check' : l.canCall ? 'call' : 'allin');
        assertConservation(s);
      }
      if (s.hand.autoJudged) s = settleFirst(s);
      else { const sel = Object.fromEntries(pots(s).map(p => [p.id, p.eligible.filter((_, i) => i === 0 || rand(4) === 0)])); s = apply(s, 'settle', { selections: sel, expectedTotal: potTotal(s) }); }
      balanced(s);
    }
    s = apply(s, 'end');
    const sum = balanced(s);
    assert.equal(sum.room.tracked, s.records.length);
    assert.equal(sum.players.reduce((n, p) => n + p.net, 0), 0, 'nets of a closed night sum to zero');
  }
});

test('antes are dead money in contribution; a short ante is an all-in that caps eligibility', () => {
  let s = newRoom('TEST', { smallBlind: 10, bigBlind: 20, startingStack: 1000, ante: 5, rebuy: true });
  for (let i = 1; i <= 3; i++) s = join(s, i);
  player(s, 'p1').stack = 3; s.total -= 997; s.roster.p1.buyIn = 3;
  s = apply(s, 'start');
  assert.equal(player(s, 'p1').stack, 0); assert.equal(player(s, 'p1').contribution, 3);
  assert.equal(player(s, 'p2').contribution, 15); assert.equal(player(s, 'p2').bet, 10);
  assert.equal(player(s, 'p3').contribution, 25); assert.equal(s.hand.currentBet, 20);
  assert.ok(s.logs.some(e => e.text.includes('前注全下')));
  s = toShowdown(s);
  const [main] = pots(s);
  assert.equal(main.amount, 9); assert.deepEqual(main.eligible.sort(), ['p1', 'p2', 'p3']);
  s = apply(s, 'settle', { selections: Object.fromEntries(pots(s).map(p => [p.id, p.eligible.includes('p1') ? ['p1'] : [p.eligible[0]]])), expectedTotal: potTotal(s) });
  assert.equal(player(s, 'p1').stack, 9); assertConservation(s);
});

test('blind levels go up every N hands and can be set by host between hands', () => {
  let s = table(2, { levelEvery: 3, ante: 0 });
  const play = () => { s = apply(s, 'start'); s = act(s, 'fold'); s = settleFirst(s); };
  for (let i = 0; i < 3; i++) play();
  assert.equal(s.level, 0);
  play();
  assert.equal(s.level, 1); assert.equal(s.hand.bigBlind, 40); assert.deepEqual(levelBlinds(s), { level: 1, small: 20, big: 40, ante: 0, multiplier: 2 });
  assert.ok(s.logs.some(e => e.kind === 'level' && e.text.includes('20/40')));
  s = apply(s, 'level', { delta: -1 });
  play(); assert.equal(s.hand.bigBlind, 20);
  s = apply(s, 'settings', { actionClock: 30, ante: 5 });
  assert.equal(s.config.actionClock, 30); assert.equal(s.config.ante, 5);
  assert.throws(() => apply(s, 'settings', { actionClock: 31 }), /行动计时/);
});

test('digital river showdown shows winners only, losers may show; nothing leaks before', () => {
  // HU: p2 大盲先拿第一张。p2: As Ad；p1: Kh Kd。公共牌 2c 7d 9h Js 3s → p2 赢。
  setNextDeck(fill(['As', 'Kh', 'Ad', 'Kd', '4c', '2c', '7d', '9h', '5c', 'Js', '6c', '3s']));
  let s = apply(table(2, { dealMode: 'digital' }), 'start');
  s = act(s, 'call'); s = act(s, 'check');
  for (let i = 0; i < 3; i++) { s = apply(s, 'next'); s = act(s, 'check'); s = act(s, 'check'); }
  assert.equal(s.hand.phase, 'showdown');
  assert.deepEqual(Object.keys(s.hand.revealed), ['p2']);
  assert.deepEqual(s.hand.mucked, ['p1']);
  assert.ok(!JSON.stringify(s.logs).includes('Kh'));
  assert.ok(!s.logs.at(-1).text.includes('一对 K') && s.logs.at(-1).text.includes('1 人盖牌'));
  const hostView = clipView(s, { role: 'host' });
  assert.ok(!JSON.stringify(hostView).includes('"Kh"'));
  assert.equal(hostView.state.hand.handNames.p1, undefined);
  s = settleFirst(s);
  assert.deepEqual(Object.keys(s.records[0].shown), ['p2']);
  assert.throws(() => apply(s, 'show', {}, 'p2'), /亮过/);
  s = apply(s, 'show', {}, 'p1');
  assert.deepEqual(s.records[0].shown.p1, ['Kh', 'Kd']);
  assert.ok(JSON.stringify(clipView(s, { role: 'spectator' })).includes('"Kh"'));
  s = apply(s, 'start');
  assert.deepEqual(clipView(s, { role: 'spectator' }).state.hand.revealed, {});
});

test('folded hand may be shown voluntarily after the hand; physical mode cannot', () => {
  setNextDeck(fill(['As', 'Kh', 'Ad', 'Kd']));
  let s = apply(table(2, { dealMode: 'digital' }), 'start');
  assert.throws(() => apply(s, 'show', {}, 'p1'), /结束后/);
  s = act(s, 'fold'); s = settleFirst(s);
  s = apply(s, 'show', {}, 'p2');
  assert.deepEqual(clipView(s, {}).state.hand.revealed.p2, ['As', 'Ad']);
  assert.equal(clipView(s, {}).state.hand.handNames.p2, undefined);
  let t = apply(table(2), 'start'); t = act(t, 'fold'); t = settleFirst(t);
  assert.throws(() => apply(t, 'show', {}, 'p1'), /实体牌/);
});

test('pause blocks action and freezes the clock; timeout needs an expired clock or an offline actor', () => {
  let s = table(3, { actionClock: 30 });
  s = apply(s, 'start');
  assert.throws(() => apply(s, 'timeout', {}), /还没超时/);
  s = apply(s, 'pause', { on: true });
  assert.throws(() => act(s, 'call'), /休息/);
  s.paused.at = new Date(Date.now() - 60_000).toISOString();
  const since = Date.parse(s.hand.actorSince);
  s = apply(s, 'pause', { on: false });
  assert.ok(Date.parse(s.hand.actorSince) - since >= 59_000);
  s.hand.actorSince = new Date(Date.now() - 31_000).toISOString();
  const who = s.hand.actor;
  s = apply(s, 'timeout', {});
  assert.equal(player(s, who).folded, true);
  assert.ok(s.logs.at(-1).text.includes('主持代（超时）'));
  const big = s.hand.actor; // 下一位
  s = apply(s, 'timeout', { actorOffline: true });
  assert.ok(player(s, big).folded || s.logs.at(-1).text.includes('过牌'));
});

test('sit out skips the next hands without blinds; coming back joins the next hand', () => {
  let s = table(3);
  s = apply(s, 'sitOut', { playerId: 'p2', away: true });
  s = apply(s, 'start');
  assert.deepEqual(s.hand.participants, ['p1', 'p3']);
  assert.equal(player(s, 'p2').contribution, 0);
  s = act(s, 'fold'); s = settleFirst(s);
  s = apply(s, 'sitOut', { playerId: 'p2', away: false });
  s = apply(s, 'start');
  assert.ok(s.hand.participants.includes('p2'));
});

test('seat change swaps or moves only between hands', () => {
  let s = table(3);
  s = apply(s, 'seat', { playerId: 'p1', seat: 3 });
  assert.deepEqual([player(s, 'p1').seat, player(s, 'p3').seat], [3, 1]);
  s = apply(s, 'seat', { playerId: 'p2', seat: 8 });
  assert.equal(player(s, 'p2').seat, 8);
  s = apply(s, 'start');
  assert.throws(() => apply(s, 'seat', { playerId: 'p2', seat: 9 }), /结束再调/);
});

test('legacy rooms without ledger restore: ledger is rebuilt from logs and stats start after upgrade', () => {
  const old = {
    code: 'OLD1', config: { name: '旧桌', smallBlind: 10, bigBlind: 20, startingStack: 1000, rebuy: true }, version: 9, total: 2300, handNumber: 3, dealerSeat: 1, balanceNote: '',
    players: [{ id: 'a', name: '阿宁', seat: 1, stack: 1600, contribution: 0, bet: 0, folded: false, inHand: true, waiting: false, leaving: false },
      { id: 'b', name: '林川', seat: 2, stack: 700, contribution: 0, bet: 0, folded: false, inHand: true, waiting: false, leaving: false }],
    hand: { number: 3, phase: 'settled', street: 1, participants: ['a', 'b'], pending: [], actor: null, currentBet: 0, lastFullRaise: 20 },
    logs: [
      { id: '1-0', at: '2026-11-14T12:00:00.000Z', hand: 0, text: '阿宁坐到 1 号位 · 起始 1000', kind: 'join' },
      { id: '2-1', at: '2026-11-14T12:00:10.000Z', hand: 0, text: '林川坐到 2 号位 · 起始 1000', kind: 'join' },
      { id: '3-2', at: '2026-11-14T12:00:20.000Z', hand: 0, text: '小满坐到 3 号位 · 起始 1000', kind: 'join' },
      { id: '4-3', at: '2026-11-14T12:01:00.000Z', hand: 1, text: '开新一手 · 庄 阿宁', kind: 'start' },
      { id: '5-4', at: '2026-11-14T12:20:00.000Z', hand: 2, text: '小满离开，带走 1200', kind: 'leave' },
      { id: '6-5', at: '2026-11-14T12:30:00.000Z', hand: 2, text: '补码 · 林川 +500', kind: 'rebuy' }
    ]
  };
  const s = normalizeRoom(structuredClone(old));
  assert.equal(s.legacy, true); assert.equal(s.statsFrom, 4); assert.equal(s.status, 'open');
  assert.equal(s.roster.b.buyIn, 1500);
  const gone = Object.values(s.roster).find(r => r.name === '小满');
  assert.equal(gone.cashOut, 1200); assert.equal(gone.seated, false);
  assertConservation(s);
  let t = apply(s, 'start'); t = act(t, 'fold'); t = settleFirst(t); t = apply(t, 'end');
  const sum = summarize(t);
  assert.equal(sum.balance.ok, true);
  assert.equal(sum.room.legacy, true); assert.equal(sum.room.tracked, 1);
  assert.equal(sum.players.reduce((n, p) => n + p.net, 0), 0);
  assert.equal(sum.players.find(p => p.name === '小满').net, 200);
  assert.equal(Math.abs(sum.players.find(p => p.name === '阿宁').net - 600), 10);
});

function fixture(store, n = 3) {
  const host = store.create({ smallBlind: 10, bigBlind: 20, startingStack: 1000, rebuy: true });
  const tokens = Array.from({ length: n }, () => freshToken());
  tokens.forEach((token, i) => store.join(host.code, { token, name: `玩家${i + 1}`, seat: i + 1 }));
  const command = (type, args = {}, token = host.token, context) => store.command(host.code, token, { type, args, version: store.get(host.code).state.version, requestId: randomUUID() }, context);
  return { ...host, tokens, command, state: () => store.get(host.code).state, id: i => store.view(host.code, tokens[i]).playerId };
}

test('store: player leaving becomes departed with personal summary; same phone can come back', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store), id = f.id(2);
    f.command('leave', {}, f.tokens[2]);
    const v = store.view(f.code, f.tokens[2]);
    assert.equal(v.role, 'departed'); assert.equal(v.playerId, id);
    assert.equal(v.summary.players.find(p => p.id === id).status, 'left');
    assert.throws(() => f.command('act', { action: 'call' }, f.tokens[2]), /自己的座位/);
    store.join(f.code, { token: f.tokens[2], name: '玩家3', seat: 9 });
    assert.equal(store.view(f.code, f.tokens[2]).role, 'player');
    assert.equal(store.view(f.code, f.tokens[2]).playerId, id);
    assert.equal(f.state().roster[id].buyIn, 2000);
  } finally { store.close(); }
});

test('store: end of night is host-only, between hands, shows summary to every phone, and undo reopens', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store);
    assert.throws(() => f.command('end', {}, f.tokens[0]), /主持权限/);
    f.command('start');
    assert.throws(() => f.command('end'), /结束再调/);
    f.command('act', { action: 'fold' }, f.tokens[0]); f.command('act', { action: 'fold' }, f.tokens[1]);
    const v0 = store.view(f.code, f.token);
    f.command('settle', { selections: Object.fromEntries(v0.pots.map(p => [p.id, p.eligible])), expectedTotal: v0.pots.reduce((a, p) => a + p.amount, 0) });
    f.command('end');
    for (const token of [f.token, ...f.tokens, '']) {
      const v = store.view(f.code, token);
      assert.equal(v.state.status, 'ended'); assert.equal(v.summary.balance.ok, true); assert.equal(v.summary.room.hands, 1);
    }
    assert.throws(() => f.command('start'), /已经结束/);
    assert.throws(() => store.join(f.code, { token: freshToken(), name: '迟到', seat: 8 }), /已经结束/);
    const again = store.rematch(f.code, f.token);
    assert.equal(f.state().nextRoom, again.code);
    assert.deepEqual({ ...store.get(again.code).state.config }, { ...f.state().config });
    assert.throws(() => store.rematch(f.code, f.token), /开过/);
    f.command('undo');
    assert.equal(f.state().status, 'open');
  } finally { store.close(); }
});

test('store: lost credential claim needs host approval, then the old phone is revoked', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store), id = f.id(0), fresh = freshToken();
    assert.throws(() => store.claim(f.code, { token: f.tokens[1], playerId: id }), /已经有座位/);
    store.claim(f.code, { token: fresh, playerId: id });
    assert.equal(store.view(f.code, fresh).claim.status, 'pending');
    assert.equal(store.view(f.code, fresh).role, 'spectator');
    const hostView = store.view(f.code, f.token);
    assert.equal(hostView.claims.length, 1); assert.equal(hostView.claims[0].name, '玩家1');
    assert.ok(!JSON.stringify(hostView.claims).includes(fresh));
    assert.throws(() => store.decideClaim(f.code, f.tokens[1], { claimId: hostView.claims[0].id, approve: true }), /主持权限/);
    store.decideClaim(f.code, f.token, { claimId: hostView.claims[0].id, approve: true });
    assert.equal(store.view(f.code, fresh).role, 'player');
    assert.equal(store.view(f.code, fresh).playerId, id);
    assert.equal(store.view(f.code, f.tokens[0]).role, 'spectator');
    assert.ok(f.state().logs.at(-1).text.includes('换了手机'));
    const other = freshToken();
    store.claim(f.code, { token: other, playerId: f.id(1) });
    store.decideClaim(f.code, f.token, { claimId: store.view(f.code, f.token).claims[0].id, approve: false });
    assert.equal(store.view(f.code, other).claim.status, 'denied');
    assert.equal(store.view(f.code, f.tokens[1]).role, 'player');
  } finally { store.close(); }
});

test('store: rebuy request is approved by host through the logged rebuy rule', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store), id = f.id(1);
    store.ask(f.code, f.tokens[1]);
    assert.throws(() => store.ask(f.code, f.tokens[1]), /申请过/);
    const ask = store.view(f.code, f.token).asks[0];
    assert.equal(ask.name, '玩家2');
    store.decideAsk(f.code, f.token, { askId: ask.id, approve: true, amount: 300 });
    assert.equal(f.state().players.find(p => p.id === id).stack, 1300);
    assert.equal(f.state().roster[id].buyIn, 1300);
    assert.equal(store.view(f.code, f.token).asks.length, 0);
  } finally { store.close(); }
});

test('store: undo history is compacted (no logs/records copies) and still restores exactly', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 2);
    const states = [];
    for (let i = 0; i < 3; i++) {
      states.push(f.state()); f.command('start');
      states.push(f.state()); f.command('act', { action: 'fold' }, f.state().hand.actor === f.id(0) ? f.tokens[0] : f.tokens[1]);
      states.push(f.state());
      const v = store.view(f.code, f.token);
      f.command('settle', { selections: Object.fromEntries(v.pots.map(p => [p.id, p.eligible])), expectedTotal: v.pots.reduce((a, p) => a + p.amount, 0) });
    }
    const raw = store.get(f.code);
    assert.ok(raw.history.every(h => !h.state.logs && !h.state.records));
    for (const expected of states.reverse()) { f.command('undo'); const actual = f.state(); assert.deepEqual({ ...actual, version: expected.version }, expected); }
  } finally { store.close(); }
});

test('store: broadcast view trims logs and records, full logs and hands are separate', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 2);
    for (let i = 0; i < 3; i++) {
      f.command('start'); f.command('act', { action: 'fold' }, f.state().hand.actor === f.id(0) ? f.tokens[0] : f.tokens[1]);
      const v = store.view(f.code, f.token); f.command('settle', { selections: Object.fromEntries(v.pots.map(p => [p.id, p.eligible])), expectedTotal: v.pots.reduce((a, p) => a + p.amount, 0) });
    }
    const v = store.view(f.code, '');
    assert.equal(v.state.records, undefined); assert.equal(v.state.recordCount, 3);
    assert.ok(v.state.logs.every(e => e.hand === 3)); assert.equal(v.state.logCount, f.state().logs.length);
    assert.equal(store.logs(f.code).length, f.state().logs.length);
    assert.equal(store.hands(f.code).records.length, 3);
  } finally { store.close(); }
});

test('paused table: nobody has legal actions until the host resumes', () => {
  let s = apply(table(3), 'start');
  const actor = s.hand.actor;
  assert.ok(legalActions(s, actor));
  s = apply(s, 'pause', { on: true });
  assert.equal(legalActions(s, actor), null);
  assert.throws(() => act(s, 'call'));
  s = apply(s, 'pause', { on: false });
  assert.ok(legalActions(s, actor));
});
