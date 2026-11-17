import { msg, joinMessages, describe, defaultText } from './messages.js';
// 无上限规则：短加注仍须补跟或弃牌，但不足完整加注时不重开已行动者的加注权。
// 多次短加注累计达到完整幅度时，按每位玩家上次行动后的增量判断（TDA 49）。
import { takeDeck, winnersAmong, handNameMessage, evaluate, sameSelections } from './cards.js';
export const streetMessage = street => msg(`street.${street}`);
export const STREETS = [0, 1, 2, 3].map(street => streetMessage(street).text);
export const LIMIT = 1_000_000_000;
export class RuleError extends Error {
  constructor(message, status = 400) { super(defaultText(message)); this.status = status; if (message?.key) { this.key = message.key; this.params = message.params || {}; } }
}
export function requireRule(condition, message, status) {
  if (!condition) throw new RuleError(message, status);
}
export function integer(value, min = 1, max = LIMIT) {
  requireRule(Number.isSafeInteger(value) && value >= min && value <= max, msg('error.integer', { min, max }));
  return value;
}
function name(value, max) {
  requireRule(typeof value === 'string', msg('error.nameRequired'));
  const result = value.trim();
  requireRule([...result].length >= 1 && [...result].length <= max && !/[\p{Cc}\p{Cf}]/u.test(value), msg('error.nameLength', { max }));
  return result;
}
export const CLOCKS = [0, 20, 30, 45, 60, 90];
export const LEVELS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100];
const nowIso = () => new Date().toISOString();
function validConfig(config, base = {}) {
  const c = { ...base, ...config };
  const { smallBlind = 10, bigBlind = 20, startingStack = 2000, dealMode = 'physical', ante = 0, levelEvery = 0, actionClock = 0, runouts = 3, straddle = false, anteMode = 'each' } = c;
  integer(smallBlind); integer(bigBlind, smallBlind); integer(startingStack, bigBlind);
  integer(ante, 0, bigBlind);
  requireRule(Number.isSafeInteger(levelEvery) && (levelEvery === 0 || (levelEvery >= 3 && levelEvery <= 200)), msg('error.levelEvery'));
  requireRule(CLOCKS.includes(actionClock), msg('error.actionClock'));
  requireRule(dealMode === 'physical' || dealMode === 'digital', msg('error.dealMode'));
  requireRule([1, 2, 3].includes(runouts), msg('error.runouts'));
  requireRule(typeof straddle === 'boolean', msg('error.straddleSetting'));
  requireRule(['each', 'bigBlind'].includes(anteMode), msg('error.anteMode'));
  return { name: name(c.name ?? msg('room.default').text, 16), smallBlind, bigBlind, startingStack, rebuy: c.rebuy === true, dealMode, ante, levelEvery, actionClock, runouts, straddle, anteMode };
}
export function newRoom(code, config = {}) {
  return { code, config: validConfig(config), version: 0, total: 0, players: [], hand: null, handNumber: 0, dealerSeat: 0, logs: [], balanceNote: '',
    status: 'open', createdAt: nowIso(), startedAt: null, endedAt: null, level: 0, levelHand: 1, paused: null, roster: {}, records: [], statsFrom: 1, nextRoom: null, nextStraddle: null };
}
// 旧房间（v1–v3）没有账本和结构化牌谱：账本从日志里的入座、补码、离开还原，统计从下一手开始。
function legacyRoster(s) {
  const entries = [];
  for (const e of s.logs || []) {
    let m;
    if ((m = /^(.+?)坐到 (\d+) 号位 · 起始 (\d+)/.exec(e.text))) {
      let r = entries.find(x => x.name === m[1] && !x.seated);
      if (!r) { r = { id: null, name: m[1], seat: Number(m[2]), buyIn: 0, cashOut: 0, rebuys: 0, joinedAt: e.at, leftAt: null, seated: true }; entries.push(r); }
      r.seated = true; r.buyIn += Number(m[3]); r.seat = Number(m[2]); r.leftAt = null;
    } else if ((m = /^补码 · (.+?) \+(\d+)$/.exec(e.text))) {
      const r = entries.find(x => x.name === m[1] && x.seated); if (r) { r.buyIn += Number(m[2]); r.rebuys += 1; }
    } else if ((m = /^(.+?)离开，带走 (\d+)$/.exec(e.text))) {
      const r = entries.find(x => x.name === m[1] && x.seated); if (r) { r.cashOut += Number(m[2]); r.seated = false; r.leftAt = e.at; }
    }
  }
  const roster = {};
  for (const p of s.players) {
    let r = entries.find(x => x.name === p.name && x.seated && !x.id);
    if (!r) r = { name: p.name, seat: p.seat, buyIn: p.stack + (p.contribution || 0), cashOut: 0, rebuys: 0, joinedAt: null, leftAt: null, seated: true, approx: true };
    r.id = p.id; roster[p.id] = r;
  }
  entries.filter(r => !r.id && !r.seated).forEach((r, i) => { r.id = `legacy-${i + 1}`; roster[r.id] = r; });
  return roster;
}
export function normalizeRoom(s) {
  if (!Array.isArray(s.logs)) s.logs = [];
  if (!s.config) s.config = {};
  if (s.config.dealMode !== 'digital' && s.config.dealMode !== 'physical') s.config.dealMode = 'physical';
  for (const [k, v] of [['ante', 0], ['levelEvery', 0], ['actionClock', 0]]) if (!Number.isSafeInteger(s.config[k])) s.config[k] = v;
  if (s.config.runouts === undefined) s.config.runouts = 3;
  if (s.config.straddle === undefined) s.config.straddle = false;
  if (s.config.anteMode === undefined) s.config.anteMode = 'each';
  if (s.nextStraddle === undefined) s.nextStraddle = null;
  if (!s.status) s.status = 'open';
  if (!s.createdAt) s.createdAt = s.logs?.[0]?.at || nowIso();
  if (s.startedAt === undefined) s.startedAt = s.logs?.find(e => e.kind === 'start')?.at || null;
  if (s.endedAt === undefined) s.endedAt = null;
  if (!Number.isSafeInteger(s.level)) s.level = 0;
  if (!Number.isSafeInteger(s.levelHand)) s.levelHand = 1;
  if (s.paused === undefined) s.paused = null;
  if (s.nextRoom === undefined) s.nextRoom = null;
  if (!Array.isArray(s.records)) s.records = [];
  if (!Number.isSafeInteger(s.statsFrom)) s.statsFrom = (s.handNumber || 0) + (s.hand && s.hand.phase !== 'settled' ? 0 : 1);
  if (!s.roster) { s.roster = legacyRoster(s); if (s.handNumber > 0) s.legacy = true; }
  for (const p of s.players) { if (p.sittingOut === undefined) p.sittingOut = false; }
  if (s.hand) {
    if (!Array.isArray(s.hand.board)) s.hand.board = [];
    if (!Array.isArray(s.hand.boards)) s.hand.boards = [[...s.hand.board]];
    if (!Number.isSafeInteger(s.hand.runs)) s.hand.runs = 1;
    if (!s.hand.runVotes) s.hand.runVotes = {};
    if (!Number.isSafeInteger(s.hand.sharedBoardCount)) s.hand.sharedBoardCount = 0;
    if (!Array.isArray(s.hand.boardHandNames)) s.hand.boardHandNames = [{ ...(s.hand.handNames || {}) }];
    if (!Array.isArray(s.hand.boardHandNamesMessage)) s.hand.boardHandNamesMessage = s.hand.boards.map(() => ({}));
    if (!s.hand.handNamesMessage) s.hand.handNamesMessage = {};
    if (!Array.isArray(s.hand.showOrder)) s.hand.showOrder = [];
    if (!s.hand.holes) s.hand.holes = {};
    if (!Array.isArray(s.hand.deck)) s.hand.deck = [];
    if (!Array.isArray(s.hand.burned)) s.hand.burned = [];
    if (s.hand.holeDealt === undefined) s.hand.holeDealt = false;
    if (!s.hand.revealed) s.hand.revealed = {};
    if (!s.hand.handNames) s.hand.handNames = {};
    if (!Number.isSafeInteger(s.hand.bigBlind)) s.hand.bigBlind = s.config.bigBlind;
    // 升级前已在进行的一手没有结构化动作，不进入牌谱统计。
    if (!Array.isArray(s.hand.actions)) { s.hand.actions = []; s.hand.untracked = true; }
    if (s.hand.riverAggressor === undefined) {
      s.hand.riverAggressor = null;
      let high = 0;
      for (const a of s.hand.actions) {
        if (a.street !== 3 || !Number.isSafeInteger(a.to)) continue;
        if (['raise', 'allin'].includes(a.a) && a.to > high) s.hand.riverAggressor = a.id;
        high = Math.max(high, a.to);
      }
    }
    if (!s.hand.actedAt) {
      s.hand.actedAt = {};
      for (const a of s.hand.actions) if (a.street === s.hand.street && ['check', 'call', 'raise', 'allin'].includes(a.a)) s.hand.actedAt[a.id] = a.to || 0;
      if (s.hand.phase === 'betting') s.hand.pending = able(s).filter(p => s.hand.pending.includes(p.id) || p.bet < s.hand.currentBet).map(p => p.id);
    }
  }
  return s;
}
export function levelBlinds(s, level = s.level || 0) {
  const m = LEVELS[Math.min(level, LEVELS.length - 1)];
  const small = s.config.smallBlind * m, big = s.config.bigBlind * m, ante = (s.config.ante || 0) * m;
  return { level, small, big, ante, multiplier: m };
}
export const isEnded = s => s.status === 'ended';
export const isDigital = s => (s.config?.dealMode || 'physical') === 'digital';
export const ongoing = s => !!s.hand && s.hand.phase !== 'settled';
export const player = (s, id) => s.players.find(p => p.id === id);
export const ordered = s => [...s.players].sort((a, b) => a.seat - b.seat);
export const live = s => s.players.filter(p => p.inHand && !p.folded);
const able = s => live(s).filter(p => p.stack > 0);
export const potTotal = s => s.players.reduce((sum, p) => sum + p.contribution, 0);
export function log(s, text, kind = 'action') {
  s.logs.push({ id: `${s.version + 1}-${s.logs.length}`, at: new Date().toISOString(), hand: s.handNumber, ...describe(text), kind });
}
function clockwise(s, after, ids) {
  return ordered(s).filter(p => ids.includes(p.id)).sort((a, b) => ((a.seat - after + 9) % 10) - ((b.seat - after + 9) % 10));
}
function nextId(s, after, ids) { return clockwise(s, after, ids)[0]?.id ?? null; }
// 座位页与开手使用同一套位置计算，预约抓不会因预告和实际轮转不同而落到别的位置。
export function nextPositions(s) {
  const participants = ordered(s).filter(p => p.stack > 0 && !p.sittingOut && !p.leaving);
  if (participants.length < 2) return null;
  const ids = participants.map(p => p.id);
  const headsUpTransition = participants.length === 2 && s.hand?.participants.length > 2 && ids.includes(s.hand.big);
  const dealer = headsUpTransition ? s.hand.big : nextId(s, s.dealerSeat, ids);
  const small = participants.length === 2 ? dealer : nextId(s, player(s, dealer).seat, ids);
  const big = nextId(s, player(s, small).seat, ids);
  return { dealer, small, big, utg: participants.length >= 3 ? nextId(s, player(s, big).seat, ids) : null };
}
function invest(p, amount) { p.stack -= amount; p.bet += amount; p.contribution += amount; }
function note(s, entry) { if (s.hand && Array.isArray(s.hand.actions)) s.hand.actions.push({ ...entry, street: s.hand.street, pot: potTotal(s) }); }
function setActor(s, id) { const h = s.hand; if (h.actor !== id) h.actorSince = id ? nowIso() : null; h.actor = id; }

