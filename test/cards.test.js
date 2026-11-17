import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import { compareRanks, evaluate, handName, makeDeck, setNextDeck, shuffle, takeDeck, useCryptoRandom, winnersAmong } from '../server/cards.js';

useCryptoRandom(randomInt);
const ev = (...cards) => evaluate(cards);
const name = (...cards) => handName(evaluate(cards));
const rank = (...cards) => evaluate(cards).rank;

test('shuffle uses injected crypto rand, never Math.random, and yields a permutation of 52 cards', () => {
  const source = readFileSync(fileURLToPath(new URL('../server/cards.js', import.meta.url)), 'utf8');
  assert.equal(source.includes('Math.random'), false);
  assert.match(source, /useCryptoRandom|rand\(/);
  const calls = [];
  const deck = shuffle(makeDeck(), n => { calls.push(n); return 0; });
  assert.equal(calls.length, 51);
  assert.deepEqual(calls, Array.from({ length: 51 }, (_, i) => 52 - i));
  assert.equal(new Set(deck).size, 52);
  assert.deepEqual([...deck].sort(), makeDeck().sort());
  const a = shuffle(), b = shuffle();
  assert.equal(a.length, 52);
  assert.notDeepEqual(a, b);
  setNextDeck(['As', 'Ad']);
  assert.deepEqual(takeDeck(), ['As', 'Ad']);
  assert.equal(takeDeck().length, 52);
});

test('fixed hand ranks: wheel, straight flush, quads vs full house, two-pair kickers, identical split, board plays', () => {
  assert.equal(name('As', '2h', '3d', '4c', '5s'), '顺子');
  assert.deepEqual(rank('As', '2h', '3d', '4c', '5s'), [4, 5]);
  assert.ok(compareRanks(rank('6s', '2h', '3d', '4c', '5s'), rank('As', '2h', '3d', '4c', '5s')) > 0);
  assert.equal(name('As', 'Ks', 'Qs', 'Js', 'Ts'), '皇家同花顺');
  assert.equal(name('9s', '8s', '7s', '6s', '5s'), '同花顺');
  assert.ok(compareRanks(rank('As', 'Ks', 'Qs', 'Js', 'Ts'), rank('9s', '8s', '7s', '6s', '5s')) > 0);
  const quads = ev('Ah', 'Ad', 'As', 'Ac', 'Kh', '9d', '2c');
  const boat = ev('Kh', 'Kd', 'Ks', 'Ah', 'Ad', '9c', '2s');
  assert.equal(handName(quads), '四条');
  assert.equal(handName(boat), '葫芦');
  assert.ok(compareRanks(quads.rank, boat.rank) > 0);
  const aceKicker = ev('Ah', '2c', 'Ks', 'Kd', '9h', '9c', '7s');
  const queenKicker = ev('Qh', '2d', 'Ks', 'Kd', '9h', '9c', '7s');
  assert.equal(handName(aceKicker), '两对');
  assert.ok(compareRanks(aceKicker.rank, queenKicker.rank) > 0);
  const left = ev('2s', '3s', 'As', 'Kd', 'Qh', 'Jc', '9c');
  const right = ev('2h', '3h', 'As', 'Kd', 'Qh', 'Jc', '9c');
  assert.equal(compareRanks(left.rank, right.rank), 0);
  assert.equal(handName(left), '高牌');
  const board = ['As', 'Ks', 'Qs', 'Js', 'Ts'];
  assert.deepEqual(winnersAmong(['p1', 'p2'], { p1: ['2s', '3s'], p2: ['4h', '5d'] }, board).sort(), ['p1', 'p2']);
  assert.equal(name('Ah', 'Kh', 'Qh', 'Jh', '9h'), '同花');
  assert.equal(name('Ah', 'Kh', 'Qh', 'Jd', 'Ts'), '顺子');
  assert.equal(name('Ah', 'Ad', 'Ac', '2s', '3d'), '三条');
  assert.equal(name('Ah', 'Ad', '2s', '3d', '4c'), '一对');
  assert.ok(compareRanks(rank('Ah', 'Kh', 'Qh', 'Jh', '9h'), rank('Ah', 'Kh', 'Qh', 'Jd', 'Ts')) > 0);
});
