import { STREETS, ongoing, player, ordered, potTotal, previewSettlement, legalActions, isDigital } from '/shared/engine.js';
import { tableSound } from '/audio/table-sound.js';
import { playingCard, boardSlots } from '/cards/table-cards.js';
import { evaluate, describeHand } from '/shared/cards.js';
import { chipStackHtml, flyChips, clearFlights } from '/chips/table-chips.js';
import { recapBody, personalBody, recapText, personalText, shareImage, copyText, signed, duration, clock as hhmm, day } from '/night/recap.js';
import { handsBody } from '/night/replay.js';
import { keepAwake, buzz, rememberRoom, lastRoom, titleAlert, awakePreferred, setAwakePreferred } from '/night/device.js';

const app = document.querySelector('#app'), modal = document.querySelector('#modal');
const params = new URLSearchParams(location.search);
let code = (params.get('room') || '').toUpperCase();
let page = location.pathname.slice(1) || 'home';
let data = null, network = null, connected = false, everConnected = false, busy = false, ws, retry, toastTimer;
let retryAttempt = 0, loadError = '', bootBusy = false;
let seatChoice = 0, selections = {}, selectedPot = 0, potFingerprint = '', logHand = null, returnFocus;
let fxGen = 0, potLock = false, wasUndo = false, raiseOpen = false, raiseValue = 0;
// 按需拉取的大块数据：完整日志、牌谱、进行中的战况。广播里只带当前手。
let extra = { logs: null, hands: null, summary: null, version: -1 }, extraBusy = false, handPick = null, skew = 0, expiredKey = '', claimPick = null;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const digitalOf = s => isDigital(s);
const n = value => Number(value || 0).toLocaleString('en-US');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tokenKey = role => `night-table.${role}.${code}`;
const readToken = role => localStorage.getItem(tokenKey(role)) || '';
const credential = () => page === 'play' || page === 'join' ? readToken('player') : readToken('host') || readToken('player');
const link = route => `/${route}?room=${code}`;
const btn = (label, action, kind = 'ghost', disabled = false, extra = '') => `<button class="btn btn-${kind}" data-do="${action}" ${disabled || busy ? 'disabled' : ''} ${extra}>${label}</button>`;
const nav = (label, route, kind = 'ghost') => `<a class="btn btn-${kind}" href="${link(route)}">${label}</a>`;
const notice = text => { const el = document.querySelector('#toast'); el.textContent = text; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 4500); };
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
async function api(path, body, token = credential()) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, { signal: controller.signal, method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || '这一步没有送出。'), { status: response.status });
    return result;
  } catch (error) {
    if (error.status) throw error;
    throw new Error('连接中断或超时，请重连后核对牌桌。');
  } finally { clearTimeout(timeout); }
}
function connectionBanner() { return !connected ? `<div class="connection" role="status">${esc(!navigator.onLine ? '网络已断开，恢复网络后会自动重连。' : loadError || '正在恢复连接，将自动重试。')} <button class="link-btn" data-do="reconnect">立即重试</button></div>` : ''; }
function loadingPage() { return `<main class="boot"><span class="seal">夜</span><p>正在接回牌桌</p>${connectionBanner()}<a href="/join">用房间码加入</a></main>`; }
function scheduleRetry(task) {
  clearTimeout(retry);
  if (!navigator.onLine) return;
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(retryAttempt++, 5)) * (.8 + Math.random() * .4);
  retry = setTimeout(task, delay);
}
function reconnect() { clearTimeout(retry); if (data) subscribe(); else boot(); }
function accept(next) {
  if (data && next.state.version < data.state.version) return;
  if (data && data.state.version !== next.state.version && modal.open && modal.dataset.version) closeModal();
  if (data && data.state.version !== next.state.version) raiseOpen = false;
  const previous = data;
  data = next;
  if (digitalOf(next.state) && next.state.hand?.autoJudged && next.state.hand.selections) selections = next.state.hand.selections;
  else {
    const fingerprint = JSON.stringify([next.state.handNumber, next.pots]);
    if (fingerprint !== potFingerprint) {
      selections = next.state.hand?.selections || Object.fromEntries(next.pots.map(p => [p.id, p.eligible.length === 1 ? [...p.eligible] : []]));
      selectedPot = 0; potFingerprint = fingerprint;
    }
  }
  if (typeof next.now === 'number') skew = next.now - Date.now();
  if (page === 'join' && data.role === 'player') { location.replace(link('play')); return; }
  if (page === 'play' && !['player', 'departed'].includes(data.role)) {
    if (previous?.role === 'player') sessionStorage.setItem('night-table.revoked', '1');
    location.replace(link('join')); return;
  }
  if (page === 'table' && data.state.status === 'ended' && previous && previous.state.status !== 'ended') { page = 'recap'; history.replaceState(null, '', link('recap')); }
  if (data.role === 'player' || data.role === 'departed') rememberRoom(code, 'play');
  if (['play', 'table', 'settle'].includes(page)) keepAwake(data.state.status !== 'ended' && data.role !== 'departed');
  if (page === 'play') {
    if (next.legal && !previous?.legal && previous) { buzz(); tableSound.play('turn'); }
    titleAlert(next.legal ? '轮到你' : null);
  }
  if (['log', 'hands', 'recap'].includes(page) && extra.version !== data.state.version) loadExtra();
  render();
  playTransition(previous, next);
}
async function loadExtra() {
  if (extraBusy || !data) return;
  extraBusy = true;
  const version = data.state.version;
  try {
    if (page === 'log') extra.logs = (await api(`/api/rooms/${code}/log`)).logs;
    if (page === 'hands') extra.hands = await api(`/api/rooms/${code}/hands`);
    if (page === 'recap' && !data.summary) extra.summary = await api(`/api/rooms/${code}/summary`);
    extra.version = version;
  } catch (error) { notice(error.message); } finally { extraBusy = false; }
  render();
  if (data.state.version !== version) loadExtra();
}
function subscribe() {
  clearTimeout(retry);
  if (!navigator.onLine || !code || page === 'transfer' || [WebSocket.OPEN, WebSocket.CONNECTING].includes(ws?.readyState)) return;
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`); ws = socket;
  socket.onopen = () => socket.send(JSON.stringify({ type: 'subscribe', code, token: credential() }));
  socket.onmessage = event => {
    if (ws !== socket) return;
    const message = JSON.parse(event.data);
    if (message.type === 'state') { const restored = !connected && everConnected; connected = true; everConnected = true; retryAttempt = 0; loadError = ''; accept(message); if (restored && data.role === 'player') notice(`已接回。${data.legal ? '轮到你。' : `你是${player(data.state, data.playerId)?.name}。`}`); }
    else notice(message.error);
  };
  socket.onclose = () => { if (ws !== socket) return; connected = false; closeModal(); render(); scheduleRetry(subscribe); };
  socket.onerror = () => socket.close();
}
// 实时连接按身份推送视图；身份变了（认领座位）就换一条连接。
function resubscribe() { if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); } subscribe(); }
async function command(type, args = {}) {
  if (busy || !connected) return;
  const version = data.state.version;
  busy = true; closeModal(); render();
  try {
    const result = await api(`/api/rooms/${code}/command`, { type, args, version, requestId: randomToken() });
    accept(result);
    if (type === 'undo') wasUndo = true;
    if (result.notice) notice(result.notice);
    else if (type === 'act') notice({ check: '已过牌', call: '已跟注', fold: '已弃牌', raise: `已加注到 ${n(args.to)}`, allin: '已全下' }[args.action]);
    else if (NOTICES[type]) notice(typeof NOTICES[type] === 'function' ? NOTICES[type](args) : NOTICES[type]);
  } catch (error) {
    tableSound.fail();
    notice(error.message);
    try { accept(await api(`/api/rooms/${code}`)); } catch { /* 重连会再次拉取 */ }
  } finally { busy = false; render(); }
}
const NOTICES = { show: '已亮牌，大家都能看到', sitOut: a => a.away ? '已暂离，下一手起不发你牌' : '欢迎回来，下一手入局', pause: a => a.on ? '已暂停，大家休息一下' : '继续打牌', end: '已散场，每个人手机上都有自己的总结', seat: '座位已调整', level: '盲注已调整，下一手生效', settings: '设置已保存，下一手生效', timeout: '已代为操作，写进了记录' };
const ICON = {
  sound: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4Z"/><path class="wave" d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  qr: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/></svg>',
  undo: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 5 11l4 4"/><path d="M5 11h9a5 5 0 0 1 0 10h-2"/></svg>',
  play: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5.5v13l11-6.5-11-6.5Z"/></svg>',
  next: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h12M13 7l5 5-5 5"/></svg>',
  split: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v6M12 10l-6 6M12 10l6 6"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  seats: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="9" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 6.5a3 3 0 0 1 0 5.5M18 14.5a5.5 5.5 0 0 1 3 4.5"/></svg>',
  list: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7h11M9 12h11M9 17h11"/><circle cx="4.5" cy="7" r=".6"/><circle cx="4.5" cy="12" r=".6"/><circle cx="4.5" cy="17" r=".6"/></svg>',
  check: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  wifi: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9a13 13 0 0 1 18 0M6 12.5a8.5 8.5 0 0 1 12 0M9 16a4 4 0 0 1 6 0"/><circle cx="12" cy="19" r=".8"/></svg>',
  minus: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg>',
  plus: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M12 6v12"/></svg>',
  lock: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  back: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  pause: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12"/></svg>',
  flag: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4"/><path d="M6 4h11l-2.5 4L17 12H6"/></svg>',
  book: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15H7.5A2.5 2.5 0 0 0 5 20.5v-15Z"/><path d="M5 20.5A2.5 2.5 0 0 0 7.5 23H19v-5"/><path d="M9 7h6"/></svg>',
  trophy: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4"/></svg>',
  copy: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/></svg>',
  image: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 3.5 3 3-2.5 4.5 4"/></svg>',
  more: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/></svg>',
  eye: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  clock: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>'
};
// 座位在跑道形牌桌上的单位坐标（相对椭圆半轴），顺时针从左上开始。
const T = -1.1, B = 1.1, S = 1.087;
const SLOTS = {
  1: [[0, B]], 2: [[-S, 0], [S, 0]], 3: [[0, T], [0.62, B], [-0.62, B]],
  4: [[-0.42, T], [0.42, T], [0.42, B], [-0.42, B]],
  5: [[0, T - 0.02], [S, -0.05], [0.5, B], [-0.5, B], [-S, -0.05]],
  6: [[-0.415, T], [0.415, T], [S, 0], [0.415, B], [-0.415, B], [-S, 0]],
  7: [[-0.42, T], [0.42, T], [S, 0], [0.62, B], [0, B + 0.02], [-0.62, B], [-S, 0]],
  8: [[-0.42, T], [0.42, T], [1.05, -0.48], [1.05, 0.48], [0.42, B], [-0.42, B], [-1.05, 0.48], [-1.05, -0.48]],
  9: [[-0.62, T], [0, T - 0.02], [0.62, T], [1.05, -0.48], [1.05, 0.48], [0.42, B], [-0.42, B], [-1.05, 0.48], [-1.05, -0.48]],
  10: [[-0.62, T], [0, T - 0.02], [0.62, T], [1.05, -0.48], [1.05, 0.48], [0.62, B], [0, B + 0.02], [-0.62, B], [-1.05, 0.48], [-1.05, -0.48]]
};
const hueOf = p => `h${((Number(p.seat) || 1) - 1) % 10 + 1}`;
const initial = name => esc([...String(name || '?')][0]);
const avatar = (p, extra = '') => `<div class="avatar ${hueOf(p)}" aria-hidden="true" ${extra}>${initial(p.name)}</div>`;
const handDetail = cards => describeHand(cards);
function equation(s) {
  const detail = `全场 ${n(s.total)} = 座位 ${n(s.total - potTotal(s))} + 池中 ${n(potTotal(s))}`;
  return `<span class="pill eq" role="status" title="${detail}"><span class="ok-dot"></span>全场 <b class="num">${n(s.total)}</b><span class="eq-detail">· 座位 <span class="num">${n(s.total - potTotal(s))}</span> + 池中 <span class="num">${n(potTotal(s))}</span></span> · 账平${s.balanceNote ? `<span class="balance-note">${esc(s.balanceNote)}</span>` : ''}</span>`;
}
const street = s => !s.hand ? '等朋友入座' : s.hand.phase === 'showdown' ? '摊牌' : s.hand.phase === 'settled' ? '这一手结束' : STREETS[s.hand.street];
function muteButton() {
  const on = tableSound.isOn();
  return `<button type="button" class="iconbtn sound-toggle ${on ? '' : 'is-off'}" data-do="toggle-sound" aria-pressed="${on}" aria-label="${on ? '关闭牌桌音效' : '打开牌桌音效'}" title="${on ? '音效开' : '音效关'}">${ICON.sound}</button>`;
}
function topbar(s) {
  return `<header class="topbar"><span class="seal" aria-hidden="true">夜</span><div class="room"><b>${esc(s.config.name)}</b><span>${digitalOf(s) ? '电子牌' : '实体牌'} · 盲注 <span class="num">${blindsText()}</span>${s.config.actionClock ? ` · 计时 ${s.config.actionClock} 秒` : ''}</span></div><div class="mid">${s.status === 'ended' ? `<span class="pill">${ICON.flag}已散场 · ${esc(day(s.endedAt))} <span class="num">${esc(hhmm(s.endedAt))}</span></span>` : s.paused ? `<span class="pill pause-pill">${ICON.pause}休息中 · <b class="num" data-since="${esc(s.paused.at)}">0:00</b></span>` : `<span class="pill">第 <b class="num">${s.handNumber}</b> 手 · ${street(s)}</span>`}${equation(s)}</div><div class="right">${s.status === 'ended' ? '' : `<a class="pill share-pill" href="${link('share')}" aria-label="分享房间 ${code}">${ICON.qr}<span>扫码入座</span><span class="code">${code}</span></a>`}${muteButton()}<a class="iconbtn" href="${link('recap')}" aria-label="${s.status === 'ended' ? '散场总结' : '目前战况'}" title="${s.status === 'ended' ? '总结' : '战况'}">${ICON.trophy}</a><a class="iconbtn" href="${link('hands')}" aria-label="牌谱回放" title="牌谱">${ICON.book}</a><a class="iconbtn" href="${link('log')}" aria-label="这一手的记录" title="记录">${ICON.list}</a></div></header>${connectionBanner()}`;
}
function blindsText() {
  const b = data.blinds || { small: data.state.config.smallBlind, big: data.state.config.bigBlind, ante: data.state.config.ante };
  return `${n(b.small)} / ${n(b.big)}${b.ante ? ` · 前注 ${n(b.ante)}` : ''}`;
}
function home() {
  if (!network) return loadingPage();
  if (!network.local) return joinLookup();
  const addr = network.addresses[0];
  const still = `<div class="still" aria-hidden="true">${playingCard('Kh', { size: 'is-still c1', flipped: true })}${playingCard('As', { size: 'is-still c2', flipped: true })}${playingCard(null, { size: 'is-still c3' })}<div class="still-chips">${chipStackHtml(6000, false, { width: 46 })}${chipStackHtml(2400, false, { width: 46 })}${chipStackHtml(800, false, { width: 46 })}</div></div>`;
  return `<main class="create"><div class="vignette" aria-hidden="true"></div>${still}<div class="c-top"><span class="seal">夜</span><span class="wordmark">夜席</span><span class="ver">开源 · 局域网牌桌</span></div>
<section class="hero-l"><div class="eyebrow"><i></i>同一 Wi‑Fi · 朋友局 · 娱乐积分</div><h1>夜席</h1><p class="sub">一张桌子，几部手机，今晚的局就开了。</p><p class="lead">这台电脑当牌桌，大家用手机扫码入座、下注。可以用电子牌让系统洗牌发牌，也可以照旧用实体牌，只把筹码交给夜席。</p>
${addr ? `<a class="pill lan" href="${esc(addr)}/join">${ICON.wifi}<span>手机连同一 Wi‑Fi，打开</span><b class="num">${esc(addr.replace(/^https?:\/\//, ''))}</b></a>${network.addresses.length > 1 ? `<details class="more-addr"><summary>其他地址</summary>${network.addresses.slice(1).map(a => `<p class="mono">${esc(a)}</p>`).join('')}</details>` : ''}` : '<p class="pill lan">还没有局域网地址。确认电脑已连上 Wi‑Fi，然后刷新。</p>'}
${openRooms(network.rooms)}${historyRooms(network.rooms)}<a class="join-link" href="/join">用房间码加入</a></section>
<form id="create-form" class="panel create-panel"><h2>开一张新桌</h2><p class="lead">两分钟就好。牌局中途也能改打牌方式和补码。</p>
<fieldset class="field modes"><legend>打牌方式</legend>
<label class="mode"><input type="radio" name="dealMode" value="digital" aria-label="电子牌" checked><i class="tick">${ICON.check}</i><span class="art art-digital" aria-hidden="true"><i class="a1">${playingCard(null, { size: 'is-tiny' })}</i><i class="a2">${playingCard('Ah', { size: 'is-tiny', flipped: true })}</i><i class="a3">${ICON.lock}</i></span><b>电子牌</b><span>系统洗牌发牌，底牌只在自己手机上，摊牌自动分池。</span></label>
<label class="mode"><input type="radio" name="dealMode" value="physical" aria-label="实体牌"><i class="tick">${ICON.check}</i><span class="art" aria-hidden="true">${chipStackHtml(725, false, { width: 32 })}</span><b>实体牌</b><span>我们自己发牌，夜席只记筹码、提示轮到谁。</span></label></fieldset>
<div class="field"><label for="room-name">房间名</label><input id="room-name" name="name" value="今晚的牌局" maxlength="16" required></div>
<div class="field"><div class="l">盲注<em>常见：10 / 20</em></div><div class="row2">${['smallBlind', 'bigBlind'].map((k, i) => `<div class="stepper"><label for="${k}" class="k">${i ? '大盲' : '小盲'}</label><button type="button" class="s" data-do="field-step" data-field="${k}" data-step="-1" aria-label="减少${i ? '大盲' : '小盲'}">${ICON.minus}</button><input id="${k}" class="num" name="${k}" type="number" min="1" step="1" value="${i ? 20 : 10}" required><button type="button" class="s" data-do="field-step" data-field="${k}" data-step="1" aria-label="增加${i ? '大盲' : '小盲'}">${ICON.plus}</button></div>`).join('')}</div></div>
<div class="field"><div class="l"><label for="startingStack">起始筹码</label><em id="bb-hint">= 100 BB</em></div><div class="stackrow"><input id="startingStack" class="num" name="startingStack" aria-label="起始筹码" type="number" min="1" step="1" value="2000" required><div class="seg" role="group" aria-label="常用起始筹码">${[50, 100, 200].map(bb => `<button type="button" data-do="stack-preset" data-bb="${bb}">${bb} BB</button>`).join('')}</div></div></div>
<label class="switch-row"><span><b>打开补码</b><span>输光后由主持补，每次都写进记录</span></span><input name="rebuy" type="checkbox"></label>
<details class="more-set"><summary>更多设置<span>前注 · 自动涨盲 · 行动计时，默认都关</span></summary><div class="settings-grid"><label>前注<input name="ante" class="num" type="number" min="0" step="1" value="0" aria-label="前注"></label><label>自动涨盲<select name="levelEvery" aria-label="自动涨盲">${LEVEL_OPTIONS.map(v => `<option value="${v}">${v ? `每 ${v} 手升一级` : '关闭'}</option>`).join('')}</select></label><label>行动计时<select name="actionClock" aria-label="行动计时">${[0, 20, 30, 45, 60, 90].map(v => `<option value="${v}">${v ? `${v} 秒` : '关闭'}</option>`).join('')}</select></label></div><p class="fine left">计时到了不会自动弃牌，只会提醒，并让主持可以替他过牌或弃牌。</p></details>
<p class="error" id="create-error" role="status"></p><button class="btn btn-amber go" type="submit">创建房间</button><p class="fine">仅娱乐积分 · 没有充值、提现或兑换 · 2–10 人</p></form></main>`;
}
function openRooms(rooms) {
  const open = rooms.filter(r => r.status !== 'ended').slice(0, 3);
  if (!open.length) return '';
  return `<div class="restore-list">${open.map(r => { const mine = localStorage.getItem(`night-table.host.${r.code}`); return `<div class="restore-row"><a class="pill" href="/table?room=${r.code}"><b>${esc(r.name)}</b><span class="num">${r.code}</span><span>${mine ? '回到牌桌（主持）' : '查看牌桌'}</span></a>${mine ? '' : `<button class="link-btn" data-do="reclaim" data-code="${r.code}">在这台电脑上接回主持</button>`}</div>`; }).join('')}</div>`;
}
function historyRooms(rooms) {
  const ended = rooms.filter(r => r.status === 'ended').slice(0, 4);
  if (!ended.length) return '';
  return `<section class="history" aria-label="历史牌局"><h3>历史牌局</h3>${ended.map(r => `<a class="hist-row" href="/recap?room=${r.code}"><span class="seal" aria-hidden="true">夜</span><span class="t"><b>${esc(r.name)}</b><small>${esc(day(r.endedAt))} · ${r.hands} 手 · ${r.players} 人 · ${r.mode === 'digital' ? '电子牌' : '实体牌'}</small></span><span class="num code">${r.code}</span></a>`).join('')}</section>`;
}
function joinLookup() {
  return `<main class="phone-app join-app"><header class="p-head"><span class="seal">夜</span><div class="t"><b>夜席</b><span>局域网牌桌 · 虚拟积分</span></div>${muteButton()}</header><div class="j-wrap"><div class="eyebrow">手机和开牌桌的电脑连同一个 Wi‑Fi</div><h1>加入牌桌</h1></div><form id="lookup-form" class="sheet j-form"><label>房间码<input name="code" class="num code-input" maxlength="4" pattern="[A-Za-z2-9]{4}" autocomplete="off" autocapitalize="characters" value="${esc(code)}" placeholder="四位房间码" required></label><p class="error" id="lookup-error"></p><button class="btn btn-amber btn-block" type="submit">找到牌桌</button>${(() => { const last = lastRoom(); return last && last.code !== code ? `<a class="btn btn-ghost btn-block last-room" href="/${last.page}?room=${last.code}">回到上次的房间 <span class="num">${last.code}</span></a>` : ''; })()}<p class="fine">仅娱乐积分，无充值提现或真钱兑换。</p></form></main>`;
}
function miniSeats(s, picker) {
  const count = 10, slots = SLOTS[10];
  return Array.from({ length: count }, (_, i) => {
    const seat = i + 1, p = s.players.find(q => q.seat === seat), [cx, cy] = slots[i];
    const style = `style="--cx:${cx};--cy:${cy}"`;
    if (p) return `<div class="ms is-taken" ${style}>${avatar(p)}<em>${esc(p.name)}</em></div>`;
    if (!picker) return `<div class="ms is-free" ${style}><i class="dot num">${seat}</i></div>`;
    const on = seatChoice === seat;
    return `<button type="button" class="ms is-free seat-choice ${on ? 'is-on' : ''}" ${style} data-do="seat-choice" data-seat="${seat}" aria-pressed="${on}" aria-label="座位 ${seat}${on ? '，你' : '，空'}"><i class="dot num">${on ? '你' : seat}</i><em>${on ? `${seat} 号 · 你` : `${seat} 号`}</em></button>`;
  }).join('');
}
function claimSection(s) {
  const people = Object.values(s.roster || {}).sort((a, b) => a.seat - b.seat);
  if (!people.length) return '';
  return `<details class="claim-box" ${claimPick ? 'open' : ''}><summary>之前坐过？换了手机、清了浏览器</summary><p class="fine left">选你自己的名字，主持人在牌桌上确认后，座位和筹码会接到这台手机上，原来那台随即失效。</p><div class="claim-list" role="group" aria-label="选你自己">${people.map(r => `<button type="button" class="claim-who ${claimPick === r.id ? 'is-on' : ''}" data-do="claim-pick" data-id="${esc(r.id)}" aria-pressed="${claimPick === r.id}">${avatar(r)}<span>${esc(r.name)}</span><small>${r.seated ? `${r.seat} 号位` : '已离席'}</small></button>`).join('')}</div>${btn(claimPick ? `请主持人确认我是「${esc(s.roster[claimPick]?.name)}」` : '先选你的名字', 'claim-submit', 'ghost', !claimPick || !connected)}</details>`;
}
function claimWait(s) {
  const c = data.claim;
  return `<main class="phone-app join-app"><header class="p-head"><span class="seal">夜</span><div class="t"><b>夜席</b><span>房间 <span class="num">${code}</span></span></div>${muteButton()}</header>${connectionBanner()}<div class="j-wrap claim-wait"><div class="eyebrow">等主持人确认</div><h1>接回 ${esc(c.name)} 的座位</h1><p class="lead">请主持人看一眼牌桌电脑，点「同意接回」。确认后这页会自动进入你的座位。</p><div class="claim-spinner" aria-hidden="true"><span class="seal">夜</span></div></div><div class="sheet j-form">${btn('不是我，重新选', 'claim-reset', 'ghost')}</div></main>`;
}
function endedJoin(s) {
  const next = s.nextRoom;
  return `<main class="phone-app join-app"><header class="p-head"><span class="seal">夜</span><div class="t"><b>${esc(s.config.name)}</b><span>已散场 · 共 ${s.handNumber} 手</span></div>${muteButton()}</header><div class="j-wrap"><div class="eyebrow">这一桌已经散场</div><h1>${esc(s.config.name)}</h1><p class="lead">不能再入座。可以看看今晚的总结${next ? '，或者去主持人新开的那一桌' : ''}。</p></div><div class="sheet j-form">${next ? `<a class="btn btn-amber btn-block" href="/join?room=${next}">去新桌 ${next} 入座</a>` : ''}<a class="btn btn-${next ? 'ghost' : 'amber'} btn-block" href="${link('recap')}">看散场总结</a></div></main>`;
}
function join(s) {
  if (s.status === 'ended') return endedJoin(s);
  if (data.claim?.status === 'pending') return claimWait(s);
  const back = data.role === 'departed' ? s.roster?.[data.playerId] : null;
  const free = Array.from({ length: 10 }, (_, i) => i + 1).filter(seat => !s.players.some(p => p.seat === seat));
  if (!free.includes(seatChoice)) seatChoice = free[0] || 0;
  return `<main class="phone-app join-app"><header class="p-head"><span class="seal">夜</span><div class="t"><b>夜席</b><span>房间 <span class="num">${code}</span></span></div>${muteButton()}</header>${connectionBanner()}<div class="j-wrap"><div class="eyebrow">你被邀请入座</div><h1>${esc(s.config.name)}</h1><div class="meta"><span class="pill">${digitalOf(s) ? '电子牌' : '实体牌'}</span><span class="pill">盲注 <b class="num">${n(s.config.smallBlind)} / ${n(s.config.bigBlind)}</b></span><span class="pill">起始 <b class="num">${n(s.config.startingStack)}</b></span></div>
<div class="mini" role="group" aria-label="选择空座"><div class="mini-table"><span>夜席</span></div>${miniSeats(s, true)}</div></div>
<form id="join-form" class="sheet j-form">${data.claim?.status === 'denied' ? '<p class="error">主持人没有同意认领。如果确实是你，当面跟主持人说一声再试。</p>' : ''}${back ? `<p class="fine left">欢迎回来，${esc(back.name)}。之前离席时带走了 ${n(back.cashOut)}，再入座会重新带入 ${n(s.config.startingStack)}，统计接着算。</p>` : ''}<label for="join-name">你的名字</label><input id="join-name" name="name" maxlength="8" required autocomplete="nickname" aria-label="你的名字" aria-describedby="name-hint" value="${esc(back?.name || params.get('name') || '')}"><p class="fine left" id="name-hint">1–8 个字，这个房间里不能重名。同一浏览器刷新会接回座位；换手机需由主持确认认领。起始筹码 ${n(s.config.startingStack)} 由房间决定。</p><p class="error" id="join-error" role="status"></p><button class="btn btn-amber btn-block" type="submit" ${!seatChoice || !connected ? 'disabled' : ''}>${seatChoice ? `坐到 ${seatChoice} 号位` : '座位已满'}</button><p class="fine">若本手已开始，你会从下一手才进入行动</p>${back ? '' : claimSection(s)}</form></main>`;
}
function share(s) {
  return `${topbar(s)}<main class="sharepage"><section class="share-l"><div class="eyebrow"><i></i>把房间给同桌的人</div><h1>${esc(s.config.name)}</h1><p class="lead">手机和这台电脑连同一个 Wi‑Fi，扫右边的码，或打开下面的地址。</p>
<ul class="rules">${[['打牌方式', digitalOf(s) ? '电子牌' : '实体牌'], ['盲注', `${n(s.config.smallBlind)} / ${n(s.config.bigBlind)}`], ['起始筹码', n(s.config.startingStack)], ['补码', s.config.rebuy ? '打开' : '关闭'], ['人数', `${s.players.length} / 10`]].map(([k, v]) => `<li><span>${k}</span><b class="num">${v}</b></li>`).join('')}</ul>
<div class="seated">${s.players.length ? s.players.map(p => `<span class="who">${avatar(p)}<em>${esc(p.name)}</em></span>`).join('') : '<p class="muted">还没有人坐下。</p>'}</div><p class="muted">至少两位有筹码的玩家坐下后，才能开新的一手。</p>
<div class="share-actions">${nav(data.role === 'host' ? '进入牌桌（主持）' : '返回牌桌', 'table', 'amber')}${data.role === 'host' ? btn('把主持交到另一台设备', 'transfer') : nav('我要加入', 'join')}</div></section>
<section class="qrbox">${data.joinUrl ? `<div class="qr-paper"><img src="/api/rooms/${code}/qr.svg" alt="${esc(data.joinUrl)}"></div><p class="cap">扫码入座</p>` : '<p class="muted">还没有局域网地址。确认电脑已连上 Wi‑Fi，然后刷新。</p>'}<p class="code-xl num">${code}</p>${data.joinUrl ? `<p class="addr mono"><a href="${esc(data.joinUrl)}">${esc(data.joinUrl)}</a></p>` : ''}</section><p class="legal-note">仅娱乐积分，无充值、提现或真钱兑换。</p></main>`;
}
function seatStatus(s, p) {
  if (p.waiting) return p.sittingOut ? '暂离' : '下一手';
  if (!p.inHand || s.hand?.phase === 'settled') return p.sittingOut ? '暂离' : p.stack === 0 ? '旁观' : data.online.includes(p.id) ? '等待' : '离线';
  if (p.folded) return '弃牌';
  if (!p.stack) return '全下';
  if (!data.online.includes(p.id)) return '离线';
  return s.hand.actor === p.id ? '行动中' : '等待';
}
function turnInfo(s) {
  if (s.paused) return ['休息一下', '手机上暂时不能行动，计时也停了'];
  if (!s.hand) return [s.players.length < 2 ? '等朋友入座' : '人齐了，准备开手', s.players.length < 2 ? '把房间码给同桌的人' : '主持人点「新的一手」，系统自动收盲'];
  if (s.hand.phase === 'settled') return ['这一手结束', '池中归零，等主持人开新的一手'];
  if (s.hand.phase === 'showdown') return digitalOf(s) && s.hand.autoJudged ? ['系统已按牌力判定', '请主持人核对并确认分池'] : ['请看实体牌，准备分池', '主持人指定每个池的赢家'];
  if (s.hand.phase === 'roundEnd') return digitalOf(s) ? ['这一轮结束', '等主持人点「下一轮」发出公共牌'] : ['这一轮结束 · 请看牌', '等主持人点「下一轮」'];
  const p = player(s, s.hand.actor), l = legalActions(s, p?.id);
  if (!p || !l) return ['等待行动', ''];
  if (!data.online.includes(p.id)) return [`${p.name}不在线`, '筹码还在，这一手停在他这里。连上之后可以继续。'];
  return [`轮到 ${p.name}`, capability(l, p)];
}
function capability(l, p) {
  if (l.call >= p.stack) return `${l.call === p.stack ? '跟注需要全部剩余' : '不足以跟注'}，全下 ${n(p.stack)}`;
  if (!l.call) return l.raise ? '可以过牌，或下注' : '不够一个最小下注，可以过牌或全下';
  return `跟注 ${n(l.call)}${l.raise ? ' · 可以加注或全下' : l.allIn ? ' · 筹码不够一次最小加注' : ' · 可以跟注或弃牌'}`;
}
// 摊牌与分池时，赢家、牌型和「+N」由公开信息（亮出的牌、分池预览）得出。
function showdownFx(s) {
  const h = s.hand;
  if (!h || h.phase !== 'showdown') return {};
  const preview = h.preview || localPreview(s);
  const awards = preview?.awards || {};
  const winners = new Set(Object.entries(awards).filter(([, v]) => v > 0).map(([id]) => id));
  const marks = {};
  const mainWinner = (h.selections?.[data.pots[0]?.id] || [])[0];
  if (digitalOf(s) && mainWinner && h.revealed?.[mainWinner] && h.board?.length === 5) {
    const best = new Set(evaluate([...h.revealed[mainWinner], ...h.board]).cards);
    for (const c of h.board) marks[c] = best.has(c) ? 'is-best' : 'is-dim';
  }
  return { awards, winners, marks };
}
function seatCard(s, p, i, count, fx = {}) {
  const [cx, cy] = (SLOTS[count] || SLOTS[10])[i] || [0, 0];
  const status = seatStatus(s, p), h = s.hand, digital = digitalOf(s);
  const revealed = h?.revealed?.[p.id];
  const holes = digital && h?.holeDealt && p.inHand && !p.folded ? `<div class="seat-holes">${revealed ? revealed.map(c => playingCard(c, { size: 'is-show', flipped: true })).join('') : `${playingCard(null, { size: 'is-seat' })}${playingCard(null, { size: 'is-seat' })}`}</div>` : '';
  const handLabel = revealed && h?.board?.length ? handDetail([...revealed, ...h.board]) : h?.handNames?.[p.id] || '';
  const acting = h?.actor === p.id && h?.phase === 'betting';
  const deadline = acting ? deadlineOf(s) : 0;
  const strip = handLabel ? `<span class="hand-name">${esc(handLabel)}</span>` : deadline ? `思考中 · <span class="num" data-countdown="${deadline}">${secondsLeft(deadline)}</span> 秒` : `${status}${p.bet && h?.phase !== 'settled' ? ` · 本轮 <span class="num">${n(p.bet)}</span>` : ''}`;
  const award = fx.awards?.[p.id];
  const cls = [acting && 'is-acting', status === '弃牌' && 'is-fold', status === '全下' && 'is-allin', status === '暂离' && 'is-away', !data.online.includes(p.id) && 'is-off', revealed && 'is-show', fx.winners?.has(p.id) && 'is-win', handLabel && 'has-hand'].filter(Boolean).join(' ');
  return `<article class="seat ${cls}" style="--cx:${cx};--cy:${cy}" data-seat-id="${p.id}" title="${p.seat} 号位">${holes}${acting ? `<i class="ring ${deadline ? 'has-clock' : ''}" aria-hidden="true" ${deadline ? `data-deadline="${deadline}" data-total="${s.config.actionClock * 1000}"` : ''}></i>` : ''}${avatar(p)}<span class="marks">${h?.dealer === p.id ? '<span class="mark mark-d" title="庄家">庄</span>' : ''}${h?.small === p.id ? '<span class="mark mark-sb" title="小盲">小</span>' : ''}${h?.big === p.id ? '<span class="mark mark-bb" title="大盲">大</span>' : ''}</span><div class="plate"><span class="name">${esc(p.name)}</span><span class="stk num">${status === '全下' && p.stack === 0 ? '<span class="allin">全下</span>' : n(p.stack)}</span><span class="strip">${strip}</span></div>${award ? `<span class="delta num">+${n(award)}</span>` : ''}</article>`;
}
// 行动计时：服务端记录 actorSince；客户端按服务器时间差显示，只是提示，从不自动行动。
function deadlineOf(s) {
  const h = s.hand;
  if (!s.config.actionClock || s.paused || !h?.actor || h.phase !== 'betting' || !h.actorSince) return 0;
  return Date.parse(h.actorSince) + s.config.actionClock * 1000;
}
const serverNow = () => Date.now() + skew;
const secondsLeft = deadline => Math.max(0, Math.ceil((deadline - serverNow()) / 1000));
function timeoutReady(s) {
  const h = s.hand;
  if (!h?.actor || h.phase !== 'betting' || s.paused) return false;
  const deadline = deadlineOf(s);
  return !data.online.includes(h.actor) || (deadline && serverNow() >= deadline);
}
function betChip(s, p, i, count) {
  if (!p.bet || !s.hand || ['settled', 'showdown'].includes(s.hand.phase)) return '';
  const [cx, cy] = (SLOTS[count] || SLOTS[10])[i] || [0, 0];
  const row = Math.abs(cy) > 0.9, bx = cx * (row ? 0.82 : 0.66), by = cy * (row ? 0.64 : 0.6);
  return `<div class="bet ${cx > 0.05 ? 'is-rev' : ''}" style="--cx:${bx};--cy:${by}" aria-hidden="true">${chipStackHtml(p.bet, false, { width: 28 })}<span class="v num">${n(p.bet)}</span></div>`;
}
function transcript(s, hand = s.handNumber) {
  const entries = s.logs.filter(e => hand === 'all' || e.hand === Number(hand));
  return `<ol class="transcript">${entries.length ? entries.map((e, i) => `<li class="${i === entries.length - 1 ? 'is-last' : ''}"><time datetime="${e.at}" class="num">${new Date(e.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time><div class="what">${esc(e.text)}</div></li>`).join('') : '<li>这一手还没有操作。</li>'}</ol>`;
}
function ticker(s) {
  const entries = s.logs.filter(e => e.hand === s.handNumber).slice(-3);
  return `<a class="ticker" href="${link('log')}" aria-label="这一手的记录">${entries.map(e => `<span class="row"><time class="num">${new Date(e.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time><span>${esc(e.text)}</span></span>`).join('')}</a>`;
}
function undoButton() { return data.role === 'host' ? btn(`撤销上一步${data.lastUndo ? `<small>${esc(data.lastUndo)}</small>` : ''}`, 'undo', 'clay', !data.lastUndo || !connected) : ''; }
function hostbar(s) {
  if (data.role !== 'host') return `<footer class="spectatorbar glass"><span class="muted">${data.role === 'player' ? '行动在各自手机上' : '看客 · 只读总览'}</span>${nav(data.role === 'player' ? '回到我的行动' : '我要加入', data.role === 'player' ? 'play' : 'join', 'amber')}</footer>`;
  const active = ongoing(s), enough = s.players.filter(p => p.stack > 0 && !p.leaving).length >= 2;
  const canStart = !active && enough && connected && !potLock, canNext = s.hand?.phase === 'roundEnd' && connected, canSplit = s.hand?.phase === 'showdown' && connected;
  const startHint = active ? '本手进行中' : potLock ? '分池入账中' : enough ? '自动轮转庄与盲位' : '还差一位有筹码的玩家';
  const nextHint = s.hand?.phase === 'betting' ? '还有人要行动' : s.hand?.phase === 'roundEnd' ? (digitalOf(s) ? '发出公共牌' : '看过实体牌再继续') : '没有下一轮';
  const splitHint = s.hand?.phase === 'showdown' ? (digitalOf(s) && s.hand.autoJudged ? '核对系统判定' : '指定每个池的赢家') : '还没到摊牌';
  const flow = (label, action, ok, hint, icon) => `<button class="btn has-icon ${ok ? 'btn-amber' : 'btn-ghost'}" data-do="${action}" title="${hint}" ${!ok || busy ? 'disabled' : ''}>${icon}<span>${label}</span><span class="sr-only">${hint}</span></button>`;
  const undoLabel = data.lastUndo ? `撤销上一步：${data.lastUndo}` : '没有可撤销的操作';
  const quiet = (label, action, ok, hint, icon, extraCls = '') => `<button class="btn btn-quiet has-icon ${extraCls}" data-do="${action}" title="${esc(hint)}" ${!ok || busy ? 'disabled' : ''}>${icon}<span>${label}</span></button>`;
  return `<footer class="hostbar">${ticker(s)}<nav class="dock glass" aria-label="主持操作">${flow('新的一手', 'start', canStart && !s.paused, s.paused ? '休息中' : startHint, ICON.play)}${flow('下一轮', 'next', canNext && !s.paused, s.paused ? '休息中' : nextHint, ICON.next)}${flow('分池', 'settlement', canSplit, splitHint, ICON.split)}<i class="sep"></i>${quiet('撤销上一步', 'undo', !!data.lastUndo && connected, undoLabel, ICON.undo)}${quiet('座位', 'manage', !active, active ? '本手不可调' : '座位、盲注与补码', ICON.seats)}${quiet(s.paused ? '继续' : '休息', s.paused ? 'resume' : 'pause', connected, s.paused ? '结束休息，继续打牌' : '暂停：手机上暂时不能行动', s.paused ? ICON.play : ICON.pause, s.paused ? 'is-lit' : '')}${quiet('散场', 'end', !active && connected && !potLock, active ? '这一手结束后才能散场' : '结束今晚，每人手机上出现总结', ICON.flag)}</nav><div class="ledger">主持 · 这台电脑<br><b>${s.paused ? '休息中，计时已停' : '行动在各自手机上'}</b></div></footer>`;
}
function streetSteps(s) {
  const h = s.hand, steps = [...STREETS, '摊牌'];
  const at = !h ? -1 : h.phase === 'showdown' || (h.phase === 'settled' && digitalOf(s)) ? 4 : h.street;
  return `<div class="street" aria-hidden="true">${steps.map((name, i) => (i === 4 && at !== 4) ? '' : `${i ? '<i></i>' : ''}<span class="${i === at ? 'on' : i < at ? 'done' : ''}">${name}</span>`).join('')}</div>`;
}
function potArea(s, fx) {
  const bets = s.players.reduce((sum, p) => sum + (p.bet || 0), 0);
  const actor = player(s, s.hand?.actor), legal = legalActions(s, actor?.id);
  if (data.pots.length > 1 && s.hand?.phase === 'betting') {
    const joins = data.pots.filter(p => actor && legal && !p.eligible.includes(actor.id) && actor.contribution + Math.min(legal.call, actor.stack) >= p.cap).length;
    return `<div class="pot" id="table-pot">${chipStackHtml(potTotal(s), false, { width: 26 })}<span class="lbl">底池</span><span class="amt num">${n(potTotal(s))}</span>${bets ? `<span class="sub">本轮 <span class="num">${n(bets)}</span></span>` : ''}</div><p class="note pot-split">${data.pots.map(p => `${p.name} <b class="num">${n(p.amount)}</b>`).join(' · ')} · 形成中${joins ? ` · ${esc(actor.name)}跟注后加入边池` : ''}</p>`;
  }
  if (data.pots.length <= 1) return `<div class="pot" id="table-pot">${chipStackHtml(potTotal(s), false, { width: 26 })}<span class="lbl">底池</span><span class="amt num">${n(potTotal(s))}</span>${bets && s.hand?.phase === 'betting' ? `<span class="sub">本轮 <span class="num">${n(bets)}</span></span>` : ''}</div>`;
  return `<div class="pots" id="table-pot">${data.pots.map((p, i) => { const win = s.hand?.phase === 'showdown' ? (selections[p.id] || s.hand.selections?.[p.id] || []) : []; return `<div class="potcard ${i === 0 ? 'is-main' : ''} ${p.forming ? 'is-forming' : ''}" id="pot-${p.id}">${chipStackHtml(p.amount, false, { width: 24 })}<div><div class="k">${p.name}${p.forming ? ' · 形成中' : ''}</div><div class="a num">${n(p.amount)}</div></div><span class="to">${win.length ? `→ ${win.map(id => esc(player(s, id)?.name)).join('、')}` : esc(p.eligible.map(id => player(s, id)?.name).join(' · ') || '待本轮结束核对')}</span>${actor && legal && !p.eligible.includes(actor.id) && actor.contribution + Math.min(legal.call, actor.stack) >= p.cap ? `<small>${esc(actor.name)}跟注后加入</small>` : ''}</div>`; }).join('')}</div>`;
}
function arena(s, fx = {}) {
  const seated = ordered(s).filter(p => !p.waiting), waiting = s.players.filter(p => p.waiting), [title, subtitle] = turnInfo(s);
  const digital = digitalOf(s), board = digital && s.hand ? boardSlots(s.hand.board || [], { marks: fx.marks || {} }) : '';
  return `<section class="arena ${seated.length > 7 ? 'crowded' : ''} ${digital ? 'is-digital' : 'is-physical'}"><div class="rail" aria-hidden="true"></div><div class="felt" aria-hidden="true"><i class="line"></i><span class="brand">夜 席</span></div>
<div class="center">${streetSteps(s)}${s.paused ? pauseCard(s) : `<div class="callout">${fx.quietTitle ? `<p class="turn">${esc(title)}</p>` : `<h1 class="turn" aria-live="polite">${esc(title)}</h1>`}<p class="turn-sub">${esc(subtitle)}</p>${data.role === 'host' && timeoutReady(s) ? timeoutButton(s) : ''}</div>`}${board}${s.hand ? potArea(s, fx) : `<div class="pot" id="table-pot"><span class="lbl">全场</span><span class="amt num">${n(s.total)}</span></div>`}${s.hand?.shortAllIn ? '<p class="note">短码全下，仍需补跟或弃牌；不足完整幅度不重开加注权。</p>' : ''}${s.hand?.participants.length === 2 ? '<p class="note">两人局 · 庄家下小盲，翻前先行动</p>' : ''}${!seated.length ? nav('房间码与二维码', 'share', 'amber') : ''}</div>
${seated.map((p, i) => seatCard(s, p, i, seated.length, fx)).join('')}${seated.map((p, i) => betChip(s, p, i, seated.length)).join('')}${waiting.length ? `<div class="waiting-strip">${waiting.map(p => `<span class="pill">${esc(p.name)} · 下一手</span>`).join('')}</div>` : ''}</section>`;
}
function pauseCard(s) {
  return `<div class="pause-card glass" role="status"><span class="eyebrow">${ICON.pause}休息一下</span><b class="num" data-since="${esc(s.paused.at)}">0:00</b><p>手机上暂时不能行动，行动计时也停了。</p>${data.role === 'host' ? btn('继续打牌', 'resume', 'amber', !connected) : ''}</div>`;
}
function timeoutButton(s) {
  const p = player(s, s.hand.actor), l = legalActions(s, p.id), offline = !data.online.includes(p.id);
  return `<button class="btn btn-ghost has-icon timeout-btn" data-do="timeout" ${busy || !connected ? 'disabled' : ''}>${ICON.clock}<span>替${esc(p.name)}${l?.check ? '过牌' : '弃牌'}</span><small>${offline ? '他掉线了' : '已超时'}</small></button>`;
}
// 主持需要处理的请求：换手机认领座位、申请补码。
function hostAlerts(s) {
  if (data.role !== 'host' || s.status === 'ended') return '';
  const claims = (data.claims || []).map(c => { const r = s.roster?.[c.playerId] || {}; return `<div class="alert glass" role="alert">${avatar({ seat: r.seat, name: c.name })}<div class="t"><b>${esc(c.name)} 想在新手机上接回座位</b><span>${hhmm(new Date(c.at).toISOString())} · 只有你能确认。同意后旧手机立即失效。</span></div>${btn('不是本人', 'claim-deny', 'ghost', false, `data-id="${c.id}"`)}${btn('同意接回', 'claim-ok', 'amber', false, `data-id="${c.id}"`)}</div>`; });
  const asks = (data.asks || []).map(a => { const p = player(s, a.playerId); if (!p) return ''; return `<div class="alert glass" role="alert">${avatar(p)}<div class="t"><b>${esc(a.name)} 申请补码</b><span>现有 ${n(p.stack)} · ${ongoing(s) ? '这一手结束后才能补' : '补码会写进记录'}</span></div><label class="ask-amt"><span class="sr-only">补码数额</span><input id="ask-${a.id}" class="num" type="number" min="1" step="1" value="${s.config.startingStack}" aria-label="给${esc(a.name)}补码"></label>${btn('忽略', 'ask-deny', 'ghost', false, `data-id="${a.id}"`)}${btn('补码', 'ask-ok', 'amber', ongoing(s), `data-id="${a.id}"`)}</div>`; });
  const all = [...claims, ...asks].filter(Boolean);
  return all.length ? `<div class="alerts" aria-label="待处理的请求">${all.join('')}</div>` : '';
}
function table(s) {
  if (s.status === 'ended') return recap(s);
  return `${topbar(s)}<main class="tablepage">${arena(s, showdownFx(s))}${hostAlerts(s)}</main>${hostbar(s)}`;
}
function phoneHead(s) {
  return `<header class="p-head"><a class="seal" href="${link('share')}" aria-label="房间 ${code}">夜</a><div class="t"><b>${esc(s.config.name)}</b><span>${s.status === 'ended' ? `已散场 · 共 ${s.handNumber} 手` : `第 ${s.handNumber} 手 · ${s.paused ? '休息中' : street(s)} · 盲注 <span class="num">${n(data.blinds?.small ?? s.config.smallBlind)}/${n(data.blinds?.big ?? s.config.bigBlind)}</span>`}</span></div>${muteButton()}</header>`;
}
function raisePresets(s, l, p) {
  const potAfterCall = potTotal(s) + l.call, base = s.hand.currentBet;
  const list = [['最小', l.minRaiseTo], ['½ 池', Math.round(base + potAfterCall / 2)], ['满池', base + potAfterCall], ['全下', l.maxRaiseTo]];
  const seen = new Set();
  return list.map(([label, v]) => [label, Math.max(l.minRaiseTo, Math.min(l.maxRaiseTo, v))]).filter(([label, v]) => label === '全下' || label === '最小' || (!seen.has(v) && v > l.minRaiseTo && v < l.maxRaiseTo)).filter(([, v]) => { if (seen.has(v)) return false; seen.add(v); return true; });
}
function actionSheet(s, p, l) {
  const label = s.hand.currentBet ? '加注' : '下注';
  if (raiseOpen && l.raise) {
    const v = Math.max(l.minRaiseTo, Math.min(l.maxRaiseTo, raiseValue || l.minRaiseTo)), pct = l.maxRaiseTo > l.minRaiseTo ? ((v - l.minRaiseTo) / (l.maxRaiseTo - l.minRaiseTo)) * 100 : 100;
    return `<section class="sheet is-raise" aria-labelledby="sheet-title"><div class="turn-row"><h1 id="sheet-title" class="turn-label">${label}到</h1><span class="ctx">跟注 <b class="num">${n(l.call)}</b> · 最少 <b class="num">${n(l.minRaiseTo)}</b></span></div>
<div class="amt"><label class="amt-field"><span class="lbl sr-only">${label}到</span><input id="raise-amount" class="num" type="number" inputmode="numeric" step="1" min="${l.minRaiseTo}" max="${l.maxRaiseTo}" value="${v}" aria-label="${label}到"></label><div class="step"><button type="button" class="iconbtn" data-do="step" data-step="-1" aria-label="减少">${ICON.minus}</button><button type="button" class="iconbtn" data-do="step" data-step="1" aria-label="增加">${ICON.plus}</button></div></div>
<p id="raise-error" class="error" role="status"></p><input type="range" id="raise-range" min="${l.minRaiseTo}" max="${l.maxRaiseTo}" value="${v}" step="1" aria-label="${label}滑杆" style="--pct:${pct}%">
<div class="presets">${raisePresets(s, l, p).map(([name, value]) => `<button type="button" data-do="preset" data-value="${value}" class="${value === v ? 'is-on' : ''}">${name}<b class="num">${n(value)}</b></button>`).join('')}</div>
<div class="pair"><span>再投入 <b id="raise-add" class="num">${n(v - p.bet)}</b></span><span id="raise-allin-note"></span></div>
<div class="acts acts-raise">${btn('取消', 'raise-cancel', 'ghost')}${btn(v === l.maxRaiseTo ? '确认全下' : `确认${label}到 ${n(v)}`, 'raise-submit', 'amber', !connected, 'id="raise-submit"')}</div><p class="rule">打开面板不会送出 · 最小${label}到 = 本轮最高 + 上次完整加注幅度</p></section>`;
  }
  const call = l.check ? btn('过牌', 'check', 'paper', !connected) : l.canCall ? btn(`跟注 ${n(l.call)}`, 'call', 'paper', !connected) : '';
  return `<section class="sheet" aria-labelledby="sheet-title"><div class="turn-row"><h1 id="sheet-title" class="turn-label" aria-live="assertive">轮到你</h1><span class="ctx">${esc(capability(l, p))}</span></div>${timerBar(s)}
<div class="acts ${call ? '' : 'two'} ${l.raise ? '' : 'no-raise'}">${btn('弃牌', 'fold', 'clay', !connected)}${call}${l.raise ? btn(label, 'raise', 'amber', !connected) : ''}</div>${l.allIn ? `<div class="acts-all">${btn(`全下 ${n(p.stack)}`, 'allin', 'brass', !connected)}</div>` : ''}<p class="fine">弃牌和全下会再确认一次</p>${phoneNav(s, p)}</section>`;
}
function timerBar(s) {
  const deadline = deadlineOf(s);
  return deadline ? `<i class="timer has-clock" aria-hidden="true" data-deadline="${deadline}" data-total="${s.config.actionClock * 1000}"></i><span class="sr-only">还有 ${secondsLeft(deadline)} 秒</span>` : '<i class="timer" aria-hidden="true"></i>';
}
function phoneNav(s, p) {
  return `<nav class="phone-nav"><a href="${link('log')}">记录</a><a href="${link('hands')}">牌谱</a><a href="${link('table')}">看牌桌</a><button class="link-btn" data-do="sit-toggle" ${busy ? 'disabled' : ''}>${p.sittingOut ? '我回来了' : '暂离'}</button><button class="link-btn more-btn" data-do="phone-more" aria-label="更多：补码、屏幕常亮、离开">更多</button></nav>`;
}
function phoneMore(s, p) {
  const leaveLabel = p.leaving ? '已记下离开' : ongoing(s) ? '这一手结束后离开' : '离开';
  const rows = [
    s.config.rebuy ? `<button class="menu-row" data-do="ask" ${data.asked ? 'disabled' : ''}><b>${data.asked ? '已申请补码' : '申请补码'}</b><span>${data.asked ? '等主持人确认' : '主持人确认后加筹码，会写进记录'}</span></button>` : '',
    `<button class="menu-row" data-do="sit-toggle"><b>${p.sittingOut ? '我回来了' : '暂离一会儿'}</b><span>${p.sittingOut ? '下一手起重新发你牌' : '下一手起不发牌、不收盲；本手仍要打完'}</span></button>`,
    `<label class="menu-row switch-row"><span><b>屏幕常亮</b><span>尝试保持亮屏，取决于浏览器；不保证防止锁屏</span></span><input id="awake-setting" type="checkbox" ${awakePreferred() ? 'checked' : ''}></label>`,
    `<button class="menu-row is-danger" data-do="leave" ${p.leaving ? 'disabled' : ''}><b>${leaveLabel}</b><span>带走现有筹码，并拿到你自己的今晚总结</span></button>`
  ].join('');
  showModal(`<h3 id="dialog-title">${esc(p.name)}</h3><div class="menu">${rows}</div><p class="fine">想加到主屏幕：浏览器菜单里选「添加到主屏幕」，下次点开直接回到座位。</p>${btn('返回', 'cancel')}`, false, true);
}
function play(s) {
  if (s.status === 'ended' || data.role === 'departed') return phoneSummary(s);
  const p = player(s, data.playerId);
  if (!p) return join(s);
  const l = data.legal, [title, subtitle] = turnInfo(s);
  let wait = title, sub = `还没到你。这一轮你已经下注 ${n(p.bet)}。`;
  if (s.paused) { wait = '休息一下'; sub = '主持人点「继续」之后接着打。计时也停了。'; }
  else if (p.sittingOut && (!s.hand || !p.inHand || p.folded || s.hand.phase === 'settled')) { wait = '你暂离了'; sub = '下一手起不发你牌、不收你的盲。回来了就点「我回来了」。'; }
  else if (!s.hand) { wait = '等主持人开新的一手'; sub = '牌在桌上，筹码已就位。'; }
  else if (s.hand.phase === 'settled') { wait = '这一手结束'; sub = p.stack ? '等主持人开新的一手。' : '筹码是 0，下一手不收你的盲。'; }
  else if (p.waiting) { wait = '下一手你就坐下'; sub = '这一手先看大家打。你的筹码不参与当前底池。'; }
  else if (p.folded) { wait = '你已弃牌'; sub = '等这一手结束。'; }
  else if (s.hand.phase === 'showdown') { wait = digitalOf(s) && s.hand.autoJudged ? '系统已按牌力判定' : '主持人正在分池'; sub = `请看电脑。${s.hand.preview ? `预览里你是 +${n(s.hand.preview.awards[p.id])}。` : ''}${s.hand.handNames?.[p.id] ? ` 你是${s.hand.handNames[p.id]}。` : ''}`; }
  else if (p.stack === 0) { wait = '你已全下'; sub = '等这一手结束。'; }
  else if (s.hand.phase === 'roundEnd') sub = digitalOf(s) ? '等主持人点「下一轮」发出公共牌。' : '请看实体牌，等主持人点「下一轮」。';
  else if (!data.online.includes(s.hand.actor)) sub = subtitle;
  const digital = digitalOf(s), board = s.hand?.board || [];
  const made = digital && data.hole ? handDetail([...data.hole, ...board]) : '';
  const opps = ordered(s).filter(q => q.id !== p.id);
  const oppHtml = `<section class="opps seatstrip" aria-label="同桌状态">${opps.map(q => { const st = seatStatus(s, q); return `<div class="opp pill-like ${s.hand?.actor === q.id ? 'is-act' : ''} ${q.folded ? 'is-fold' : ''}">${avatar(q)}${s.hand?.dealer === q.id ? '<i class="d">庄</i>' : ''}<span class="n">${esc(q.name)}</span><em class="b num ${q.bet ? '' : 'muted'}">${q.bet && s.hand?.phase === 'betting' ? `${n(q.bet)}` : st === '等待' ? n(q.stack) : st}</em></div>`; }).join('')}</section>`;
  const boardHtml = `<section class="p-board felt-surface ${digital ? '' : 'is-physical'}"><div class="top"><span class="potv">${chipStackHtml(potTotal(s), true, { width: 20 })}底池 <b class="num">${n(potTotal(s))}</b></span><span>${s.hand?.currentBet && s.hand.phase === 'betting' ? `本轮最高 <b class="num small">${n(s.hand.currentBet)}</b> · ` : ''}${street(s)}</span></div>${digital ? `<div class="row">${boardSlots(board, { size: 'is-mini' })}</div>` : `<p class="phys-note">${s.hand ? '实体牌：请看桌上的牌' : '等主持人开新的一手'}</p>`}</section>`;
  const hero = `<section class="hero ${digital && data.hole ? 'has-cards' : ''}">${digital && data.hole ? `<div class="hero-cards" data-testid="hole-cards">${data.hole.map(c => playingCard(c, { size: 'is-hero', flipped: true })).join('')}</div>` : ''}<div class="made">${made ? `<span class="tag" data-testid="my-hand">${esc(made)}</span>` : ''}<div class="me"><h2 class="me-name">${esc(p.name)}</h2><span class="me-stack">筹码 <b class="num" data-testid="my-stack">${n(p.stack)}</b></span></div></div><p class="me-sub">本手已投入 <span class="num">${n(p.contribution)}</span> · 本轮 <span class="num">${n(p.bet)}</span> · 全场 <span class="num">${n(s.total)}</span></p></section>`;
  const canShow = digital && s.hand && ['showdown', 'settled'].includes(s.hand.phase) && s.hand.participants?.includes(p.id) && data.hole && !s.hand.revealed?.[p.id];
  const mucked = canShow && s.hand.mucked?.includes(p.id);
  const extraBtns = [
    p.sittingOut && !l ? btn('我回来了', 'sit-toggle', 'amber', !connected) : '',
    canShow ? btn(mucked ? '亮牌（默认盖着）' : '亮牌给大家看', 'show', 'paper', !connected) : '',
    !l && s.config.rebuy && p.stack === 0 && !p.inHand ? (data.asked ? '<p class="fine left">已申请补码，等主持人确认。</p>' : btn('申请补码', 'ask', 'amber', !connected)) : ''
  ].filter(Boolean).join('');
  const sheet = l ? actionSheet(s, p, l) : `<section class="sheet is-wait"><div class="waitblock" aria-live="polite"><strong>${esc(wait)}</strong><p>${esc(sub)}</p>${mucked ? '<p class="mucked">你的牌没有亮出，别人看不到。</p>' : ''}</div>${extraBtns ? `<div class="wait-acts">${extraBtns}</div>` : ''}${phoneNav(s, p)}</section>`;
  return `<main class="phone-app ${raiseOpen && data.legal?.raise ? 'is-raising' : ''} ${s.paused ? 'is-paused' : ''}">${phoneHead(s)}${connectionBanner()}${oppHtml}${boardHtml}${hero}${sheet}</main>`;
}
function localPreview(s) { try { return previewSettlement(s, selections); } catch { return null; } }
function remainderText(s, preview) {
  if (!preview) return '每个池都要指定赢家。';
  return preview.details.map(d => `${d.name} ${n(d.amount)} 由 ${d.winners.length} 人平分，每人 ${n(d.each)}，余 ${d.remainder}。${d.remainder ? `庄是${player(s, s.hand.dealer)?.name || `${s.hand.dealerSeat}号位`}，从他左侧数起，余数按顺序给：${d.oddRecipients.map(id => player(s, id).name).join(' → ')}。` : '这个池可以整除，没有余数。'}`).join(' ');
}
function digitalSettle(s) {
  const preview = s.hand.preview || localPreview(s);
  const rows = data.pots.map(pot => `<span>${pot.name} <b class="num">${n(pot.amount)}</b> → <em>${(s.hand.selections?.[pot.id] || []).map(id => esc(player(s, id)?.name)).join('、')}</em></span>`).join('');
  const odd = preview?.details?.some(d => d.remainder);
  return `${topbar(s)}<main class="tablepage is-settle">${arena(s, { ...showdownFx(s), quietTitle: true })}</main><footer class="hostbar"><nav class="settlebar glass" aria-label="确认分池"><div class="ttl"><h2>系统已按牌力判定</h2><span>主持核对后确认，不能改判</span></div><div class="rows">${rows}</div><div class="bal" title="${esc(remainderText(s, preview))}"><span class="ok-dot"></span>${preview ? `分池后全场 <b class="num">${n(preview.afterTotal)}</b> · ${odd ? '含余数' : '无余数'}` : ''}<span class="sr-only remainder">${esc(remainderText(s, preview))}</span></div>${nav('返回牌桌', 'table', 'quiet')}${btn('确认这样分池', 'settle-confirm', 'amber', !preview || !preview.balanced || !connected)}</nav></footer>`;
}
function settle(s) {
  if (data.role !== 'host' || s.hand?.phase !== 'showdown') return table(s);
  if (digitalOf(s) && s.hand.autoJudged) return digitalSettle(s);
  const pot = data.pots[selectedPot] || data.pots[0], preview = localPreview(s);
  if (!pot) return table(s);
  const chosen = selections[pot.id] || [];
  const fx = { awards: preview?.awards || {}, winners: new Set(Object.values(selections).flat()), marks: {} };
  const panel = `<aside class="settle-panel glass" aria-label="分池"><h2>指定每个池的赢家</h2><p class="hint">先选池，再选赢家。点一人独得，点多人即平分。</p>
<div class="potpick">${data.pots.map((p, i) => `<button class="${i === selectedPot ? 'is-on' : ''}" data-do="pot" data-index="${i}" aria-pressed="${i === selectedPot}"><span class="t"><b>${p.name}</b><span class="num">${n(p.amount)}</span></span><span class="w">${selections[p.id]?.length ? `已指定 ${selections[p.id].map(id => esc(player(s, id)?.name)).join('、')}` : '还没指定赢家'}</span></button>`).join('')}</div>
<h3>${pot.name} <span class="num">${n(pot.amount)}</span> 的赢家</h3><div class="winners">${pot.eligible.map(id => { const p = player(s, id), on = chosen.includes(id); return `<button class="winner ${on ? 'is-on' : ''}" data-do="winner" data-id="${id}" aria-pressed="${on}" ${busy ? 'disabled' : ''}>${avatar(p)}<span class="name">${esc(p.name)}</span><span class="tick">${on ? chosen.length > 1 ? '平分' : '独得' : '有资格'}</span></button>`; }).join('')}</div>
<div class="locked">${s.players.filter(p => !pot.eligible.includes(p.id)).map(p => `<div><b>${esc(p.name)}</b>${p.folded ? '已弃牌，不能赢这个池' : '未投入这个池'}</div>`).join('')}</div>
<div class="preview" aria-live="polite"><p class="remainder">${esc(remainderText(s, preview))}</p>${s.players.filter(p => preview?.awards[p.id]).map(p => `<div class="line"><span>${esc(p.name)}</span><span class="num">+${n(preview.awards[p.id])}</span></div>`).join('')}<div class="balance-foot">${preview ? `<span class="ok-dot"></span>分出 <b class="num">${n(preview.distributed)}</b> · 池中归零 · 分池后全场仍是 <b class="num">${n(preview.afterTotal)}</b>` : '每个池都要指定赢家，才能核对全场积分。'}</div></div>
<div class="panel-actions">${nav('返回牌桌', 'table', 'ghost')}${btn('确认这样分池', 'settle-confirm', 'amber', !preview || !preview.balanced || !connected)}</div></aside>`;
  return `${topbar(s)}<main class="tablepage has-panel">${arena(s, fx)}${panel}</main>`;
}
function logPage(s) {
  if (extra.logs) s = { ...s, logs: extra.logs };
  return `${topbar(s)}<main class="pagewrap"><div class="panel logsheet"><h2>这一手发生过什么</h2><p class="lead">时间、谁、做了什么。高亮的是最近一步，撤销只会动它。要回到更早，就再撤一次。</p><label>回看记录<select id="log-hand"><option value="all" ${logHand === 'all' ? 'selected' : ''}>全部记录</option>${Array.from({ length: s.handNumber + 1 }, (_, i) => `<option value="${i}" ${Number(logHand ?? s.handNumber) === i ? 'selected' : ''}>${i ? `第 ${i} 手` : '入座与设置'}</option>`).join('')}</select></label>${transcript(s, logHand ?? s.handNumber)}<div class="panel-actions">${nav(data.role === 'player' ? '返回行动页' : '返回牌桌', data.role === 'player' ? 'play' : 'table')}${undoButton()}</div></div></main>`;
}
const LEVEL_OPTIONS = [0, 5, 8, 10, 15, 20, 30];
function blindSettings(s) {
  const b = data.blinds, c = s.config;
  const opt = (values, current, label) => values.map(v => `<option value="${v}" ${v === current ? 'selected' : ''}>${label(v)}</option>`).join('');
  return `<section class="manage-sec"><div class="sec-head"><h2>盲注与节奏</h2><span class="muted">下一手生效</span></div>
<div class="level-row"><div class="level-now"><span>现在</span><b class="num">${n(b.small)} / ${n(b.big)}</b>${b.ante ? `<small class="num">前注 ${n(b.ante)}</small>` : ''}<em>第 ${b.level + 1} 级</em></div>${btn(`${ICON.minus}<span>降一级</span>`, 'level-down', 'ghost has-icon', b.level === 0)}${btn(`${ICON.plus}<span>升一级</span>`, 'level-up', 'ghost has-icon')}</div>
<form id="settings-form" class="settings-grid"><label>自动涨盲<select name="levelEvery">${opt(LEVEL_OPTIONS.includes(c.levelEvery) ? LEVEL_OPTIONS : [...LEVEL_OPTIONS, c.levelEvery], c.levelEvery, v => v ? `每 ${v} 手升一级` : '关闭')}</select></label>
<label>前注（起始级别）<input name="ante" class="num" type="number" min="0" step="1" max="${c.bigBlind}" value="${c.ante}" aria-label="前注"></label>
<label>行动计时<select name="actionClock">${opt([0, 20, 30, 45, 60, 90], c.actionClock, v => v ? `${v} 秒` : '关闭')}</select></label>
<button class="btn btn-ghost" type="submit">保存设置</button></form></section>`;
}
function manage(s) {
  if (data.role !== 'host' || ongoing(s)) return table(s);
  const seatOpts = p => Array.from({ length: 10 }, (_, i) => i + 1).map(seat => { const o = s.players.find(q => q.seat === seat); return `<option value="${seat}" ${seat === p.seat ? 'selected' : ''}>${seat} 号${o && o.id !== p.id ? ` · 互换` : o ? ' · 现在' : ' · 空'}</option>`; }).join('');
  return `${topbar(s)}<main class="pagewrap"><div class="panel manage"><h1>座位</h1><p class="lead">顺时针的下一位，就是庄家左侧。调整只在两手之间。</p><fieldset class="field modes"><legend>打牌方式</legend><label class="mode" data-do="set-mode" data-mode="digital"><input type="radio" name="dealMode" value="digital" aria-label="电子牌" ${digitalOf(s) ? 'checked' : ''}><i class="tick">${ICON.check}</i><b>电子牌</b><span>系统洗牌发牌，底牌只在自己手机上，摊牌按牌力分池。</span></label><label class="mode" data-do="set-mode" data-mode="physical"><input type="radio" name="dealMode" value="physical" aria-label="实体牌" ${digitalOf(s) ? '' : 'checked'}><i class="tick">${ICON.check}</i><b>实体牌</b><span>我们自己发牌，系统只记筹码。</span></label></fieldset>${blindSettings(s)}<label class="switch-row"><span><b>打开补码</b><span>${s.config.rebuy ? '每次补码都会写入日志，并增加全场总额。' : '补码关着。打开后，每次加筹码都会写入日志。'}</span></span><input id="rebuy-setting" type="checkbox" ${s.config.rebuy ? 'checked' : ''}></label>
<div class="manage-list">${ordered(s).map(p => `<div class="manage-row ${p.sittingOut ? 'is-away' : ''}">${avatar(p)}<strong>${p.seat} · ${esc(p.name)}<small class="num">${n(p.stack)}${p.sittingOut ? ' · 暂离' : ''}${data.online.includes(p.id) ? '' : ' · 离线'}</small></strong><label class="seat-to"><span class="sr-only">给${esc(p.name)}换座</span><select data-seat-for="${p.id}" aria-label="给${esc(p.name)}换座">${seatOpts(p)}</select></label>${btn('逆时针', 'move', 'ghost', false, `data-id="${p.id}" data-direction="-1"`)}${btn('顺时针', 'move', 'ghost', false, `data-id="${p.id}" data-direction="1"`)}${btn(p.sittingOut ? '回到桌上' : '暂离', 'host-sit', 'ghost', false, `data-id="${p.id}" data-away="${!p.sittingOut}"`)}${s.config.rebuy ? `<label class="rebuy-amt"><span class="sr-only">给${esc(p.name)}补码</span><input id="rebuy-${p.id}" class="num" type="number" min="1" step="1" value="500" aria-label="给${esc(p.name)}补码"></label>${btn('补码', 'rebuy', 'ghost', false, `data-id="${p.id}"`)}` : ''}${btn('移出座位', 'remove', 'clay', false, `data-id="${p.id}"`)}</div>`).join('')}</div><p class="fine left">移出座位的人会带走现有筹码，并在自己手机上看到今晚的个人总结。暂离只跳过发牌和收盲，不补盲。</p><div class="panel-actions">${nav('返回牌桌', 'table')}${btn('今晚就到这儿 · 散场', 'end', 'clay', !connected)}</div></div></main>`;
}
// ───────── 散场总结 / 战况 ─────────
const summaryOf = () => data.summary || extra.summary;
function recap(s) {
  const sum = summaryOf(), ended = s.status === 'ended', host = data.role === 'host';
  if (!sum) return `${topbar(s)}<main class="recappage is-loading"><p class="muted">正在汇总今晚的每一手。</p></main>`;
  const me = data.playerId;
  const next = s.nextRoom;
  const dock = `<footer class="hostbar recapbar"><nav class="dock glass" aria-label="总结操作">
${btn(`${ICON.copy}<span>复制战报</span>`, 'recap-copy', 'quiet has-icon')}${btn(`${ICON.image}<span>保存为图片</span>`, 'recap-image', 'quiet has-icon')}<a class="btn btn-quiet has-icon" href="${link('hands')}">${ICON.book}<span>牌谱回放</span></a>
${ended ? (host ? `<i class="sep"></i>${btn(`${ICON.undo}<span>撤销散场</span>`, 'undo', 'quiet has-icon', !data.lastUndo || !connected)}${next ? `<a class="btn btn-amber has-icon" href="/share?room=${next}">${ICON.play}<span>去新桌 ${next}</span></a>` : btn(`${ICON.play}<span>用同样设置再开一桌</span>`, 'rematch', 'amber has-icon', !connected)}` : next ? `<i class="sep"></i><a class="btn btn-amber has-icon" href="/join?room=${next}${me && player(s, me) ? `&name=${encodeURIComponent(player(s, me).name)}` : ''}">${ICON.play}<span>去新桌 ${next} 入座</span></a>` : '') : `<i class="sep"></i>${nav(`${ICON.back}<span>返回${data.role === 'player' ? '我的座位' : '牌桌'}</span>`, data.role === 'player' ? 'play' : 'table', 'amber has-icon')}`}</nav></footer>`;
  return `${topbar(s)}<main class="recappage ${ended ? 'is-ended' : 'is-live'} ${sum.players.length > 7 ? 'is-crowded' : ''}">${recapBody(sum, { me })}</main>${dock}`;
}
function rankMini(sum, me) {
  return `<ol class="ps-rank">${sum.players.map(p => `<li class="${p.id === me ? 'is-me' : ''} ${p.net > 0 ? 'is-up' : p.net < 0 ? 'is-down' : ''}"><span class="num r">${p.rank}</span>${avatar(p)}<b>${esc(p.name)}${p.status === 'left' ? '<small>先走</small>' : ''}</b><span class="num v">${signed(p.net)}</span></li>`).join('')}</ol>`;
}
function phoneSummary(s) {
  const sum = data.summary, me = data.playerId, mine = sum?.players.find(p => p.id === me);
  if (!sum || !mine) return `<main class="phone-app">${phoneHead(s)}<div class="j-wrap"><p class="muted">正在汇总。</p></div></main>`;
  const departed = data.role === 'departed', next = s.nextRoom;
  const live = departed && s.status !== 'ended';
  const cta = next ? `<a class="btn btn-amber btn-block" href="/join?room=${next}&name=${encodeURIComponent(mine.name)}">去新桌 ${next} 入座</a>` : live ? `<a class="btn btn-amber btn-block" href="${link('join')}">回到桌上</a>` : '';
  return `<main class="phone-app summary-app">${phoneHead(s)}${connectionBanner()}<div class="ps-wrap" data-testid="personal-summary">${personalBody(sum, me)}
${live ? `<p class="ps-live"><span class="ok-dot"></span><span>牌局还在继续，已到第 <b class="num">${s.handNumber}</b> 手。你的数字定格在离席那一刻。</span></p>` : ''}
<section class="ps-table"><div class="ps-table-head"><h2>${s.status === 'ended' ? '全桌' : '目前全桌'}</h2><a href="${link('recap')}">完整总结</a></div>${rankMini(sum, me)}<p class="ps-bal"><span class="ok-dot ${sum.balance.ok ? '' : 'is-off'}"></span>${sum.balance.ok ? `账平 · 总带入 <b class="num">${n(sum.balance.buyIn)}</b>` : '账目没有对上，以主持电脑为准'}</p></section></div>
<footer class="sheet ps-actions">${cta}<div class="ps-btns">${btn(`${ICON.image}<span>保存为图片</span>`, 'my-image', next || live ? 'paper has-icon' : 'amber has-icon')}${btn(`${ICON.copy}<span>复制</span>`, 'my-copy', 'paper has-icon')}<a class="btn btn-paper has-icon" href="${link('hands')}">${ICON.book}<span>牌谱</span></a></div><p class="fine">仅娱乐积分，不涉及任何真钱结算</p></footer></main>`;
}
async function showImage(me) {
  const sum = summaryOf(); if (!sum) return;
  notice('正在画图…');
  try {
    const url = await shareImage(sum, me);
    const fileName = `夜席-${sum.room.name}${me ? '-' + (sum.players.find(p => p.id === me)?.name || '') : ''}.png`;
    showModal(`<h3 id="dialog-title">${me ? '我的今晚' : '今晚战报'}</h3><p>手机上长按图片可以保存或转发；电脑上点「下载」。</p><img class="share-img" src="${url}" alt="${esc(sum.room.name)} 战报图片"><div class="stack-btns">${btn('返回', 'cancel')}<a class="btn btn-amber" href="${url}" download="${esc(fileName)}">下载图片</a></div>`, false);
    document.querySelector('#toast').hidden = true;
  } catch (e) { notice(`没画出来：${e.message}`); }
}
async function copySummary(me) {
  const sum = summaryOf(); if (!sum) return;
  const text = me ? personalText(sum, me) : recapText(sum);
  if (await copyText(text)) { notice('已复制，可以直接粘贴到群里'); return; }
  showModal(`<h3 id="dialog-title">复制战报</h3><p>这个浏览器不允许自动复制。长按下面的文字全选复制。</p><textarea class="copy-area" readonly rows="12">${esc(text)}</textarea>${btn('返回', 'cancel')}`, false);
  modal.querySelector('textarea')?.select();
}
// ───────── 牌谱 ─────────
function handsPage(s) {
  const back = data.role === 'player' ? nav(`${ICON.back}<span>返回我的座位</span>`, 'play', 'quiet has-icon') : data.role === 'departed' ? nav(`${ICON.back}<span>我的总结</span>`, 'play', 'quiet has-icon') : nav(`${ICON.back}<span>${s.status === 'ended' ? '散场总结' : '返回牌桌'}</span>`, s.status === 'ended' ? 'recap' : 'table', 'quiet has-icon');
  return `${topbar(s)}<main class="handspage"><div class="hv-top">${back}<span class="muted">${extra.hands ? `已记录 ${extra.hands.records.length} 手 · 只显示公开过的牌` : ''}</span></div><div class="hv-grid">${extra.hands ? handsBody(extra.hands, handPick) : '<p class="muted">正在读取牌谱。</p>'}</div></main>`;
}
function render() {
  const active = document.activeElement;
  const focusAttrs = active && app.contains(active) ? [...active.attributes].filter(a => a.name.startsWith('data-') || ['href', 'name', 'type'].includes(a.name)).map(a => [a.name, a.value]) : [];
  const fields = [...app.querySelectorAll('input')].filter(el => el.id).map(el => [el.id, el.value]);
  const focusId = active?.id, start = active?.selectionStart, end = active?.selectionEnd;
  const transcriptScroll = app.querySelector('.transcript')?.scrollTop;
  document.body.className = page === 'home' ? 'is-home' : ['play', 'join'].includes(page) || !code || !data ? 'is-phone' : 'is-screen';
  if (data && ['table', 'settle', 'manage'].includes(page) && data.state.status === 'ended') page = 'recap';
  if (page === 'home') { document.body.className = network && !network.local ? 'is-phone' : 'is-home'; app.innerHTML = home(); }
  else if (page === 'transfer') { document.body.className = 'is-phone'; app.innerHTML = `<main class="phone-app join-app"><header class="p-head"><span class="seal">夜</span><div class="t"><b>夜席</b><span>接任主持</span></div></header><div class="j-wrap"><div class="eyebrow">只在同桌主持人同意时接任</div><h1>把主持交到这台设备</h1><p class="lead">这台设备成为主持后，原来那台电脑就不能再分池。</p></div><div class="sheet j-form">${btn('确认接任主持', 'accept-transfer', 'amber')}</div></main>`; }
  else if (!code) app.innerHTML = joinLookup();
  else if (!data) app.innerHTML = loadingPage();
  else app.innerHTML = ({ join, share, play, table, settle, log: logPage, manage, recap, hands: handsPage }[page] || table)(data.state);
  for (const [id, value] of fields) { const el = document.getElementById(id); if (el && el.type !== 'checkbox') el.value = value; }
  const fresh = focusId ? document.getElementById(focusId) : focusAttrs.length ? [...app.querySelectorAll('button, a, select, input')].find(el => el.tagName === active.tagName && focusAttrs.every(([k, v]) => el.getAttribute(k) === v)) : null;
  if (fresh && active.tagName === 'INPUT' && !['checkbox', 'radio'].includes(active.type) && fresh.tagName === 'INPUT' && fresh.type === active.type) {
    // Keep the live input node so caret/selection (not readable on number inputs) survives a state push mid-edit.
    for (const a of [...active.attributes]) if (a.name !== 'value' && !fresh.hasAttribute(a.name)) active.removeAttribute(a.name);
    for (const a of [...fresh.attributes]) if (a.name !== 'value') active.setAttribute(a.name, a.value);
    fresh.replaceWith(active); active.focus({ preventScroll: true });
    try { active.setSelectionRange(start, end); } catch { /* number input keeps its own selection */ }
  } else if (fresh) { fresh.focus({ preventScroll: true }); try { fresh.setSelectionRange(start, end); } catch { /* number input */ } }
  const transcriptEl = app.querySelector('.transcript');
  if (transcriptEl) transcriptEl.scrollTop = page === 'table' ? transcriptEl.scrollHeight : transcriptScroll || 0;
  const nameEl = document.querySelector('#join-name');
  if (nameEl) document.querySelector('#join-form button[type=submit]').disabled = !nameEl.value.trim() || !connected || !seatChoice;
  if (document.querySelector('#raise-amount')) updateRaise();
  const dock = document.querySelector('#sound-dock');
  if (dock) dock.innerHTML = tableSound.blocked ? '<button type="button" class="sound-unlock" data-do="unlock-sound">轻触开启牌桌音效</button>' : '';
}
function closeModal() { if (modal.open) modal.close(); modal.innerHTML = ''; delete modal.dataset.version; }
function showModal(html, actionSensitive = true, sheet = false) {
  returnFocus = document.activeElement;
  modal.innerHTML = html; modal.className = sheet ? 'raise-modal' : '';
  if (actionSensitive) modal.dataset.version = String(data.state.version);
  modal.showModal(); modal.querySelector('[data-do="cancel"]')?.focus();
}
function confirm(title, text, action, kind = 'clay-fill', quote = '', extra = '') {
  showModal(`<h3 id="dialog-title">${esc(title)}</h3><p>${esc(text)}</p>${quote ? `<div class="quote">${esc(quote)}</div>` : ''}<div class="stack-btns">${btn('返回', 'cancel')}${btn(action === 'undo-submit' ? '确认撤销' : title.replace('？', ''), action, kind, false, extra)}</div>`);
}
function allinText(s, p, l) {
  if (p.stack <= l.call) return `剩余 ${n(p.stack)}，${p.stack < l.call ? '不够跟注' : '刚好跟注'}。全下会把这 ${n(p.stack)} 全部放入池中。`;
  return l.shortAllIn ? '不足一次完整加注。其他人仍需补跟或弃牌；已行动者只有面对累计完整加注幅度时才能再加注。' : '将投入全部剩余。无人能跟注的部分会退回。';
}
function updateRaise(value) {
  const amount = document.querySelector('#raise-amount');
  if (!amount || !data.legal) return;
  if (value !== undefined) amount.value = String(value);
  const l = data.legal, p = player(data.state, data.playerId), target = Number(amount.value), label = data.state.hand.currentBet ? '加注' : '下注';
  const valid = amount.value !== '' && Number.isSafeInteger(target) && target >= l.minRaiseTo && target <= l.maxRaiseTo;
  if (valid) raiseValue = target;
  document.querySelector('#raise-error').textContent = valid ? '' : `需要 ${n(l.minRaiseTo)}–${n(l.maxRaiseTo)} 之间的整数。`;
  document.querySelector('#raise-add').textContent = valid ? n(target - p.bet) : '—';
  const range = document.querySelector('#raise-range');
  if (valid) range.value = String(target);
  range.style.setProperty('--pct', `${l.maxRaiseTo > l.minRaiseTo ? ((Number(range.value) - l.minRaiseTo) / (l.maxRaiseTo - l.minRaiseTo)) * 100 : 100}%`);
  const submit = document.querySelector('#raise-submit'); submit.disabled = !valid || busy || !connected;
  submit.textContent = target === l.maxRaiseTo ? '确认全下' : `确认${label}到 ${valid ? n(target) : '—'}`;
  document.querySelector('#raise-allin-note').textContent = target === l.maxRaiseTo ? allinText(data.state, p, l) : '';
  document.querySelectorAll('[data-do=preset]').forEach(el => el.classList.toggle('is-on', Number(el.dataset.value) === target));
}
app.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target, values = new FormData(form);
  const submit = form.querySelector('button[type=submit]'); if (submit) submit.disabled = true;
  try {
    if (form.id === 'create-form') {
      const result = await api('/api/rooms', { name: values.get('name'), smallBlind: Number(values.get('smallBlind')), bigBlind: Number(values.get('bigBlind')), startingStack: Number(values.get('startingStack')), rebuy: values.has('rebuy'), dealMode: values.get('dealMode') || 'digital', ante: Number(values.get('ante') || 0), levelEvery: Number(values.get('levelEvery') || 0), actionClock: Number(values.get('actionClock') || 0) }, '');
      localStorage.setItem(`night-table.host.${result.code}`, result.token); location.assign(`/share?room=${result.code}`);
    } else if (form.id === 'lookup-form') {
      const room = values.get('code').toUpperCase(); await api(`/api/rooms/${room}`, undefined, ''); location.assign(`/join?room=${room}`);
    } else if (form.id === 'settings-form') {
      await command('settings', { ante: Number(values.get('ante')), levelEvery: Number(values.get('levelEvery')), actionClock: Number(values.get('actionClock')) });
      if (submit) submit.disabled = false;
    } else if (form.id === 'join-form') {
      let token = readToken('player'); if (!token) { token = randomToken(); localStorage.setItem(tokenKey('player'), token); }
      await api(`/api/rooms/${code}/join`, { name: values.get('name'), seat: seatChoice, token }, ''); location.assign(link('play'));
    }
  } catch (error) { const el = form.querySelector('.error'); if (el) el.textContent = error.message; else notice(error.message); if (submit) submit.disabled = false; }
});
document.addEventListener('input', event => {
  if (event.target.id === 'raise-amount') updateRaise();
  if (event.target.id === 'raise-range') updateRaise(Number(event.target.value));
  if (event.target.id === 'join-name') document.querySelector('#join-form button[type=submit]').disabled = !event.target.value.trim() || !connected || !seatChoice;
  if (event.target.closest('#create-form')) {
    const f = document.querySelector('#create-form'), v = new FormData(f), small = Number(v.get('smallBlind')), big = Number(v.get('bigBlind')), starting = Number(v.get('startingStack'));
    const error = ![small, big, starting].every(x => Number.isSafeInteger(x) && x > 0 && x <= 1_000_000_000) ? '请填写正整数。' : big < small ? '大盲不能小于小盲。' : starting < big ? '起始筹码至少要够一个大盲。' : '';
    document.querySelector('#create-error').textContent = error; f.querySelector('button[type=submit]').disabled = !!error || !v.get('name').trim();
    const hint = document.querySelector('#bb-hint'); if (hint) hint.textContent = big > 0 && starting > 0 ? `= ${Math.round(starting / big * 10) / 10} BB` : '';
    f.querySelectorAll('[data-do=stack-preset]').forEach(b => b.classList.toggle('is-on', big * Number(b.dataset.bb) === starting));
  }
});
document.addEventListener('change', event => {
  if (event.target.id === 'log-hand') { logHand = event.target.value; render(); }
  if (event.target.id === 'rebuy-setting') command('rebuySetting', { enabled: event.target.checked });
  if (event.target.id === 'awake-setting') setAwakePreferred(event.target.checked);
  if (event.target.dataset.seatFor) { const seat = Number(event.target.value); const p = player(data.state, event.target.dataset.seatFor); if (p && seat !== p.seat) command('seat', { playerId: p.id, seat }); }
});
document.addEventListener('click', async event => {
  const el = event.target.closest('[data-do]'); if (!el || el.disabled) return;
  const action = el.dataset.do, s = data?.state, p = s && player(s, data.playerId);
  switch (action) {
    case 'reconnect': reconnect(); break;
    case 'cancel': closeModal(); returnFocus?.focus(); break;
    case 'seat-choice': seatChoice = Number(el.dataset.seat); render(); break;
    case 'start': case 'next': await command(action); break;
    case 'check': case 'call': await command('act', { action }); break;
    case 'fold': confirm('确认弃牌？', '这一手你不能再赢任何池。', 'fold-submit'); break;
    case 'fold-submit': await command('act', { action: 'fold' }); break;
    case 'allin': confirm('确认全下', allinText(s, p, data.legal), 'allin-submit', 'brass', `全下 ${n(p.stack)}`); break;
    case 'allin-submit': await command('act', { action: 'allin' }); break;
    case 'raise': raiseOpen = true; raiseValue = data.legal?.minRaiseTo || 0; render(); break;
    case 'raise-cancel': raiseOpen = false; render(); document.querySelector('[data-do="raise"]')?.focus(); break;
    case 'field-step': { const input = document.getElementById(el.dataset.field), v = Number(input.value) || 0, step = v < 10 ? 1 : v < 50 ? 5 : v < 200 ? 10 : 50; input.value = String(Math.max(1, v + Number(el.dataset.step) * step)); input.dispatchEvent(new Event('input', { bubbles: true })); break; }
    case 'stack-preset': { const f = document.querySelector('#create-form'), big = Number(f.bigBlind.value) || 0; if (big > 0) { f.startingStack.value = String(big * Number(el.dataset.bb)); f.startingStack.dispatchEvent(new Event('input', { bubbles: true })); } break; }
    case 'preset': updateRaise(Number(el.dataset.value)); break;
    case 'step': { const current = Number(document.querySelector('#raise-amount').value), l = data.legal; updateRaise(Math.max(l.minRaiseTo, Math.min(l.maxRaiseTo, current + Number(el.dataset.step) * s.config.bigBlind))); break; }
    case 'raise-submit': { const target = Number(document.querySelector('#raise-amount').value); await command('act', target === data.legal.maxRaiseTo ? { action: 'allin' } : { action: 'raise', to: target }); break; }
    case 'undo': confirm('撤销上一步？', '只会撤回最近这一步。筹码和底池按它发生之前重算。', 'undo-submit', 'clay-fill', data.lastUndo); break;
    case 'undo-submit': await command('undo'); break;
    case 'settlement': location.assign(link('settle')); break;
    case 'pot': selectedPot = Number(el.dataset.index); render(); break;
    case 'winner': {
      const pot = data.pots[selectedPot], current = selections[pot.id] || [];
      selections = { ...selections, [pot.id]: current.includes(el.dataset.id) ? current.filter(id => id !== el.dataset.id) : [...current, el.dataset.id] };
      render(); await command('preview', { selections: localPreview(s) ? selections : null }); break;
    }
    case 'settle-confirm': { const preview = localPreview(s); if (preview) confirm('确认这样分池', `${remainderText(s, preview)} 分池后全场仍是 ${n(s.total)}。`, 'settle-submit', 'amber', `分出 ${n(preview.distributed)} · 池中归零`); break; }
    case 'settle-submit': { const preview = localPreview(s); if (preview) { await command('settle', { selections, expectedTotal: preview.distributed }); if (data.state.hand.phase === 'settled') location.assign(link('table')); } break; }
    case 'manage': location.assign(link('manage')); break;
    case 'move': await command('move', { playerId: el.dataset.id, direction: Number(el.dataset.direction) }); break;
    case 'rebuy': await command('rebuy', { playerId: el.dataset.id, amount: Number(document.getElementById(`rebuy-${el.dataset.id}`).value) }); break;
    case 'leave': case 'remove': { const who = action === 'remove' ? player(s, el.dataset.id) : p; confirm(ongoing(s) ? '确认这一手结束后离开' : '确认离开', ongoing(s) ? '本手仍需自己行动，不会自动弃牌。结束后，下一手开手时再移出座位。' : `确认离开，并带走 ${n(who.stack)}。`, 'leave-submit', 'clay-fill', who.name, `data-id="${who.id}"`); break; }
    case 'leave-submit': await command('leave', { playerId: el.dataset.id }); break;
    case 'transfer': {
      try { const result = await api(`/api/rooms/${code}/transfer`, {}); showModal(`<h3 id="dialog-title">把主持交到另一台设备</h3><p>让新主持用手机扫码，或打开下面的地址。对方确认后，这台电脑退出主持。5 分钟有效，只能用一次。</p>${result.qr ? `<div class="qr-paper transfer-qr">${result.qr}</div>` : ''}<p class="transfer-link mono">${esc(result.url)}</p>${btn('返回', 'cancel')}`, false); } catch (e) { notice(e.message); } break;
    }
    case 'accept-transfer': {
      try { const result = await api(`/api/rooms/${code}/accept-transfer`, { secret: location.hash.slice(1) }, ''); localStorage.setItem(tokenKey('host'), result.token); location.replace(link('table')); } catch (e) { notice(e.message); } break;
    }
    case 'toggle-sound': tableSound.toggle(); render(); break;
    case 'unlock-sound': await tableSound.unlock(); render(); break;
    case 'set-mode': await command('setDealMode', { dealMode: el.dataset.mode || el.value }); break;
    case 'pause': await command('pause', { on: true }); break;
    case 'resume': await command('pause', { on: false }); break;
    case 'end': confirm('确认散场？', `散场后房间只能看、不能再打。每个人手机上会出现自己的总结，大屏显示全桌排行。共 ${s.handNumber} 手。点错了可以撤销。`, 'end-submit', 'clay-fill', '散场 · 仅娱乐积分，不做任何真钱结算'); break;
    case 'end-submit': await command('end'); if (data.state.status === 'ended' && page !== 'recap') { page = 'recap'; history.replaceState(null, '', link('recap')); render(); } break;
    case 'timeout': { const actor = player(s, s.hand?.actor), l = actor && legalActions(s, actor.id); if (actor) confirm(`替${actor.name}${l?.check ? '过牌' : '弃牌'}？`, `${data.online.includes(actor.id) ? '行动计时已经到了。' : '他现在掉线了。'}能过牌就过牌，不能过牌才弃牌。会写进记录，可以撤销。`, 'timeout-submit', 'clay-fill', actor.name); break; }
    case 'timeout-submit': await command('timeout'); break;
    case 'show': await command('show'); break;
    case 'sit-toggle': closeModal(); await command('sitOut', { away: !p.sittingOut }); break;
    case 'host-sit': await command('sitOut', { playerId: el.dataset.id, away: el.dataset.away === 'true' }); break;
    case 'phone-more': phoneMore(s, p); break;
    case 'ask': closeModal(); try { accept(await api(`/api/rooms/${code}/ask`, {})); notice('已申请补码，等主持人确认'); } catch (e) { notice(e.message); } break;
    case 'ask-ok': case 'ask-deny': { const amount = Number(document.getElementById(`ask-${el.dataset.id}`)?.value); try { accept(await api(`/api/rooms/${code}/decide-ask`, { askId: el.dataset.id, approve: action === 'ask-ok', amount, requestId: randomToken() })); notice(action === 'ask-ok' ? `已补码 ${n(amount)}` : '已忽略'); } catch (e) { notice(e.message); } break; }
    case 'claim-ok': case 'claim-deny': try { const r = await api(`/api/rooms/${code}/decide-claim`, { claimId: el.dataset.id, approve: action === 'claim-ok' }); accept(r); notice(r.approved ? `${r.name} 已在新手机上接回座位` : '已拒绝'); } catch (e) { notice(e.message); } break;
    case 'claim-pick': claimPick = el.dataset.id; render(); break;
    case 'claim-submit': {
      let token = readToken('player'); if (!token) { token = randomToken(); localStorage.setItem(tokenKey('player'), token); }
      try { accept(await api(`/api/rooms/${code}/claim`, { token, playerId: claimPick }, token)); resubscribe(); } catch (e) { notice(e.message); } break;
    }
    case 'claim-reset': localStorage.removeItem(tokenKey('player')); claimPick = null; location.reload(); break;
    case 'level-up': case 'level-down': await command('level', { delta: action === 'level-up' ? 1 : -1 }); break;
    case 'rematch': try { const r = await api(`/api/rooms/${code}/rematch`, {}); localStorage.setItem(`night-table.host.${r.code}`, r.token); location.assign(`/share?room=${r.code}`); } catch (e) { notice(e.message); } break;
    case 'reclaim': try { const r = await api(`/api/rooms/${el.dataset.code}/reclaim-host`, {}, ''); localStorage.setItem(`night-table.host.${el.dataset.code}`, r.token); location.assign(`/table?room=${el.dataset.code}`); } catch (e) { notice(e.message); } break;
    case 'recap-copy': await copySummary(null); break;
    case 'recap-image': await showImage(null); break;
    case 'my-copy': await copySummary(data.playerId); break;
    case 'my-image': await showImage(data.playerId); break;
    case 'hand-pick': if (el.dataset.n) { handPick = Number(el.dataset.n); render(); document.querySelector('.hv-detail')?.scrollTo?.({ top: 0 }); } break;
  }
});
modal.addEventListener('click', event => { if (event.target === modal) { const rect = modal.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeModal(); } });
window.addEventListener('offline', () => { clearTimeout(retry); connected = false; ws?.close(); closeModal(); render(); });
window.addEventListener('online', () => { if (!connected) reconnect(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && (!data || ws?.readyState === WebSocket.CLOSED)) reconnect(); });

// 计时环、休息时长：每 250ms 只改文字和 CSS 变量，不重绘整页。
setInterval(() => {
  if (!data) return;
  const now = serverNow();
  document.querySelectorAll('[data-deadline]').forEach(el => {
    const left = Math.max(0, Number(el.dataset.deadline) - now), total = Number(el.dataset.total) || 1;
    el.style.setProperty('--p', String(Math.min(1, left / total)));
    el.classList.toggle('is-low', left <= 5000);
  });
  document.querySelectorAll('[data-countdown]').forEach(el => { el.textContent = String(Math.max(0, Math.ceil((Number(el.dataset.countdown) - now) / 1000))); });
  document.querySelectorAll('[data-since]').forEach(el => { const sec = Math.max(0, Math.floor((now - Date.parse(el.dataset.since)) / 1000)); el.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; });
  const s = data.state, key = s.hand?.actor ? `${s.hand.actor}:${s.hand.actorSince}:${timeoutReady(s)}` : '';
  if (data.role === 'host' && key !== expiredKey) { const first = !expiredKey; expiredKey = key; if (!first && page === 'table' && !modal.open) render(); }
  if (page === 'play' && data.legal) { const d = deadlineOf(s); if (d && d - now <= 10_000 && d - now > 9_750) buzz([20]); }
}, 250);
function logSound(prev, next) {
  if (!prev) return;
  const seen = new Set((prev.state.logs || []).map(e => e.id));
  for (const entry of (next.state.logs || []).filter(e => !seen.has(e.id))) {
    const t = entry.text;
    if (entry.kind === 'start') tableSound.play('button');
    else if (entry.kind === 'deal') { tableSound.play('shuffle'); tableSound.play('deal', { copies: 4, gap: 0.06 }); }
    else if (entry.kind === 'next') tableSound.play(digitalOf(next.state) ? 'flip' : 'button');
    else if (entry.kind === 'settle') tableSound.play('pot');
    else if (entry.kind === 'showdown' || entry.kind === 'show') tableSound.play('flip');
    else if (entry.kind === 'end') tableSound.play('pot');
    else if (['pause', 'level', 'sitout', 'claim', 'settings', 'move', 'join', 'leave', 'rebuy', 'leaveRequest'].includes(entry.kind)) tableSound.play('button');
    else if (t.includes('过牌')) tableSound.play('check');
    else if (t.includes('弃牌')) tableSound.play('fold');
    else if (t.includes('全下') || t.includes('短码')) tableSound.play('allin');
    else if (t.includes('加注') || t.includes('下注')) tableSound.play('raise');
    else if (t.includes('跟注') || entry.kind === 'blind' || t.includes('退回')) tableSound.play('bet');
  }
}
function playTransition(prev, next) {
  const gen = ++fxGen;
  const undone = wasUndo || (prev && (next.state.logCount ?? next.state.logs?.length ?? 0) < (prev.state.logCount ?? prev.state.logs?.length ?? 0));
  wasUndo = false;
  if (undone) {
    clearFlights();
    potLock = false;
    tableSound.play('button');
    return;
  }
  if (!prev || !next) return;
  logSound(prev, next);
  if (reducedMotion()) return;
  const s0 = prev.state, s1 = next.state;
  if (s1.hand?.phase === 'settled' && s0.hand?.phase === 'showdown' && s1.hand.preview) {
    potLock = true;
    render();
    animatePots(s1.hand.preview, gen).finally(() => { if (gen === fxGen) { potLock = false; render(); } });
    return;
  }
  const pot = document.querySelector('#table-pot');
  if (pot) for (const pl of s1.players) {
    const q = s0.players.find(x => x.id === pl.id);
    if (!q) continue;
    const seat = document.querySelector(`[data-seat-id="${pl.id}"]`);
    if (!seat) continue;
    if (pl.bet > q.bet) flyChips(seat, pot, pl.bet - q.bet, { duration: 400 });
    else if (pl.contribution < q.contribution) flyChips(pot, seat, q.contribution - pl.contribution, { duration: 360 });
  }
  if (digitalOf(s1) && s1.hand?.holeDealt && !s0.hand?.holeDealt) dealFromButton(s1, gen);
  if (digitalOf(s1) && (s1.hand?.board?.length || 0) > (s0.hand?.board?.length || 0)) {
    document.querySelectorAll('.board-slot .npcard.is-flipped').forEach((el, i) => {
      if (i < (s0.hand?.board?.length || 0)) return;
      el.classList.remove('is-flipped');
      requestAnimationFrame(() => setTimeout(() => { if (gen === fxGen) el.classList.add('is-flipped'); }, 80 * (i - (s0.hand?.board?.length || 0))));
    });
  }
  if (digitalOf(s1) && s1.hand?.phase === 'showdown' && s0.hand?.phase !== 'showdown') {
    const ids = s1.players.filter(pl => pl.inHand && !pl.folded && s1.hand.revealed?.[pl.id]).sort((a, b) => ((a.seat - s1.hand.dealerSeat + 9) % 10) - ((b.seat - s1.hand.dealerSeat + 9) % 10));
    ids.forEach((pl, i) => {
      document.querySelectorAll(`[data-seat-id="${pl.id}"] .npcard`).forEach((el, j) => {
        el.classList.remove('is-flipped');
        setTimeout(() => { if (gen === fxGen) el.classList.add('is-flipped'); }, 120 * i + 40 * j);
      });
    });
  }
}

function dealFromButton(s, gen) {
  const origin = document.querySelector(`[data-seat-id="${s.hand.dealer}"]`) || document.querySelector('#table-pot');
  const seats = [...document.querySelectorAll('.seat-holes')];
  let delay = 0;
  for (let round = 0; round < 2; round++) for (const seat of seats) {
    const wait = delay;
    delay += 60;
    setTimeout(() => {
      if (gen !== fxGen || !origin) return;
      const fx = document.getElementById('fx');
      if (!fx) return;
      const a = origin.getBoundingClientRect(), b = seat.getBoundingClientRect();
      const ghost = document.createElement('div');
      ghost.innerHTML = playingCard(null, { size: 'is-seat' });
      ghost.style.cssText = 'position:absolute;left:0;top:0;will-change:transform;';
      fx.append(ghost);
      const x1 = a.left + a.width / 2 - 18, y1 = a.top + 8;
      const x2 = b.left + (round * 20), y2 = b.top;
      ghost.animate([
        { transform: `translate(${x1}px, ${y1}px) rotateZ(-18deg)`, opacity: 0.95 },
        { transform: `translate(${(x1 + x2) / 2}px, ${Math.min(y1, y2) - 28}px) rotateZ(10deg)`, offset: 0.45 },
        { transform: `translate(${x2}px, ${y2}px) rotateZ(0deg)`, opacity: 1 }
      ], { duration: 480, easing: 'cubic-bezier(0.22, 0.8, 0.24, 1)', fill: 'forwards' })
        .finished.then(() => ghost.remove()).catch(() => ghost.remove());
    }, wait);
  }
}
function animatePots(preview, gen) {
  let chain = Promise.resolve();
  for (const detail of preview.details || []) {
    chain = chain.then(() => {
      if (gen !== fxGen) return;
      tableSound.play('pot');
      const source = document.querySelector(`#pot-${detail.id}`) || document.querySelector('#table-pot');
      const tasks = (detail.winners || []).map((id, i) => new Promise(resolve => {
        const seat = document.querySelector(`[data-seat-id="${id}"]`);
        const odd = (detail.oddRecipients || []).includes(id) ? 1 : 0;
        const main = Math.max(0, (detail.shares?.[id] || 0) - odd);
        if (!main || !seat) return resolve();
        setTimeout(() => flyChips(source, seat, main, { duration: 480, onDone: resolve }), i * 30);
      }));
      return Promise.all(tasks).then(() => {
        const odds = detail.oddRecipients || [];
        if (!odds.length) return;
        tableSound.play('odd');
        return Promise.all(odds.map(id => new Promise(resolve => {
          const seat = document.querySelector(`[data-seat-id="${id}"]`);
          if (!seat) return resolve();
          flyChips(document.querySelector(`#pot-${detail.id}`) || document.querySelector('#table-pot'), seat, 1, { duration: 280, odd: true, onDone: resolve });
        })));
      });
    });
  }
  return chain;
}

async function boot() {
  if (bootBusy) return;
  bootBusy = true;
  render();
  try {
    if (page === 'home') { network = await api('/api/network', undefined, ''); retryAttempt = 0; loadError = ''; render(); }
    else if (code && page !== 'transfer') { if (sessionStorage.getItem('night-table.revoked')) { sessionStorage.removeItem('night-table.revoked'); setTimeout(() => notice('这个座位已经在另一台手机上接回，这台手机不再能操作。'), 300); } accept(await api(`/api/rooms/${code}`)); subscribe(); if (page === 'settle' && data.role !== 'host') notice('没有主持权限。分池、撤销和开新一手只在主持那台电脑上。'); }
  } catch (error) {
    loadError = error.message; render();
    if (!error.status || error.status >= 500 || error.status === 429) scheduleRetry(boot);
  } finally { bootBusy = false; }
}
boot();
