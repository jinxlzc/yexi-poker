// 散场总结：大屏排行、手机个人总结、文字战报与竖版分享图。数据全部来自服务端 summarize()。
import { playingCard, SUIT_PATH } from '/cards/table-cards.js';

export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const n = value => Number(value || 0).toLocaleString('en-US');
export const signed = v => (v > 0 ? `+${n(v)}` : v < 0 ? `−${n(-v)}` : '±0');
const hue = seat => `h${((Number(seat) || 1) - 1) % 10 + 1}`;
const initial = name => esc([...String(name || '?')][0]);
const avatar = (p, size = '') => `<div class="avatar ${hue(p.seat)} ${size}" aria-hidden="true">${initial(p.name)}</div>`;
const pad = v => String(v).padStart(2, '0');
export const clock = iso => { if (!iso) return ''; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const day = iso => { if (!iso) return ''; const d = new Date(iso); return `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`; };
export function duration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ''}`;
}
const tone = v => (v > 0 ? 'is-up' : v < 0 ? 'is-down' : 'is-even');
const modeLabel = room => `${room.mode === 'digital' ? '电子牌' : '实体牌'} · 盲注 ${n(room.smallBlind)}/${n(room.bigBlind)}${room.ante ? ` · 前注 ${n(room.ante)}` : ''}`;
function span(room) { return `${day(room.startedAt || room.createdAt)} ${clock(room.startedAt || room.createdAt)}–${room.ended ? clock(room.endedAt) : '现在'}`; }

function statNote(sum) {
  if (sum.room.legacy && sum.room.statsFrom > 1) return `这张桌子来自旧版本：第 1–${sum.room.statsFrom - 1} 手只计入盈亏，手数、入池率等从第 ${sum.room.statsFrom} 手开始统计。`;
  return '';
}
function balanceCard(sum) {
  const b = sum.balance;
  return `<section class="rc-balance ${b.ok ? 'is-ok' : 'is-off'}" aria-label="账目核对"><div class="rc-bal-head"><span class="rc-check" aria-hidden="true">${b.ok ? '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>' : '!'}</span><div><b>${b.ok ? '账平' : '账对不上'}</b><span>${b.ok ? '每一手的输赢加起来，正好等于带入与离场的差' : '请截图并反馈；数字以服务端记录为准'}</span></div></div>
<div class="rc-eq"><div><span>总带入</span><b class="num">${n(b.buyIn)}</b></div><i>=</i><div><span>最终筹码</span><b class="num">${n(b.final)}</b></div>${b.cashOut ? `<i>+</i><div><span>提前带走</span><b class="num">${n(b.cashOut)}</b></div>` : ''}${b.pot ? `<i>+</i><div><span>池中</span><b class="num">${n(b.pot)}</b></div>` : ''}</div></section>`;
}
function highlightCard(h, sum) {
  const who = sum.players.filter(p => h.players?.includes(p.id));
  const cards = h.board?.length && (h.kind === 'pot' || h.kind === 'best') ? `<div class="rc-hl-cards">${h.cards ? `<span class="rc-hole">${h.cards.map(c => playingCard(c, { size: 'is-mini', flipped: true })).join('')}</span>` : ''}<span class="rc-board">${h.board.map(c => playingCard(c, { size: 'is-mini', flipped: true, cls: h.best && !h.best.includes(c) ? 'is-dim' : '' })).join('')}</span></div>` : '';
  const value = h.kind === 'pot' ? n(h.value) : h.kind === 'swing' ? signed(h.value) : h.kind === 'vpip' ? `${h.value}%` : h.kind === 'allin' ? `${h.value} 手` : '';
  return `<article class="rc-hl rc-hl-${h.kind}"><div class="rc-hl-top"><span class="rc-hl-title">${esc(h.title)}</span>${who.length ? `<span class="rc-hl-who">${who.slice(0, 3).map(p => avatar(p, 'is-xs')).join('')}</span>` : ''}</div>${value ? `<div class="rc-hl-value num">${value}</div>` : ''}<p class="rc-hl-text">${esc(h.text)}</p>${cards}</article>`;
}
function rankRow(p, max, me) {
  const w = max ? Math.max(3, Math.round(Math.abs(p.net) / max * 100)) : 0;
  const sub = p.status === 'left' ? `${clock(p.leftAt)} 提前离席 · 带走 ${n(p.cashOut)}` : `带入 ${n(p.buyIn)}${p.rebuys ? `（含补码 ${p.rebuys} 次）` : ''} → ${n(p.final)}`;
  return `<li class="rc-row ${tone(p.net)} ${p.id === me ? 'is-me' : ''} ${p.status === 'left' ? 'is-left' : ''}" data-player="${esc(p.id)}"><span class="rc-rank num">${p.rank}</span>${avatar(p)}<div class="rc-who"><b>${esc(p.name)}${p.id === me ? '<em>你</em>' : ''}</b><span>${esc(sub)}</span></div>
