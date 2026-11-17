// 散场总结：大屏排行、手机个人总结、文字战报与竖版分享图。数据全部来自服务端 summarize()。
import { playingCard, rankLabel, SUIT_PATH } from '../cards/table-cards.js';
import { t, localized, getLanguage, locale } from '../i18n/index.js';

export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const n = value => Number(value || 0).toLocaleString(locale());
export const signed = v => (v > 0 ? `+${n(v)}` : v < 0 ? `−${n(-v)}` : '±0');
const hue = seat => `h${((Number(seat) || 1) - 1) % 10 + 1}`;
const initial = name => esc([...String(name || '?')][0]);
const avatar = (p, size = '') => `<div class="avatar ${hue(p.seat)} ${size}" aria-hidden="true">${initial(p.name)}</div>`;
const pad = v => String(v).padStart(2, '0');
export const clock = iso => { if (!iso) return ''; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const day = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  return getLanguage() === 'zh-CN'
    ? t('night.day', { month: d.getMonth() + 1, day: d.getDate(), weekday: t('night.weekdays')[d.getDay()] })
    : new Intl.DateTimeFormat(locale(), { month: 'short', day: 'numeric', weekday: 'short' }).format(d);
};
export function duration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return t('night.underMinute');
  if (m < 60) return t('night.minutes', { count: m });
  return t('night.hours', { hours: Math.floor(m / 60), minutes: m % 60 ? t('night.minutePart', { count: m % 60 }) : '' });
}
const handCount = value => t(Number(value) === 1 ? 'night.handCountOne' : 'night.handCount', { count: value });
const tone = v => (v > 0 ? 'is-up' : v < 0 ? 'is-down' : 'is-even');
const modeLabel = room => `${t(room.mode === 'digital' ? 'night.digital' : 'night.physical')} · ${t('night.blinds')} ${n(room.smallBlind)}/${n(room.bigBlind)}${room.ante ? ` · ${t(room.anteMode === 'bigBlind' ? 'night.bigBlindAnte' : 'night.ante')} ${n(room.ante)}` : ''}`;
const place = best => `${t('night.hand', { count: best.hand })}${best.run ? ` · ${t('night.run', { count: best.run })}` : ''}`;
const textOf = (value, field) => localized(value[`${field}Message`] || value[field]);
function span(room) { return `${day(room.startedAt || room.createdAt)} ${clock(room.startedAt || room.createdAt)}–${room.ended ? clock(room.endedAt) : t('night.now')}`; }