function draw(h) {
  requireRule(Array.isArray(h.deck) && h.deck.length > 0, msg('error.deckEmpty'));
  return h.deck.shift();
}
function dealOrder(s) {
  const first = s.hand.participants.length === 2 ? player(s, s.hand.big) : player(s, s.hand.small);
  const after = first.seat === 1 ? 10 : first.seat - 1;
  return clockwise(s, after, s.hand.participants);
}
function dealHoles(s) {
  const h = s.hand;
  h.deck = takeDeck();
  h.burned = [];
  h.board = [];
  h.boards = [[]];
  h.holes = {};
  h.revealed = {};
  h.handNames = {};
  h.autoJudged = false;
  const order = dealOrder(s);
  for (let round = 0; round < 2; round++) for (const p of order) (h.holes[p.id] ??= []).push(draw(h));
  h.holeDealt = true;
  log(s, msg('log.deal'), 'deal');
}
function dealBoard(s, count, run = 0) {
  const h = s.hand;
  h.burned.push(draw(h));
  for (let i = 0; i < count; i++) h.boards[run].push(draw(h));
  h.board = [...h.boards[0]];
}
export function autoWinners(s) {
  const holes = s.hand.holes || {};
  return Object.fromEntries(runPots(s).map(pot => {
    if (pot.eligible.length <= 1) return [pot.id, [...pot.eligible]];
    const board = s.hand.boards?.[pot.run - 1] || s.hand.board || [];
    return [pot.id, winnersAmong(pot.eligible, holes, board)];
  }));
}
function reveal(s, p) {
  const h = s.hand, holes = h.holes?.[p.id];
  if (!holes || holes.length !== 2) return;
  h.revealed[p.id] = [...holes];
  h.boards.forEach((board, i) => {
    h.boardHandNames[i] ??= {};
    h.boardHandNamesMessage ??= h.boards.map(() => ({}));
    h.boardHandNamesMessage[i] ??= {};
    if (board.length >= 3) {
      const description = handNameMessage(evaluate([...holes, ...board]));
      h.boardHandNames[i][p.id] = description.text;
      h.boardHandNamesMessage[i][p.id] = description;
    }
  });
  h.handNames = { ...h.boardHandNames[0] };
  h.handNamesMessage = { ...h.boardHandNamesMessage[0] };
}
// 摊牌时只要有存活者全下，所有存活者亮牌；否则只亮赢家，其余默认盖牌，可以自己选择亮。
// 牌型名只给已亮的人，日志不写盖牌者的牌力。
function digitalShowdown(s) {
  const h = s.hand, survivors = live(s);
  h.autoJudged = true;
  h.revealed = {};
  h.handNames = {};
  h.boardHandNames = h.boards.map(() => ({}));
  h.handNamesMessage = {};
  h.boardHandNamesMessage = h.boards.map(() => ({}));
  h.mucked = [];
  h.selections = autoWinners(s);
  h.preview = previewSettlement(s, h.selections);
  if (survivors.length <= 1) {
    if (survivors[0]) log(s, msg('log.soleSurvivor', { name: survivors[0].name }), 'showdown');
    return;
  }
  const runout = survivors.some(p => p.stack === 0);
  const winners = new Set(Object.values(h.selections).flat());
  const first = !runout && player(s, h.riverAggressor);
  const order = clockwise(s, first && !first.folded ? (first.seat + 8) % 10 + 1 : h.dealerSeat, survivors.map(p => p.id));
  h.showOrder = order.map(p => p.id);
  const shown = order.filter(p => runout || winners.has(p.id));
  for (const p of shown) reveal(s, p);
  h.mucked = survivors.filter(p => !shown.includes(p)).map(p => p.id);
  log(s, msg('log.showOrder', { names: joinMessages(order.map(p => p.name), ' → ') }), 'showdown');
  for (let i = 0; i < h.runs; i++) log(s, msg('log.showdown', { run: h.runs > 1 ? msg('fragment.run', { run: i + 1 }) : '', hands: joinMessages(shown.map(p => msg('log.playerHand', { name: p.name, hand: h.boardHandNamesMessage[i]?.[p.id] || h.boardHandNames[i]?.[p.id] || '' }))), mucked: h.mucked.length ? msg('fragment.mucked', { count: h.mucked.length }) : '' }), 'showdown');
}
function runOutDigital(s) {
  const h = s.hand;
  const from = h.street, shared = [...h.board];
  h.sharedBoardCount = shared.length;
  h.boards = Array.from({ length: h.runs }, () => [...shared]);
  h.currentBet = 0; h.lastFullRaise = h.bigBlind; h.shortAllIn = false;
  for (const p of s.players) p.bet = 0;
  for (let run = 0; run < h.runs; run++) {
    h.street = from;
    while (h.street < 3) {
      h.street += 1;
      dealBoard(s, h.street === 1 ? 3 : 1, run);
      note(s, { a: 'street', run: run + 1, board: [...h.boards[run]] });
      log(s, msg('log.streetCards', { run: h.runs > 1 ? msg('fragment.run', { run: run + 1 }) : '', street: streetMessage(h.street), cards: h.boards[run].join(' ') }), 'next');
    }
  }
}
function resolveRuns(s, runs, by = '') {
  const h = s.hand;
  h.runs = runs; h.runResolved = true;
  note(s, { a: 'runResult', runs, ...(by ? { by: defaultText(by), byMessage: describe(by) } : {}) });
  log(s, msg('log.runResult', { runs, reason: by || msg('reason.minimumVote') }), 'runout');
  if (isDigital(s)) runOutDigital(s);
  else h.boards = Array.from({ length: runs }, () => []);
  h.phase = 'showdown';
  if (isDigital(s)) digitalShowdown(s);
}
export const LOG_WINDOW = 60;
export function clipView(raw, identity = {}) {
  // 广播只带当前手的日志和账本；完整日志、牌谱按需另取。只复制要发出去的部分，长夜里也不会越来越慢。
  const { logs = [], records = [], ...rest } = raw;
  const s = normalizeRoom({ ...structuredClone(rest), logs: structuredClone(logs.filter(e => e.hand === raw.handNumber).slice(-LOG_WINDOW)), records: [] });
  let hole = null;
  s.logCount = logs.length;
  s.recordCount = records.length;
  s.lastRecord = records.at(-1)?.n ?? null;
  delete s.records;
  if (s.hand) {
    const secret = s.hand.holes || {};
    delete s.hand.deck;
    delete s.hand.burned;
    delete s.hand.holes;
    s.hand.board = s.hand.board || [];
    s.hand.holeDealt = !!s.hand.holeDealt;
    if (identity.playerId && secret[identity.playerId]) hole = [...secret[identity.playerId]];
    const show = isDigital(s) && (s.hand.phase === 'showdown' || s.hand.phase === 'settled');
    const revealed = show ? s.hand.revealed || {} : {};
    s.hand.revealed = Object.fromEntries(Object.entries(revealed).map(([id, cards]) => [id, [...cards]]));
    s.hand.handNamesMessage = Object.fromEntries(Object.entries(s.hand.handNamesMessage || {}).filter(([id]) => s.hand.revealed[id]));
    s.hand.boardHandNamesMessage = s.hand.boardHandNamesMessage.map(names => Object.fromEntries(Object.entries(names).filter(([id]) => s.hand.revealed[id])));
    s.hand.handNames = Object.fromEntries(Object.entries(s.hand.handNames || {}).filter(([id]) => s.hand.revealed[id]));
    s.hand.boardHandNames = s.hand.boardHandNames.map(names => Object.fromEntries(Object.entries(names).filter(([id]) => s.hand.revealed[id])));
  }
  return { state: s, hole };
}