<div class="rc-bar" aria-hidden="true"><i style="--w:${w}%"></i></div><div class="rc-net"><b class="num">${signed(p.net)}</b><span>${p.hands ? `${p.hands} 手${p.vpip !== null ? ` · 入池 ${p.vpip}%` : ''}` : '没有上桌'}</span></div></li>`;
}
// 大屏 / 手机通用的全桌总结主体。
export function recapBody(sum, { me = null } = {}) {
  const max = Math.max(0, ...sum.players.map(p => Math.abs(p.net)));
  const left = sum.players.filter(p => p.status === 'left').length;
  const note = statNote(sum);
  return `<section class="rc-hero"><div class="eyebrow rc-eyebrow"><i></i>${sum.room.ended ? '今晚散场' : '牌局进行中 · 目前战况'}</div><h1>${esc(sum.room.name)}</h1>
<ul class="rc-facts"><li><span>时长</span><b class="num">${duration(sum.room.durationMs)}</b></li><li><span>手数</span><b class="num">${n(sum.room.hands)}</b></li><li><span>人数</span><b class="num">${sum.players.length}${left ? `<small> · ${left} 人先走</small>` : ''}</b></li><li><span>${esc(span(sum.room))}</span><b>${esc(modeLabel(sum.room))}</b></li></ul></section>
<section class="rc-rank-list" aria-label="排行"><h2 class="sr-only">排行</h2><ol>${sum.players.map(p => rankRow(p, max, me)).join('')}</ol>${note ? `<p class="rc-note">${esc(note)}</p>` : ''}</section>
<aside class="rc-side">${balanceCard(sum)}${sum.highlights.length ? `<section class="rc-hls" aria-label="高光时刻"><h2>今晚的高光</h2><div class="rc-hl-grid">${sum.highlights.map(h => highlightCard(h, sum)).join('')}</div></section>` : ''}</aside>`;
}
// 手机上的个人总结卡。
export function personalBody(sum, me) {
  const p = sum.players.find(q => q.id === me);
  if (!p) return '';
  const stats = [
    ['总带入', n(p.buyIn), p.rebuys ? `含补码 ${p.rebuys} 次` : '起始筹码'],
    [p.status === 'left' ? '离席带走' : '最终筹码', n(p.status === 'left' ? p.cashOut : p.final), p.status === 'left' ? `${clock(p.leftAt)} 离席` : '散场时'],
    ['打了', `${n(p.hands)} 手`, sum.room.legacy && sum.room.statsFrom > 1 ? `从第 ${sum.room.statsFrom} 手起` : `全桌 ${n(sum.room.hands)} 手`],
    ['拿下底池', `${n(p.won)} 次`, p.hands ? `占 ${Math.round(p.won / p.hands * 100)}%` : ''],
    ['最大一笔', p.biggest ? `+${n(p.biggest)}` : '—', p.biggestHand ? `第 ${p.biggestHand} 手` : '还没赢过底池'],
    ['入池率', p.vpip !== null ? `${p.vpip}%` : '—', '翻前主动投入'],
    ['全下', `${n(p.allins)} 手`, p.showdowns ? `摊牌 ${p.showdowns} 次` : '']
  ];
  return `<section class="pc-hero ${tone(p.net)}"><div class="pc-top">${avatar(p, 'is-lg')}<div><span class="eyebrow">${p.status === 'left' ? '你提前离席了' : '你的今晚'}</span><b>${esc(p.name)}</b></div><span class="pc-rank"><b class="num">${p.rank}</b><small>/ ${sum.players.length}</small></span></div>