function statNote(sum) {
  if (sum.room.legacy && sum.room.statsFrom > 1) return t('night.legacyStats', { last: sum.room.statsFrom - 1, first: sum.room.statsFrom });
  return '';
}
function balanceCard(sum) {
  const b = sum.balance;
  return `<section class="rc-balance ${b.ok ? 'is-ok' : 'is-off'}" aria-label="${t('night.balanceCheck')}"><div class="rc-bal-head"><span class="rc-check" aria-hidden="true">${b.ok ? '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>' : '!'}</span><div><b>${t(b.ok ? 'night.balanced' : 'night.unbalanced')}</b><span>${t(b.ok ? 'night.balanceExplanation' : 'night.balanceHelp')}</span></div></div>
<div class="rc-eq"><div><span>${t('night.buyIn')}</span><b class="num">${n(b.buyIn)}</b></div><i>=</i><div><span>${t('night.finalChips')}</span><b class="num">${n(b.final)}</b></div>${b.cashOut ? `<i>+</i><div><span>${t('night.cashOutEarly')}</span><b class="num">${n(b.cashOut)}</b></div>` : ''}${b.pot ? `<i>+</i><div><span>${t('night.inPot')}</span><b class="num">${n(b.pot)}</b></div>` : ''}</div></section>`;
}
function roundResults(round, names) {
  return round.pots.map(p => {
    const awards = p.winners.map(id => `${names.get(id) || '?'} +${n(p.shares[id])}`).join(t('night.separator'));
    return `${textOf(p, 'name')} ${n(p.amount)}${awards ? ` · ${awards}` : ''}`;
  });
}
function highlightRuns(rounds, names) {
  return `<div class="rc-hl-runs">${rounds.map(round => {
    const cards = round.board.map(c => playingCard(c, { size: 'is-mini', flipped: true })).join('');
    const results = roundResults(round, names).map(line => `<p class="rc-hl-shares">${esc(line)}</p>`).join('');
    return `<section class="rc-hl-run" data-run="${round.run}"><h3>${t('night.run', { count: round.run })}</h3>${cards ? `<div class="rc-hl-cards"><div class="rc-board">${cards}</div></div>` : ''}${results}</section>`;
  }).join('')}</div>`;
}
function highlightCard(h, sum) {
  const who = sum.players.filter(p => h.players?.includes(p.id));
  const cards = h.board?.length && (h.kind === 'pot' || h.kind === 'best') ? `<div class="rc-hl-cards">${h.cards ? `<span class="rc-hole">${h.cards.map(c => playingCard(c, { size: 'is-mini', flipped: true })).join('')}</span>` : ''}<span class="rc-board">${h.board.map(c => playingCard(c, { size: 'is-mini', flipped: true, cls: h.best && !h.best.includes(c) ? 'is-dim' : '' })).join('')}</span></div>` : '';
  const value = h.kind === 'pot' ? n(h.value) : h.kind === 'swing' ? signed(h.value) : h.kind === 'vpip' ? `${h.value}%` : h.kind === 'allin' ? handCount(h.value) : '';
  const rounds = h.rounds ? highlightRuns(h.rounds, new Map(sum.players.map(p => [p.id, p.name]))) : '';
  return `<article class="rc-hl rc-hl-${h.kind}"><div class="rc-hl-top"><span class="rc-hl-title">${esc(textOf(h, 'title'))}</span>${who.length ? `<span class="rc-hl-who">${who.slice(0, 3).map(p => avatar(p, 'is-xs')).join('')}</span>` : ''}</div>${value ? `<div class="rc-hl-value num">${value}</div>` : ''}<p class="rc-hl-text">${esc(textOf(h, 'text'))}</p>${cards}${rounds}</article>`;
}
function rankRow(p, max, me) {
  const w = max ? Math.max(3, Math.round(Math.abs(p.net) / max * 100)) : 0;
  const sub = p.status === 'left' ? t('night.leftWith', { time: clock(p.leftAt), amount: n(p.cashOut) }) : t('night.buyInTo', { amount: n(p.buyIn), rebuys: p.rebuys ? t('night.rebuySuffix', { count: p.rebuys }) : '', final: n(p.final) });
  return `<li class="rc-row ${tone(p.net)} ${p.id === me ? 'is-me' : ''} ${p.status === 'left' ? 'is-left' : ''}" data-player="${esc(p.id)}"><span class="rc-rank num">${p.rank}</span>${avatar(p)}<div class="rc-who"><b>${esc(p.name)}${p.id === me ? `<em>${t('night.you')}</em>` : ''}</b><span>${esc(sub)}</span></div>
<div class="rc-bar" aria-hidden="true"><i style="--w:${w}%"></i></div><div class="rc-net"><b class="num">${signed(p.net)}</b><span>${p.hands ? `${handCount(p.hands)}${p.vpip !== null ? ` · ${t('night.vpipShort', { value: p.vpip })}` : ''}` : t('night.notPlayed')}</span></div></li>`;
}
// 大屏 / 手机通用的全桌总结主体。
export function recapBody(sum, { me = null } = {}) {
  const max = Math.max(0, ...sum.players.map(p => Math.abs(p.net)));
  const left = sum.players.filter(p => p.status === 'left').length;
  const note = statNote(sum);
  return `<section class="rc-hero"><div class="eyebrow rc-eyebrow"><i></i>${t(sum.room.ended ? 'night.nightEnded' : 'night.nightLive')}</div><h1>${esc(sum.room.name)}</h1>
<ul class="rc-facts"><li><span>${t('night.duration')}</span><b class="num">${duration(sum.room.durationMs)}</b></li><li><span>${t('night.hands')}</span><b class="num">${n(sum.room.hands)}</b></li><li><span>${t('night.players')}</span><b class="num">${sum.players.length}${left ? `<small> · ${t('night.playersLeft', { count: left })}</small>` : ''}</b></li><li><span>${esc(span(sum.room))}</span><b>${esc(modeLabel(sum.room))}</b></li></ul></section>
<section class="rc-rank-list" aria-label="${t('night.rankings')}"><h2 class="sr-only">${t('night.rankings')}</h2><ol>${sum.players.map(p => rankRow(p, max, me)).join('')}</ol>${note ? `<p class="rc-note">${esc(note)}</p>` : ''}</section>
<aside class="rc-side">${balanceCard(sum)}${sum.highlights.length ? `<section class="rc-hls" aria-label="${t('night.highlightsLabel')}"><h2>${t('night.highlightsTonight')}</h2><div class="rc-hl-grid">${sum.highlights.map(h => highlightCard(h, sum)).join('')}</div></section>` : ''}</aside>`;
}
// 手机上的个人总结卡。
export function personalBody(sum, me) {
  const p = sum.players.find(q => q.id === me);
  if (!p) return '';
  const stats = [
    [t('night.buyIn'), n(p.buyIn), p.rebuys ? t('night.rebuysIncluded', { count: p.rebuys }) : t('night.startingChips')],
    [t(p.status === 'left' ? 'night.cashOut' : 'night.finalChips'), n(p.status === 'left' ? p.cashOut : p.final), p.status === 'left' ? t('night.leftAt', { time: clock(p.leftAt) }) : t('night.atClose')],
    [t('night.played'), handCount(n(p.hands)), sum.room.legacy && sum.room.statsFrom > 1 ? t('night.fromHand', { count: sum.room.statsFrom }) : t('night.tableHands', { count: n(sum.room.hands) })],
    [t('night.wonPots'), handCount(n(p.won)), p.hands ? t('night.wonNote', { value: Math.round(p.won / p.hands * 100) }) : ''],
    [t('night.biggestWin'), p.biggest ? `+${n(p.biggest)}` : '—', p.biggestHand ? t('night.biggestHand', { count: p.biggestHand }) : t('night.noPotWon')],
    [t('night.vpip'), p.vpip !== null ? `${p.vpip}%` : '—', t('night.vpipNote')],
    [t('night.allin'), handCount(n(p.allins)), p.showdowns ? t('night.showdownsCount', { count: p.showdowns }) : '']
  ];
  return `<section class="pc-hero ${tone(p.net)}"><div class="pc-top">${avatar(p, 'is-lg')}<div><span class="eyebrow">${t(p.status === 'left' ? 'night.youLeft' : 'night.yourNight')}</span><b>${esc(p.name)}</b></div><span class="pc-rank"><b class="num">${p.rank}</b><small>/ ${sum.players.length}</small></span></div>
<div class="pc-net num">${signed(p.net)}</div><p class="pc-sub">${esc(sum.room.name)} · ${esc(span(sum.room))} · ${duration(sum.room.durationMs)}</p></section>
<section class="pc-stats">${stats.map(([k, v, sub]) => `<div><span>${k}</span><b class="num">${esc(v)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`).join('')}</section>
${p.best ? `<section class="pc-best"><span class="eyebrow">${t('night.bestShownTitle')}</span><div class="pc-best-row"><span class="rc-hole">${p.best.cards.map(c => playingCard(c, { size: 'is-mini', flipped: true })).join('')}</span><div><b>${esc(textOf(p.best, 'name'))}</b><small>${place(p.best)}</small></div></div></section>` : ''}`;
}

// ── 文字战报 ──
export function recapText(sum) {
  const r = sum.room, b = sum.balance;
  const lines = [t('night.reportTitle', { name: r.name }), `${span(r)} · ${duration(r.durationMs)} · ${t('night.totalHands', { count: r.hands })}`, modeLabel(r), '', t('night.rankingText')];
  for (const p of sum.players) lines.push(`${p.rank}. ${p.name}  ${signed(p.net)}${t('night.parenthetical', { text: p.status === 'left' ? t('night.leftEarly', { time: clock(p.leftAt) }) : t('night.buyInTo', { amount: n(p.buyIn), rebuys: '', final: n(p.final) }) })}`);
  lines.push('', b.ok ? t('night.balanceText', { buyIn: n(b.buyIn), final: n(b.final), cashOut: b.cashOut ? t('night.cashOutText', { amount: n(b.cashOut) }) : '' }) : t('night.balanceMismatchText'));
  if (sum.highlights.length) {
    lines.push('', t('night.highlights'));
    const names = new Map(sum.players.map(p => [p.id, p.name]));
    const suits = { s: '♠', h: '♥', d: '♦', c: '♣' };
    for (const h of sum.highlights) {
      lines.push(`· ${textOf(h, 'title')}${h.kind === 'pot' ? ` ${n(h.value)}` : h.kind === 'swing' ? ` ${signed(h.value)}` : ''} · ${textOf(h, 'text')}`);
      for (const round of h.rounds || []) {
        const cards = round.board.map(c => rankLabel(c[0]) + suits[c[1]]).join(' ');
        lines.push([`  ${t('night.run', { count: round.run })}`, cards, roundResults(round, names).join(' / ')].filter(Boolean).join(' · '));
      }
    }
  }
  lines.push('', t('night.disclaimer'));
  return lines.join('\n');
}
export function personalText(sum, me) {
  const p = sum.players.find(q => q.id === me); if (!p) return recapText(sum);
  const lines = [t('night.myReportTitle', { name: sum.room.name }), `${p.name} ${signed(p.net)} · ${t('night.rankOf', { rank: p.rank, total: sum.players.length })}`,
    t('night.buyInPersonal', { amount: n(p.buyIn), rebuys: p.rebuys ? t('night.rebuySuffix', { count: p.rebuys }) : '', result: t(p.status === 'left' ? 'night.cashOutAmount' : 'night.finalAmount', { amount: n(p.status === 'left' ? p.cashOut : p.final) }) }),
    `${t('night.playedCount', { count: p.hands })}${p.vpip !== null ? ` · ${t('night.vpipValue', { value: p.vpip })}` : ''} · ${t('night.wonCountText', { count: p.won })}${p.biggest ? ` · ${t('night.biggestCountText', { amount: n(p.biggest), hand: p.biggestHand })}` : ''}${p.allins ? ` · ${t('night.allinCount', { count: p.allins })}` : ''}`];
  if (p.best) lines.push(`${t('night.bestShown', { name: textOf(p.best, 'name') })}${t('night.parenthetical', { text: place(p.best) })}`);
  lines.push(`${span(sum.room)} · ${duration(sum.room.durationMs)}`, t('night.disclaimer'));
  return lines.join('\n');
}

// ── 分享图（Canvas 绘制，不依赖截图库） ──
const HUES = ['#5f7f9c', '#9a6b52', '#6e8f6a', '#8a6c95', '#a08a53', '#5b8c8c', '#9c5f6b', '#6b7aa6', '#8c8a62', '#7a6a5c'];
const DEFAULT_FONTS = { serif: "'NT Serif SC', 'Songti SC', 'STSong', serif", sans: "'NT Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif", num: "'NT Inter', 'NT Sans SC', system-ui, sans-serif", rank: "'NT Fraunces', 'NT Serif SC', Georgia, serif" };
export function imageFonts() {
  const language = getLanguage();
  if (language === 'zh-CN') return { ...DEFAULT_FONTS };
  const fallbacks = {
    'zh-TW': { sans: "'NT Inter', 'PingFang TC', 'Microsoft JhengHei', 'Noto Sans CJK TC', system-ui, sans-serif", serif: "'Songti TC', 'Noto Serif CJK TC', 'PingFang TC', 'Microsoft JhengHei', serif" },
    ja: { sans: "'Hiragino Sans', 'Noto Sans CJK JP', 'Yu Gothic', 'Meiryo', system-ui, sans-serif", serif: "'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif CJK JP', 'Hiragino Sans', serif" },
    ko: { sans: "'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans CJK KR', system-ui, sans-serif", serif: "'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Serif CJK KR', system-ui, sans-serif" }
  };
  const fallback = fallbacks[language] || { sans: "'NT Inter', system-ui, sans-serif", serif: "'NT Inter', system-ui, sans-serif" };
  const style = typeof document !== 'undefined' && typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const sans = style?.getPropertyValue('--font-ui').trim() || fallback.sans;
  const serif = style?.getPropertyValue('--font-serif').trim() || fallback.serif;
  return { sans, serif, num: `'NT Inter', ${sans}`, rank: `'NT Fraunces', ${serif}` };
}
const C = { ink: '#060807', ink2: '#111816', text: '#f2ede2', text2: 'rgba(242,237,226,.66)', text3: 'rgba(242,237,226,.48)', hair: 'rgba(236,228,210,.12)', gold: '#e3c48a', goldHi: '#f4dfb3', seal: '#d4573e', jade: '#84cfae', danger: '#ee8a74', paper: '#f8f3e8', red: '#c33a2c', black: '#16181b' };
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function txt(ctx, s, x, y, { font, color = C.text, align = 'left', spacing = 0, base = 'alphabetic', maxWidth }) {
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`;
  const width = maxWidth ?? (align === 'left' ? ctx.canvas.width - 96 - x : align === 'right' ? x - 96 : undefined);
  if (width > 0) ctx.fillText(s, x, y, width);
  else ctx.fillText(s, x, y);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}
function fit(ctx, s, width, font) {
  ctx.font = font; if (ctx.measureText(s).width <= width) return s;
  let t = [...s]; while (t.length > 1 && ctx.measureText(`${t.join('')}…`).width > width) t.pop();
  return `${t.join('')}…`;
}
function seal(ctx, x, y, s, F) {
  const g = ctx.createLinearGradient(x, y, x + s, y + s); g.addColorStop(0, '#e06a4f'); g.addColorStop(.45, C.seal); g.addColorStop(1, '#a83c28');
  rr(ctx, x, y, s, s, s * .22); ctx.fillStyle = g; ctx.fill();
  rr(ctx, x + 4, y + 4, s - 8, s - 8, s * .16); ctx.strokeStyle = 'rgba(255,240,225,.38)'; ctx.lineWidth = 1.5; ctx.stroke();
  txt(ctx, t('night.seal'), x + s / 2, y + s / 2 + 2, { font: `700 ${s * .56}px ${F.serif}`, color: '#fff4ea', align: 'center', base: 'middle' });
}
function shade(hex, amt) {
  const v = parseInt(hex.slice(1), 16), mixc = amt > 0 ? 255 : 0, a = Math.abs(amt);
  const ch = i => Math.round(((v >> i) & 255) * (1 - a) + mixc * a);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
function disc(ctx, x, y, r, p, F) {
  const c = HUES[((Number(p.seat) || 1) - 1) % 10];
  const g = ctx.createRadialGradient(x - r * .4, y - r * .6, r * .1, x, y, r * 1.15); g.addColorStop(0, shade(c, .14)); g.addColorStop(1, shade(c, -.46));
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 2; ctx.stroke();
  txt(ctx, [...String(p.name)][0] || '?', x, y + 2, { font: `600 ${r * .9}px ${F.serif}`, color: '#f7f1e4', align: 'center', base: 'middle' });
}
function suit(ctx, code, x, y, size, color) {
  ctx.save(); ctx.translate(x, y); ctx.scale(size / 100, size / 100); ctx.fillStyle = color; ctx.fill(new Path2D(SUIT_PATH[code])); ctx.restore();
}
function card(ctx, code, x, y, w, F) {
  const h = w * 1.4, red = code[1] === 'h' || code[1] === 'd';
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 8;
  rr(ctx, x, y, w, h, w * .09); ctx.fillStyle = C.paper; ctx.fill(); ctx.restore();
  const ink = red ? C.red : C.black, rank = code[0] === 'T' ? '10' : code[0];
  txt(ctx, rank, x + w * .1, y + w * .46, { font: `620 ${w * .42}px ${F.rank}`, color: ink });
  suit(ctx, code[1], x + w * .12, y + w * .54, w * .22, ink);
  suit(ctx, code[1], x + w * .42, y + h - w * .58, w * .5, ink);
}
function frame(ctx, W, H) {
  ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
  let g = ctx.createRadialGradient(W / 2, 260, 40, W / 2, 260, W * .9); g.addColorStop(0, 'rgba(23,80,69,.55)'); g.addColorStop(.55, 'rgba(15,59,50,.18)'); g.addColorStop(1, 'rgba(6,8,7,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  g = ctx.createRadialGradient(W / 2, 120, 10, W / 2, 120, 520); g.addColorStop(0, 'rgba(255,236,190,.10)'); g.addColorStop(1, 'rgba(255,236,190,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  rr(ctx, 28, 28, W - 56, H - 56, 44); ctx.strokeStyle = 'rgba(227,196,138,.34)'; ctx.lineWidth = 2; ctx.stroke();
  rr(ctx, 36, 36, W - 72, H - 72, 38); ctx.strokeStyle = 'rgba(227,196,138,.10)'; ctx.lineWidth = 1; ctx.stroke();
}
function footer(ctx, W, H, F) {
  ctx.strokeStyle = C.hair; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(96, H - 132); ctx.lineTo(W - 96, H - 132); ctx.stroke();
  seal(ctx, 96, H - 104, 44, F);
  txt(ctx, t('night.appTitle'), 156, H - 74, { font: `700 30px ${F.serif}`, spacing: 6 });
  txt(ctx, t('night.imageFooter'), W - 96, H - 74, { font: `400 24px ${F.sans}`, color: C.text3, align: 'right', maxWidth: W - 380 });
}
async function fontsReady(F) {
  try { await Promise.all([`700 40px ${F.serif}`, `600 40px ${F.serif}`, `400 20px ${F.sans}`, `700 20px ${F.sans}`, `600 40px ${F.num}`, `620 40px ${F.rank}`].map(f => document.fonts.load(f, `${t('night.appTitle')}0A`))); } catch { /* 系统字体兜底 */ }
}
export async function shareImage(sum, me = null) {
  const F = imageFonts();
  await fontsReady(F);
  const W = 1080, mine = me && sum.players.find(p => p.id === me);
  const rows = mine ? 0 : sum.players.length;
  const H = mine ? 1440 : Math.max(1350, 400 + rows * 104 + 90 + (sum.highlights.length ? 240 : 0) + 190);
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  frame(ctx, W, H);
  const r = sum.room;
  txt(ctx, t(mine ? 'night.imageMine' : 'night.imageReport'), 96, 150, { font: `500 26px ${F.sans}`, color: C.gold, spacing: 6 });
  txt(ctx, r.name, 96, 232, { font: `700 72px ${F.serif}`, spacing: 6 });
  txt(ctx, `${span(r)} · ${duration(r.durationMs)} · ${handCount(r.hands)}`, 96, 290, { font: `400 28px ${F.sans}`, color: C.text2 });
  txt(ctx, modeLabel(r), 96, 334, { font: `400 26px ${F.sans}`, color: C.text3 });
  if (mine) {
    const p = mine, color = p.net > 0 ? C.goldHi : p.net < 0 ? C.danger : C.text;
    disc(ctx, 140, 470, 44, p, F);
    txt(ctx, p.name, 206, 466, { font: `600 44px ${F.serif}`, spacing: 2 });
    txt(ctx, p.status === 'left' ? t('night.leftEarly', { time: clock(p.leftAt) }) : t('night.rankPlayers', { rank: p.rank, total: sum.players.length }), 206, 506, { font: `400 26px ${F.sans}`, color: C.text2 });
    txt(ctx, signed(p.net), 96, 700, { font: `650 168px ${F.num}`, color, spacing: -4 });
    const stats = [[t('night.buyIn'), n(p.buyIn)], [t(p.status === 'left' ? 'night.cashOut' : 'night.finalChips'), n(p.status === 'left' ? p.cashOut : p.final)], [t('night.played'), handCount(p.hands)], [t('night.wonPots'), handCount(p.won)], [t('night.biggestWin'), p.biggest ? `+${n(p.biggest)}` : '—'], [t('night.vpip'), p.vpip !== null ? `${p.vpip}%` : '—']];
    stats.forEach(([k, v], i) => {
      const x = 96 + (i % 3) * 300, y = 800 + Math.floor(i / 3) * 170;
      rr(ctx, x, y, 276, 146, 26); ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.fill(); ctx.strokeStyle = C.hair; ctx.stroke();
      txt(ctx, k, x + 26, y + 50, { font: `400 24px ${F.sans}`, color: C.text3, spacing: 2, maxWidth: 224 });
      txt(ctx, v, x + 26, y + 112, { font: `600 46px ${F.num}`, maxWidth: 224 });
    });
    if (p.best) {
      txt(ctx, `${t('night.bestShown', { name: textOf(p.best, 'name') })}${p.best.run ? ` · ${place(p.best)}` : ''}`, 96, 1166, { font: `600 30px ${F.serif}`, color: C.goldHi, spacing: 2 });
      p.best.cards.forEach((c, i) => card(ctx, c, 96 + i * 92, 1190, 80, F));
    }
  } else {
    let y = 400;
    const max = Math.max(1, ...sum.players.map(p => Math.abs(p.net)));
    for (const p of sum.players) {
      const up = p.net > 0, color = up ? C.goldHi : p.net < 0 ? C.danger : C.text2;
      if (p.rank === 1 && up) { rr(ctx, 72, y - 8, W - 144, 96, 24); ctx.fillStyle = 'rgba(227,196,138,.08)'; ctx.fill(); ctx.strokeStyle = 'rgba(227,196,138,.36)'; ctx.stroke(); }
      txt(ctx, String(p.rank), 116, y + 54, { font: `620 40px ${F.rank}`, color: p.rank <= 3 ? C.gold : C.text3, align: 'center' });
      disc(ctx, 196, y + 40, 32, p, F);
      txt(ctx, p.name, 248, y + 34, { font: `600 34px ${F.serif}`, spacing: 1, maxWidth: 330 });
      txt(ctx, p.status === 'left' ? t('night.leftEarly', { time: clock(p.leftAt) }) : t('night.buyInTo', { amount: n(p.buyIn), rebuys: '', final: n(p.final) }), 248, y + 72, { font: `400 22px ${F.sans}`, color: C.text3 });
      const bw = Math.max(6, Math.round(Math.abs(p.net) / max * 190));
      rr(ctx, 600, y + 34, 190, 10, 5); ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fill();
      rr(ctx, 600, y + 34, bw, 10, 5); ctx.fillStyle = up ? C.gold : p.net < 0 ? 'rgba(238,138,116,.8)' : C.text3; ctx.fill();
      txt(ctx, signed(p.net), W - 96, y + 52, { font: `650 42px ${F.num}`, color, align: 'right', maxWidth: 170 });
      y += 104;
    }
    const b = sum.balance;
    y += 20;
    ctx.fillStyle = b.ok ? C.jade : C.danger; ctx.beginPath(); ctx.arc(104, y + 22, 7, 0, Math.PI * 2); ctx.fill();
    txt(ctx, b.ok ? t('night.imageBalanced', { buyIn: n(b.buyIn), final: n(b.final), cashOut: b.cashOut ? t('night.imageCashOut', { amount: n(b.cashOut) }) : '' }) : t('night.imageMismatch'), 126, y + 32, { font: `400 26px ${F.sans}`, color: C.text2 });
    y += 80;
    const hls = sum.highlights.slice(0, 2);
    hls.forEach((h, i) => {
      const x = 96 + i * 456, w = hls.length === 1 ? W - 192 : 432;
      rr(ctx, x, y, w, 200, 28); ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.fill(); ctx.strokeStyle = C.hair; ctx.stroke();
      txt(ctx, textOf(h, 'title'), x + 28, y + 52, { font: `600 28px ${F.serif}`, color: C.gold, spacing: 3, maxWidth: w - 56 });
      const value = h.kind === 'pot' ? n(h.value) : h.kind === 'swing' ? signed(h.value) : h.kind === 'vpip' ? `${h.value}%` : h.kind === 'allin' ? handCount(h.value) : '';
      if (value) txt(ctx, value, x + 28, y + 118, { font: `650 54px ${F.num}`, maxWidth: w - 56 });
      ctx.save(); rr(ctx, x, y, w, 200, 28); ctx.clip();
      if (value) txt(ctx, fit(ctx, textOf(h, 'text'), w - 56, `400 24px ${F.sans}`), x + 28, y + 166, { font: `400 24px ${F.sans}`, color: C.text2 });
      else {
        const parts = textOf(h, 'text').split(' · '), big = parts.length > 2 ? parts.slice(1, -1).join(' · ') : parts[0], small = parts.length > 2 ? `${parts[0]} · ${parts.at(-1)}` : parts.slice(1).join(' · ');
        txt(ctx, fit(ctx, big, w - 56, `600 40px ${F.serif}`), x + 28, y + 116, { font: `600 40px ${F.serif}`, spacing: 2 });
        txt(ctx, fit(ctx, small, w - 56, `400 24px ${F.sans}`), x + 28, y + 166, { font: `400 24px ${F.sans}`, color: C.text2 });
      }
      ctx.restore();
    });
  }
  footer(ctx, W, H, F);
  return canvas.toDataURL('image/png');
}

// http 局域网不是安全上下文，Clipboard API 不可用：退回到选中文本复制。
export async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through */ }
  const area = document.createElement('textarea');
  area.value = text; area.setAttribute('readonly', ''); area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.append(area); area.select(); area.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove(); return ok;
}