export function assertConservation(s) {
  requireRule(Number.isSafeInteger(s.total) && s.total >= 0, msg('error.total'));
  requireRule(new Set(s.players.map(p => p.seat)).size === s.players.length, msg('error.seatDuplicate'));
  requireRule(s.players.every(p => [p.stack, p.bet, p.contribution].every(n => Number.isSafeInteger(n) && n >= 0) && p.bet <= p.contribution), msg('error.chipRecord'));
  requireRule(s.players.reduce((n, p) => n + p.stack, 0) + potTotal(s) === s.total, msg('error.balance'));
  requireRule(pots(s).reduce((sum, p) => sum + p.amount, 0) === potTotal(s), msg('error.potBalance'));
  return true;
}
// 以投入层级计算资格；弃牌筹码仍计入金额，同一资格的连续层合并。
function potName(index) {
  const nameMessage = msg(index === 0 ? 'pot.main' : index === 1 ? 'pot.side' : 'pot.sideNumber', index > 1 ? { number: index } : {});
  return { name: nameMessage.text, nameMessage, nameKey: nameMessage.key, nameParams: nameMessage.params };
}
function setBalanceNote(s, value) {
  s.balanceNote = defaultText(value);
  s.balanceNoteMessage = describe(value);
}
export function pots(s) {
  // 单人代付的前注属于全桌主池，不能变成代付者的边池投入。
  const bba = ongoing(s) ? s.hand.bigBlindAnte || 0 : 0;
  const contribution = p => p.contribution - (p.id === s.hand?.big ? bba : 0);
  const levels = [...new Set(s.players.map(contribution).filter(Boolean))].sort((a, b) => a - b);
  const result = [];
  let previous = 0;
  for (const level of levels) {
    const contributors = ordered(s).filter(p => contribution(p) >= level);
    const eligible = contributors.filter(p => p.inHand && !p.folded).map(p => p.id);
    const amount = (level - previous) * contributors.length;
    const last = result.at(-1);
    // 兼容旧版本短码不补差规则下，后来弃牌者独占的最高投入层。
    // 这部分是已放弃的死钱，归入最近的可争夺下层，不能产生无赢家的池。
    if (last && (eligible.length === 0 || JSON.stringify(last.eligible) === JSON.stringify(eligible))) {
      last.amount += amount; last.cap = level;
    } else result.push({ id: `pot-${result.length}`, amount, eligible, cap: level });
    previous = level;
  }
  if (bba && result.length) result[0].amount += bba;
  return result.map((p, i) => ({ ...p, ...potName(i), forming: ongoing(s) && s.hand.phase !== 'showdown' }));
}
// 分池和记录共用份额。单轮保留原有池编号，旧牌谱与客户端调用仍可读取。
export function runPots(s) {
  const all = pots(s), runs = s.hand?.runs || 1;
  return Array.from({ length: runs }, (_, i) => all.map(pot => ({ ...pot,
    id: runs === 1 ? pot.id : `run-${i + 1}:${pot.id}`, potId: pot.id, run: i + 1,
    potAmount: pot.amount, amount: Math.floor(pot.amount / runs) + (i < pot.amount % runs ? 1 : 0), runOdd: i < pot.amount % runs
  }))).flat();
}
// 一轮结束时退回没人匹配的本轮投入；前注不在 bet 中，不能退款。
function refundUncalled(s) {
  const sorted = [...s.players].sort((a, b) => b.bet - a.bet);
  if (sorted.length < 2 || sorted[0].folded) return;
  const excess = sorted[0].bet - sorted[1].bet;
  if (excess > 0) {
    const p = sorted[0]; p.bet -= excess; p.contribution -= excess; p.stack += excess;
    note(s, { a: 'refund', id: p.id, amount: excess });
    log(s, msg('log.refund', { name: p.name, amount: excess }), 'refund');
  }
}
function finishOrAdvance(s, after) {
  const h = s.hand;
  h.pending = h.pending.filter(id => able(s).some(p => p.id === id));
  if (live(s).length <= 1) h.pending = [];
  // 无人能继续下注时，只需匹配实际盲注/全下，不必补足名义上的大盲。
  if (able(s).length <= 1) h.currentBet = Math.max(0, ...live(s).map(p => p.bet));
  // 只剩一人有筹码，若他还欠跟注仍要选择跟或弃；否则没有可争夺的额外下注。
  if (able(s).length === 1 && able(s)[0].bet >= h.currentBet) h.pending = [];
  if (h.pending.length) { setActor(s, nextId(s, after, h.pending)); return; }
  refundUncalled(s);
  setActor(s, null);
  if (live(s).length > 1 && h.street < 3 && able(s).length <= 1 && live(s).some(p => p.stack === 0)) {
    if (s.config.runouts === 1) resolveRuns(s, 1, msg('reason.runsDisabled'));
    else {
      h.phase = 'runChoice'; h.runMax = s.config.runouts; h.runVotes = {};
      log(s, msg('log.runVoteStart', { max: h.runMax }), 'runout');
    }
    return;
  }
  h.phase = live(s).length <= 1 || able(s).length <= 1 || h.street === 3 ? 'showdown' : 'roundEnd';
  if (h.phase === 'showdown' && isDigital(s)) digitalShowdown(s);
}
export function legalActions(s, id) {
  const p = player(s, id), h = s.hand;
  if (!p || !h || h.phase !== 'betting' || h.actor !== id || !p.inHand || p.folded || p.stack <= 0 || s.paused) return null;
  const call = Math.max(0, h.currentBet - p.bet);
  const minRaiseTo = h.currentBet + h.lastFullRaise;
  const maxRaiseTo = p.bet + p.stack;
  const lastActed = h.actedAt?.[id];
  const raiseReopened = lastActed === undefined || h.currentBet - lastActed >= h.lastFullRaise;
  const canRaise = able(s).some(other => other.id !== id) && raiseReopened;
  return { call, minRaiseTo, maxRaiseTo, fold: true, check: call === 0,
    canCall: call > 0 && p.stack > call,
    raise: canRaise && maxRaiseTo >= minRaiseTo,
    // 未关闭加注权者可声明全下；没有对手能匹配的部分会立即退款，不生成空边池。
    allIn: maxRaiseTo <= h.currentBet || raiseReopened,
    shortAllIn: canRaise && maxRaiseTo > h.currentBet && maxRaiseTo < minRaiseTo };
}
export function previewSettlement(s, selections) {
  requireRule(s.hand?.phase === 'showdown', msg('error.showdown'));
  requireRule(selections && typeof selections === 'object' && !Array.isArray(selections), msg('error.potWinners'));
  const allPots = runPots(s);
  requireRule(Object.keys(selections).length === allPots.length, msg('error.potWinners'));
  const awards = Object.fromEntries(s.players.map(p => [p.id, 0]));
  const details = allPots.map(pot => {
    const winners = selections[pot.id];
    requireRule(Array.isArray(winners) && winners.length > 0 && new Set(winners).size === winners.length, msg('error.distinctWinners'));
    requireRule(winners.every(id => pot.eligible.includes(id)), msg('error.ineligibleWinner'));
    // 每个池分别平分，奇数筹码从按钮左侧起，顺时针给最近的赢家（TDA 21）。
    const order = clockwise(s, s.hand.dealerSeat, winners).map(p => p.id);
    const each = Math.floor(pot.amount / winners.length), remainder = pot.amount % winners.length;
    const shares = Object.fromEntries(order.map((id, i) => [id, each + (i < remainder ? 1 : 0)]));
    for (const [id, value] of Object.entries(shares)) awards[id] += value;
    return { ...pot, winners: order, each, remainder, oddRecipients: order.slice(0, remainder), shares };
  });
  const distributed = Object.values(awards).reduce((a, b) => a + b, 0);
  const afterTotal = s.players.reduce((sum, p) => sum + p.stack + awards[p.id], 0);
  requireRule(distributed === potTotal(s) && afterTotal === s.total, msg('error.balance'));
  return { awards, details, distributed, afterTotal, balanced: true };
}
function between(s) { requireRule(!ongoing(s), msg('error.betweenHands')); }
function remove(s, p) {
  requireRule(!!p, msg('error.seatMissing'));
  s.total -= p.stack; setBalanceNote(s, msg('balance.leave', { amount: p.stack }));
  const r = s.roster[p.id];
  if (r) { r.cashOut += p.stack; r.seated = false; r.leftAt = nowIso(); r.seat = p.seat; }
  log(s, msg('log.leave', { name: p.name, amount: p.stack }), 'leave');
  s.players = s.players.filter(q => q.id !== p.id);
}
export function apply(s, type, args = {}, actorId = null) {
  const state = normalizeRoom(structuredClone(s));
  mutate(state, type, args, actorId);
  assertConservation(state);
  return state;
}
function notPaused(s) { requireRule(!s.paused, msg('error.paused')); }
function performAct(s, id, args, by = '') {
  const p = player(s, id), h = s.hand, legal = legalActions(s, id);
  requireRule(!!legal, msg('error.turn'));
  const action = args.action;
  requireRule(['fold', 'check', 'call', 'raise', 'allin'].includes(action), msg('error.actionUnknown'));
  h.shortAllIn = false;
  let description, fullRaise = false, amount = 0;
  if (action === 'fold') { p.folded = true; description = msg('action.fold'); }
  if (action === 'check') { requireRule(legal.check, msg('error.cannotCheck')); description = msg('action.check'); }
  if (action === 'call') {
    requireRule(legal.call > 0, msg('error.nothingToCall'));
    requireRule(p.stack > legal.call, msg('error.confirmAllIn'));
    amount = legal.call; invest(p, amount); description = msg('action.call', { amount: legal.call });
  }
  if (action === 'raise' || action === 'allin') {
    if (action === 'allin') requireRule(legal.allIn, msg('error.raiseClosed'));
    const target = action === 'allin' ? legal.maxRaiseTo : integer(args.to, 1, Number.MAX_SAFE_INTEGER);
    requireRule(target <= legal.maxRaiseTo && target > p.bet, msg('error.stackLimit'));
    if (action === 'raise') requireRule(legal.raise && target >= legal.minRaiseTo, msg('error.minRaise', { amount: legal.minRaiseTo }));
    const delta = target - h.currentBet;
    amount = target - p.bet;
    fullRaise = delta >= h.lastFullRaise;
    if (target > h.currentBet) {
      if (h.street === 3) h.riverAggressor = p.id;
      h.shortAllIn = !fullRaise;
      if (fullRaise) h.lastFullRaise = delta;
      h.currentBet = target;
    }
    invest(p, amount);
    description = p.stack === 0 ? msg('action.allin', { amount, short: h.shortAllIn ? msg('fragment.short') : '' }) : msg(legal.call === 0 && h.currentBet === target && target === delta ? 'action.bet' : 'action.raise', { target, amount });
  }
  if (h.street === 0 && amount > 0 && Array.isArray(h.vpip) && !h.vpip.includes(p.id)) h.vpip.push(p.id);
  h.actedAt[p.id] = h.currentBet;
  h.pending = able(s).filter(q => q.id !== p.id && (h.pending.includes(q.id) || q.bet < h.currentBet)).map(q => q.id);
  note(s, { a: action, id: p.id, amount, to: p.bet, allin: p.stack === 0 && action !== 'fold', ...(by ? { by: defaultText(by), byMessage: describe(by) } : {}) });
  log(s, msg('log.action', { name: p.name, action: description, by: by ? msg('fragment.host', { reason: by }) : '' }));
  finishOrAdvance(s, p.seat);
}
function record(s, preview, contrib) {
  const h = s.hand;
  if (h.untracked) return;
  const awards = Object.fromEntries(Object.entries(preview.awards).filter(([, v]) => v > 0));
  s.records.push({
    n: h.number, at: h.startedAt || null, end: nowIso(), mode: s.config.dealMode,
    blinds: { small: h.smallBlind ?? s.config.smallBlind, big: h.bigBlind, ante: h.ante || 0, anteMode: h.anteMode || 'each' },
    dealer: h.dealer, small: h.small, big: h.big, straddle: h.straddle || null,
    seats: Object.fromEntries(h.participants.map(id => { const p = player(s, id); return [id, { name: p.name, seat: p.seat, start: h.startStacks?.[id] ?? null }]; })),
    actions: h.actions, board: [...h.board], boards: structuredClone(h.boards), runs: h.runs, sharedBoardCount: h.sharedBoardCount,
    handsMessage: structuredClone(h.handNamesMessage || {}), boardHandsMessage: structuredClone(h.boardHandNamesMessage || []),
    shown: structuredClone(h.revealed || {}), hands: { ...(h.handNames || {}) }, boardHands: structuredClone(h.boardHandNames), showOrder: [...h.showOrder],
    folded: h.participants.filter(id => player(s, id).folded), showdown: live(s).length > 1,
    pots: preview.details.map(({ eligible, cap, forming, ...d }) => d),
    awards, contrib, vpip: [...(h.vpip || [])]
  });
}
function mutate(s, type, args, actorId) {
  requireRule(!isEnded(s), msg('error.ended'));
  switch (type) {
    case 'join': {
      requireRule(s.players.length < 10, msg('error.tableFull'));
      const nm = name(args.name, 8); integer(args.seat, 1, 10);
      requireRule(!s.players.some(p => p.name === nm), msg('error.nameTaken'));
      requireRule(!Object.values(s.roster).some(r => r.id !== args.id && r.name === nm), msg('error.namePreviouslyUsed'));
      requireRule(!s.players.some(p => p.seat === args.seat), msg('error.seatTaken'));
      requireRule(typeof args.id === 'string' && !player(s, args.id), msg('error.playerIdentity'));
      const p = { id: args.id, name: nm, seat: args.seat, stack: s.config.startingStack, contribution: 0, bet: 0, folded: false, inHand: false, waiting: ongoing(s), leaving: false, sittingOut: false };
      const back = s.roster[args.id];
      s.players.push(p); s.total += p.stack; setBalanceNote(s, msg('balance.join', { amount: p.stack }));
      if (back) { back.buyIn += p.stack; back.seated = true; back.leftAt = null; back.seat = p.seat; back.name = nm; back.returns = (back.returns || 0) + 1; }
      else s.roster[p.id] = { id: p.id, name: nm, seat: p.seat, buyIn: p.stack, cashOut: 0, rebuys: 0, joinedAt: nowIso(), joinedHand: s.handNumber + 1, leftAt: null, seated: true };
      log(s, msg('log.join', { name: nm, returned: back ? msg('fragment.returned') : '', seat: p.seat, stack: p.stack, waiting: p.waiting ? msg('fragment.nextHand') : '' }), 'join');
      break;
    }
    case 'start': {
      between(s); notPaused(s);
      for (const p of [...s.players]) if (p.leaving) remove(s, p);
      const participants = ordered(s).filter(p => p.stack > 0 && !p.sittingOut);
      requireRule(participants.length >= 2, s.players.some(p => p.sittingOut) ? msg('error.playersAvailable') : msg('error.playersRequired'));
      const ids = participants.map(p => p.id);
      const positions = nextPositions(s);
      const dealer = player(s, positions.dealer), small = player(s, positions.small), big = player(s, positions.big);
      const requestedStraddle = s.nextStraddle;
      const straddler = s.config.straddle && requestedStraddle && positions.utg === requestedStraddle ? player(s, requestedStraddle) : null;
      s.nextStraddle = null;
      s.dealerSeat = dealer.seat; s.handNumber += 1; setBalanceNote(s, '');
      if (s.config.levelEvery > 0 && s.handNumber - s.levelHand >= s.config.levelEvery && s.level < LEVELS.length - 1) {
        s.level += 1; s.levelHand = s.handNumber;
        const up = levelBlinds(s);
        log(s, msg('log.levelUp', { small: up.small, big: up.big, ante: up.ante ? msg('fragment.ante', { amount: up.ante }) : '' }), 'level');
      }
      const b = levelBlinds(s), at = nowIso();
      if (!s.startedAt) s.startedAt = at;
      for (const p of s.players) { p.inHand = ids.includes(p.id); p.folded = false; p.waiting = false; p.bet = 0; p.contribution = 0; }
      s.hand = { number: s.handNumber, dealer: dealer.id, dealerSeat: dealer.seat, small: small.id, big: big.id, street: 0, phase: 'betting', currentBet: b.big, lastFullRaise: b.big, smallBlind: b.small, bigBlind: b.big, ante: b.ante, actor: null, actorSince: null, pending: ids, shortAllIn: false, participants: ids, selections: null, preview: null, board: [], holes: {}, deck: [], burned: [], holeDealt: false, revealed: {}, handNames: {}, mucked: [], autoJudged: false,
        startedAt: at, startStacks: Object.fromEntries(participants.map(p => [p.id, p.stack])), actions: [], vpip: [], actedAt: {},
        runs: 1, runVotes: {}, runResolved: false, boards: [[]], sharedBoardCount: 0, boardHandNames: [{}], handNamesMessage: {}, boardHandNamesMessage: [{}], showOrder: [], riverAggressor: null,
        straddle: straddler?.id || null, anteMode: s.config.anteMode, bigBlindAnte: 0 };
      log(s, msg('log.start', { name: dealer.name }), 'start');
      if (requestedStraddle && !straddler) log(s, msg('log.straddleIgnored'), 'blind');
      if (b.ante && s.config.anteMode === 'each') {
        for (const p of participants) { const paid = Math.min(b.ante, p.stack); p.stack -= paid; p.contribution += paid; note(s, { a: 'ante', id: p.id, amount: paid, allin: p.stack === 0 }); }
        log(s, msg('log.anteEach', { amount: b.ante, allin: participants.some(p => p.stack === 0) ? msg('fragment.anteAllIn', { names: joinMessages(participants.filter(p => p.stack === 0).map(p => p.name), msg('separator.names')) }) : '' }), 'blind');
      }
      for (const [p, amount, label, a] of [[small, b.small, msg('blind.sb'), 'sb'], [big, b.big, msg('blind.bb'), 'bb']]) {
        const paid = Math.min(amount, p.stack);
        if (!paid) { log(s, msg('log.blindSkipped', { name: p.name, blind: label }), 'blind'); continue; }
        invest(p, paid); note(s, { a, id: p.id, amount: paid, allin: p.stack === 0 });
        log(s, msg('log.blind', { name: p.name, blind: label, allin: p.stack === 0 ? msg('fragment.allIn') : '', amount: paid }), 'blind');
      }
      if (b.ante && s.config.anteMode === 'bigBlind') {
        const paid = Math.min(b.ante, big.stack);
        big.stack -= paid; big.contribution += paid; s.hand.bigBlindAnte = paid;
        note(s, { a: 'ante', id: big.id, amount: paid, allin: big.stack === 0, anteMode: 'bigBlind' });
        log(s, msg('log.bigBlindAnte', { name: big.name, amount: paid, detail: paid < b.ante ? msg('fragment.anteShort', { amount: b.ante }) : msg('fragment.tableAnte') }), 'blind');
      }
      if (straddler) {
        const paid = Math.min(2 * b.big, straddler.stack);
        invest(straddler, paid); s.hand.currentBet = 2 * b.big; s.hand.lastFullRaise = 2 * b.big;
        note(s, { a: 'straddle', id: straddler.id, amount: paid, allin: straddler.stack === 0 });
        log(s, msg('log.straddle', { name: straddler.name, amount: paid, blind: 2 * b.big, short: paid < 2 * b.big ? msg('fragment.shortAllIn') : '' }), 'blind');
      }
      if (isDigital(s)) dealHoles(s);
      finishOrAdvance(s, straddler?.seat || big.seat);
      break;
    }
    case 'runVote': {
      notPaused(s);
      const h = s.hand, id = actorId || args.playerId;
      requireRule(h?.phase === 'runChoice', msg('error.runVotePhase'));
      requireRule(live(s).some(p => p.id === id), msg('error.runVoteEligible'));
      requireRule(!Object.hasOwn(h.runVotes, id), msg('error.runVoted'));
      integer(args.runs, 1, h.runMax);
      if (!actorId) requireRule(args.actorOffline === true, msg('error.playerOnline'));
      const by = actorId ? '' : msg('reason.offline');
      h.runVotes[id] = args.runs;
      note(s, { a: 'runVote', id, runs: args.runs, ...(by ? { by: defaultText(by), byMessage: describe(by) } : {}) });
      log(s, msg('log.runVote', { name: player(s, id).name, runs: args.runs, by: by ? msg('fragment.host', { reason: by }) : '' }), 'runout');
      if (live(s).every(p => Object.hasOwn(h.runVotes, p.id))) resolveRuns(s, Math.min(...live(s).map(p => h.runVotes[p.id])));
      break;
    }
    case 'runOnce': {
      notPaused(s); requireRule(s.hand?.phase === 'runChoice', msg('error.runVotePhase'));
      resolveRuns(s, 1, msg('reason.hostRunOnce')); break;
    }
    case 'straddle': {
      between(s); const id = actorId || args.playerId;
      requireRule(s.config.straddle, msg('error.straddleDisabled'));
      requireRule(typeof args.enabled === 'boolean', msg('error.straddleSetting'));
      requireRule(!!player(s, id), msg('error.seatMissing'));
      requireRule(args.enabled ? nextPositions(s)?.utg === id : s.nextStraddle === id, msg('error.straddleEligible'));
      s.nextStraddle = args.enabled ? id : null;
      log(s, msg(args.enabled ? 'log.straddleReserve' : 'log.straddleCancel', { name: player(s, id).name, by: actorId ? '' : msg('fragment.hostSetting') }), 'settings');
      break;
    }
    case 'act': notPaused(s); performAct(s, actorId, args); break;
    case 'timeout': {
      notPaused(s);
      const h = s.hand; requireRule(h?.phase === 'betting' && !!h.actor, msg('error.noActor'));
      const clock = s.config.actionClock || 0;
      const expired = clock > 0 && h.actorSince && Date.now() - Date.parse(h.actorSince) >= clock * 1000;
      requireRule(expired || args.actorOffline === true, msg('error.actorNotExpired'));
      const legal = legalActions(s, h.actor);
      performAct(s, h.actor, { action: legal?.check ? 'check' : 'fold' }, msg(expired ? 'reason.timeout' : 'reason.offline'));
      break;
    }
    case 'next': {
      notPaused(s);
      requireRule(s.hand?.phase === 'roundEnd' && s.hand.street < 3, msg('error.nextStreet'));
      const h = s.hand; h.street += 1; h.phase = 'betting'; h.currentBet = 0; h.lastFullRaise = h.bigBlind; h.shortAllIn = false;
      h.actedAt = {};
      for (const p of s.players) p.bet = 0;
      h.pending = able(s).map(p => p.id);
      if (isDigital(s)) dealBoard(s, h.street === 1 ? 3 : 1);
      note(s, { a: 'street', board: [...h.board] });
      log(s, msg('log.street', { street: streetMessage(h.street) }), 'next');
      finishOrAdvance(s, h.dealerSeat);
      break;
    }
    case 'preview': {
      requireRule(s.hand?.phase === 'showdown', msg('error.showdown'));
      if (isDigital(s) && s.hand.autoJudged) {
        requireRule(args.selections === null || sameSelections(args.selections, s.hand.selections), msg('error.digitalJudgment'));
        s.hand.preview = previewSettlement(s, s.hand.selections);
        break;
      }
      s.hand.preview = args.selections === null ? null : previewSettlement(s, args.selections);
      s.hand.selections = structuredClone(args.selections);
      break;
    }
    case 'settle': {
      requireRule(s.hand?.phase === 'showdown', msg('error.showdown'));
      let selections = args.selections;
      if (isDigital(s) && s.hand.autoJudged) {
        const judged = autoWinners(s);
        requireRule(sameSelections(selections, judged), msg('error.digitalJudgment'));
        selections = judged;
      }
      const preview = previewSettlement(s, selections);
      requireRule(args.expectedTotal === preview.distributed, msg('error.previewChanged'));
      const contrib = Object.fromEntries(s.players.filter(p => p.contribution > 0).map(p => [p.id, p.contribution]));
      for (const p of s.players) { p.stack += preview.awards[p.id]; p.contribution = 0; p.bet = 0; }
      for (const detail of preview.details) log(s, msg('log.settle', { run: s.hand.runs > 1 ? msg('fragment.run', { run: detail.run }) : '', pot: detail.nameMessage || detail.name, amount: detail.amount, odd: detail.runOdd ? msg('fragment.runOdd') : '', winners: joinMessages(detail.winners.map(id => msg('log.award', { name: player(s, id).name, amount: detail.shares[id], odd: detail.oddRecipients.includes(id) ? msg('fragment.oddChip') : '' }))) }), 'settle');
      s.hand.phase = 'settled'; s.hand.actor = null; s.hand.actorSince = null; s.hand.pending = []; s.hand.preview = preview; s.hand.selections = selections;
      record(s, preview, contrib);
      break;
    }
    case 'show': {
      requireRule(isDigital(s), msg('error.physicalShow'));
      const h = s.hand, p = player(s, actorId);
      requireRule(!!p && !!h && (h.phase === 'showdown' || h.phase === 'settled'), msg('error.showAfterHand'));
      requireRule(h.participants.includes(p.id) && h.holes?.[p.id]?.length === 2, msg('error.notInHand'));
      requireRule(!h.revealed[p.id], msg('error.alreadyShown'));
      reveal(s, p);
      h.mucked = (h.mucked || []).filter(id => id !== p.id);
      log(s, msg('log.show', { name: p.name, cards: h.revealed[p.id].join(' '), hand: h.handNames[p.id] ? msg('fragment.handSuffix', { hand: h.handNamesMessage[p.id] || h.handNames[p.id] }) : '' }), 'show');
      const rec = s.records.at(-1);
      if (h.phase === 'settled' && rec?.n === h.number) { rec.shown[p.id] = [...h.revealed[p.id]]; if (h.handNames[p.id]) rec.hands[p.id] = h.handNames[p.id]; rec.boardHands = structuredClone(h.boardHandNames); rec.handsMessage = structuredClone(h.handNamesMessage); rec.boardHandsMessage = structuredClone(h.boardHandNamesMessage); rec.actions.push({ a: 'show', id: p.id, street: h.street, pot: 0 }); }
      else note(s, { a: 'show', id: p.id });
      break;
    }
    case 'rebuySetting': between(s); requireRule(typeof args.enabled === 'boolean', msg('error.rebuySetting')); s.config.rebuy = args.enabled; log(s, msg(args.enabled ? 'log.rebuyOn' : 'log.rebuyOff'), 'settings'); break;
    case 'rebuy': {
      between(s); requireRule(s.config.rebuy, msg('error.rebuyClosed'));
      const p = player(s, args.playerId); requireRule(!!p, msg('error.seatMissing'));
      integer(args.amount); integer(p.stack + args.amount);
      p.stack += args.amount; s.total += args.amount; setBalanceNote(s, msg('balance.rebuy', { amount: args.amount }));
      const r = s.roster[p.id]; if (r) { r.buyIn += args.amount; r.rebuys += 1; }
      log(s, msg('log.rebuy', { name: p.name, amount: args.amount }), 'rebuy'); break;
    }
    case 'move': {
      between(s); const p = player(s, args.playerId); requireRule(!!p, msg('error.seatMissing'));
      requireRule(args.direction === 1 || args.direction === -1, msg('error.direction'));
      const seat = (p.seat - 1 + args.direction + 10) % 10 + 1;
      const other = s.players.find(q => q.seat === seat);
      if (other) other.seat = p.seat;
      p.seat = seat;
      log(s, msg(args.direction === 1 ? 'log.moveClockwise' : 'log.moveCounterclockwise', { name: p.name }), 'move'); break;
    }
    case 'seat': {
      between(s); const p = player(s, args.playerId); requireRule(!!p, msg('error.seatMissing')); integer(args.seat, 1, 10);
      requireRule(args.seat !== p.seat, msg('error.sameSeat'));
      const other = s.players.find(q => q.seat === args.seat);
      if (other) other.seat = p.seat;
      p.seat = args.seat;
      log(s, other ? msg('log.swap', { name: p.name, other: other.name }) : msg('log.seat', { name: p.name, seat: args.seat }), 'move'); break;
    }
    case 'leave': {
      const p = player(s, actorId || args.playerId); requireRule(!!p, msg('error.seatMissing'));
      if (ongoing(s)) { requireRule(!!actorId, msg('error.betweenHands')); p.leaving = true; log(s, msg('log.leaveRequest', { name: p.name }), 'leaveRequest'); }
      else remove(s, p);
      break;
    }
    case 'sitOut': {
      const p = player(s, actorId || args.playerId); requireRule(!!p, msg('error.seatMissing'));
      requireRule(typeof args.away === 'boolean', msg('error.sitOutSetting'));
      requireRule(p.sittingOut !== args.away, args.away ? msg('error.alreadyAway') : msg('error.alreadyPresent'));
      p.sittingOut = args.away;
      const mid = ongoing(s) && p.inHand && !p.folded;
      log(s, args.away ? msg('log.sitOut', { name: p.name, after: mid ? msg('fragment.afterHand') : '' }) : msg('log.return', { name: p.name }), 'sitout');
      break;
    }
    case 'pause': {
      requireRule(typeof args.on === 'boolean', msg('error.pauseSetting'));
      if (args.on) { requireRule(!s.paused, msg('error.alreadyPaused')); s.paused = { at: nowIso() }; log(s, msg('log.pause'), 'pause'); }
      else {
        requireRule(!!s.paused, msg('error.notPaused'));
        const away = Date.now() - Date.parse(s.paused.at);
        if (s.hand?.actorSince) s.hand.actorSince = new Date(Date.parse(s.hand.actorSince) + away).toISOString();
        s.paused = null; log(s, msg('log.resume'), 'pause');
      }
      break;
    }
    case 'level': {
      between(s); requireRule(args.delta === 1 || args.delta === -1, msg('error.levelStep'));
      const level = s.level + args.delta; requireRule(level >= 0 && level < LEVELS.length, args.delta > 0 ? msg('error.levelMax') : msg('error.levelMin'));
      s.level = level; s.levelHand = s.handNumber + 1;
      const b = levelBlinds(s); log(s, msg('log.levelSet', { small: b.small, big: b.big, ante: b.ante ? msg('fragment.ante', { amount: b.ante }) : '' }), 'level'); break;
    }
    case 'settings': {
      between(s);
      const patch = {};
      for (const k of ['ante', 'levelEvery', 'actionClock', 'runouts', 'straddle', 'anteMode']) if (args[k] !== undefined) patch[k] = args[k];
      requireRule(Object.keys(patch).length > 0, msg('error.settingsEmpty'));
      const next = validConfig(patch, s.config);
      const text = [];
      if (next.ante !== s.config.ante) text.push(next.ante ? msg('setting.ante', { amount: next.ante }) : msg('setting.anteOff'));
      if (next.levelEvery !== s.config.levelEvery) { text.push(next.levelEvery ? msg('setting.levelEvery', { hands: next.levelEvery }) : msg('setting.levelOff')); s.levelHand = s.handNumber + 1; }
      if (next.actionClock !== s.config.actionClock) text.push(next.actionClock ? msg('setting.clock', { seconds: next.actionClock }) : msg('setting.clockOff'));
      if (next.runouts !== s.config.runouts) text.push(next.runouts === 1 ? msg('setting.runOff') : msg('setting.runMax', { runs: next.runouts }));
      if (next.straddle !== s.config.straddle) text.push(msg(next.straddle ? 'setting.straddleOn' : 'setting.straddleOff'));
      if (next.anteMode !== s.config.anteMode) text.push(msg(next.anteMode === 'bigBlind' ? 'setting.anteBigBlind' : 'setting.anteEach'));
      s.config = next;
      if (text.length) log(s, msg('log.settings', { settings: joinMessages(text) }), 'settings');
      break;
    }
    case 'setDealMode': {
      between(s);
      requireRule(args.dealMode === 'physical' || args.dealMode === 'digital', msg('error.dealMode'));
      s.config.dealMode = args.dealMode;
      log(s, msg('log.dealMode', { mode: msg(args.dealMode === 'digital' ? 'setting.digital' : 'setting.physical') }), 'settings');
      break;
    }
    case 'end': {
      between(s);
      s.status = 'ended'; s.endedAt = nowIso(); s.paused = null;
      for (const p of s.players) { p.leaving = false; p.waiting = false; }
      log(s, msg('log.end', { hands: s.handNumber }), 'end');
      break;
    }
    default: throw new RuleError(msg('error.commandUnknown'));
  }
}
