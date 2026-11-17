// 每手牌谱：按街分组的时间线。只用已公开的信息（下注、公共牌、本人选择亮出的底牌、分池结果）。
import { playingCard } from '/cards/table-cards.js';
import { esc, n, signed, clock } from '/night/recap.js';

const STREET = ['翻前', '翻牌圈', '转牌圈', '河牌圈'];
const hue = seat => `h${((Number(seat) || 1) - 1) % 10 + 1}`;
const av = (p, cls = 'is-xs') => `<span class="avatar ${hue(p?.seat)} ${cls}" aria-hidden="true">${esc([...String(p?.name || '?')][0])}</span>`;
const mini = cards => cards.map(c => playingCard(c, { size: 'is-mini', flipped: true })).join('');
function verb(a, opened) {
  const by = a.by ? `<em class="hv-by">主持代 · ${esc(a.by)}</em>` : '';
  switch (a.a) {
    case 'sb': return `小盲 <b class="num">${n(a.amount)}</b>`;
    case 'bb': return `大盲 <b class="num">${n(a.amount)}</b>`;
    case 'ante': return `前注 <b class="num">${n(a.amount)}</b>`;
    case 'fold': return `弃牌${by}`;
    case 'check': return `过牌${by}`;
    case 'call': return `跟注 <b class="num">${n(a.amount)}</b>${a.allin ? ' · 全下' : ''}`;
    case 'raise': return `${opened ? '加注到' : '下注'} <b class="num">${n(a.to)}</b>`;
    case 'allin': return `全下 <b class="num">${n(a.amount)}</b>${a.to ? `<small> · 到 ${n(a.to)}</small>` : ''}`;
    case 'refund': return `未被跟注，退回 <b class="num">${n(a.amount)}</b>`;
    case 'show': return '亮牌';
    default: return esc(a.a);
  }
}
export function handTitle(r) { return `第 ${r.n} 手`; }
function potOf(r) { return r.pots.reduce((s, p) => s + p.amount, 0); }
function listItem(r, on, roster) {
  const winners = Object.keys(r.awards).map(id => esc(r.seats[id]?.name || roster[id]?.name)).join('、');
  return `<li><button type="button" class="hv-item ${on ? 'is-on' : ''}" data-do="hand-pick" data-n="${r.n}" aria-current="${on}"><span class="hv-n num">${r.n}</span><span class="hv-w"><b>${winners || '—'}</b><small>${clock(r.at)} · ${Object.keys(r.seats).length} 人${r.showdown ? ' · 摊牌' : ''}</small></span><span class="hv-pot num">${n(potOf(r))}</span></button></li>`;
}
function detail(r) {
  const seatOf = id => r.seats[id] || { name: '?', seat: 1 };
  const order = Object.entries(r.seats).sort((a, b) => a[1].seat - b[1].seat);
  const seats = order.map(([id, p]) => {
    const net = (r.awards[id] || 0) - (r.contrib[id] || 0);
    const shown = r.shown?.[id];
    const tag = id === r.dealer ? '<i class="hv-mark">庄</i>' : '';
    const state = r.folded.includes(id) ? '弃牌' : shown ? (r.hands?.[id] || '亮牌') : r.mode === 'digital' && r.showdown ? '盖牌' : r.showdown ? '摊牌' : '';
    return `<div class="hv-seat ${net > 0 ? 'is-up' : net < 0 ? 'is-down' : ''}">${av(p, '')}${tag}<b>${esc(p.name)}</b><span class="num hv-net">${signed(net)}</span>${p.start !== null && p.start !== undefined ? `<small class="num">${n(p.start)} → ${n(p.start + net)}</small>` : ''}${shown ? `<span class="hv-cards">${mini(shown)}</span>` : ''}${state ? `<em>${esc(state)}</em>` : ''}</div>`;
  }).join('');
  const groups = [[]]; let boards = [[]];
  for (const a of r.actions) {
    if (a.a === 'street') { groups.push([]); boards.push(a.board || []); continue; }
    groups[groups.length - 1].push(a);
  }
  const timeline = groups.map((acts, i) => {
    if (!acts.length && i > 0 && !(boards[i] || []).length) return '';
    let opened = i === 0;
    const rows = acts.map(a => {
      const p = seatOf(a.id), html = `<li class="hv-act hv-${a.a}">${av(p)}<span class="hv-name">${esc(p.name)}</span><span class="hv-verb">${verb(a, opened)}</span><span class="hv-pot num">${n(a.pot)}</span></li>`;
      if (a.a === 'raise' || a.a === 'allin') opened = true;
      return html;
    }).join('');
    const board = i > 0 ? (boards[i] || []).slice((boards[i - 1] || []).length) : [];
    return `<section class="hv-street"><header><h3>${STREET[i] || '摊牌'}</h3>${board.length ? `<span class="hv-board">${mini(board)}</span>` : ''}<span class="hv-col">底池</span></header><ol>${rows || '<li class="hv-act is-empty">没有人行动</li>'}</ol></section>`;
  }).join('');
  const result = r.pots.map(p => `<li><span>${esc(p.name)} <b class="num">${n(p.amount)}</b></span><span>${p.winners.map(id => `${esc(seatOf(id).name)} <b class="num">+${n(p.shares[id])}</b>`).join(' · ')}</span></li>`).join('');
  const secs = r.at && r.end ? Math.max(1, Math.round((Date.parse(r.end) - Date.parse(r.at)) / 1000)) : null;
  return `<header class="hv-head"><div><span class="eyebrow">牌谱</span><h2>${handTitle(r)}</h2></div><p>庄 ${esc(seatOf(r.dealer).name)} · 盲注 <span class="num">${n(r.blinds.small)}/${n(r.blinds.big)}</span>${r.blinds.ante ? ` · 前注 <span class="num">${n(r.blinds.ante)}</span>` : ''} · ${clock(r.at)}${secs ? ` · 用时 ${secs >= 60 ? `${Math.floor(secs / 60)} 分 ` : ''}${secs % 60} 秒` : ''} · ${r.mode === 'digital' ? '电子牌' : '实体牌'}</p></header>
<div class="hv-seats">${seats}</div>${r.board.length ? `<div class="hv-final"><span class="eyebrow">公共牌</span><span class="hv-board is-lg">${r.board.map(c => playingCard(c, { size: 'is-mini', flipped: true })).join('')}</span></div>` : ''}
<div class="hv-timeline">${timeline}</div><section class="hv-result"><h3>分池</h3><ul>${result}</ul></section>`;
}
export function handsBody(data, selected) {
  const records = data?.records || [];
  if (!records.length) return `<div class="hv-empty"><span class="seal">夜</span><p>还没有打完的一手。打完第一手，这里就有牌谱。</p>${data?.legacy ? '<p class="muted">旧版本打过的手没有结构化记录，只在「记录」里有文字日志。</p>' : ''}</div>`;
  const r = records.find(x => x.n === selected) || records.at(-1);
  const i = records.indexOf(r);
  return `<nav class="hv-list" aria-label="选择一手"><ol>${[...records].reverse().map(x => listItem(x, x === r, data.roster)).join('')}</ol></nav>
<article class="hv-detail" aria-live="polite">${detail(r)}<div class="hv-pager"><button type="button" class="btn btn-ghost" data-do="hand-pick" data-n="${records[i - 1]?.n ?? ''}" ${i > 0 ? '' : 'disabled'}>上一手</button><span class="num">${i + 1} / ${records.length}</span><button type="button" class="btn btn-ghost" data-do="hand-pick" data-n="${records[i + 1]?.n ?? ''}" ${i < records.length - 1 ? '' : 'disabled'}>下一手</button></div></article>`;
}
