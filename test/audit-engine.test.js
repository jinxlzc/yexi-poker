import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, assertConservation, legalActions, newRoom, normalizeRoom, player, pots, potTotal } from '../server/engine.js';
import { makeDeck, setNextDeck } from '../server/cards.js';
import { summarize } from '../server/summary.js';

function table(stacks, config = {}) {
  let s = newRoom('TEST', { startingStack: 1000, ...config });
  for (const [i, stack] of stacks.entries()) {
    const id = `p${i + 1}`;
    s = apply(s, 'join', { id, name: `玩家${i + 1}`, seat: i + 1 });
    s.total += stack - 1000; player(s, id).stack = stack; s.roster[id].buyIn = stack;
  }
  return s;
}
const act = (s, action, to) => apply(s, 'act', { action, to }, s.hand.actor);
function finish(s) {
  for (let guard = 0; s.hand.phase !== 'showdown'; guard++) {
    assert.ok(guard < 150);
    if (s.hand.phase === 'roundEnd') s = apply(s, 'next');
    else { const l = legalActions(s, s.hand.actor); s = act(s, l.check ? 'check' : l.canCall ? 'call' : 'allin'); }
  }
  return s;
}
const settle = s => apply(s, 'settle', { selections: s.hand.selections || Object.fromEntries(pots(s).map(p => [p.id, [p.eligible[0]]])), expectedTotal: potTotal(s) });
const deck = prefix => setNextDeck([...prefix, ...makeDeck().filter(c => !prefix.includes(c))]);

test('audit: short raise requires prior callers to match, without restoring raise or all-in raise rights', () => {
  let s = apply(table([1000, 1000, 150, 1000]), 'start');
  s = act(s, 'raise', 100); s = act(s, 'call'); s = act(s, 'call'); s = act(s, 'allin');
  assert.equal(s.hand.actor, 'p4');
  for (const id of ['p4', 'p1', 'p2']) {
    assert.equal(s.hand.actor, id);
    const l = legalActions(s, id);
    assert.equal(l.call, 50); assert.equal(l.raise, false); assert.equal(l.allIn, false);
    assert.throws(() => act(s, 'raise', 230)); assert.throws(() => act(s, 'allin'));
    s = act(s, 'call');
  }
  assert.equal(s.hand.phase, 'roundEnd'); assert.equal(potTotal(s), 600);
  assert.equal(player(s, 'p3').stack, 0); assertConservation(s);
});

test('audit: cumulative short raises reopen only players facing a full increment since their last action', () => {
  let s = apply(table([150, 190, 1000, 1000]), 'start');
  s = act(s, 'raise', 100); s = act(s, 'allin'); s = act(s, 'allin'); s = act(s, 'call');
  assert.equal(s.hand.actor, 'p4');
  assert.equal(legalActions(s, 'p4').raise, true);
  assert.equal(legalActions(s, 'p4').minRaiseTo, 270);
  s = act(s, 'raise', 270); assert.equal(s.hand.actor, 'p3');
  assert.equal(legalActions(s, 'p3').raise, true);
  s = act(s, 'call'); assertConservation(s);
});

test('audit: a check before an incomplete opening all-in must call or fold but cannot raise', () => {
  let s = apply(table([1000, 1000, 30]), 'start');
  s = act(s, 'call'); s = act(s, 'call'); s = act(s, 'check'); s = apply(s, 'next');
  s = act(s, 'check'); s = act(s, 'allin');
  assert.equal(legalActions(s, 'p1').raise, true);
  s = act(s, 'call');
  assert.equal(s.hand.actor, 'p2'); assert.equal(legalActions(s, 'p2').call, 10);
  assert.equal(legalActions(s, 'p2').raise, false);
  s = act(s, 'call'); assert.equal(s.hand.phase, 'roundEnd');
});

test('audit: a lone covering player owes only the short blind and cannot bet into an empty side pot', () => {
  let s = apply(table([100, 15]), 'start');
  assert.equal(legalActions(s, 'p1').call, 5);
  assert.equal(legalActions(s, 'p1').raise, false);
  const allin = act(s, 'allin'); assert.equal(potTotal(allin), 30); assert.equal(player(allin, 'p1').stack, 85);
  s = act(s, 'call'); assert.equal(potTotal(s), 30); assert.equal(player(s, 'p1').stack, 85);
  s = apply(table([100, 10]), 'start');
  assert.equal(s.hand.phase, 'showdown'); assert.deepEqual(s.hand.vpip, []);
});

