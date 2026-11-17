import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, newRoom, player, assertConservation } from '../server/engine.js';
import { summarize } from '../server/summary.js';
import { personalText, recapBody, recapText } from '../public/night/recap.js';
import { handsBody } from '../public/night/replay.js';

const pot = (run, i, amount, potAmount, shares, oddRecipients = []) => ({
  id: `run-${run}-pot-${i}`,
  potId: `pot-${i}`,
  run,
  name: i ? '边池 1' : '主池',
  amount,
  potAmount,
  runOdd: amount > Math.floor(potAmount / 3),
  winners: Object.keys(shares),
  shares,
  each: Math.floor(amount / Object.keys(shares).length),
  remainder: oddRecipients.length,
  oddRecipients
});

function settledTable(record, stacks) {
  let s = newRoom('TEST', { dealMode: 'digital', smallBlind: 1, bigBlind: 2, startingStack: 100 });
  for (const [id, seat] of [['p1', 1], ['p2', 2], ['p3', 3]]) {
    s = apply(s, 'join', { id, seat, name: `玩家${seat}` });
  }
  for (const [id, seat] of [['p1', 1], ['p2', 2], ['p3', 3]]) {
    player(s, id).stack = stacks[seat - 1];
  }
  s.handNumber = 1;
  s.records = [{
    n: 1, mode: 'digital', dealer: 'p1', small: 'p2', big: 'p3', blinds: { small: 1, big: 2, ante: 0 },
    seats: Object.fromEntries(s.players.map(p => [p.id, { name: p.name, seat: p.seat, start: 100 }])),
    actions: [], showdown: true,
    ...record
  }];
  assertConservation(s);
  return s;
}

function successiveBoards() {
  return settledTable({
    board: ['9s', '9c', '2d', '4c', '7h'],
    boards: [
      ['9s', '9c', '2d', '4c', '7h'],
      ['Qs', 'Js', 'Ts', '3d', '8d'],
      ['3h', '4h', '5d', '6c', '7c']
    ],
    runs: 3, sharedBoardCount: 0,
    actions: [
      { a: 'runVote', id: 'p1', runs: 3, street: 0, pot: 19 },
      { a: 'runResult', runs: 3, street: 0, pot: 19 },
      { a: 'street', street: 1, run: 1, board: ['9s', '9c', '2d'] },
      { a: 'street', street: 2, run: 1, board: ['9s', '9c', '2d', '4c'] },
      { a: 'street', street: 3, run: 1, board: ['9s', '9c', '2d', '4c', '7h'] },
      { a: 'street', street: 1, run: 2, board: ['Qs', 'Js', 'Ts'] }
    ],
    boardHands: [
      { p1: '一对', p2: '四条', p3: '葫芦' },
      { p1: '皇家同花顺', p2: '一对', p3: '一对' },
      { p1: '顺子', p2: '顺子', p3: '顺子' }
    ],
    showOrder: ['p2', 'p3', 'p1'],
    shown: { p1: ['As', 'Ks'], p2: ['9h', '9d'], p3: ['2s', '2c'] },
    folded: [], vpip: ['p1', 'p2', 'p3'],
    contrib: { p1: 7, p2: 7, p3: 5 }, awards: { p1: 7, p2: 10, p3: 2 },
    pots: [
      pot(1, 0, 5, 15, { p2: 5 }), pot(1, 1, 2, 4, { p2: 2 }),
      pot(2, 0, 5, 15, { p1: 5 }), pot(2, 1, 1, 4, { p1: 1 }),
      pot(3, 0, 5, 15, { p2: 2, p3: 2, p1: 1 }, ['p2', 'p3']),
      pot(3, 1, 1, 4, { p2: 1, p1: 0 }, ['p2'])
    ]
  }, [100, 103, 97]);
}

test('summary finds the strongest shown hand on a later board', () => {
  const sum = summarize(successiveBoards());
  const p1 = sum.players.find(p => p.id === 'p1');
  assert.deepEqual(p1.best, { name: '皇家同花顺', nameMessage: { key: 'server.handDescription.9', params: {}, text: '皇家同花顺' }, cards: ['As', 'Ks'], hand: 1, run: 2 });
  const best = sum.highlights.find(h => h.kind === 'best');
  assert.equal(best.run, 2);
  assert.deepEqual(best.board, ['Qs', 'Js', 'Ts', '3d', '8d']);
  assert.match(best.text, /第 2 轮/);
});

