// 无上限规则：短加注仍须补跟或弃牌，但不足完整加注时不重开已行动者的加注权。
// 多次短加注累计达到完整幅度时，按每位玩家上次行动后的增量判断（TDA 49）。
import { takeDeck, winnersAmong, handName, evaluate, sameSelections } from './cards.js';
export const STREETS = ['翻前', '翻牌圈', '转牌圈', '河牌圈'];
export const LIMIT = 1_000_000_000;
export class RuleError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function requireRule(condition, message, status) {
  if (!condition) throw new RuleError(message, status);
}
export function integer(value, min = 1, max = LIMIT) {
  requireRule(Number.isSafeInteger(value) && value >= min && value <= max, `需要 ${min}–${max} 之间的整数。`);
  return value;
}
function name(value, max) {
  requireRule(typeof value === 'string', '请填写名字。');
  const result = value.trim();
  requireRule([...result].length >= 1 && [...result].length <= max && !/[\p{Cc}\p{Cf}]/u.test(value), `名字需要 1–${max} 个字，不能含控制字符。`);
  return result;
}
export const CLOCKS = [0, 20, 30, 45, 60, 90];
export const LEVELS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100];
const nowIso = () => new Date().toISOString();
function validConfig(config, base = {}) {
  const c = { ...base, ...config };
  const { smallBlind = 10, bigBlind = 20, startingStack = 2000, dealMode = 'physical', ante = 0, levelEvery = 0, actionClock = 0 } = c;
  integer(smallBlind); integer(bigBlind, smallBlind); integer(startingStack, bigBlind);
  integer(ante, 0, bigBlind);
  requireRule(Number.isSafeInteger(levelEvery) && (levelEvery === 0 || (levelEvery >= 3 && levelEvery <= 200)), '涨盲间隔需要 3–200 手，或关闭。');
  requireRule(CLOCKS.includes(actionClock), '行动计时只能选关闭或 20/30/45/60/90 秒。');
  requireRule(dealMode === 'physical' || dealMode === 'digital', '打牌方式无效。');
  return { name: name(c.name ?? '今晚的牌局', 16), smallBlind, bigBlind, startingStack, rebuy: c.rebuy === true, dealMode, ante, levelEvery, actionClock };
}
export function newRoom(code, config = {}) {
  return { code, config: validConfig(config), version: 0, total: 0, players: [], hand: null, handNumber: 0, dealerSeat: 0, logs: [], balanceNote: '',
    status: 'open', createdAt: nowIso(), startedAt: null, endedAt: null, level: 0, levelHand: 1, paused: null, roster: {}, records: [], statsFrom: 1, nextRoom: null };
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
    if (!s.hand.holes) s.hand.holes = {};
    if (!Array.isArray(s.hand.deck)) s.hand.deck = [];
    if (!Array.isArray(s.hand.burned)) s.hand.burned = [];
    if (s.hand.holeDealt === undefined) s.hand.holeDealt = false;
    if (!s.hand.revealed) s.hand.revealed = {};
    if (!s.hand.handNames) s.hand.handNames = {};
    if (!Number.isSafeInteger(s.hand.bigBlind)) s.hand.bigBlind = s.config.bigBlind;
    // 升级前已在进行的一手没有结构化动作，不进入牌谱统计。
    if (!Array.isArray(s.hand.actions)) { s.hand.actions = []; s.hand.untracked = true; }
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
  s.logs.push({ id: `${s.version + 1}-${s.logs.length}`, at: new Date().toISOString(), hand: s.handNumber, text, kind });
}
function clockwise(s, after, ids) {
  return ordered(s).filter(p => ids.includes(p.id)).sort((a, b) => ((a.seat - after + 9) % 10) - ((b.seat - after + 9) % 10));
}
function nextId(s, after, ids) { return clockwise(s, after, ids)[0]?.id ?? null; }
function invest(p, amount) { p.stack -= amount; p.bet += amount; p.contribution += amount; }
function note(s, entry) { if (s.hand && Array.isArray(s.hand.actions)) s.hand.actions.push({ ...entry, street: s.hand.street, pot: potTotal(s) }); }
function setActor(s, id) { const h = s.hand; if (h.actor !== id) h.actorSince = id ? nowIso() : null; h.actor = id; }