test('audit: any live all-in at showdown tables every survivor including side-pot losers', () => {
  deck(['As', 'Kh', '2s', 'Ad', 'Kd', '3s', '4c', '5h', '8d', 'Tc', '6c', 'Jh', '7c', 'Qh']);
  let s = apply(table([40, 1000, 1000], { dealMode: 'digital' }), 'start');
  s = act(s, 'allin'); s = act(s, 'call'); s = act(s, 'call'); s = finish(s);
  assert.deepEqual(Object.keys(s.hand.revealed).sort(), ['p1', 'p2', 'p3']);
  assert.deepEqual(s.hand.mucked, []);
});

test('audit: live summary reconciles unsettled contributions without reporting a ledger error', () => {
  let s = apply(table([1000, 1000, 1000]), 'start');
  s = act(s, 'raise', 100);
  const sum = summarize(s);
  assert.equal(sum.balance.ok, true);
  assert.ok(sum.players.every(p => p.consistent));
  assert.equal(sum.balance.buyIn, sum.balance.final + sum.balance.pot + sum.balance.cashOut);
  assert.deepEqual(sum.players.map(p => p.net), [0, 0, 0]);
});

test('audit: separate main and side-pot winners are not described as a split pot', () => {
  let s = apply(table([100, 200, 300]), 'start');
  s = act(s, 'allin'); s = act(s, 'allin'); s = act(s, 'allin');
  s = apply(s, 'settle', { selections: { 'pot-0': ['p1'], 'pot-1': ['p2'] }, expectedTotal: 500 });
  assert.doesNotMatch(summarize(s).highlights[0].text, /平分/);
});

test('audit: shuffled deterministic multiway showdown awards distinct main and side winners', () => {
  // p2 KK, p3 QQ, p1 AA. p3 unmatched 100 is refunded.
  deck(['Ks', 'Qs', 'As', 'Kd', 'Qd', 'Ad', '4c', '2h', '7d', '9c', '5c', 'Jh', '6c', '3s']);
  let s = apply(table([100, 200, 300], { dealMode: 'digital' }), 'start');
  s = act(s, 'allin'); s = act(s, 'allin'); s = act(s, 'allin');
  assert.deepEqual(s.hand.selections, { 'pot-0': ['p1'], 'pot-1': ['p2'] });
  s = settle(s); assert.deepEqual(s.players.map(p => p.stack), [300, 200, 100]);
  const sum = summarize(s); assert.equal(sum.balance.ok, true);
  assert.deepEqual(sum.players.map(p => [p.id, p.won, p.biggest, p.allins, p.showdowns]), [['p1', 1, 300, 1, 1], ['p2', 1, 200, 1, 1], ['p3', 0, null, 1, 1]]);
});

test('audit: names reject control characters even when trimming would hide them', () => {
  for (const name of ['\n甲', '乙\t', '丙\u0000', '丁\u202e', 'A\r\n']) {
    assert.throws(() => newRoom('TEST', { name }));
    assert.throws(() => apply(newRoom('TEST'), 'join', { id: 'p1', name, seat: 1 }));
  }
});

test('audit: a valid raise may exceed the per-buy-in limit after winning other stacks', () => {
  let s = table([2_000_000_000, 2_000_000_000]);
  s = apply(s, 'start'); s = act(s, 'raise', 1_000_000_001);
  assert.equal(player(s, 'p1').bet, 1_000_000_001); assertConservation(s);
});

test('audit: transition to heads-up does not charge the previous big blind twice', () => {
  let s = apply(table([1000, 1000, 1000]), 'start');
  s = settle(finish(s)); s = apply(s, 'leave', { playerId: 'p1' }); s = apply(s, 'start');
  assert.deepEqual([s.hand.dealer, s.hand.small, s.hand.big, s.hand.actor], ['p3', 'p3', 'p2', 'p3']);
});