test('summary preserves run-by-run payouts and counts a winning hand only once', () => {
  const sum = summarize(successiveBoards());
  assert.equal(sum.balance.ok, true);
  assert.deepEqual(sum.players.map(p => [p.id, p.won, p.biggest, p.net]), [
    ['p2', 1, 10, 3], ['p1', 1, 7, 0], ['p3', 1, 2, -3]
  ]);
  const largest = sum.highlights.find(h => h.kind === 'pot');
  assert.equal(largest.value, 19);
  assert.match(largest.text, /3 轮/);
  assert.doesNotMatch(largest.text, /平分/);
  assert.deepEqual(largest.rounds.map(r => [r.run, r.board, r.pots.map(p => [p.name, p.amount, p.shares])]), [
    [1, ['9s', '9c', '2d', '4c', '7h'], [['主池', 5, { p2: 5 }], ['边池 1', 2, { p2: 2 }]]],
    [2, ['Qs', 'Js', 'Ts', '3d', '8d'], [['主池', 5, { p1: 5 }], ['边池 1', 1, { p1: 1 }]]],
    [3, ['3h', '4h', '5d', '6c', '7c'], [['主池', 5, { p2: 2, p3: 2, p1: 1 }], ['边池 1', 1, { p2: 1, p1: 0 }]]]
  ]);
});

test('old single-board records keep hand ranks and report unequal tied payouts', () => {
  const board = ['As', 'Ks', 'Qs', 'Js', 'Ts'];
  const sum = summarize(settledTable({
    board, shown: { p1: ['2s', '3s'], p2: ['4h', '5d'] },
    folded: ['p3'], vpip: ['p1', 'p2'],
    contrib: { p1: 5, p2: 5, p3: 3 }, awards: { p1: 6, p2: 7 },
    pots: [{ name: '主池', amount: 13, winners: ['p2', 'p1'], shares: { p2: 7, p1: 6 } }]
  }, [101, 102, 97]));
  assert.equal(sum.balance.ok, true);
  assert.equal(sum.players.find(p => p.id === 'p1').best.name, '皇家同花顺');
  assert.equal(sum.players.find(p => p.id === 'p3').won, 0);
  assert.match(sum.highlights[0].text, /分获底池/);
  assert.doesNotMatch(sum.highlights[0].text, /平分/);
});

test('replay shows each run board, payouts, public hand names and showdown order', () => {
  const s = successiveBoards(), html = handsBody({ records: s.records, roster: s.roster }, 1);
  assert.ok(html.indexOf('class="hv-runouts"') < html.indexOf('class="hv-timeline"'), 'each run result precedes the action timeline');
  assert.match(html, /摊牌顺序[^<]*<\/[^>]+>\s*玩家2 → 玩家3 → 玩家1/);
  assert.match(html, /第 2 轮 · 翻牌圈/);
  const secondRun = html.match(/class="hv-run" data-run="2"[^]*?<\/section>/)?.[0];
  assert.ok(secondRun);
  assert.match(secondRun, /data-card="Qs"/);
  assert.match(secondRun, /皇家同花顺/);
  assert.match(secondRun, /玩家1 <b class="num">\+5/);
  assert.doesNotMatch(secondRun, /data-card="9s"/);
});

test('recap and share text show later runs and explain winning-hand totals', () => {
  const sum = summarize(successiveBoards()), html = recapBody(sum);
  const thirdRun = html.match(/class="rc-hl-run" data-run="3"[^]*?<\/section>/)?.[0];
  assert.ok(thirdRun);
  assert.match(thirdRun, /data-card="7c"/);
  assert.match(thirdRun, /主池 5.*玩家2 \+2.*玩家3 \+2.*玩家1 \+1/);
  assert.match(recapText(sum), /第 3 轮.*7♣.*主池 5.*玩家1 \+1/);
  assert.match(personalText(sum, 'p1'), /赢池 1 手.*第 1 手/);
  assert.match(personalText(sum, 'p1'), /皇家同花顺（第 1 手 · 第 2 轮）/);
});