function draw(h) {
  requireRule(Array.isArray(h.deck) && h.deck.length > 0, '牌叠不够了。');
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
  h.holes = {};
  h.revealed = {};
  h.handNames = {};
  h.autoJudged = false;
  const order = dealOrder(s);
  for (let round = 0; round < 2; round++) for (const p of order) (h.holes[p.id] ??= []).push(draw(h));
  h.holeDealt = true;
  log(s, '已发底牌', 'deal');
}
function dealBoard(s, count) {
  const h = s.hand;
  h.burned.push(draw(h));
  for (let i = 0; i < count; i++) h.board.push(draw(h));
}
export function autoWinners(s) {
  const holes = s.hand.holes || {};
  const board = s.hand.board || [];
  return Object.fromEntries(pots(s).map(pot => {
    if (pot.eligible.length <= 1) return [pot.id, [...pot.eligible]];
    return [pot.id, winnersAmong(pot.eligible, holes, board)];
  }));
}
function reveal(s, p) {
  const h = s.hand, holes = h.holes?.[p.id];
  if (!holes || holes.length !== 2) return;
  h.revealed[p.id] = [...holes];
  if (h.board.length >= 3) h.handNames[p.id] = handName(evaluate([...holes, ...h.board]));
}
// 摊牌时只要有存活者全下，所有存活者亮牌；否则只亮赢家，其余默认盖牌，可以自己选择亮。
// 牌型名只给已亮的人，日志不写盖牌者的牌力。
function digitalShowdown(s) {
  const h = s.hand, survivors = live(s);
  h.autoJudged = true;
  h.revealed = {};
  h.handNames = {};
  h.mucked = [];
  h.selections = autoWinners(s);
  h.preview = previewSettlement(s, h.selections);
  if (survivors.length <= 1) {
    if (survivors[0]) log(s, `摊牌 · 只剩 ${survivors[0].name}，不必亮牌`, 'showdown');
    return;
  }
  const runout = survivors.some(p => p.stack === 0);
  const winners = new Set(Object.values(h.selections).flat());
  const shown = survivors.filter(p => runout || winners.has(p.id));
  for (const p of shown) reveal(s, p);
  h.mucked = survivors.filter(p => !shown.includes(p)).map(p => p.id);
  log(s, `摊牌 · ${shown.map(p => `${p.name} ${h.handNames[p.id]}`).join(' · ')}${h.mucked.length ? ` · ${h.mucked.length} 人盖牌` : ''}`, 'showdown');
}
function runOutDigital(s) {
  const h = s.hand;
  while (h.street < 3) {
    h.street += 1;
    h.currentBet = 0;
    h.lastFullRaise = h.bigBlind;
    h.shortAllIn = false;
    for (const p of s.players) p.bet = 0;
    dealBoard(s, h.street === 1 ? 3 : 1);
    note(s, { a: 'street', board: [...h.board] });
    log(s, `进入${STREETS[h.street]}`, 'next');
  }
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
    s.hand.handNames = Object.fromEntries(Object.entries(s.hand.handNames || {}).filter(([id]) => s.hand.revealed[id]));
  }
  return { state: s, hole };
}

