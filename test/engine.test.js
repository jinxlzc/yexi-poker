import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, assertConservation, legalActions, newRoom, player, pots, potTotal, previewSettlement } from '../server/engine.js';

function room(stacks = [1000, 1000, 1000], config = {}) {
  let s = newRoom('TEST', { runouts: 1, ...config });
  stacks.forEach((_, i) => { s = apply(s, 'join', { id: `p${i + 1}`, name: `玩家${i + 1}`, seat: i + 1 }); });
  stacks.forEach((stack, i) => { player(s, `p${i + 1}`).stack = stack; });
  s.total = stacks.reduce((a, b) => a + b, 0);
  return s;
}
const act = (s, action, to) => apply(s, 'act', { action, to }, s.hand.actor);
const choose = s => Object.fromEntries(pots(s).map(p => [p.id, [p.eligible[0]]]));
function settle(s, selections = choose(s)) { return apply(s, 'settle', { selections, expectedTotal: potTotal(s) }); }
function checkToShowdown(s) {
  let guard = 0;
  while (s.hand.phase !== 'showdown' && guard++ < 100) {
    if (s.hand.phase === 'roundEnd') s = apply(s, 'next');
    else { const l = legalActions(s, s.hand.actor); s = act(s, l.check ? 'check' : l.canCall ? 'call' : 'allin'); }
  }
  assert.ok(guard < 100); return s;
}

