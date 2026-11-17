// 一晚的总结：只用账本（带入 / 带走）和结构化牌谱算；算不准的字段给 null，界面就不显示。
import { evaluate, compareRanks, describeHand } from './cards.js';
import { potTotal } from './engine.js';

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
export function summarize(s, now = Date.now()) {
  const records = s.records || [];
  const seated = new Map(s.players.map(p => [p.id, p]));
  const roster = Object.values(s.roster || {});
  const stats = new Map(roster.map(r => [r.id, { hands: 0, vpip: 0, won: 0, biggest: 0, biggestHand: null, allins: 0, showdowns: 0, handNet: 0, bestNet: 0, bestNetHand: null, best: null }]));
  const statOf = id => { if (!stats.has(id)) stats.set(id, { hands: 0, vpip: 0, won: 0, biggest: 0, biggestHand: null, allins: 0, showdowns: 0, handNet: 0, bestNet: 0, bestNetHand: null, best: null }); return stats.get(id); };
  let biggestPot = null, bestShown = null;
  for (const rec of records) {
    const total = rec.pots.reduce((sum, p) => sum + p.amount, 0);
    if (!biggestPot || total > biggestPot.amount) biggestPot = { amount: total, rec };
    const allinIds = new Set(rec.actions.filter(a => a.allin && a.id).map(a => a.id));
    for (const id of Object.keys(rec.seats)) {
      const st = statOf(id), award = rec.awards[id] || 0, net = award - (rec.contrib[id] || 0);
      st.hands += 1;
      if (rec.vpip.includes(id)) st.vpip += 1;
      if (award > 0) st.won += 1;
      if (award > st.biggest) { st.biggest = award; st.biggestHand = rec.n; }
      if (net > st.bestNet) { st.bestNet = net; st.bestNetHand = rec.n; }
      if (allinIds.has(id)) st.allins += 1;
      if (rec.showdown && !rec.folded.includes(id)) st.showdowns += 1;
      st.handNet += net;
      const shown = rec.shown?.[id];
      if (shown && rec.board.length >= 3) {
        const ev = evaluate([...shown, ...rec.board]);
        const entry = { rank: ev.rank, name: describeHand([...shown, ...rec.board]), cards: shown, best: ev.cards, board: rec.board, hand: rec.n, id };
        if (!st.best || compareRanks(ev.rank, st.best.rank) > 0) st.best = entry;
        if (!bestShown || compareRanks(ev.rank, bestShown.rank) > 0) bestShown = entry;
      }
    }
  }
  const players = roster.map(r => {
    const p = seated.get(r.id), st = statOf(r.id);
    const final = p ? p.stack : 0;
    // 本手尚未结算的投入仍属未决筹码；战况净值只展示已结束手的盈亏。
    const net = final + (p?.contribution || 0) + r.cashOut - r.buyIn;
    return {
      id: r.id, name: r.name, seat: p?.seat ?? r.seat, status: p ? 'seated' : 'left', leftAt: p ? null : r.leftAt,
      buyIn: r.buyIn, rebuys: r.rebuys || 0, cashOut: r.cashOut, final, net, approx: !!r.approx,
      hands: st.hands, vpip: st.hands >= 1 ? pct(st.vpip, st.hands) : null, won: st.won, biggest: st.biggest || null, biggestHand: st.biggestHand,
      bestNet: st.bestNet || null, bestNetHand: st.bestNetHand, allins: st.allins, showdowns: st.showdowns,
      best: st.best ? { name: st.best.name, cards: st.best.cards, hand: st.best.hand } : null,
      // 非旧数据时，逐手盈亏之和必须等于账本盈亏。
      consistent: s.legacy ? null : st.handNet === net
    };
  }).sort((a, b) => b.net - a.net || b.final - a.final || a.seat - b.seat);
  players.forEach((p, i) => { p.rank = i > 0 && players[i - 1].net === p.net ? players[i - 1].rank : i + 1; });
  const buyIn = roster.reduce((n, r) => n + r.buyIn, 0), cashOut = roster.reduce((n, r) => n + r.cashOut, 0);
  const finalSum = s.players.reduce((n, p) => n + p.stack, 0), pot = potTotal(s);
  const balance = { buyIn, cashOut, final: finalSum, pot, total: s.total, ok: buyIn === finalSum + cashOut + pot && s.total === finalSum + pot && players.every(p => p.consistent !== false) };
  const name = id => s.roster?.[id]?.name || '?';
  const highlights = [];
  if (biggestPot && biggestPot.amount > 0) {
    const rec = biggestPot.rec, winners = Object.keys(rec.awards);
    const shownWinner = winners.find(id => rec.shown?.[id]);
    highlights.push({ kind: 'pot', title: '最大底池', value: biggestPot.amount, hand: rec.n, players: winners,
      text: `第 ${rec.n} 手 · ${winners.map(name).join('、')}${winners.length > 1 ? (rec.pots.length > 1 ? '分获底池' : '平分') : '拿下'}${shownWinner && rec.board.length >= 3 ? ` · ${describeHand([...rec.shown[shownWinner], ...rec.board])}` : ''}`,
      board: rec.board, cards: shownWinner ? rec.shown[shownWinner] : null });
  }
  if (bestShown && bestShown.rank[0] >= 2) highlights.push({ kind: 'best', title: '最强亮牌', value: null, hand: bestShown.hand, players: [bestShown.id], text: `${name(bestShown.id)} · ${bestShown.name} · 第 ${bestShown.hand} 手`, board: bestShown.board, cards: bestShown.cards, best: bestShown.best });
  const swing = players.filter(p => p.bestNet).sort((a, b) => b.bestNet - a.bestNet)[0];
  if (swing && (!highlights[0] || swing.bestNetHand !== highlights[0].hand)) highlights.push({ kind: 'swing', title: '单手最大收获', value: swing.bestNet, hand: swing.bestNetHand, players: [swing.id], text: `${swing.name} · 第 ${swing.bestNetHand} 手净赢` });
  const allin = players.filter(p => p.allins >= 2).sort((a, b) => b.allins - a.allins)[0];
  if (allin) highlights.push({ kind: 'allin', title: '全下之王', value: allin.allins, players: [allin.id], text: `${allin.name} · ${allin.allins} 手全下` });
  const minHands = Math.max(5, Math.ceil(records.length * 0.3));
  const loose = players.filter(p => p.hands >= minHands && p.vpip !== null);
  if (loose.length >= 2) { const top = loose.sort((a, b) => b.vpip - a.vpip)[0]; highlights.push({ kind: 'vpip', title: '最爱入池', value: top.vpip, players: [top.id], text: `${top.name} · 入池率 ${top.vpip}%` }); }
  const start = s.startedAt || s.createdAt, end = s.endedAt || new Date(now).toISOString();
  return {
    room: { code: s.code, name: s.config.name, mode: s.config.dealMode, smallBlind: s.config.smallBlind, bigBlind: s.config.bigBlind, ante: s.config.ante || 0, level: s.level || 0,
      createdAt: s.createdAt, startedAt: s.startedAt, endedAt: s.endedAt, durationMs: start ? Math.max(0, Date.parse(end) - Date.parse(start)) : 0,
      hands: s.handNumber, tracked: records.length, statsFrom: s.statsFrom || 1, legacy: !!s.legacy, ended: s.status === 'ended' },
    players, balance, highlights: highlights.slice(0, 4)
  };
}
