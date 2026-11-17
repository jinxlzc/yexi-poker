// 每手牌谱：按街分组的时间线，只使用公开的下注、公共牌、亮牌和分池结果。
import { t, localized } from '../i18n/index.js';
import { playingCard } from '../cards/table-cards.js';
import { esc, n, signed, clock } from './recap.js';

const STREET = ['night.preflop', 'night.flop', 'night.turn', 'night.river'];
const hue = seat => `h${((Number(seat) || 1) - 1) % 10 + 1}`;
const av = (p, cls = 'is-xs') => `<span class="avatar ${hue(p?.seat)} ${cls}" aria-hidden="true">${esc([...String(p?.name || '?')][0])}</span>`;
const mini = cards => cards.map(c => playingCard(c, { size: 'is-mini', flipped: true })).join('');
function verb(a, opened) {
  const by = a.by ? `<em class="hv-by">${esc(t('night.hostProxy', { name: localized(a.byMessage || a.by) }))}</em>` : '';
  switch (a.a) {
    case 'sb': return `${t('night.smallBlind')} <b class="num">${n(a.amount)}</b>`;
    case 'bb': return `${t('night.bigBlind')} <b class="num">${n(a.amount)}</b>`;
    case 'ante': return `${t(a.anteMode === 'bigBlind' ? 'night.bigBlindAnte' : 'night.ante')} <b class="num">${n(a.amount)}</b>`;
    case 'straddle': return `${t('night.straddle')} <b class="num">${n(a.amount)}</b>${a.allin ? ` · ${t('night.allin')}` : ''}`;
    case 'fold': return `${t('night.fold')}${by}`;
    case 'check': return `${t('night.check')}${by}`;
    case 'call': return `${t('night.call')} <b class="num">${n(a.amount)}</b>${a.allin ? ` · ${t('night.allin')}` : ''}`;
    case 'raise': return `${t(opened ? 'night.raiseTo' : 'night.bet')} <b class="num">${n(a.to)}</b>`;
    case 'allin': return `${t('night.allin')} <b class="num">${n(a.amount)}</b>${a.to ? `<small> · ${t('night.toAmount', { amount: n(a.to) })}</small>` : ''}`;
    case 'refund': return `${t('night.refund')} <b class="num">${n(a.amount)}</b>`;
    case 'runVote': return `${t('night.runVote', { count: n(a.runs) })}${by}`;
    case 'runResult': return `${t('night.runResult', { count: n(a.runs) })}${a.by ? `<em class="hv-by">${esc(localized(a.byMessage || a.by))}</em>` : ''}`;
    case 'show': return t('night.show');
    default: return esc(a.a);
  }
}
export function handTitle(r) { return t('night.hand', { count: r.n }); }
function potOf(r) { return r.pots.reduce((s, p) => s + p.amount, 0); }
function listItem(r, on, roster) {
  const winners = Object.keys(r.awards).map(id => esc(r.seats[id]?.name || roster[id]?.name)).join(t('night.separator'));
  return `<li><button type="button" class="hv-item ${on ? 'is-on' : ''}" data-do="hand-pick" data-n="${r.n}" aria-current="${on}"><span class="hv-n num">${r.n}</span><span class="hv-w"><b>${winners || '—'}</b><small>${clock(r.at)} · ${t('night.playerCount', { count: Object.keys(r.seats).length })}${r.showdown ? ` · ${t('night.showdown')}` : ''}${r.runs > 1 ? ` · ${t('night.runCount', { count: r.runs })}` : ''}</small></span><span class="hv-pot num">${n(potOf(r))}</span></button></li>`;
}
function timelineOf(r, seatOf) {
  const groups = [{ street: 0, run: null, board: [], acts: [] }];
  const dealt = new Map();
  for (const a of r.actions) {
    if (a.a !== 'street') { groups.at(-1).acts.push(a); continue; }
    const run = a.run || 1, board = a.board || [];
    const prior = dealt.get(run) ?? (run > 1 ? r.sharedBoardCount || 0 : 0);
    const labelRun = r.runs > 1 && board.length > (r.sharedBoardCount || 0);
    groups.push({ street: a.street ?? groups.at(-1).street + 1, run: labelRun ? run : null, board: board.slice(prior), acts: [] });
    dealt.set(run, board.length);
  }
  return groups.map(({ street, run, board, acts }) => {
    if (!acts.length && street > 0 && !board.length) return '';
    let opened = street === 0;
    const rows = acts.map(a => {
      const p = a.id ? seatOf(a.id) : { name: t('night.table') };
      const html = `<li class="hv-act hv-${esc(a.a)}">${av(p)}<span class="hv-name">${esc(p.name)}</span><span class="hv-verb">${verb(a, opened)}</span><span class="hv-pot num">${n(a.pot)}</span></li>`;
      if (a.a === 'raise' || a.a === 'allin') opened = true;
      return html;
    }).join('');
    return `<section class="hv-street"><header><h3>${run ? `${t('night.run', { count: run })} · ` : ''}${t(STREET[street] || 'night.showdown')}</h3>${board.length ? `<span class="hv-board">${mini(board)}</span>` : ''}<span class="hv-col">${t('night.pot')}</span></header><ol>${rows || `<li class="hv-act is-empty">${t('night.noAction')}</li>`}</ol></section>`;
  }).join('');
}
function boardOf(board) {
  return board.length ? `<div class="hv-final"><span class="eyebrow">${t('night.board')}</span><div class="hv-board is-lg">${mini(board)}</div></div>` : '';
}
function resultOf(pots, seatOf) {
  return pots.map(p => {
    const awards = p.winners.map(id => `${esc(seatOf(id).name)} <b class="num">+${n(p.shares[id])}</b>${p.oddRecipients?.includes(id) ? t('night.oddIncluded') : ''}`).join(' · ');
    return `<li><span>${esc(localized(p.nameMessage || p.name))} <b class="num">${n(p.amount)}</b>${p.runOdd ? t('night.runOddIncluded') : ''}</span><span>${awards}</span></li>`;
  }).join('');
}
function resultsOf(r, seatOf) {
  if (!(r.runs > 1)) return `<section class="hv-result"><h3>${t('night.potDistribution')}</h3><ul>${resultOf(r.pots, seatOf)}</ul></section>`;
  const rounds = Array.from({ length: r.runs }, (_, i) => {
    const run = i + 1;
    const board = boardOf(r.boards?.[i] || []);
    const hands = Object.entries(r.boardHands?.[i] || {}).filter(([id]) => r.shown?.[id]);
    const names = hands.map(([id, name]) => `${esc(seatOf(id).name)} · ${esc(localized(r.boardHandsMessage?.[i]?.[id] || name))}`).join('　');
    const result = resultOf(r.pots.filter(p => p.run === run), seatOf);
    return `<section class="hv-run" data-run="${run}"><h4>${t('night.run', { count: run })}</h4>${board}${names ? `<p class="hv-hand-names">${names}</p>` : ''}<ul>${result}</ul></section>`;
  });
  return `<section class="hv-result"><h3>${t('night.potDistribution')}</h3><div class="hv-runouts">${rounds.join('')}</div></section>`;
}
function detail(r) {
  const seatOf = id => r.seats[id] || { name: '?', seat: 1 };
  const multi = r.runs > 1;
  const order = Object.entries(r.seats).sort((a, b) => a[1].seat - b[1].seat);
  const seats = order.map(([id, p]) => {
    const net = (r.awards[id] || 0) - (r.contrib[id] || 0);
    const shown = r.shown?.[id];
    const tag = id === r.dealer ? `<i class="hv-mark">${t('night.dealerMark')}</i>` : '';
    const state = r.folded.includes(id) ? t('night.fold') : shown ? (multi ? t('night.show') : localized(r.handsMessage?.[id] || r.hands?.[id]) || t('night.show')) : r.mode === 'digital' && r.showdown ? t('night.muck') : r.showdown ? t('night.showdown') : '';
    return `<div class="hv-seat ${net > 0 ? 'is-up' : net < 0 ? 'is-down' : ''}">${av(p, '')}${tag}<b>${esc(p.name)}</b><span class="num hv-net">${signed(net)}</span>${p.start !== null && p.start !== undefined ? `<small class="num">${n(p.start)} → ${n(p.start + net)}</small>` : ''}${shown ? `<span class="hv-cards">${mini(shown)}</span>` : ''}${state ? `<em>${esc(state)}</em>` : ''}</div>`;
  }).join('');
  const showOrder = r.showOrder?.length ? `<p class="hv-order"><b>${t('night.showOrder')}</b> ${r.showOrder.map(id => esc(seatOf(id).name)).join(' → ')}</p>` : '';
  const secs = r.at && r.end ? Math.max(1, Math.round((Date.parse(r.end) - Date.parse(r.at)) / 1000)) : null;
  const ante = r.blinds.ante ? ` · ${t(r.blinds.anteMode === 'bigBlind' ? 'night.bigBlindAnte' : 'night.ante')} <span class="num">${n(r.blinds.ante)}</span>` : '';
  const straddle = r.straddle ? ` · ${esc(t('night.straddleBy', { name: seatOf(r.straddle).name }))}` : '';
  const result = resultsOf(r, seatOf);
  return `<header class="hv-head"><div><span class="eyebrow">${t('night.handHistory')}</span><h2>${handTitle(r)}</h2></div><p>${t('night.dealer')} ${esc(seatOf(r.dealer).name)} · ${t('night.blinds')} <span class="num">${n(r.blinds.small)}/${n(r.blinds.big)}</span>${ante}${straddle} · ${clock(r.at)}${secs ? ` · ${t('night.elapsed', { minutes: secs >= 60 ? t('night.elapsedMinutes', { count: Math.floor(secs / 60) }) : '', seconds: secs % 60 })}` : ''} · ${t(r.mode === 'digital' ? 'night.digital' : 'night.physical')}</p></header>
<div class="hv-seats">${seats}</div>${showOrder}${multi ? result : boardOf(r.board)}
<div class="hv-timeline">${timelineOf(r, seatOf)}</div>${multi ? '' : result}`;
}
export function handsBody(data, selected) {
  const records = data?.records || [];
  if (!records.length) return `<div class="hv-empty"><span class="seal">${t('night.seal')}</span><p>${t('night.noHands')}</p>${data?.legacy ? `<p class="muted">${t('night.legacyHands')}</p>` : ''}</div>`;
  const r = records.find(x => x.n === selected) || records.at(-1);
  const i = records.indexOf(r);
  return `<nav class="hv-list" aria-label="${t('night.chooseHand')}"><ol>${[...records].reverse().map(x => listItem(x, x === r, data.roster)).join('')}</ol></nav>
<article class="hv-detail" aria-live="polite">${detail(r)}<div class="hv-pager"><button type="button" class="btn btn-ghost" data-do="hand-pick" data-n="${records[i - 1]?.n ?? ''}" ${i > 0 ? '' : 'disabled'}>${t('night.previousHand')}</button><span class="num">${i + 1} / ${records.length}</span><button type="button" class="btn btn-ghost" data-do="hand-pick" data-n="${records[i + 1]?.n ?? ''}" ${i < records.length - 1 ? '' : 'disabled'}>${t('night.nextHand')}</button></div></article>`;
}