<div class="pc-net num">${signed(p.net)}</div><p class="pc-sub">${esc(sum.room.name)} · ${esc(span(sum.room))} · ${duration(sum.room.durationMs)}</p></section>
<section class="pc-stats">${stats.map(([k, v, sub]) => `<div><span>${k}</span><b class="num">${esc(v)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`).join('')}</section>
${p.best ? `<section class="pc-best"><span class="eyebrow">你亮过的最好一手</span><div class="pc-best-row"><span class="rc-hole">${p.best.cards.map(c => playingCard(c, { size: 'is-mini', flipped: true })).join('')}</span><div><b>${esc(p.best.name)}</b><small>第 ${p.best.hand} 手</small></div></div></section>` : ''}`;
}

// ── 文字战报 ──
export function recapText(sum) {
  const r = sum.room, b = sum.balance;
  const lines = [`【夜席战报】${r.name}`, `${span(r)} · ${duration(r.durationMs)} · 共 ${r.hands} 手`, modeLabel(r), '', '排名'];
  for (const p of sum.players) lines.push(`${p.rank}. ${p.name}  ${signed(p.net)}${p.status === 'left' ? `（${clock(p.leftAt)} 提前离席）` : `（带入 ${n(p.buyIn)} → ${n(p.final)}）`}`);
  lines.push('', b.ok ? `账平：总带入 ${n(b.buyIn)} = 最终筹码 ${n(b.final)}${b.cashOut ? ` + 提前带走 ${n(b.cashOut)}` : ''}` : '账目没有对上，请以主持电脑为准。');
  if (sum.highlights.length) { lines.push('', '高光'); for (const h of sum.highlights) lines.push(`· ${h.title}${h.kind === 'pot' ? ` ${n(h.value)}` : h.kind === 'swing' ? ` ${signed(h.value)}` : ''} · ${h.text}`); }
  lines.push('', '仅娱乐积分，不涉及任何真钱结算。');
  return lines.join('\n');
}
export function personalText(sum, me) {
  const p = sum.players.find(q => q.id === me); if (!p) return recapText(sum);
  const lines = [`【夜席】我的今晚 · ${sum.room.name}`, `${p.name} ${signed(p.net)} · 第 ${p.rank} / ${sum.players.length}`,
    `带入 ${n(p.buyIn)}${p.rebuys ? `（含补码 ${p.rebuys} 次）` : ''} → ${p.status === 'left' ? `离席带走 ${n(p.cashOut)}` : `最终 ${n(p.final)}`}`,
    `打了 ${p.hands} 手${p.vpip !== null ? ` · 入池率 ${p.vpip}%` : ''} · 拿下底池 ${p.won} 次${p.biggest ? ` · 最大一笔 +${n(p.biggest)}` : ''}${p.allins ? ` · 全下 ${p.allins} 手` : ''}`];
  if (p.best) lines.push(`亮过最好的一手：${p.best.name}（第 ${p.best.hand} 手）`);
  lines.push(`${span(sum.room)} · ${duration(sum.room.durationMs)}`, '仅娱乐积分，不涉及任何真钱结算。');
  return lines.join('\n');
}

// ── 分享图（Canvas 绘制，不依赖截图库） ──
const HUES = ['#5f7f9c', '#9a6b52', '#6e8f6a', '#8a6c95', '#a08a53', '#5b8c8c', '#9c5f6b', '#6b7aa6', '#8c8a62', '#7a6a5c'];
const F = { serif: "'NT Serif SC', 'Songti SC', 'STSong', serif", sans: "'NT Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif", num: "'NT Inter', 'NT Sans SC', system-ui, sans-serif", rank: "'NT Fraunces', 'NT Serif SC', Georgia, serif" };
const C = { ink: '#060807', ink2: '#111816', text: '#f2ede2', text2: 'rgba(242,237,226,.66)', text3: 'rgba(242,237,226,.48)', hair: 'rgba(236,228,210,.12)', gold: '#e3c48a', goldHi: '#f4dfb3', seal: '#d4573e', jade: '#84cfae', danger: '#ee8a74', paper: '#f8f3e8', red: '#c33a2c', black: '#16181b' };
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function txt(ctx, s, x, y, { font, color = C.text, align = 'left', spacing = 0, base = 'alphabetic' }) {
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(s, x, y);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}
function fit(ctx, s, width, font) {
  ctx.font = font; if (ctx.measureText(s).width <= width) return s;
  let t = [...s]; while (t.length > 1 && ctx.measureText(`${t.join('')}…`).width > width) t.pop();
  return `${t.join('')}…`;
}
function seal(ctx, x, y, s) {
  const g = ctx.createLinearGradient(x, y, x + s, y + s); g.addColorStop(0, '#e06a4f'); g.addColorStop(.45, C.seal); g.addColorStop(1, '#a83c28');
  rr(ctx, x, y, s, s, s * .22); ctx.fillStyle = g; ctx.fill();
  rr(ctx, x + 4, y + 4, s - 8, s - 8, s * .16); ctx.strokeStyle = 'rgba(255,240,225,.38)'; ctx.lineWidth = 1.5; ctx.stroke();
  txt(ctx, '夜', x + s / 2, y + s / 2 + 2, { font: `700 ${s * .56}px ${F.serif}`, color: '#fff4ea', align: 'center', base: 'middle' });
}
function shade(hex, amt) {
  const v = parseInt(hex.slice(1), 16), mixc = amt > 0 ? 255 : 0, a = Math.abs(amt);
  const ch = i => Math.round(((v >> i) & 255) * (1 - a) + mixc * a);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
function disc(ctx, x, y, r, p) {
  const c = HUES[((Number(p.seat) || 1) - 1) % 10];
  const g = ctx.createRadialGradient(x - r * .4, y - r * .6, r * .1, x, y, r * 1.15); g.addColorStop(0, shade(c, .14)); g.addColorStop(1, shade(c, -.46));
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 2; ctx.stroke();
  txt(ctx, [...String(p.name)][0] || '?', x, y + 2, { font: `600 ${r * .9}px ${F.serif}`, color: '#f7f1e4', align: 'center', base: 'middle' });
}
function suit(ctx, code, x, y, size, color) {
  ctx.save(); ctx.translate(x, y); ctx.scale(size / 100, size / 100); ctx.fillStyle = color; ctx.fill(new Path2D(SUIT_PATH[code])); ctx.restore();
}
function card(ctx, code, x, y, w) {
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
function footer(ctx, W, H) {
  ctx.strokeStyle = C.hair; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(96, H - 132); ctx.lineTo(W - 96, H - 132); ctx.stroke();
  seal(ctx, 96, H - 104, 44);
  txt(ctx, '夜席', 156, H - 74, { font: `700 30px ${F.serif}`, spacing: 6 });
  txt(ctx, '局域网朋友局 · 仅娱乐积分，不涉及真钱', W - 96, H - 74, { font: `400 24px ${F.sans}`, color: C.text3, align: 'right' });
}
async function fontsReady() {
  try { await Promise.all([`700 40px 'NT Serif SC'`, `600 40px 'NT Serif SC'`, `400 20px 'NT Sans SC'`, `700 20px 'NT Sans SC'`, `600 40px 'NT Inter'`, `620 40px 'NT Fraunces'`].map(f => document.fonts.load(f, '夜席0A'))); } catch { /* 系统字体兜底 */ }
}
export async function shareImage(sum, me = null) {
  await fontsReady();
  const W = 1080, mine = me && sum.players.find(p => p.id === me);
  const rows = mine ? 0 : sum.players.length;
  const H = mine ? 1440 : Math.max(1350, 400 + rows * 104 + 90 + (sum.highlights.length ? 240 : 0) + 190);
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  frame(ctx, W, H);
  const r = sum.room;
  txt(ctx, mine ? '我 的 今 晚' : '夜 席 战 报', 96, 150, { font: `500 26px ${F.sans}`, color: C.gold, spacing: 6 });
  txt(ctx, r.name, 96, 232, { font: `700 72px ${F.serif}`, spacing: 6 });
  txt(ctx, `${span(r)} · ${duration(r.durationMs)} · ${r.hands} 手`, 96, 290, { font: `400 28px ${F.sans}`, color: C.text2 });
  txt(ctx, modeLabel(r), 96, 334, { font: `400 26px ${F.sans}`, color: C.text3 });
  if (mine) {
    const p = mine, color = p.net > 0 ? C.goldHi : p.net < 0 ? C.danger : C.text;
    disc(ctx, 140, 470, 44, p);
    txt(ctx, p.name, 206, 466, { font: `600 44px ${F.serif}`, spacing: 2 });
    txt(ctx, p.status === 'left' ? `${clock(p.leftAt)} 提前离席` : `第 ${p.rank} 名 · 共 ${sum.players.length} 人`, 206, 506, { font: `400 26px ${F.sans}`, color: C.text2 });
    txt(ctx, signed(p.net), 96, 700, { font: `650 168px ${F.num}`, color, spacing: -4 });
    const stats = [['总带入', n(p.buyIn)], [p.status === 'left' ? '离席带走' : '最终筹码', n(p.status === 'left' ? p.cashOut : p.final)], ['打了', `${p.hands} 手`], ['拿下底池', `${p.won} 次`], ['最大一笔', p.biggest ? `+${n(p.biggest)}` : '—'], ['入池率', p.vpip !== null ? `${p.vpip}%` : '—']];
    stats.forEach(([k, v], i) => {
      const x = 96 + (i % 3) * 300, y = 800 + Math.floor(i / 3) * 170;
      rr(ctx, x, y, 276, 146, 26); ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.fill(); ctx.strokeStyle = C.hair; ctx.stroke();
      txt(ctx, k, x + 26, y + 50, { font: `400 24px ${F.sans}`, color: C.text3, spacing: 2 });
      txt(ctx, v, x + 26, y + 112, { font: `600 46px ${F.num}` });
    });
    if (p.best) {
      txt(ctx, `亮过最好的一手 · ${p.best.name}`, 96, 1166, { font: `600 30px ${F.serif}`, color: C.goldHi, spacing: 2 });
      p.best.cards.forEach((c, i) => card(ctx, c, 96 + i * 92, 1190, 80));
    }
  } else {
    let y = 400;
    const max = Math.max(1, ...sum.players.map(p => Math.abs(p.net)));
    for (const p of sum.players) {
      const up = p.net > 0, color = up ? C.goldHi : p.net < 0 ? C.danger : C.text2;
      if (p.rank === 1 && up) { rr(ctx, 72, y - 8, W - 144, 96, 24); ctx.fillStyle = 'rgba(227,196,138,.08)'; ctx.fill(); ctx.strokeStyle = 'rgba(227,196,138,.36)'; ctx.stroke(); }
      txt(ctx, String(p.rank), 116, y + 54, { font: `620 40px ${F.rank}`, color: p.rank <= 3 ? C.gold : C.text3, align: 'center' });
      disc(ctx, 196, y + 40, 32, p);
      txt(ctx, p.name, 248, y + 34, { font: `600 34px ${F.serif}`, spacing: 1 });
      txt(ctx, p.status === 'left' ? `${clock(p.leftAt)} 提前离席` : `带入 ${n(p.buyIn)} → ${n(p.final)}`, 248, y + 72, { font: `400 22px ${F.sans}`, color: C.text3 });
      const bw = Math.max(6, Math.round(Math.abs(p.net) / max * 190));
      rr(ctx, 600, y + 34, 190, 10, 5); ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fill();
      rr(ctx, 600, y + 34, bw, 10, 5); ctx.fillStyle = up ? C.gold : p.net < 0 ? 'rgba(238,138,116,.8)' : C.text3; ctx.fill();
      txt(ctx, signed(p.net), W - 96, y + 52, { font: `650 42px ${F.num}`, color, align: 'right' });
      y += 104;
    }
    const b = sum.balance;
    y += 20;
    ctx.fillStyle = b.ok ? C.jade : C.danger; ctx.beginPath(); ctx.arc(104, y + 22, 7, 0, Math.PI * 2); ctx.fill();
    txt(ctx, b.ok ? `账平 · 总带入 ${n(b.buyIn)} = 最终 ${n(b.final)}${b.cashOut ? ` + 带走 ${n(b.cashOut)}` : ''}` : '账目没有对上，请以主持电脑为准', 126, y + 32, { font: `400 26px ${F.sans}`, color: C.text2 });
    y += 80;
    const hls = sum.highlights.slice(0, 2);
    hls.forEach((h, i) => {
      const x = 96 + i * 456, w = hls.length === 1 ? W - 192 : 432;
      rr(ctx, x, y, w, 200, 28); ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.fill(); ctx.strokeStyle = C.hair; ctx.stroke();
      txt(ctx, h.title, x + 28, y + 52, { font: `600 28px ${F.serif}`, color: C.gold, spacing: 3 });
      const value = h.kind === 'pot' ? n(h.value) : h.kind === 'swing' ? signed(h.value) : h.kind === 'vpip' ? `${h.value}%` : h.kind === 'allin' ? `${h.value} 手` : '';
      if (value) txt(ctx, value, x + 28, y + 118, { font: `650 54px ${F.num}` });
      ctx.save(); rr(ctx, x, y, w, 200, 28); ctx.clip();
      if (value) txt(ctx, fit(ctx, h.text, w - 56, `400 24px ${F.sans}`), x + 28, y + 166, { font: `400 24px ${F.sans}`, color: C.text2 });
      else {
        const parts = h.text.split(' · '), big = parts.length > 2 ? parts.slice(1, -1).join(' · ') : parts[0], small = parts.length > 2 ? `${parts[0]} · ${parts.at(-1)}` : parts.slice(1).join(' · ');
        txt(ctx, fit(ctx, big, w - 56, `600 40px ${F.serif}`), x + 28, y + 116, { font: `600 40px ${F.serif}`, spacing: 2 });
        txt(ctx, fit(ctx, small, w - 56, `400 24px ${F.sans}`), x + 28, y + 166, { font: `400 24px ${F.sans}`, color: C.text2 });
      }
      ctx.restore();
    });
  }
  footer(ctx, W, H);
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