test('2–10 seats, integer configuration, name and occupied seat validation', () => {
  assert.throws(() => newRoom('TEST', { smallBlind: 20, bigBlind: 10 }));
  assert.throws(() => newRoom('TEST', { startingStack: 1 }));
  assert.throws(() => newRoom('TEST', { bigBlind: 2.1 }));
  let s = room([100]);
  assert.throws(() => apply(s, 'start'), /至少两位/);
  assert.throws(() => apply(s, 'join', { id: 'x', name: '玩家1', seat: 2 }), /已经有人/);
  assert.throws(() => apply(s, 'join', { id: 'x', name: '另一个', seat: 1 }), /座位已经/);
  s = room(Array(10).fill(100));
  assert.throws(() => apply(s, 'join', { id: 'x', name: '第十一人', seat: 1 }), /坐满/);
});
test('three players: blinds, preflop actor, rotation and manual street advance', () => {
  let s = apply(room(), 'start');
  assert.deepEqual([s.hand.dealer, s.hand.small, s.hand.big, s.hand.actor], ['p1', 'p2', 'p3', 'p1']);
  assert.equal(potTotal(s), 30);
  s = act(s, 'call'); s = act(s, 'call'); s = act(s, 'check');
  assert.equal(s.hand.phase, 'roundEnd'); assert.equal(s.hand.street, 0); assert.equal(s.hand.actor, null);
  assert.throws(() => act(s, 'check'));
  s = apply(s, 'next'); assert.equal(s.hand.street, 1); assert.equal(s.hand.actor, 'p2');
  assert.ok(s.players.every(p => p.bet === 0)); assert.equal(potTotal(s), 60);
  s = settle(checkToShowdown(s)); s = apply(s, 'start');
  assert.deepEqual([s.hand.dealer, s.hand.small, s.hand.big, s.hand.actor], ['p2', 'p3', 'p1', 'p2']);
});
test('heads-up: dealer posts small blind, acts first preflop and last postflop', () => {
  let s = apply(room([1000, 1000]), 'start');
  assert.deepEqual([s.hand.dealer, s.hand.small, s.hand.big, s.hand.actor], ['p1', 'p1', 'p2', 'p1']);
  s = act(s, 'call'); s = act(s, 'check'); s = apply(s, 'next');
  assert.equal(s.hand.actor, 'p2');
  s = settle(checkToShowdown(s)); s = apply(s, 'start');
  assert.deepEqual([s.hand.dealer, s.hand.small, s.hand.big, s.hand.actor], ['p2', 'p2', 'p1', 'p2']);
});
test('zero stacks and departed seats skipped, three players transition to heads-up', () => {
  let s = room([100, 0, 100, 100]);
  s = apply(s, 'leave', { playerId: 'p4' });
  s = apply(s, 'start');
  assert.deepEqual([s.hand.small, s.hand.big, s.hand.actor], ['p1', 'p3', 'p1']);
  assert.equal(player(s, 'p2').bet, 0); assert.equal(player(s, 'p2').inHand, false);
  s = settle(checkToShowdown(s)); s = apply(s, 'start'); assert.equal(s.hand.dealer, 'p3');
});
test('minimum raise uses last full increment, excluding the call portion', () => {
  let s = apply(room(), 'start');
  assert.equal(legalActions(s, 'p1').minRaiseTo, 40);
  assert.throws(() => act(s, 'raise', 39), /最小加注到 40/);
  s = act(s, 'raise', 100);
  assert.equal(s.hand.lastFullRaise, 80);
  assert.equal(legalActions(s, 'p2').minRaiseTo, 180);
  assert.throws(() => act(s, 'raise', 179), /最小加注到 180/);
  assert.throws(() => act(s, 'raise', 180.5), /整数/);
  assert.throws(() => act(s, 'raise', 1001), /超过/);
  s = act(s, 'raise', 180); assert.equal(s.hand.lastFullRaise, 80); assertConservation(s);
});
test('short all-in requires a call but does not reopen raising; a later full raise reopens', () => {
  let s = apply(room([1000, 1000, 150, 1000]), 'start');
  s = act(s, 'raise', 100); // p4
  s = act(s, 'call'); // p1 closes
  s = act(s, 'call'); // p2 closes
  s = act(s, 'allin'); // p3 adds only 50
  assert.equal(s.hand.phase, 'betting'); assert.equal(s.hand.actor, 'p4');
  assert.equal(player(s, 'p1').contribution, 100);
  assert.equal(player(s, 'p3').stack, 0); // 其他人还需补跟，不能提前退款
  assert.equal(legalActions(s, 'p4').raise, false);
  assert.ok(s.logs.some(e => e.text.includes('短码')));
  s = act(s, 'call'); s = act(s, 'call'); s = act(s, 'call');
  assert.equal(s.hand.phase, 'roundEnd'); assert.equal(potTotal(s), 600);

  s = apply(room([1000, 1000, 1000, 150, 1000]), 'start');
  s = act(s, 'allin'); // p4 raises 130, a full raise to 150
  s = act(s, 'raise', 300); // p5 full raise
  assert.equal(s.hand.actor, 'p1');

  s = apply(room([150, 1000, 1000, 1000]), 'start');
  s = act(s, 'raise', 100); // p4 closes
  s = act(s, 'allin'); // p1 short 150
  assert.deepEqual(s.hand.pending.sort(), ['p2', 'p3', 'p4']);
  assert.equal(s.hand.lastFullRaise, 80);
  assert.equal(legalActions(s, 'p2').minRaiseTo, 230);
  s = act(s, 'raise', 230); // complete 80 reopens p4
  assert.ok(s.hand.pending.includes('p4'));
  s = act(s, 'call'); assert.equal(s.hand.actor, 'p4'); assertConservation(s);
});
test('multiple short all-ins cumulatively reopen when the caller faces a full increment', () => {
  let s = apply(room([150, 190, 1000, 1000]), 'start');
  s = act(s, 'raise', 100); s = act(s, 'allin'); s = act(s, 'allin');
  assert.equal(s.hand.actor, 'p3'); assert.equal(s.hand.lastFullRaise, 80);
  assert.ok(s.hand.pending.includes('p4'));
  assert.equal(legalActions(s, 'p3').minRaiseTo, 270);
  s = act(s, 'call'); assert.equal(s.hand.actor, 'p4');
  assert.equal(legalActions(s, 'p4').raise, true);
  s = act(s, 'call'); assert.equal(s.hand.phase, 'roundEnd');
  assert.equal(player(s, 'p4').contribution, 190);
});
test('all-in below call, exact-call all-in, short blinds, and no empty side betting', () => {
  let s = apply(room([5, 100]), 'start');
  assert.equal(s.hand.phase, 'showdown'); assert.equal(potTotal(s), 10);
  assert.equal(player(s, 'p1').stack, 0); assert.equal(player(s, 'p2').stack, 95);
  assert.throws(() => apply(s, 'next'));
  s = apply(room([100, 10]), 'start');
  assert.equal(s.hand.actor, null); assert.equal(s.hand.phase, 'showdown'); assert.equal(potTotal(s), 20);
  s = apply(room([20, 100]), 'start');
  assert.equal(legalActions(s, 'p1').canCall, false);
  assert.throws(() => act(s, 'call'), /全下/);
  s = act(s, 'allin'); assert.equal(s.hand.phase, 'showdown');
});
test('side pots eligibility with 3 stack levels, folded dead money and merged layers', () => {
  let s = apply(room([100, 200, 300]), 'start');
  s = act(s, 'allin'); s = act(s, 'allin'); s = act(s, 'allin');
  assert.equal(s.hand.phase, 'showdown');
  assert.deepEqual(pots(s).map(p => [p.amount, p.eligible]), [[300, ['p1', 'p2', 'p3']], [200, ['p2', 'p3']]]);
  assert.equal(player(s, 'p3').stack, 100);
  assert.throws(() => previewSettlement(s, { 'pot-0': ['p1'], 'pot-1': ['p1'] }), /资格/);
  assert.throws(() => previewSettlement(s, { 'pot-0': ['p1'] }), /每个池/);
  s = settle(s, { 'pot-0': ['p1'], 'pot-1': ['p2'] });
  assert.deepEqual(s.players.map(p => p.stack), [300, 200, 100]); assertConservation(s);

  s = apply(room(), 'start'); s = act(s, 'raise', 100); s = act(s, 'fold'); s = act(s, 'call');
  assert.deepEqual(pots(s).map(p => [p.amount, p.eligible]), [[210, ['p1', 'p3']]]);
  s = checkToShowdown(s);
  assert.throws(() => previewSettlement(s, { 'pot-0': ['p2'] }), /资格/);
});
test('odd chip split clockwise from dealer left, only among selected eligible winners', () => {
  let s = apply(room([100, 100, 100], { smallBlind: 1, bigBlind: 2 }), 'start');
  s = act(s, 'call'); s = act(s, 'fold'); s = act(s, 'check'); s = checkToShowdown(s);
  assert.equal(potTotal(s), 5);
  const selection = { 'pot-0': ['p1', 'p3'] }, preview = previewSettlement(s, selection);
  assert.deepEqual(preview.awards, { p1: 2, p2: 0, p3: 3 });
  assert.deepEqual(preview.details[0].oddRecipients, ['p3']);
  assert.throws(() => apply(s, 'settle', { selections: selection, expectedTotal: 6 }), /预览/);
  assert.throws(() => previewSettlement({ ...s, total: 301 }, selection), /对不上/);
  s = settle(s, selection); assert.equal(s.total, 300); assert.equal(potTotal(s), 0);
});
test('a single survivor still requires host settlement; matched dead money stays in pot', () => {
  let s = apply(room(), 'start'); s = act(s, 'fold'); s = act(s, 'fold');
  assert.equal(s.hand.phase, 'showdown'); assert.equal(potTotal(s), 20);
  assert.deepEqual(pots(s)[0].eligible, ['p3']);
  assert.throws(() => apply(s, 'start'), /结束再调/);
  s = settle(s); assert.equal(player(s, 'p3').stack, 1010); assertConservation(s);
});
test('late join waits for next hand without changing current participants or actor', () => {
  let s = apply(room([1000, 1000]), 'start');
  const participants = [...s.hand.participants], actor = s.hand.actor;
  s = apply(s, 'join', { id: 'new', name: '新同桌', seat: 5 });
  assert.deepEqual(s.hand.participants, participants); assert.equal(s.hand.actor, actor);
  assert.equal(player(s, 'new').waiting, true); assert.equal(player(s, 'new').contribution, 0);
  assert.ok(pots(s).every(p => !p.eligible.includes('new')));
  s = settle(checkToShowdown(s)); s = apply(s, 'start'); assert.equal(player(s, 'new').inHand, true);
});
test('rebuy, seat movement and deferred leaving preserve accounting and only occur between hands', () => {
  let s = room();
  assert.throws(() => apply(s, 'rebuy', { playerId: 'p1', amount: 100 }), /关着/);
  s = apply(s, 'rebuySetting', { enabled: true });
  assert.throws(() => apply(s, 'rebuy', { playerId: 'p1', amount: -1 }), /整数/);
  s = apply(s, 'rebuy', { playerId: 'p1', amount: 100 }); assert.equal(s.total, 3100);
  s = apply(s, 'move', { playerId: 'p1', direction: 1 }); assert.equal(player(s, 'p2').seat, 1);
  s = apply(s, 'start');
  assert.throws(() => apply(s, 'move', { playerId: 'p1', direction: 1 }), /结束再调/);
  assert.throws(() => apply(s, 'rebuy', { playerId: 'p1', amount: 100 }), /结束再调/);
  assert.throws(() => apply(s, 'leave', { playerId: 'p1' }), /结束再调/);
  const actor = s.hand.actor; s = apply(s, 'leave', {}, 'p1'); assert.equal(s.hand.actor, actor); assert.ok(player(s, 'p1'));
  s = settle(checkToShowdown(s)); const remaining = player(s, 'p1').stack;
  s = apply(s, 'start'); assert.equal(player(s, 'p1'), undefined); assert.equal(s.total, 3100 - remaining); assertConservation(s);
});
test('wrong actor, illegal check, malformed raise and repeated out-of-turn action leave original state untouched', () => {
  const s = apply(room(), 'start'), copy = structuredClone(s);
  assert.throws(() => apply(s, 'act', { action: 'call' }, 'p2'));
  assert.throws(() => act(s, 'check'), /不能过牌/);
  assert.throws(() => act(s, 'raise', NaN)); assert.throws(() => act(s, 'raise', '100'));
  assert.deepEqual(s, copy);
});
test('legacy folded high tier after a short all-in becomes dead money in the nearest eligible pot', () => {
  let s = apply(room([661, 72, 963, 566, 957, 30], { smallBlind: 1, bigBlind: 2 }), 'start');
  s = act(s, 'allin'); // p4 566
  s = act(s, 'call'); // p5 closes at 566
  s = act(s, 'allin'); // p6 30
  s = act(s, 'allin'); // p1 short 661
  s = act(s, 'fold'); s = act(s, 'call'); // p3 661, p5 remains closed
  // 旧版快照已跳过 p5 的补跟；保留该兼容性场景，新开手不再产生这种状态。
  s.hand.pending = []; s.hand.actor = null; s.hand.phase = 'roundEnd';
  s = apply(s, 'next'); s = act(s, 'raise', 2); s = act(s, 'call');
  s = apply(s, 'next'); s = act(s, 'fold'); // p3 has the only 663 tier but has folded
  assert.equal(s.hand.phase, 'showdown');
  assert.ok(pots(s).every(p => p.eligible.length > 0 && !p.eligible.includes('p3')));
  const highest = pots(s).at(-1);
  assert.deepEqual(highest.eligible, ['p1']); assert.equal(highest.amount, 188);
  s = settle(s); assertConservation(s); assert.equal(potTotal(s), 0);
});
test('seeded legal sequences: conservation after every action and every split across 2–10 players', () => {
  let seed = 0xA11CE;
  const rng = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let run = 0; run < 400; run++) {
    const count = 2 + run % 9;
    let s = apply(room(Array.from({ length: count }, () => 1 + Math.floor(rng() * 1000)), { smallBlind: 1, bigBlind: 2 }), 'start');
    const total = s.total;
    let step = 0;
    while (s.hand.phase !== 'showdown' && step++ < 300) {
      if (s.hand.phase === 'roundEnd') s = apply(s, 'next');
      else {
        const l = legalActions(s, s.hand.actor), choices = ['fold'];
        if (l.check) choices.push('check', 'check');
        if (l.canCall) choices.push('call', 'call');
        if (l.raise) choices.push('raise');
        if (l.allIn) choices.push('allin');
        const action = choices[Math.floor(rng() * choices.length)];
        s = act(s, action, l.minRaiseTo);
      }
      assertConservation(s); assert.equal(s.total, total);
    }
    assert.ok(step < 300, `run ${run} terminated`);
    assert.ok(pots(s).every(p => p.eligible.length), `run ${run}: every pot has eligible players: ${JSON.stringify(s)}`);
    const selection = Object.fromEntries(pots(s).map(p => [p.id, p.eligible.filter(() => rng() > .5).length ? p.eligible : [p.eligible[0]]]));
    s = settle(s, selection); assertConservation(s); assert.equal(potTotal(s), 0); assert.equal(s.total, total);
  }
});
