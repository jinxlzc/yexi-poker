// 52 张标准扑克：编码为点数+花色，如 As、Td、2c。纯函数判定，洗牌随机源由 useCryptoRandom 注入。
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['s', 'h', 'd', 'c'];
export const CATEGORIES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺', '皇家同花顺'];
export const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i + 2]));

export const cardRank = code => code[0];
export const cardSuit = code => code[1];
export const cardValue = code => RANK_VALUE[code[0]];
export const isCard = code => typeof code === 'string' && /^[2-9TJQKA][shdc]$/.test(code);

export function makeDeck() {
  return RANKS.flatMap(rank => SUITS.map(suit => rank + suit));
}

let randInt = null;
let nextDeck = null;
export function useCryptoRandom(fn) { randInt = fn; }
export function setNextDeck(deck) { nextDeck = deck ? [...deck] : null; }

export function shuffle(source = makeDeck(), rand = randInt) {
  if (typeof rand !== 'function') throw new Error('洗牌需要安全随机源。');
  const deck = [...source];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function takeDeck() {
  if (nextDeck) {
    const deck = nextDeck;
    nextDeck = null;
    return deck;
  }
  return shuffle();
}

export function compareRanks(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

function counts(values) {
  const map = new Map();
  for (const v of values) map.set(v, (map.get(v) || 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
}

function straightHigh(values) {
  const unique = [...new Set(values)].sort((a, b) => b - a);
  if (unique.length < 5) return 0;
  if (unique.includes(14) && unique.includes(5) && unique.includes(4) && unique.includes(3) && unique.includes(2)) {
    const wheel = [14, 5, 4, 3, 2];
    if (wheel.every(v => unique.includes(v)) && unique.length === 5) return 5;
    // 7 张里可能同时有轮子和更高顺子，5 张判定时 unique 恰为 5。
    if (unique.length === 5) return 5;
  }
  if (unique[0] - unique[4] === 4 && unique.length === 5) return unique[0];
  return 0;
}

export function evaluate5(cards) {
  const values = cards.map(cardValue).sort((a, b) => b - a);
  const flush = cards.every(c => cardSuit(c) === cardSuit(cards[0]));
  const groups = counts(values);
  const highStraight = straightHigh(values);
  if (flush && highStraight === 14) return [9, 14];
  if (flush && highStraight) return [8, highStraight];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1]?.[1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...values];
  if (highStraight) return [4, highStraight];
  if (groups[0][1] === 3) return [3, groups[0][0], ...groups.slice(1).map(g => g[0])];
  if (groups[0][1] === 2 && groups[1]?.[1] === 2) return [2, groups[0][0], groups[1][0], groups[2][0]];
  if (groups[0][1] === 2) return [1, groups[0][0], ...groups.slice(1).map(g => g[0])];
  return [0, ...values];
}

function combinations(items, k) {
  const out = [];
  const walk = (start, acc) => {
    if (acc.length === k) { out.push(acc); return; }
    for (let i = start; i <= items.length - (k - acc.length); i++) walk(i + 1, [...acc, items[i]]);
  };
  walk(0, []);
  return out;
}

export function evaluate(cards) {
  if (cards.length === 5) return { rank: evaluate5(cards), cards: [...cards] };
  let best = null, bestCards = null;
  for (const five of combinations(cards, 5)) {
    const rank = evaluate5(five);
    if (!best || compareRanks(rank, best) > 0) { best = rank; bestCards = five; }
  }
  return { rank: best, cards: bestCards };
}

export function handName(result) {
  return CATEGORIES[result.rank[0]];
}

export function winnersAmong(ids, holes, board) {
  const scored = ids.map(id => ({ id, ev: evaluate([...(holes[id] || []), ...board]) }));
  let best = scored[0].ev.rank;
  for (const row of scored) if (compareRanks(row.ev.rank, best) > 0) best = row.ev.rank;
  return scored.filter(row => compareRanks(row.ev.rank, best) === 0).map(row => row.id);
}

export function sameSelections(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!Array.isArray(a[key]) || !Array.isArray(b[key]) || !a[key].every(id => typeof id === 'string') || new Set(a[key]).size !== a[key].length) return false;
    const left = [...a[key]].sort();
    const right = [...b[key]].sort();
    if (left.length !== right.length || left.some((id, i) => id !== right[i])) return false;
  }
  return true;
}

const VALUE_LABEL = v => ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10' }[v] || String(v));
// 中文牌型描述，例如「葫芦 · K 带 10」。只对已经公开或本人可见的牌调用。
export function describeHand(cards) {
  if (!cards || cards.length < 2) return '';
  if (cards.length < 5) return cards.length === 2 && cards[0][0] === cards[1][0] ? `一对 ${VALUE_LABEL(RANK_VALUE[cards[0][0]])}` : '';
  const r = evaluate(cards).rank, v = i => VALUE_LABEL(r[i]);
  return [`高牌 ${v(1)}`, `一对 ${v(1)}`, `两对 · ${v(1)} 和 ${v(2)}`, `三条 ${v(1)}`, `顺子 · 到 ${v(1)}`, `同花 · ${v(1)} 高`, `葫芦 · ${v(1)} 带 ${v(2)}`, `四条 ${v(1)}`, `同花顺 · 到 ${v(1)}`, '皇家同花顺'][r[0]];
}
