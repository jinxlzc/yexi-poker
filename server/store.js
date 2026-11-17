import { msg, joinMessages, describe, defaultText } from './messages.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { apply, assertConservation, legalActions, newRoom, pots, runPots, requireRule, RuleError, clipView, normalizeRoom, isEnded, levelBlinds, ongoing, isDigital } from './engine.js';
import { useCryptoRandom, isCard } from './cards.js';
import { summarize } from './summary.js';
useCryptoRandom(randomInt);

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const hashToken = token => createHash('sha256').update(token || '').digest('hex');
export const freshToken = () => randomBytes(32).toString('hex');
const HOST_ACTIONS = new Set(['start', 'next', 'settle', 'preview', 'undo', 'rebuy', 'rebuySetting', 'move', 'seat', 'setDealMode', 'timeout', 'pause', 'level', 'settings', 'end', 'runOnce']);
const PLAYER_ACTIONS = new Set(['act', 'leave', 'show', 'sitOut', 'runVote', 'straddle']);
const EITHER = new Set(['leave', 'sitOut', 'runVote', 'straddle']);
const CLAIM_TTL = 15 * 60_000;
const validToken = token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
// 撤销快照不存日志和牌谱：二者只追加，撤销时按长度从当前状态截回。牌谱最后一条可能被「亮牌」改写，所以单独存。
function compact(state) {
  const { logs, records, ...rest } = state;
  return { ...rest, logsLen: logs.length, recordsLen: records?.length ?? 0, recordTail: records?.at(-1) ?? null };
}
function expand(snap, current) {
  if (Array.isArray(snap.logs)) return snap;
  const { logsLen, recordsLen, recordTail, ...rest } = snap;
  const records = recordsLen ? [...(current.records || []).slice(0, recordsLen - 1), recordTail] : [];
  return { ...rest, logs: current.logs.slice(0, logsLen), records };
}
export class Store {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.cache = new Map();
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, record TEXT NOT NULL)');
  }
  list() {
    return this.db.prepare('SELECT code, record FROM rooms').all().map(r => {
      try {
        const s = this.parse(r.record).state;
        return { code: r.code, name: s.config.name, status: s.status, createdAt: s.createdAt, endedAt: s.endedAt, hands: s.handNumber, players: Object.keys(s.roster).length, mode: s.config.dealMode };
      } catch {
        // 保留坏行供人工恢复；一间损坏房间不能拖垮所有健康房间的入口。
        return { code: r.code, name: msg('room.damaged').text, nameMessage: msg('room.damaged'), status: 'unavailable', hands: 0, players: 0 };
      }
    }).sort((a, b) => String(b.endedAt || b.createdAt).localeCompare(String(a.endedAt || a.createdAt)));
  }
  // 读写都以数据库为准；cache 只保存最近一次落盘的文本和它的解析结果，给只读的视图、牌谱、总结复用，
  // 避免每次广播给每台手机都重新解析整晚的记录。要修改的调用方拿到的永远是一份新解析的副本。
  text(code) {
    const hit = this.cache.get(code);
    if (hit) return hit.text;
    const row = this.db.prepare('SELECT record FROM rooms WHERE code = ?').get(code);
    requireRule(!!row, msg('error.roomMissing'), 404);
    this.cache.set(code, { text: row.record, record: null });
    return row.record;
  }
  parse(text) {
    try {
      const record = JSON.parse(text), s = record.state;
      requireRule(s && Array.isArray(s.players) && s.config && typeof record.hostHash === 'string', msg('error.badRecord'));
      for (const k of ['logs', 'records']) requireRule(s[k] == null || Array.isArray(s[k]), msg('error.badRecord'));
      for (const k of ['smallBlind', 'bigBlind', 'startingStack']) requireRule(Number.isSafeInteger(s.config[k]), msg('error.badSettings'));
      newRoom(s.code, s.config); // 同创建时的数值范围校验。
      normalizeRoom(s);
      assertConservation(s);
      requireRule(s.players.every(p => typeof p.id === 'string' && typeof p.name === 'string' && Number.isInteger(p.seat) && p.seat >= 1 && p.seat <= 10) && new Set(s.players.map(p => p.id)).size === s.players.length, msg('error.badSeats'));
      if (ongoing(s) && isDigital(s)) {
        const h = s.hand;
        requireRule(h.participants.every(id => h.holes[id]?.length === 2), msg('error.holesMissing'));
        requireRule(h.boards.length === h.runs && JSON.stringify(h.boards[0]) === JSON.stringify(h.board), msg('error.boardDamaged'));
        requireRule([0, 3, 4].includes(h.sharedBoardCount), msg('error.boardPrefix'));
        requireRule(h.boards.every(b => Array.isArray(b) && [0, 3, 4, 5].includes(b.length) && b.length >= h.sharedBoardCount && b.slice(0, h.sharedBoardCount).every((c, i) => c === h.board[i])), msg('error.boardDamaged'));
        const boardCards = h.boards.flatMap((board, i) => i === 0 ? board : board.slice(h.sharedBoardCount));
        const cards = [...Object.values(h.holes).flat(), ...h.deck, ...boardCards, ...h.burned];
        requireRule(cards.length === 52 && cards.every(isCard) && new Set(cards).size === 52, msg('error.deckDamaged'));
      }
      for (const k of ['claims', 'asks', 'history', 'requests']) { record[k] ??= []; requireRule(Array.isArray(record[k]), msg('error.badRecord')); }
      record.transfer ??= null; record.playerHashes ??= {};
      requireRule(typeof record.playerHashes === 'object' && !Array.isArray(record.playerHashes), msg('error.credentialsDamaged'));
      return record;
    } catch {
      throw new RuleError(msg('error.roomDamaged'), 503);
    }
  }
  get(code) { return this.parse(this.text(code)); }
  peek(code) {
    const text = this.text(code), hit = this.cache.get(code);
    if (!hit.record) hit.record = this.parse(text);
    return hit.record;
  }
  save(record) {
    assertConservation(record.state);
    // 一个 row 是一次完整事务：牌局、日志、凭证哈希、去重记录、撤销快照同时落盘。
    const text = JSON.stringify(record);
    this.db.prepare('INSERT INTO rooms (code, record) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET record = excluded.record').run(record.state.code, text);
    this.cache.set(record.state.code, { text, record: null });
  }
  create(config) {
    let code;
    do { code = Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (this.db.prepare('SELECT code FROM rooms WHERE code = ?').get(code));
    const token = freshToken();
    const record = { state: newRoom(code, config), hostHash: hashToken(token), playerHashes: {}, history: [], requests: [], transfer: null, claims: [], asks: [] };
    this.save(record);
    return { code, token };
  }
  identity(record, token) {
    if (!token) return { role: 'spectator', playerId: null };
    const hash = hashToken(token);
    if (hash === record.hostHash) return { role: 'host', playerId: null };
    const id = record.playerHashes[hash];
    if (id && record.state.players.some(p => p.id === id)) return { role: 'player', playerId: id };
    if (id && record.state.roster?.[id]) return { role: 'departed', playerId: id };
    return { role: 'spectator', playerId: null };
  }
  checkpoint(record, next, label) {
    record.history.push({ state: compact(record.state), label: defaultText(label), labelMessage: describe(label),
      ...(next.status === 'ended' ? { pending: { claims: record.claims, asks: record.asks } } : {}) });
    if (record.history.length > 200) record.history.shift();
    next.version = record.state.version + 1;
    record.state = next;
  }
  join(code, args) {
    requireRule(validToken(args.token), msg('error.deviceToken'));
    const record = this.get(code), hash = hashToken(args.token), identity = this.identity(record, args.token);
    if (identity.role === 'player') return;
    requireRule(identity.role !== 'host', msg('error.hostDevice'));
    const id = identity.role === 'departed' ? identity.playerId : randomUUID();
    const next = apply(record.state, 'join', { name: args.name, seat: args.seat, id });
    this.checkpoint(record, next, msg('undo.join', { name: args.name }));
    record.playerHashes[hash] = id;
    this.save(record);
  }
  command(code, token, command, context = {}) {
    const record = this.get(code), identity = this.identity(record, token);
    const { type, version, requestId } = command;
    let args = command.args && typeof command.args === 'object' && !Array.isArray(command.args) ? { ...command.args } : {};
    if (HOST_ACTIONS.has(type) || (EITHER.has(type) && identity.role !== 'player')) {
      requireRule(identity.role === 'host', msg('error.hostActions'), 403);
    } else requireRule(PLAYER_ACTIONS.has(type) && identity.role === 'player', msg('error.ownSeat'), 403);
    if (identity.role === 'player' && args.playerId !== undefined) requireRule(args.playerId === identity.playerId, msg('error.ownSeat'), 403);
    requireRule(typeof requestId === 'string' && requestId.length >= 8 && requestId.length <= 100, msg('error.requestId'));
    const requestKey = `${hashToken(token)}:${requestId}`;
    if (record.requests.includes(requestKey)) return { duplicate: true };
    requireRule(version === record.state.version, msg('error.staleVersion'), 409);
    delete args.actorOffline;
    if (type === 'timeout') { const actor = record.state.hand?.actor; args.actorOffline = Array.isArray(context.online) && !!actor && !context.online.includes(actor); }
    if (type === 'runVote' && identity.role === 'host') args.actorOffline = Array.isArray(context.online) && typeof args.playerId === 'string' && !context.online.includes(args.playerId);
    let notice, noticeMessage;
    if (type === 'undo') {
      const previous = record.history.pop(); requireRule(!!previous, msg('error.noUndo'));
      const version = record.state.version + 1;
      record.state = normalizeRoom(expand(previous.state, record.state)); record.state.version = version;
      if (previous.pending) { record.claims = previous.pending.claims; record.asks = previous.pending.asks; }
      noticeMessage = msg('undo.notice', { action: previous.labelMessage || previous.label });
      notice = noticeMessage.text;
    } else {
      const next = apply(record.state, type, args, identity.playerId);
      if (type === 'preview') { next.version = record.state.version + 1; record.state = next; }
      else this.checkpoint(record, next, type === 'start' ? msg('undo.start') : type === 'settle' ? msg('undo.settle') : type === 'end' ? msg('undo.end') : joinMessages(next.logs.slice(record.state.logs.length), msg('separator.history')));
    }
    if (type === 'end') { record.claims = record.claims.filter(c => c.status !== 'pending'); record.asks = []; }
    record.requests.push(requestKey); record.requests = record.requests.slice(-512);
    this.save(record);
    return { notice, noticeMessage };
  }
  // 丢了凭证：新设备提出认领，主持确认后把座位凭证换到新设备，旧设备随即失效。
  claim(code, args) {
    requireRule(validToken(args.token), msg('error.deviceToken'));
    const record = this.get(code), hash = hashToken(args.token), identity = this.identity(record, args.token);
    requireRule(!isEnded(record.state), msg('error.ended'));
    requireRule(identity.role === 'spectator', identity.role === 'host' ? msg('error.deviceIsHost') : msg('error.deviceSeated'));
    requireRule(typeof args.playerId === 'string' && Object.hasOwn(record.state.roster, args.playerId), msg('error.noSuchSeat'));
    const target = record.state.roster[args.playerId];
    requireRule(!!target, msg('error.noSuchSeat'));
    const now = Date.now();
    record.claims = record.claims.filter(c => c.status === 'pending' ? now - c.at < CLAIM_TTL : now - c.at < 60 * 60_000).filter(c => c.hash !== hash);
    requireRule(record.claims.filter(c => c.status === 'pending').length < 10, msg('error.tooManyClaims'));
    record.claims.push({ id: randomBytes(8).toString('hex'), hash, playerId: target.id, at: now, status: 'pending' });
    this.save(record);
  }
  decideClaim(code, token, { claimId, approve }) {
    const record = this.get(code);
    requireRule(this.identity(record, token).role === 'host', msg('error.hostRequired'), 403);
    requireRule(!isEnded(record.state), msg('error.ended'));
    const claim = record.claims.find(c => c.id === claimId && c.status === 'pending' && Date.now() - c.at < CLAIM_TTL);
    requireRule(!!claim, msg('error.claimExpired'));
    const ownedId = record.playerHashes[claim.hash];
    const hasIdentity = ownedId && (record.state.roster[ownedId] || record.state.players.some(p => p.id === ownedId));
    requireRule(Object.hasOwn(record.state.roster, claim.playerId) && !hasIdentity && record.hostHash !== claim.hash, msg('error.claimChanged'));
    claim.status = approve === true ? 'approved' : 'denied';
    const name = record.state.roster[claim.playerId]?.name;
    if (claim.status === 'approved') {
      for (const [h, id] of Object.entries(record.playerHashes)) if (id === claim.playerId) delete record.playerHashes[h];
      record.playerHashes[claim.hash] = claim.playerId;
      for (const other of record.claims) if (other !== claim && other.playerId === claim.playerId && other.status === 'pending') other.status = 'denied';
      record.state.logs.push({ id: `${record.state.version + 1}-${record.state.logs.length}`, at: new Date().toISOString(), hand: record.state.handNumber, ...msg('log.claim', { name }), kind: 'claim' });
    }
    record.state.version += 1;
    this.save(record);
    return { name, approved: claim.status === 'approved' };
  }
  // 手机申请补码：只是请求，主持同意后才真正加筹码（仍走 rebuy 规则与日志）。
  ask(code, token) {
    const record = this.get(code), identity = this.identity(record, token);
    requireRule(identity.role === 'player', msg('error.ownSeatRequest'), 403);
    requireRule(!isEnded(record.state), msg('error.ended'));
    requireRule(record.state.config.rebuy, msg('error.rebuyDisabled'));
    requireRule(!record.asks.some(a => a.playerId === identity.playerId), msg('error.askPending'));
    record.asks.push({ id: randomBytes(8).toString('hex'), playerId: identity.playerId, at: Date.now() });
    this.save(record);
  }
  decideAsk(code, token, { askId, approve, amount, requestId }) {
    const record = this.get(code);
    requireRule(this.identity(record, token).role === 'host', msg('error.hostRequired'), 403);
    const ask = record.asks.find(a => a.id === askId);
    requireRule(!!ask, msg('error.askHandled'));
    if (approve === true) {
      this.command(code, token, { type: 'rebuy', args: { playerId: ask.playerId, amount }, version: record.state.version, requestId: requestId || randomUUID() });
      const fresh = this.get(code); fresh.asks = fresh.asks.filter(a => a.id !== askId); this.save(fresh);
    } else { record.asks = record.asks.filter(a => a.id !== askId); record.state.version += 1; this.save(record); }
  }
  transfer(code, token) {
    const record = this.get(code);
    requireRule(this.identity(record, token).role === 'host', msg('error.hostRequired'), 403);
    const secret = randomBytes(16).toString('hex');
    record.transfer = { hash: hashToken(secret), expires: Date.now() + 5 * 60_000 };
    this.save(record); return secret;
  }
  acceptTransfer(code, secret) {
    requireRule(typeof secret === 'string' && /^[a-f0-9]{32}$/.test(secret), msg('error.transferCode'), 403);
    const record = this.get(code);
    requireRule(record.transfer && record.transfer.expires > Date.now() && record.transfer.hash === hashToken(secret), msg('error.transferCode'), 403);
    const token = freshToken();
    record.hostHash = hashToken(token); record.transfer = null; record.state.version += 1;
    this.save(record); return token;
  }
  // 只给运行服务的这台电脑（调用方需确认是 localhost 回环访问）：主持凭证丢了时接回。
  reclaimHost(code) {
    const record = this.get(code), token = freshToken();
    record.hostHash = hashToken(token); record.transfer = null; record.state.version += 1;
    this.save(record); return token;
  }
  rematch(code, token) {
    const record = this.get(code);
    requireRule(this.identity(record, token).role === 'host', msg('error.hostRequired'), 403);
    requireRule(isEnded(record.state), msg('error.rematchAfterEnd'));
    requireRule(!record.state.nextRoom, msg('error.rematchExists'));
    const { config } = record.state;
    const created = this.create({ ...config });
    record.state.nextRoom = created.code; record.state.version += 1;
    this.save(record);
    return created;
  }
  logs(code) { return this.peek(code).state.logs; }
  hands(code) { const s = this.peek(code).state; return { records: s.records, roster: Object.fromEntries(Object.values(s.roster).map(r => [r.id, { name: r.name, seat: r.seat }])), statsFrom: s.statsFrom, legacy: !!s.legacy }; }
  summary(code) { return summarize(this.peek(code).state); }
  view(code, token, online = []) {
    const record = this.peek(code), identity = this.identity(record, token);
    const { state, hole } = clipView(record.state, identity);
    const extra = {};
    if (identity.role === 'host') {
      const now = Date.now();
      extra.claims = record.claims.filter(c => c.status === 'pending' && now - c.at < CLAIM_TTL).map(c => ({ id: c.id, playerId: c.playerId, name: record.state.roster[c.playerId]?.name, at: c.at, seated: record.state.players.some(p => p.id === c.playerId) }));
      extra.asks = record.asks.map(a => ({ id: a.id, playerId: a.playerId, name: record.state.roster[a.playerId]?.name, at: a.at }));
    } else if (identity.role === 'spectator' && token) {
      const mine = record.claims.filter(c => c.hash === hashToken(token)).at(-1);
      if (mine) extra.claim = { status: mine.status === 'pending' && Date.now() - mine.at >= CLAIM_TTL ? 'expired' : mine.status, name: record.state.roster[mine.playerId]?.name };
    } else if (identity.role === 'player') extra.asked = record.asks.some(a => a.playerId === identity.playerId);
    if (isEnded(record.state) || identity.role === 'departed') extra.summary = summarize(record.state);
    return { state, hole, ...identity, legal: legalActions(record.state, identity.playerId), pots: pots(record.state), runPots: runPots(record.state), online, blinds: levelBlinds(record.state),
      lastUndo: identity.role === 'host' ? record.history.at(-1)?.label ?? null : null,
      lastUndoMessage: identity.role === 'host' ? record.history.at(-1)?.labelMessage ?? null : null, now: Date.now(), ...extra };
  }
  close() { this.db.close(); }
}