export function assertConservation(s) {
  requireRule(Number.isSafeInteger(s.total) && s.total >= 0, '全场积分无效。');
  requireRule(new Set(s.players.map(p => p.seat)).size === s.players.length, '座位重复。');
  requireRule(s.players.every(p => [p.stack, p.bet, p.contribution].every(n => Number.isSafeInteger(n) && n >= 0) && p.bet <= p.contribution), '筹码记录无效。');
  requireRule(s.players.reduce((n, p) => n + p.stack, 0) + potTotal(s) === s.total, '分配后对不上全场积分，先不要确认。');
  requireRule(pots(s).reduce((sum, p) => sum + p.amount, 0) === potTotal(s), '分池总额对不上。');
  return true;
}
// 以投入层级计算资格；弃牌筹码仍计入金额，同一资格的连续层合并。
export function pots(s) {
  const levels = [...new Set(s.players.map(p => p.contribution).filter(Boolean))].sort((a, b) => a - b);
  const result = [];
  let previous = 0;
  for (const level of levels) {
    const contributors = ordered(s).filter(p => p.contribution >= level);
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
  return result.map((p, i) => ({ ...p, name: i === 0 ? '主池' : i === 1 ? '边池' : `边池 ${i}`, forming: ongoing(s) && s.hand.phase !== 'showdown' }));
}
// 一轮结束时退回没人匹配的本轮投入；前注不在 bet 中，不能退款。
function refundUncalled(s) {
  const sorted = [...s.players].sort((a, b) => b.bet - a.bet);
  if (sorted.length < 2 || sorted[0].folded) return;
  const excess = sorted[0].bet - sorted[1].bet;
  if (excess > 0) {
    const p = sorted[0]; p.bet -= excess; p.contribution -= excess; p.stack += excess;
    note(s, { a: 'refund', id: p.id, amount: excess });
    log(s, `${p.name} 未被跟注退回 ${excess}`, 'refund');
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
  if (isDigital(s) && live(s).length > 1 && h.street < 3 && able(s).length <= 1) {
    runOutDigital(s);
    h.phase = 'showdown';
    digitalShowdown(s);
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
  requireRule(s.hand?.phase === 'showdown', '还没到摊牌。');
  requireRule(selections && typeof selections === 'object' && !Array.isArray(selections), '每个池都要指定赢家。');
  const allPots = pots(s);
  requireRule(Object.keys(selections).length === allPots.length, '每个池都要指定赢家。');
  const awards = Object.fromEntries(s.players.map(p => [p.id, 0]));
  const details = allPots.map(pot => {
    const winners = selections[pot.id];
    requireRule(Array.isArray(winners) && winners.length > 0 && new Set(winners).size === winners.length, '每个池都要指定不同的赢家。');
    requireRule(winners.every(id => pot.eligible.includes(id)), '有人没有资格赢这个池。');
    // 每个池分别平分，奇数筹码从按钮左侧起，顺时针给最近的赢家（TDA 21）。
    const order = clockwise(s, s.hand.dealerSeat, winners).map(p => p.id);
    const each = Math.floor(pot.amount / winners.length), remainder = pot.amount % winners.length;
    const shares = Object.fromEntries(order.map((id, i) => [id, each + (i < remainder ? 1 : 0)]));
    for (const [id, value] of Object.entries(shares)) awards[id] += value;
    return { ...pot, winners: order, each, remainder, oddRecipients: order.slice(0, remainder), shares };
  });
  const distributed = Object.values(awards).reduce((a, b) => a + b, 0);
  const afterTotal = s.players.reduce((sum, p) => sum + p.stack + awards[p.id], 0);
  requireRule(distributed === potTotal(s) && afterTotal === s.total, '分配后对不上全场积分，先不要确认。');
  return { awards, details, distributed, afterTotal, balanced: true };
}
function between(s) { requireRule(!ongoing(s), '这一手结束再调。'); }
function remove(s, p) {
  requireRule(!!p, '座位不存在。');
  s.total -= p.stack; s.balanceNote = `有人离开 −${p.stack}`;
  const r = s.roster[p.id];
  if (r) { r.cashOut += p.stack; r.seated = false; r.leftAt = nowIso(); r.seat = p.seat; }
  log(s, `${p.name}离开，带走 ${p.stack}`, 'leave');
  s.players = s.players.filter(q => q.id !== p.id);
}
export function apply(s, type, args = {}, actorId = null) {
  const state = normalizeRoom(structuredClone(s));
  mutate(state, type, args, actorId);
  assertConservation(state);
  return state;
}
function notPaused(s) { requireRule(!s.paused, '正在休息。主持人点「继续」之后再来。'); }
function performAct(s, id, args, by = '') {
  const p = player(s, id), h = s.hand, legal = legalActions(s, id);
  requireRule(!!legal, '还没轮到你，或本轮行动已结束。');
  const action = args.action;
  requireRule(['fold', 'check', 'call', 'raise', 'allin'].includes(action), '未知行动。');
  h.shortAllIn = false;
  let description, fullRaise = false, amount = 0;
  if (action === 'fold') { p.folded = true; description = '弃牌'; }
  if (action === 'check') { requireRule(legal.check, '当前不能过牌，需要跟注。'); description = '过牌'; }
  if (action === 'call') {
    requireRule(legal.call > 0, '没有需要跟注的筹码。');
    requireRule(p.stack > legal.call, '剩余筹码只能全下，请确认全下。');
    amount = legal.call; invest(p, amount); description = `跟注 ${legal.call}`;
  }
  if (action === 'raise' || action === 'allin') {
    if (action === 'allin') requireRule(legal.allIn, '当前只能跟注或弃牌，不能再加注。');
    const target = action === 'allin' ? legal.maxRaiseTo : integer(args.to, 1, Number.MAX_SAFE_INTEGER);
    requireRule(target <= legal.maxRaiseTo && target > p.bet, '不能投入超过自己的剩余筹码。');
    if (action === 'raise') requireRule(legal.raise && target >= legal.minRaiseTo, `最小加注到 ${legal.minRaiseTo}。`);
    const delta = target - h.currentBet;
    amount = target - p.bet;
    fullRaise = delta >= h.lastFullRaise;
    if (target > h.currentBet) {
      h.shortAllIn = !fullRaise;
      if (fullRaise) h.lastFullRaise = delta;
      h.currentBet = target;
    }
    invest(p, amount);
    description = p.stack === 0 ? `全下 ${amount}${h.shortAllIn ? ' · 短码' : ''}` : `${legal.call === 0 && h.currentBet === target && target === delta ? '下注' : '加注'}到 ${target} · 再投入 ${amount}`;
  }
  if (h.street === 0 && amount > 0 && Array.isArray(h.vpip) && !h.vpip.includes(p.id)) h.vpip.push(p.id);
  h.actedAt[p.id] = h.currentBet;
  h.pending = able(s).filter(q => q.id !== p.id && (h.pending.includes(q.id) || q.bet < h.currentBet)).map(q => q.id);
  note(s, { a: action, id: p.id, amount, to: p.bet, allin: p.stack === 0 && action !== 'fold', ...(by ? { by } : {}) });
  log(s, `${p.name} ${description}${by ? ` · 主持代（${by}）` : ''}`);
  finishOrAdvance(s, p.seat);
}
function record(s, preview, contrib) {
  const h = s.hand;
  if (h.untracked) return;
  const awards = Object.fromEntries(Object.entries(preview.awards).filter(([, v]) => v > 0));
  s.records.push({
    n: h.number, at: h.startedAt || null, end: nowIso(), mode: s.config.dealMode,
    blinds: { small: h.smallBlind ?? s.config.smallBlind, big: h.bigBlind, ante: h.ante || 0 },
    dealer: h.dealer, small: h.small, big: h.big,
    seats: Object.fromEntries(h.participants.map(id => { const p = player(s, id); return [id, { name: p.name, seat: p.seat, start: h.startStacks?.[id] ?? null }]; })),
    actions: h.actions, board: [...h.board], shown: structuredClone(h.revealed || {}), hands: { ...(h.handNames || {}) },
    folded: h.participants.filter(id => player(s, id).folded), showdown: live(s).length > 1,
    pots: preview.details.map(d => ({ name: d.name, amount: d.amount, winners: d.winners, shares: d.shares })),
    awards, contrib, vpip: [...(h.vpip || [])]
  });
}
function mutate(s, type, args, actorId) {
  requireRule(!isEnded(s), '牌局已经结束，只能查看。');
  switch (type) {
    case 'join': {
      requireRule(s.players.length < 10, '这张桌子已经坐满。');
      const nm = name(args.name, 8); integer(args.seat, 1, 10);
      requireRule(!s.players.some(p => p.name === nm), '已经有人叫这个名字。换一个，大家才分得清。');
      requireRule(!Object.values(s.roster).some(r => r.id !== args.id && r.name === nm), '今晚已经有人用过这个名字。如果就是你，请用「这是我，换了手机」认领。');
      requireRule(!s.players.some(p => p.seat === args.seat), '这个座位已经有人。');
      requireRule(typeof args.id === 'string' && !player(s, args.id), '玩家身份无效。');
      const p = { id: args.id, name: nm, seat: args.seat, stack: s.config.startingStack, contribution: 0, bet: 0, folded: false, inHand: false, waiting: ongoing(s), leaving: false, sittingOut: false };
      const back = s.roster[args.id];
      s.players.push(p); s.total += p.stack; s.balanceNote = `入座 +${p.stack}`;
      if (back) { back.buyIn += p.stack; back.seated = true; back.leftAt = null; back.seat = p.seat; back.name = nm; back.returns = (back.returns || 0) + 1; }
      else s.roster[p.id] = { id: p.id, name: nm, seat: p.seat, buyIn: p.stack, cashOut: 0, rebuys: 0, joinedAt: nowIso(), joinedHand: s.handNumber + 1, leftAt: null, seated: true };
      log(s, `${nm}${back ? '回到桌上，' : ''}坐到 ${p.seat} 号位 · 起始 ${p.stack}${p.waiting ? ' · 下一手' : ''}`, 'join');
      break;
    }
    case 'start': {
      between(s); notPaused(s);
      for (const p of [...s.players]) if (p.leaving) remove(s, p);
      const participants = ordered(s).filter(p => p.stack > 0 && !p.sittingOut);
      requireRule(participants.length >= 2, s.players.some(p => p.sittingOut) ? '至少两位有筹码、没有暂离的玩家才能开始。' : '至少两位有筹码的玩家坐下后才能开始。');
      const ids = participants.map(p => p.id);
      // 多人转单挑时，仍在桌上的原大盲改下小盲，避免连续两手交大盲。
      const headsUpTransition = participants.length === 2 && s.hand?.participants.length > 2 && ids.includes(s.hand.big);
      const dealer = player(s, headsUpTransition ? s.hand.big : nextId(s, s.dealerSeat, ids));
      const small = participants.length === 2 ? dealer : player(s, nextId(s, dealer.seat, ids));
      const big = player(s, nextId(s, small.seat, ids));
      s.dealerSeat = dealer.seat; s.handNumber += 1; s.balanceNote = '';
      if (s.config.levelEvery > 0 && s.handNumber - s.levelHand >= s.config.levelEvery && s.level < LEVELS.length - 1) {
        s.level += 1; s.levelHand = s.handNumber;
        const up = levelBlinds(s);
        log(s, `盲注升到 ${up.small}/${up.big}${up.ante ? ` · 前注 ${up.ante}` : ''}`, 'level');
      }
      const b = levelBlinds(s), at = nowIso();
      if (!s.startedAt) s.startedAt = at;
      for (const p of s.players) { p.inHand = ids.includes(p.id); p.folded = false; p.waiting = false; p.bet = 0; p.contribution = 0; }
      s.hand = { number: s.handNumber, dealer: dealer.id, dealerSeat: dealer.seat, small: small.id, big: big.id, street: 0, phase: 'betting', currentBet: b.big, lastFullRaise: b.big, smallBlind: b.small, bigBlind: b.big, ante: b.ante, actor: null, actorSince: null, pending: ids, shortAllIn: false, participants: ids, selections: null, preview: null, board: [], holes: {}, deck: [], burned: [], holeDealt: false, revealed: {}, handNames: {}, mucked: [], autoJudged: false,
        startedAt: at, startStacks: Object.fromEntries(participants.map(p => [p.id, p.stack])), actions: [], vpip: [], actedAt: {} };
      log(s, `开新一手 · 庄 ${dealer.name}`, 'start');
      if (b.ante) {
        for (const p of participants) { const paid = Math.min(b.ante, p.stack); p.stack -= paid; p.contribution += paid; note(s, { a: 'ante', id: p.id, amount: paid, allin: p.stack === 0 }); }
        log(s, `前注 · 每人 ${b.ante}${participants.some(p => p.stack === 0) ? ` · ${participants.filter(p => p.stack === 0).map(p => p.name).join('、')}前注全下` : ''}`, 'blind');
      }
      for (const [p, amount, label, a] of [[small, b.small, '小盲', 'sb'], [big, b.big, '大盲', 'bb']]) {
        const paid = Math.min(amount, p.stack);
        if (!paid) { log(s, `${p.name} 已全下，不再下${label}`, 'blind'); continue; }
        invest(p, paid); note(s, { a, id: p.id, amount: paid, allin: p.stack === 0 });
        log(s, `${p.name} ${label}${p.stack === 0 ? '全下' : ''} ${paid}`, 'blind');
      }
      if (isDigital(s)) dealHoles(s);
      finishOrAdvance(s, big.seat);
      break;
    }
    case 'act': notPaused(s); performAct(s, actorId, args); break;
    case 'timeout': {
      notPaused(s);
      const h = s.hand; requireRule(h?.phase === 'betting' && !!h.actor, '现在没有人在行动。');
      const clock = s.config.actionClock || 0;
      const expired = clock > 0 && h.actorSince && Date.now() - Date.parse(h.actorSince) >= clock * 1000;
      requireRule(expired || args.actorOffline === true, '还没超时，他也在线。再等等他。');
      const legal = legalActions(s, h.actor);
      performAct(s, h.actor, { action: legal?.check ? 'check' : 'fold' }, expired ? '超时' : '掉线');
      break;
    }
    case 'next': {
      notPaused(s);
      requireRule(s.hand?.phase === 'roundEnd' && s.hand.street < 3, '还有人要行动，或没有下一轮。');
      const h = s.hand; h.street += 1; h.phase = 'betting'; h.currentBet = 0; h.lastFullRaise = h.bigBlind; h.shortAllIn = false;
      h.actedAt = {};
      for (const p of s.players) p.bet = 0;
      h.pending = able(s).map(p => p.id);
      if (isDigital(s)) dealBoard(s, h.street === 1 ? 3 : 1);
      note(s, { a: 'street', board: [...h.board] });
      log(s, `进入${STREETS[h.street]}`, 'next');
      finishOrAdvance(s, h.dealerSeat);
      break;
    }
    case 'preview': {
      requireRule(s.hand?.phase === 'showdown', '还没到摊牌。');
      if (isDigital(s) && s.hand.autoJudged) {
        requireRule(args.selections === null || sameSelections(args.selections, s.hand.selections), '电子牌由系统按牌力判定，不能改判。');
        s.hand.preview = previewSettlement(s, s.hand.selections);
        break;
      }
      s.hand.preview = args.selections === null ? null : previewSettlement(s, args.selections);
      s.hand.selections = structuredClone(args.selections);
      break;
    }
    case 'settle': {
      requireRule(s.hand?.phase === 'showdown', '还没到摊牌。');
      let selections = args.selections;
      if (isDigital(s) && s.hand.autoJudged) {
        const judged = autoWinners(s);
        requireRule(sameSelections(selections, judged), '电子牌由系统按牌力判定，不能改判。');
        selections = judged;
      }
      const preview = previewSettlement(s, selections);
      requireRule(args.expectedTotal === preview.distributed, '分池预览已经变化，请重新核对。');
      const contrib = Object.fromEntries(s.players.filter(p => p.contribution > 0).map(p => [p.id, p.contribution]));
      for (const p of s.players) { p.stack += preview.awards[p.id]; p.contribution = 0; p.bet = 0; }
      for (const detail of preview.details) log(s, `${detail.name} ${detail.amount} · ${detail.winners.map(id => `${player(s, id).name} +${detail.shares[id]}${detail.oddRecipients.includes(id) ? '（含余数 1）' : ''}`).join(' · ')}`, 'settle');
      s.hand.phase = 'settled'; s.hand.actor = null; s.hand.actorSince = null; s.hand.pending = []; s.hand.preview = preview; s.hand.selections = selections;
      record(s, preview, contrib);
      break;
    }
    case 'show': {
      requireRule(isDigital(s), '实体牌请直接把牌翻给大家看。');
      const h = s.hand, p = player(s, actorId);
      requireRule(!!p && !!h && (h.phase === 'showdown' || h.phase === 'settled'), '这一手结束后才能亮牌。');
      requireRule(h.participants.includes(p.id) && h.holes?.[p.id]?.length === 2, '你没有参与这一手。');
      requireRule(!h.revealed[p.id], '已经亮过了。');
      reveal(s, p);
      h.mucked = (h.mucked || []).filter(id => id !== p.id);
      log(s, `${p.name} 亮牌 ${h.revealed[p.id].join(' ')}${h.handNames[p.id] ? ` · ${h.handNames[p.id]}` : ''}`, 'show');
      const rec = s.records.at(-1);
      if (h.phase === 'settled' && rec?.n === h.number) { rec.shown[p.id] = [...h.revealed[p.id]]; if (h.handNames[p.id]) rec.hands[p.id] = h.handNames[p.id]; rec.actions.push({ a: 'show', id: p.id, street: h.street, pot: 0 }); }
      else note(s, { a: 'show', id: p.id });
      break;
    }
    case 'rebuySetting': between(s); requireRule(typeof args.enabled === 'boolean', '补码开关无效。'); s.config.rebuy = args.enabled; log(s, `补码${args.enabled ? '打开' : '关闭'}`, 'settings'); break;
    case 'rebuy': {
      between(s); requireRule(s.config.rebuy, '补码关着。打开后，每次加筹码都会写入日志。');
      const p = player(s, args.playerId); requireRule(!!p, '座位不存在。');
      integer(args.amount); integer(p.stack + args.amount);
      p.stack += args.amount; s.total += args.amount; s.balanceNote = `含补码 +${args.amount}`;
      const r = s.roster[p.id]; if (r) { r.buyIn += args.amount; r.rebuys += 1; }
      log(s, `补码 · ${p.name} +${args.amount}`, 'rebuy'); break;
    }
    case 'move': {
      between(s); const p = player(s, args.playerId); requireRule(!!p, '座位不存在。');
      requireRule(args.direction === 1 || args.direction === -1, '请选择顺时针或逆时针。');
      const seat = (p.seat - 1 + args.direction + 10) % 10 + 1;
      const other = s.players.find(q => q.seat === seat);
      if (other) other.seat = p.seat;
      p.seat = seat;
      log(s, `座位调整：${p.name}${args.direction === 1 ? '顺时针' : '逆时针'}一格`, 'move'); break;
    }
    case 'seat': {
      between(s); const p = player(s, args.playerId); requireRule(!!p, '座位不存在。'); integer(args.seat, 1, 10);
      requireRule(args.seat !== p.seat, '已经在这个座位。');
      const other = s.players.find(q => q.seat === args.seat);
      if (other) other.seat = p.seat;
      p.seat = args.seat;
      log(s, other ? `换座：${p.name} 和 ${other.name} 互换` : `换座：${p.name} 换到 ${args.seat} 号位`, 'move'); break;
    }
    case 'leave': {
      const p = player(s, actorId || args.playerId); requireRule(!!p, '座位不存在。');
      if (ongoing(s)) { requireRule(!!actorId, '这一手结束再调。'); p.leaving = true; log(s, `${p.name}将在这一手结束后离开`, 'leaveRequest'); }
      else remove(s, p);
      break;
    }
    case 'sitOut': {
      const p = player(s, actorId || args.playerId); requireRule(!!p, '座位不存在。');
      requireRule(typeof args.away === 'boolean', '暂离开关无效。');
      requireRule(p.sittingOut !== args.away, args.away ? '已经是暂离。' : '你已经在桌上。');
      p.sittingOut = args.away;
      const mid = ongoing(s) && p.inHand && !p.folded;
      log(s, args.away ? `${p.name} 暂离${mid ? ' · 这一手打完后' : ''}` : `${p.name} 回来了 · 下一手入局`, 'sitout');
      break;
    }
    case 'pause': {
      requireRule(typeof args.on === 'boolean', '暂停开关无效。');
      if (args.on) { requireRule(!s.paused, '已经在休息。'); s.paused = { at: nowIso() }; log(s, '休息一下', 'pause'); }
      else {
        requireRule(!!s.paused, '没有在休息。');
        const away = Date.now() - Date.parse(s.paused.at);
        if (s.hand?.actorSince) s.hand.actorSince = new Date(Date.parse(s.hand.actorSince) + away).toISOString();
        s.paused = null; log(s, '休息结束，继续', 'pause');
      }
      break;
    }
    case 'level': {
      between(s); requireRule(args.delta === 1 || args.delta === -1, '只能升一级或降一级。');
      const level = s.level + args.delta; requireRule(level >= 0 && level < LEVELS.length, args.delta > 0 ? '已经是最高一级。' : '已经是起始盲注。');
      s.level = level; s.levelHand = s.handNumber + 1;
      const b = levelBlinds(s); log(s, `主持把盲注调到 ${b.small}/${b.big}${b.ante ? ` · 前注 ${b.ante}` : ''} · 下一手起`, 'level'); break;
    }
    case 'settings': {
      between(s);
      const patch = {};
      for (const k of ['ante', 'levelEvery', 'actionClock']) if (args[k] !== undefined) patch[k] = args[k];
      requireRule(Object.keys(patch).length > 0, '没有要改的设置。');
      const next = validConfig(patch, s.config);
      const text = [];
      if (next.ante !== s.config.ante) text.push(next.ante ? `前注 ${next.ante}` : '关闭前注');
      if (next.levelEvery !== s.config.levelEvery) { text.push(next.levelEvery ? `每 ${next.levelEvery} 手涨盲` : '关闭涨盲'); s.levelHand = s.handNumber + 1; }
      if (next.actionClock !== s.config.actionClock) text.push(next.actionClock ? `行动计时 ${next.actionClock} 秒` : '关闭行动计时');
      s.config = next;
      if (text.length) log(s, `设置：${text.join(' · ')}`, 'settings');
      break;
    }
    case 'setDealMode': {
      between(s);
      requireRule(args.dealMode === 'physical' || args.dealMode === 'digital', '打牌方式无效。');
      s.config.dealMode = args.dealMode;
      log(s, `打牌方式改为${args.dealMode === 'digital' ? '电子牌' : '实体牌'}`, 'settings');
      break;
    }
    case 'end': {
      between(s);
      s.status = 'ended'; s.endedAt = nowIso(); s.paused = null;
      for (const p of s.players) { p.leaving = false; p.waiting = false; }
      log(s, `牌局结束 · 共 ${s.handNumber} 手`, 'end');
      break;
    }
    default: throw new RuleError('未知操作。');
  }
}