test('audit: late join and sit-out rotate the moving button over eligible seats only', () => {
  let s = apply(table([1000, 1000, 1000, 1000]), 'start');
  s = apply(s, 'sitOut', { playerId: 'p2', away: true });
  s = apply(s, 'join', { id: 'p5', name: '迟到', seat: 7 });
  assert.equal(player(s, 'p5').inHand, false); assert.equal(s.hand.actor, 'p4');
  s = settle(finish(s)); s = apply(s, 'start');
  assert.deepEqual([s.hand.dealer, s.hand.small, s.hand.big, s.hand.actor], ['p3', 'p4', 'p5', 'p1']);
  assert.equal(player(s, 'p2').contribution, 0); assert.ok(s.hand.participants.includes('p5'));
});

test('audit: 1200 seeded hands with antes conserve chips, preserve eligibility and terminate in both modes', () => {
  let seed = 0xC0DEC0DE;
  const rand = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let run = 0; run < 1200; run++) {
    const count = 2 + rand(9), mode = run % 2 ? 'physical' : 'digital';
    // 固定种子也驱动电子牌牌叠，避免测试重放时牌面变化。
    const cards = makeDeck(); for (let i = 51; i > 0; i--) { const j = rand(i + 1); [cards[i], cards[j]] = [cards[j], cards[i]]; }
    if (mode === 'digital') setNextDeck(cards);
    let s = table(Array.from({ length: count }, () => 1 + rand(700)), { smallBlind: 5, bigBlind: 10, ante: rand(11), dealMode: mode });
    const total = s.total; s = apply(s, 'start');
    for (let step = 0; s.hand.phase !== 'showdown'; step++) {
      assert.ok(step < 300, `seed C0DEC0DE run ${run}`);
      if (s.hand.phase === 'roundEnd') {
        const liveBets = s.players.filter(p => p.inHand && !p.folded && p.stack > 0).map(p => p.bet);
        assert.equal(new Set(liveBets).size, 1, 'no caller may skip matching a short raise');
        s = apply(s, 'next');
      } else {
        const l = legalActions(s, s.hand.actor), choices = ['fold'];
        if (l.check) choices.push('check', 'check'); if (l.canCall) choices.push('call', 'call');
        if (l.raise) choices.push('raise'); if (l.allIn) choices.push('allin');
        s = act(s, choices[rand(choices.length)], l.minRaiseTo);
      }
      assertConservation(s); assert.equal(s.total, total);
      assert.ok(s.players.every(p => p.bet <= p.contribution));
    }
    assert.ok(pots(s).every(p => p.eligible.length && p.eligible.every(id => !player(s, id).folded)));
    s = settle(s); assert.equal(potTotal(s), 0); assert.equal(s.players.reduce((n, p) => n + p.stack, 0), total);
    assert.equal(summarize(s).balance.ok, true);
  }
});

test('audit: migrating a betting snapshot restores owed calls while preserving each callers reopening threshold', () => {
  // p4 raises 100, p5 all-in 150, p6 calls 150, p1 all-in 190.
  // p4 faces +90 (>=80), p6 faces +40 (<80): their raise rights differ.
  let s = apply(table([190, 1000, 1000, 1000, 150, 1000]), 'start');
  s = act(s, 'raise', 100); s = act(s, 'allin'); s = act(s, 'call'); s = act(s, 'allin');
  delete s.hand.actedAt;
  s.hand.pending = ['p2', 'p3']; // 旧版短加注遗漏了已行动者的补跟。
  s = normalizeRoom(s);
  assert.deepEqual(s.hand.pending.sort(), ['p2', 'p3', 'p4', 'p6']);
  s = act(s, 'call'); s = act(s, 'call');
  assert.equal(s.hand.actor, 'p4'); assert.equal(legalActions(s, 'p4').raise, true);
  s = act(s, 'call'); assert.equal(s.hand.actor, 'p6');
  assert.equal(legalActions(s, 'p6').call, 40); assert.equal(legalActions(s, 'p6').raise, false);
  assert.equal(legalActions(s, 'p6').allIn, false);
  s = act(s, 'call'); assert.equal(s.hand.phase, 'roundEnd'); assertConservation(s);
});
