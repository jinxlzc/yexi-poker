import { t, localized, getLanguage, setLanguage, languages } from '/i18n/index.js';
import { STREETS, streetMessage, ongoing, player, ordered, potTotal, previewSettlement, legalActions, isDigital, nextPositions, levelBlinds } from '/shared/engine.js';
import { tableSound } from '/audio/table-sound.js';
import { playingCard, boardSlots } from '/cards/table-cards.js';
import { evaluate, describeHandMessage } from '/shared/cards.js';
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
let tableReveal = null;
// 按需拉取的大块数据：完整日志、牌谱、进行中的战况。广播里只带当前手。
let extra = { logs: null, hands: null, summary: null, version: -1 }, extraBusy = false, handPick = null, skew = 0, expiredKey = '', claimPick = null;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const digitalOf = s => isDigital(s);
const n = value => Number(value || 0).toLocaleString(getLanguage());
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tokenKey = role => `night-table.${role}.${code}`;
const readToken = role => localStorage.getItem(tokenKey(role)) || '';
const credential = () => page === 'play' || page === 'join' ? readToken('player') : readToken('host') || readToken('player');
const link = route => `/${route}?room=${code}`;
const btn = (label, action, kind = 'ghost', disabled = false, extra = '') => `<button class="btn btn-${kind}" data-do="${action}" ${disabled || busy ? 'disabled' : ''} ${extra}>${label}</button>`;
const nav = (label, route, kind = 'ghost') => `<a class="btn btn-${kind}" href="${link(route)}">${label}</a>`;
const settlementPots = view => view.runPots || view.pots;
const runVoters = s => ordered(s).filter(p => p.inHand && !p.folded);
const runVoteOf = (s, id) => s.hand?.runVotes?.[id];
const runMaxOf = s => s.hand?.runMax || s.config.runouts || 3;
const waitingToVote = (s, id) => !runVoteOf(s, id) && runVoters(s).some(p => p.id === id);
const listSeparator = () => ['zh-CN', 'zh-TW', 'ja'].includes(getLanguage()) ? '、' : ', ';
const runChoiceLabel = runs => t(`run.${runs}`);
const runName = run => t('ui.001', { p0: run });
const potName = p => localized(p.nameMessage || p.name);
const runPotName = (s, p) => `${s.hand?.runs > 1 ? `${runName(p.run)} · ` : ''}${potName(p)}`;
const runResultLabel = s => t('ui.002', { p0: s.hand.runs || 1 });
const seatName = (s, id) => player(s, id)?.name || s.roster?.[id]?.name || '';
const notice = text => { const el = document.querySelector('#toast'); el.textContent = text; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 4500); };
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
async function api(path, body, token = credential()) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, { signal: controller.signal, method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(localized(result) || t('ui.003')), { status: response.status });
    return result;
  } catch (error) {
    if (error.status) throw error;
    throw new Error(t('ui.004'));
  } finally { clearTimeout(timeout); }
}
function connectionBanner() { return !connected ? `<div class="connection" role="status">${esc(!navigator.onLine ? t('ui.005') : loadError || t('ui.006'))} <button class="link-btn" data-do="reconnect">${t('ui.007')}</button></div>` : ''; }
function loadingPage() { return `<main class="boot"><span class="seal">${t('ui.008')}</span><p>${t('ui.009')}</p>${connectionBanner()}<a href="/join">${t('ui.010')}</a></main>`; }
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
  syncTableReveal(previous?.state, next.state);
  if (digitalOf(next.state) && next.state.hand?.autoJudged && next.state.hand.selections) selections = next.state.hand.selections;
  else {
    const pots = settlementPots(next);
    const fingerprint = JSON.stringify([next.state.handNumber, next.state.hand?.phase, pots]);
    if (fingerprint !== potFingerprint) {
      selections = next.state.hand?.selections || Object.fromEntries(pots.map(p => [p.id, p.eligible.length === 1 ? [...p.eligible] : []]));
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
    const vote = view => view?.state.hand?.phase === 'runChoice' && !view.state.paused && waitingToVote(view.state, view.playerId);
    const choosing = vote(next);
    if (previous && ((next.legal && !previous.legal) || (choosing && !vote(previous)))) { buzz(); tableSound.play('turn'); }
    titleAlert(next.legal ? t('ui.011') : choosing ? t('ui.012') : null);
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
    if (message.type === 'state') { const restored = !connected && everConnected; connected = true; everConnected = true; retryAttempt = 0; loadError = ''; accept(message); if (restored && data.role === 'player') notice(t('ui.015', { p0: data.legal ? t('ui.013') : t('ui.014', { p0: player(data.state, data.playerId)?.name }) })); }
    else notice(localized(message));
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
    if (type === 'undo' && data.state.version < result.state.version) wasUndo = true;
    accept(result);
    if (result.notice) notice(localized(result.noticeMessage || result.notice));
    else if (type === 'act') notice({ check: t('ui.016'), call: t('ui.017'), fold: t('ui.018'), raise: t('ui.019', { p0: n(args.to) }), allin: t('ui.020') }[args.action]);
    else { const messages = notices(); if (messages[type]) notice(typeof messages[type] === 'function' ? messages[type](args) : messages[type]); }
  } catch (error) {
    tableSound.fail();
    notice(error.message);
    try { accept(await api(`/api/rooms/${code}`)); } catch { /* 重连会再次拉取 */ }
  } finally { busy = false; render(); }
}
const notices = () => ({ show: t('ui.021'), sitOut: a => a.away ? t('ui.022') : t('ui.023'), pause: a => a.on ? t('ui.024') : t('ui.025'), end: t('ui.026'), seat: t('ui.027'), level: t('ui.028'), settings: t('ui.029'), timeout: t('ui.030'), runVote: a => a.playerId ? t('ui.031') : t('ui.032', { p0: a.runs }), straddle: a => a.enabled ? t('ui.033') : t('ui.034') });
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
const handDetail = cards => localized(describeHandMessage(cards));
function equation(s) {
  const detail = t('ui.035', { p0: n(s.total), p1: n(s.total - potTotal(s)), p2: n(potTotal(s)) });
  return `<span class="pill eq" role="status" title="${detail}"><span class="ok-dot"></span>${t('ui.036')}<b class="num">${n(s.total)}</b><span class="eq-detail">${t('ui.037')}<span class="num">${n(s.total - potTotal(s))}</span>${t('ui.038')}<span class="num">${n(potTotal(s))}</span></span>${t('ui.039', { p0: s.balanceNote ? `<span class="balance-note">${esc(localized(s.balanceNoteMessage || s.balanceNote))}</span>` : '' })}</span>`;
}
const street = s => !s.hand ? t('ui.040') : s.hand.phase === 'runChoice' ? t('ui.041') : s.hand.phase === 'showdown' ? t('ui.042') : s.hand.phase === 'settled' ? t('ui.043') : localized(streetMessage(s.hand.street));
function languagePicker() {
  return `<label class="language-picker"><span class="sr-only">${t('language.label')}</span><select data-language aria-label="${t('language.label')}">${Object.entries(languages).map(([value, label]) => `<option value="${value}" ${value === getLanguage() ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
}
function muteButton() {
  const on = tableSound.isOn();
  return `<button type="button" class="iconbtn sound-toggle ${on ? '' : 'is-off'}" data-do="toggle-sound" aria-pressed="${on}" aria-label="${on ? t('ui.044') : t('ui.045')}" title="${on ? t('ui.046') : t('ui.047')}">${ICON.sound}</button>`;
}
function topbar(s) {
  return `<header class="topbar"><span class="seal" aria-hidden="true">${t('ui.008')}</span><div class="room"><b>${esc(s.config.name)}</b><span>${t('ui.061', { p0: digitalOf(s) ? t('ui.048') : t('ui.049') })}<span class="num">${blindsText()}</span>${s.config.actionClock ? t('ui.050', { p0: s.config.actionClock }) : ''}</span></div><div class="mid">${s.status === 'ended' ? `<span class="pill">${t('ui.051', { p0: ICON.flag, p1: esc(day(s.endedAt)) })}<span class="num">${esc(hhmm(s.endedAt))}</span></span>` : s.paused ? `<span class="pill pause-pill">${t('ui.052', { p0: ICON.pause })}<b class="num" data-since="${esc(s.paused.at)}">0:00</b></span>` : `<span class="pill">${t('ui.053')}<b class="num">${s.handNumber}</b>${t('ui.054', { p0: street(s) })}</span>`}${equation(s)}</div><div class="right">${s.status === 'ended' ? '' : `<a class="pill share-pill" href="${link('share')}" aria-label="${t('ui.055', { p0: code })}">${ICON.qr}<span>${t('ui.056')}</span><span class="code">${code}</span></a>`}${languagePicker()}${muteButton()}<a class="iconbtn" href="${link('recap')}" aria-label="${s.status === 'ended' ? t('ui.057') : t('ui.058')}" title="${s.status === 'ended' ? t('ui.059') : t('ui.060')}">${ICON.trophy}</a><a class="iconbtn" href="${link('hands')}" aria-label="${t('ui.062')}" title="${t('ui.063')}">${ICON.book}</a><a class="iconbtn" href="${link('log')}" aria-label="${t('ui.064')}" title="${t('ui.065')}">${ICON.list}</a></div></header>${connectionBanner()}`;
}
function blindsText() {
  const b = data.blinds || { small: data.state.config.smallBlind, big: data.state.config.bigBlind, ante: data.state.config.ante };
  const s = data.state, anteMode = ongoing(s) ? s.hand.anteMode : s.config.anteMode;
  return `${n(b.small)} / ${n(b.big)}${b.ante ? ` · ${anteMode === 'bigBlind' ? t('ui.066') : t('ui.067')} ${n(b.ante)}` : ''}`;
}
const options = (values, current, label) => values.map(v => `<option value="${v}" ${v === current ? 'selected' : ''}>${label(v)}</option>`).join('');
const ruleFields = c => `<label>${t('ui.071')}<select name="runouts">${options([1, 2, 3], c.runouts ?? 3, v => t('ui.068', { p0: v }))}</select></label>
<label>${t('ui.072')}<select name="anteMode">${options(['each', 'bigBlind'], c.anteMode || 'each', v => v === 'bigBlind' ? t('ui.069') : t('ui.070'))}</select></label>
<label class="switch-row rules-switch"><span><b>${t('ui.073')}</b><span>${t('ui.074')}</span></span><input name="straddle" type="checkbox" aria-label="${t('ui.075')}" ${c.straddle ? 'checked' : ''}></label>`;
const ruleSettings = fields => ({ runouts: Number(fields.get('runouts')), anteMode: fields.get('anteMode'), straddle: fields.has('straddle') });
function home() {
  if (!network) return loadingPage();
  if (!network.local) return joinLookup();
  const addr = network.addresses[0];
  const still = `<div class="still" aria-hidden="true">${playingCard('Kh', { size: 'is-still c1', flipped: true })}${playingCard('As', { size: 'is-still c2', flipped: true })}${playingCard(null, { size: 'is-still c3' })}<div class="still-chips">${chipStackHtml(6000, false, { width: 46 })}${chipStackHtml(2400, false, { width: 46 })}${chipStackHtml(800, false, { width: 46 })}</div></div>`;
  return `<main class="create"><div class="vignette" aria-hidden="true"></div>${still}<div class="c-top"><span class="seal">${t('ui.008')}</span><span class="wordmark">${t('ui.086')}</span>${languagePicker()}<span class="ver">${t('ui.087')}</span></div>
<section class="hero-l"><div class="eyebrow"><i></i>${t('ui.088')}</div><h1>${t('ui.086')}</h1><p class="sub">${t('ui.089')}</p><p class="lead">${t('ui.090')}</p>
${addr ? `<a class="pill lan" href="${esc(addr)}/join">${ICON.wifi}<span>${t('ui.077')}</span><b class="num">${esc(addr.replace(/^https?:\/\//, ''))}</b></a>${network.addresses.length > 1 ? `<details class="more-addr"><summary>${t('ui.076')}</summary>${network.addresses.slice(1).map(a => `<p class="mono">${esc(a)}</p>`).join('')}</details>` : ''}` : `<p class="pill lan">${t('ui.078')}</p>`}
${openRooms(network.rooms)}${historyRooms(network.rooms)}<a class="join-link" href="/join">${t('ui.010')}</a></section>
<form id="create-form" class="panel create-panel"><h2>${t('ui.091')}</h2><p class="lead">${t('ui.092')}</p>
<fieldset class="field modes"><legend>${t('ui.093')}</legend>
<label class="mode"><input type="radio" name="dealMode" value="digital" aria-label="${t('ui.048')}" checked><i class="tick">${ICON.check}</i><span class="art art-digital" aria-hidden="true"><i class="a1">${playingCard(null, { size: 'is-tiny' })}</i><i class="a2">${playingCard('Ah', { size: 'is-tiny', flipped: true })}</i><i class="a3">${ICON.lock}</i></span><b>${t('ui.048')}</b><span>${t('ui.094')}</span></label>
<label class="mode"><input type="radio" name="dealMode" value="physical" aria-label="${t('ui.049')}"><i class="tick">${ICON.check}</i><span class="art" aria-hidden="true">${chipStackHtml(725, false, { width: 32 })}</span><b>${t('ui.049')}</b><span>${t('ui.095')}</span></label></fieldset>
<div class="field"><label for="room-name">${t('ui.096')}</label><input id="room-name" name="name" value="${t('ui.097')}" maxlength="16" required></div>
<div class="field"><div class="l">${t('ui.098')}<em>${t('ui.099')}</em></div><div class="row2">${['smallBlind', 'bigBlind'].map((k, i) => `<div class="stepper"><label for="${k}" class="k">${i ? t('ui.079') : t('ui.080')}</label><button type="button" class="s" data-do="field-step" data-field="${k}" data-step="-1" aria-label="${t('ui.081', { p0: i ? t('ui.079') : t('ui.080') })}">${ICON.minus}</button><input id="${k}" class="num" name="${k}" type="number" min="1" step="1" value="${i ? 20 : 10}" required><button type="button" class="s" data-do="field-step" data-field="${k}" data-step="1" aria-label="${t('ui.082', { p0: i ? t('ui.079') : t('ui.080') })}">${ICON.plus}</button></div>`).join('')}</div></div>
<div class="field"><div class="l"><label for="startingStack">${t('ui.100')}</label><em id="bb-hint">${t('ui.bigBlindHint', { amount: 100 })}</em></div><div class="stackrow"><input id="startingStack" class="num" name="startingStack" aria-label="${t('ui.100')}" type="number" min="1" step="1" value="2000" required><div class="seg" role="group" aria-label="${t('ui.101')}">${[50, 100, 200].map(bb => `<button type="button" data-do="stack-preset" data-bb="${bb}">${t('ui.bigBlindUnits', { amount: bb })}</button>`).join('')}</div></div></div>
<label class="switch-row"><span><b>${t('ui.102')}</b><span>${t('ui.103')}</span></span><input name="rebuy" type="checkbox"></label>
<details class="more-set"><summary>${t('ui.104')}</summary><div class="settings-grid"><label>${t('ui.105')}<input name="ante" class="num" type="number" min="0" step="1" value="0" aria-label="${t('ui.105')}"></label><label>${t('ui.106')}<select name="levelEvery" aria-label="${t('ui.106')}">${options(LEVEL_OPTIONS, 0, v => v ? t('ui.083', { p0: v }) : t('ui.084'))}</select></label><label>${t('ui.107')}<select name="actionClock" aria-label="${t('ui.107')}">${options([0, 20, 30, 45, 60, 90], 0, v => v ? t('ui.085', { p0: v }) : t('ui.084'))}</select></label>${ruleFields({})}</div><p class="fine left">${t('ui.108')}</p></details>
<p class="error" id="create-error" role="status"></p><button class="btn btn-amber go" type="submit">${t('ui.109')}</button><p class="fine">${t('ui.110')}</p></form></main>`;
}
function openRooms(rooms) {
  const open = rooms.filter(r => r.status !== 'ended').slice(0, 3);
  if (!open.length) return '';
  return `<div class="restore-list">${open.map(r => { const mine = localStorage.getItem(`night-table.host.${r.code}`); return `<div class="restore-row"><a class="pill" href="/table?room=${r.code}"><b>${esc(localized(r.nameMessage || r.name))}</b><span class="num">${r.code}</span><span>${mine ? t('ui.111') : t('ui.112')}</span></a>${mine ? '' : `<button class="link-btn" data-do="reclaim" data-code="${r.code}">${t('ui.113')}</button>`}</div>`; }).join('')}</div>`;
}
function historyRooms(rooms) {
  const ended = rooms.filter(r => r.status === 'ended').slice(0, 4);
  if (!ended.length) return '';
  return `<section class="history" aria-label="${t('ui.115')}"><h3>${t('ui.115')}</h3>${ended.map(r => `<a class="hist-row" href="/recap?room=${r.code}"><span class="seal" aria-hidden="true">${t('ui.008')}</span><span class="t"><b>${esc(localized(r.nameMessage || r.name))}</b><small>${t('ui.114', { p0: esc(day(r.endedAt)), p1: r.hands, p2: r.players, p3: r.mode === 'digital' ? t('ui.048') : t('ui.049') })}</small></span><span class="num code">${r.code}</span></a>`).join('')}</section>`;
}
function joinLookup() {
  return `<main class="phone-app join-app"><header class="p-head"><span class="seal">${t('ui.008')}</span><div class="t"><b>${t('ui.086')}</b><span>${t('ui.117')}</span></div>${languagePicker()}${muteButton()}</header><div class="j-wrap"><div class="eyebrow">${t('ui.118')}</div><h1>${t('ui.119')}</h1></div><form id="lookup-form" class="sheet j-form"><label>${t('ui.120')}<input name="code" class="num code-input" maxlength="4" pattern="[A-Za-z2-9]{4}" autocomplete="off" autocapitalize="characters" value="${esc(code)}" placeholder="${t('ui.121')}" required></label><p class="error" id="lookup-error"></p><button class="btn btn-amber btn-block" type="submit">${t('ui.122')}</button>${(() => { const last = lastRoom(); return last && last.code !== code ? `<a class="btn btn-ghost btn-block last-room" href="/${last.page}?room=${last.code}">${t('ui.116')}<span class="num">${last.code}</span></a>` : ''; })()}<p class="fine">${t('ui.123')}</p></form></main>`;
}
function miniSeats(s, picker) {
  const count = 10, slots = SLOTS[10];
  return Array.from({ length: count }, (_, i) => {
    const seat = i + 1, p = s.players.find(q => q.seat === seat), [cx, cy] = slots[i];
    const style = `style="--cx:${cx};--cy:${cy}"`;
    if (p) return `<div class="ms is-taken" ${style}>${avatar(p)}<em>${esc(p.name)}</em></div>`;
    if (!picker) return `<div class="ms is-free" ${style}><i class="dot num">${seat}</i></div>`;
    const on = seatChoice === seat;
    return `<button type="button" class="ms is-free seat-choice ${on ? 'is-on' : ''}" ${style} data-do="seat-choice" data-seat="${seat}" aria-pressed="${on}" aria-label="${t('ui.129', { p0: seat, p1: on ? t('ui.124') : t('ui.125') })}"><i class="dot num">${on ? t('ui.126') : seat}</i><em>${on ? t('ui.127', { p0: seat }) : t('ui.128', { p0: seat })}</em></button>`;
  }).join('');
}
function claimSection(s) {
  const people = Object.values(s.roster || {}).sort((a, b) => a.seat - b.seat);
  if (!people.length) return '';
  return `<details class="claim-box" ${claimPick ? 'open' : ''}><summary>${t('ui.134')}</summary><p class="fine left">${t('ui.135')}</p><div class="claim-list" role="group" aria-label="${t('ui.136')}">${people.map(r => `<button type="button" class="claim-who ${claimPick === r.id ? 'is-on' : ''}" data-do="claim-pick" data-id="${esc(r.id)}" aria-pressed="${claimPick === r.id}">${avatar(r)}<span>${esc(r.name)}</span><small>${r.seated ? t('ui.130', { p0: r.seat }) : t('ui.131')}</small></button>`).join('')}</div>${btn(claimPick ? t('ui.132', { p0: esc(s.roster[claimPick]?.name) }) : t('ui.133'), 'claim-submit', 'ghost', !claimPick || !connected)}</details>`;
}
function claimWait(s) {
  const c = data.claim;
  return `<main class="phone-app join-app"><header class="p-head"><span class="seal">${t('ui.008')}</span><div class="t"><b>${t('ui.086')}</b><span>${t('ui.138')}<span class="num">${code}</span></span></div>${languagePicker()}${muteButton()}</header>${connectionBanner()}<div class="j-wrap claim-wait"><div class="eyebrow">${t('ui.139')}</div><h1>${t('ui.140', { p0: esc(c.name) })}</h1><p class="lead">${t('ui.141')}</p><div class="claim-spinner" aria-hidden="true"><span class="seal">${t('ui.008')}</span></div></div><div class="sheet j-form">${btn(t('ui.137'), 'claim-reset', 'ghost')}</div></main>`;
}
function endedJoin(s) {
  const next = s.nextRoom;
  return `<main class="phone-app join-app"><header class="p-head"><span class="seal">${t('ui.008')}</span><div class="t"><b>${esc(s.config.name)}</b><span>${t('ui.144', { p0: s.handNumber })}</span></div>${languagePicker()}${muteButton()}</header><div class="j-wrap"><div class="eyebrow">${t('ui.145')}</div><h1>${esc(s.config.name)}</h1><p class="lead">${t('ui.146', { p0: next ? t('ui.142') : '' })}</p></div><div class="sheet j-form">${next ? `<a class="btn btn-amber btn-block" href="/join?room=${next}">${t('ui.143', { p0: next })}</a>` : ''}<a class="btn btn-${next ? 'ghost' : 'amber'} btn-block" href="${link('recap')}">${t('ui.147')}</a></div></main>`;
}
function join(s) {
  if (s.status === 'ended') return endedJoin(s);
  if (data.claim?.status === 'pending') return claimWait(s);
  const back = data.role === 'departed' ? s.roster?.[data.playerId] : null;
  const free = Array.from({ length: 10 }, (_, i) => i + 1).filter(seat => !s.players.some(p => p.seat === seat));
  if (!free.includes(seatChoice)) seatChoice = free[0] || 0;
  return `<main class="phone-app join-app"><header class="p-head"><span class="seal">${t('ui.008')}</span><div class="t"><b>${t('ui.086')}</b><span>${t('ui.138')}<span class="num">${code}</span></span></div>${languagePicker()}${muteButton()}</header>${connectionBanner()}<div class="j-wrap"><div class="eyebrow">${t('ui.152')}</div><h1>${esc(s.config.name)}</h1><div class="meta"><span class="pill">${digitalOf(s) ? t('ui.048') : t('ui.049')}</span><span class="pill">${t('ui.153')}<b class="num">${n(s.config.smallBlind)} / ${n(s.config.bigBlind)}</b></span><span class="pill">${t('ui.154')}<b class="num">${n(s.config.startingStack)}</b></span></div>
<div class="mini" role="group" aria-label="${t('ui.155')}"><div class="mini-table"><span>${t('ui.086')}</span></div>${miniSeats(s, true)}</div></div>
<form id="join-form" class="sheet j-form">${data.claim?.status === 'denied' ? `<p class="error">${t('ui.148')}</p>` : ''}${back ? `<p class="fine left">${t('ui.149', { p0: esc(back.name), p1: n(back.cashOut), p2: n(s.config.startingStack) })}</p>` : ''}<label for="join-name">${t('ui.156')}</label><input id="join-name" name="name" maxlength="8" required autocomplete="nickname" aria-label="${t('ui.156')}" aria-describedby="name-hint" value="${esc(back?.name || params.get('name') || '')}"><p class="fine left" id="name-hint">${t('ui.157', { p0: n(s.config.startingStack) })}</p><p class="error" id="join-error" role="status"></p><button class="btn btn-amber btn-block" type="submit" ${!seatChoice || !connected ? 'disabled' : ''}>${seatChoice ? t('ui.150', { p0: seatChoice }) : t('ui.151')}</button><p class="fine">${t('ui.158')}</p>${back ? '' : claimSection(s)}</form></main>`;
}
function share(s) {
  return `${topbar(s)}<main class="sharepage"><section class="share-l"><div class="eyebrow"><i></i>${t('ui.167')}</div><h1>${esc(s.config.name)}</h1><p class="lead">${t('ui.168')}</p>
<ul class="rules">${[[t('ui.093'), digitalOf(s) ? t('ui.048') : t('ui.049')], [t('ui.098'), `${n(s.config.smallBlind)} / ${n(s.config.bigBlind)}`], [t('ui.100'), n(s.config.startingStack)], [t('ui.159'), s.config.rebuy ? t('ui.160') : t('ui.084')], [t('ui.161'), `${s.players.length} / 10`]].map(([k, v]) => `<li><span>${k}</span><b class="num">${v}</b></li>`).join('')}</ul>
<div class="seated">${s.players.length ? s.players.map(p => `<span class="who">${avatar(p)}<em>${esc(p.name)}</em></span>`).join('') : `<p class="muted">${t('ui.162')}</p>`}</div><p class="muted">${t('ui.169')}</p>
<div class="share-actions">${nav(data.role === 'host' ? t('ui.163') : t('ui.164'), 'table', 'amber')}${data.role === 'host' ? btn(t('ui.165'), 'transfer') : nav(t('ui.166'), 'join')}</div></section>
<section class="qrbox">${data.joinUrl ? `<div class="qr-paper"><img src="/api/rooms/${code}/qr.svg" alt="${esc(data.joinUrl)}"></div><p class="cap">${t('ui.056')}</p>` : `<p class="muted">${t('ui.078')}</p>`}<p class="code-xl num">${code}</p>${data.joinUrl ? `<p class="addr mono"><a href="${esc(data.joinUrl)}">${esc(data.joinUrl)}</a></p>` : ''}</section><p class="legal-note">${t('ui.170')}</p></main>`;
}
function seatStatus(s, p) {
  if (p.waiting) return p.sittingOut ? t('ui.171') : t('ui.172');
  if (!p.inHand || s.hand?.phase === 'settled') return p.sittingOut ? t('ui.171') : p.stack === 0 ? t('ui.173') : data.online.includes(p.id) ? t('ui.174') : t('ui.175');
  if (p.folded) return t('ui.176');
  if (s.hand.phase === 'runChoice') return runVoteOf(s, p.id) ? runChoiceLabel(runVoteOf(s, p.id)) : t('ui.178');
  if (!p.stack) return t('ui.179');
  if (!data.online.includes(p.id)) return t('ui.175');
  return s.hand.actor === p.id ? t('ui.180') : t('ui.174');
}
const runRule = () => t('ui.181');
const explainRunRule = s => `${runRule()}${runMaxOf(s) > 2 ? t('ui.182') : ''}`;
function runVoteStatus(s) {
  const voters = runVoters(s), voted = voters.filter(p => runVoteOf(s, p.id)), pending = voters.filter(p => !runVoteOf(s, p.id));
  return `<div class="run-vote-status" role="status"><p><b>${t('ui.186')}</b> ${voted.map(p => t('ui.183', { p0: esc(p.name), p1: runVoteOf(s, p.id) })).join(listSeparator()) || t('ui.184')}</p><p><b>${t('ui.174')}</b> ${pending.map(p => esc(p.name)).join(listSeparator()) || t('ui.185')}</p></div>`;
}
function runVoteButtons(s, action, id = '') {
  const value = runVoteOf(s, id);
  return `<div class="run-vote-buttons" role="group" aria-label="${t('ui.041')}">${Array.from({ length: runMaxOf(s) }, (_, i) => {
    const runs = i + 1, proxy = action === 'run-proxy-submit';
    return btn(`${proxy ? t('ui.187') : ''}${runChoiceLabel(runs)}`, action, runs === value ? 'amber' : 'paper', !connected || !!s.paused || !!value,
      `data-runs="${runs}" ${proxy ? `data-id="${esc(id)}"` : `aria-pressed="${runs === value}"`}`);
  }).join('')}</div>`;
}
function runChoiceHost(s) {
  if (data.role !== 'host') return runVoteStatus(s);
  const proxies = runVoters(s).filter(p => !runVoteOf(s, p.id) && !data.online.includes(p.id));
  return `${runVoteStatus(s)}<div class="run-host-actions">${btn(t('ui.189'), 'run-once', 'brass', !connected || !!s.paused)}${proxies.map(p => btn(t('ui.190', { p0: esc(p.name) }), 'run-proxy', 'ghost', !connected || !!s.paused, `data-id="${esc(p.id)}"`)).join('')}</div>`;
}
function runChoicePhone(s, p) {
  const eligible = runVoters(s).some(q => q.id === p.id), selected = runVoteOf(s, p.id);
  return `<section class="sheet run-choice" data-testid="run-choice" aria-labelledby="run-choice-title">
<h1 id="run-choice-title">${t('ui.194')}</h1><p class="run-choice-rule">${explainRunRule(s)}</p>
${eligible ? runVoteButtons(s, 'run-vote', p.id) : ''}
${selected ? `<p class="run-choice-rule">${t('ui.191', { p0: selected })}</p>` : eligible ? '' : `<p class="run-choice-rule">${t('ui.192')}</p>`}
${s.paused ? `<p class="run-choice-rule">${t('ui.193')}</p>` : ''}
${runVoteStatus(s)}${phoneNav(s, p)}</section>`;
}
function turnInfo(s) {
  if (s.paused) return [t('ui.195'), t('ui.196')];
  if (!s.hand) return [s.players.length < 2 ? t('ui.040') : t('ui.197'), s.players.length < 2 ? t('ui.198') : t('ui.199')];
  if (s.hand.phase === 'settled') return [t('ui.043'), t('ui.200')];
  if (s.hand.phase === 'runChoice') return [t('ui.194'), explainRunRule(s)];
  if (s.hand.phase === 'showdown') return digitalOf(s) && s.hand.autoJudged ? [t('ui.201'), t('ui.202')] : [t('ui.203'), t('ui.204')];
  if (s.hand.phase === 'roundEnd') return digitalOf(s) ? [t('ui.205'), t('ui.206')] : [t('ui.207'), t('ui.208')];
  const p = player(s, s.hand.actor), l = legalActions(s, p?.id);
  if (!p || !l) return [t('ui.209'), ''];
  if (!data.online.includes(p.id)) return [t('ui.210', { p0: p.name }), t('ui.211')];
  return [t('ui.212', { p0: p.name }), capability(l, p)];
}
function capability(l, p) {
  if (l.call >= p.stack) return t('ui.215', { p0: l.call === p.stack ? t('ui.213') : t('ui.214'), p1: n(p.stack) });
  if (!l.call) return l.raise ? t('ui.216') : t('ui.217');
  return t('ui.221', { p0: n(l.call), p1: l.raise ? t('ui.218') : l.allIn ? t('ui.219') : t('ui.220') });
}
// 摊牌与分池时，赢家、牌型和「+N」由公开信息（亮出的牌、分池预览）得出。
function showdownFx(s) {
  const h = s.hand;
  if (!h || h.phase !== 'showdown') return {};
  const preview = h.preview || localPreview(s);
  const awards = preview?.awards || {};
  const winners = new Set(Object.entries(awards).filter(([, v]) => v > 0).map(([id]) => id));
  const marks = {};
  const mainWinner = (h.selections?.[settlementPots(data)[0]?.id] || [])[0];
  if (digitalOf(s) && mainWinner && h.revealed?.[mainWinner] && h.board?.length === 5) {
    const best = new Set(evaluate([...h.revealed[mainWinner], ...h.board]).cards);
    for (const c of h.board) marks[c] = best.has(c) ? 'is-best' : 'is-dim';
  }
  return { awards, winners, marks };
}
function shownCard(s, p, card, index) {
  const delay = tableReveal?.number === s.hand.number ? tableReveal.delays.get(p.id) : undefined;
  const start = delay === undefined ? -Infinity : tableReveal.at + delay + 40 * index - Date.now();
  return playingCard(card, { size: 'is-show', flipped: true, extra: start > -360 ? `style="--show-delay:${start}ms" data-show-order="${s.hand.showOrder?.indexOf(p.id) ?? -1}"` : '' });
}
function seatCard(s, p, i, count, fx = {}) {
  const [cx, cy] = (SLOTS[count] || SLOTS[10])[i] || [0, 0];
  const status = seatStatus(s, p), h = s.hand, digital = digitalOf(s);
  const revealed = h?.revealed?.[p.id];
  const holes = digital && h?.holeDealt && p.inHand && (!p.folded || revealed) ? `<div class="seat-holes">${revealed ? revealed.map((c, j) => shownCard(s, p, c, j)).join('') : `${playingCard(null, { size: 'is-seat' })}${playingCard(null, { size: 'is-seat' })}`}</div>` : '';
  const handLabel = h?.runs > 1 ? '' : revealed && h?.board?.length ? handDetail([...revealed, ...h.board]) : localized(h?.handNamesMessage?.[p.id] || h?.handNames?.[p.id]);
  const acting = h?.actor === p.id && h?.phase === 'betting';
  const deadline = acting ? deadlineOf(s) : 0;
  const strip = handLabel ? `<span class="hand-name">${esc(handLabel)}</span>` : deadline ? `${t('ui.222')}<span class="num" data-countdown="${deadline}">${secondsLeft(deadline)}</span>${t('ui.223')}` : `${status}${p.bet && h?.phase !== 'settled' ? `${t('ui.224')}<span class="num">${n(p.bet)}</span>` : ''}`;
  const award = fx.awards?.[p.id];
  const cls = [acting && 'is-acting', status === t('ui.176') && 'is-fold', status === t('ui.179') && 'is-allin', status === t('ui.171') && 'is-away', !data.online.includes(p.id) && 'is-off', revealed && 'is-show', fx.winners?.has(p.id) && 'is-win', handLabel && 'has-hand'].filter(Boolean).join(' ');
  return `<article class="seat ${cls}" style="--cx:${cx};--cy:${cy}" data-seat-id="${p.id}" title="${t('ui.130', { p0: p.seat })}">${holes}${acting ? `<i class="ring ${deadline ? 'has-clock' : ''}" aria-hidden="true" ${deadline ? `data-deadline="${deadline}" data-total="${s.config.actionClock * 1000}"` : ''}></i>` : ''}${avatar(p)}<span class="marks">${h?.dealer === p.id ? `<span class="mark mark-d" title="${t('ui.225')}">${t('ui.226')}</span>` : ''}${h?.small === p.id ? `<span class="mark mark-sb" title="${t('ui.080')}">${t('ui.227')}</span>` : ''}${h?.big === p.id ? `<span class="mark mark-bb" title="${t('ui.079')}">${t('ui.228')}</span>` : ''}${h?.straddle === p.id ? `<span class="mark mark-straddle" title="${t('ui.straddleTitle')}">${t('ui.straddleMarker')}</span>` : ''}</span><div class="plate"><span class="name">${esc(p.name)}</span><span class="stk num">${status === t('ui.179') && p.stack === 0 ? `<span class="allin">${t('ui.179')}</span>` : n(p.stack)}</span><span class="strip">${strip}</span></div>${award ? `<span class="delta num">+${n(award)}</span>` : ''}</article>`;
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
  if (!p.bet || !s.hand || !['betting', 'roundEnd'].includes(s.hand.phase)) return '';
  const [cx, cy] = (SLOTS[count] || SLOTS[10])[i] || [0, 0];
  const row = Math.abs(cy) > 0.9, bx = cx * (row ? 0.82 : 0.66), by = cy * (row ? 0.64 : 0.6);
  return `<div class="bet ${cx > 0.05 ? 'is-rev' : ''}" style="--cx:${bx};--cy:${by}" aria-hidden="true">${chipStackHtml(p.bet, false, { width: 28 })}<span class="v num">${n(p.bet)}</span></div>`;
}
function transcript(s, hand = s.handNumber) {
  const entries = s.logs.filter(e => hand === 'all' || e.hand === Number(hand));
  return `<ol class="transcript">${entries.length ? entries.map((e, i) => `<li class="${i === entries.length - 1 ? 'is-last' : ''}"><time datetime="${e.at}" class="num">${new Date(e.at).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit', hour12: false })}</time><div class="what">${esc(localized(e))}</div></li>`).join('') : `<li>${t('ui.229')}</li>`}</ol>`;
}
function ticker(s) {
  const entries = s.logs.filter(e => e.hand === s.handNumber).slice(-3);
  return `<a class="ticker" href="${link('log')}" aria-label="${t('ui.064')}">${entries.map(e => `<span class="row"><time class="num">${new Date(e.at).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit', hour12: false })}</time><span>${esc(localized(e))}</span></span>`).join('')}</a>`;
}
function undoButton() { return data.role === 'host' ? btn(t('ui.230', { p0: data.lastUndo ? `<small>${esc(localized(data.lastUndoMessage || data.lastUndo))}</small>` : '' }), 'undo', 'clay', !data.lastUndo || !connected) : ''; }
function hostbar(s) {
  if (data.role !== 'host') return `<footer class="spectatorbar glass"><span class="muted">${data.role === 'player' ? t('ui.231') : t('ui.232')}</span>${nav(data.role === 'player' ? t('ui.233') : t('ui.166'), data.role === 'player' ? 'play' : 'join', 'amber')}</footer>`;
  const active = ongoing(s), enough = !!nextPositions(s), choosing = s.hand?.phase === 'runChoice';
  const canStart = !active && enough && connected && !potLock, canNext = s.hand?.phase === 'roundEnd' && connected, canSplit = s.hand?.phase === 'showdown' && connected;
  const startHint = active ? t('ui.234') : potLock ? t('ui.235') : enough ? t('ui.236') : t('ui.237');
  const nextHint = choosing ? t('ui.238') : s.hand?.phase === 'betting' ? t('ui.239') : s.hand?.phase === 'roundEnd' ? (digitalOf(s) ? t('ui.240') : t('ui.241')) : t('ui.242');
  const splitHint = s.hand?.phase === 'showdown' ? (digitalOf(s) && s.hand.autoJudged ? t('ui.243') : t('ui.244')) : t('ui.245');
  const flow = (label, action, ok, hint, icon) => `<button class="btn has-icon ${ok ? 'btn-amber' : 'btn-ghost'}" data-do="${action}" title="${hint}" ${!ok || busy ? 'disabled' : ''}>${icon}<span>${label}</span><span class="sr-only">${hint}</span></button>`;
  const undoLabel = data.lastUndo ? t('ui.246', { p0: localized(data.lastUndoMessage || data.lastUndo) }) : t('ui.247');
  const quiet = (label, action, ok, hint, icon, extraCls = '') => `<button class="btn btn-quiet has-icon ${extraCls}" data-do="${action}" title="${esc(hint)}" ${!ok || busy ? 'disabled' : ''}>${icon}<span>${label}</span></button>`;
  return `<footer class="hostbar">${ticker(s)}<nav class="dock glass" aria-label="${t('ui.265')}">${flow(t('ui.248'), 'start', canStart && !s.paused, s.paused ? t('ui.249') : startHint, ICON.play)}${flow(t('ui.250'), 'next', canNext && !s.paused, s.paused ? t('ui.249') : nextHint, ICON.next)}${flow(t('ui.251'), 'settlement', canSplit, splitHint, ICON.split)}<i class="sep"></i>${quiet(t('ui.252'), 'undo', !!data.lastUndo && connected, undoLabel, ICON.undo)}${quiet(t('ui.253'), 'manage', !active, active ? t('ui.254') : t('ui.255'), ICON.seats)}${quiet(s.paused ? t('ui.256') : t('ui.257'), s.paused ? 'resume' : 'pause', connected, s.paused ? t('ui.258') : t('ui.259'), s.paused ? ICON.play : ICON.pause, s.paused ? 'is-lit' : '')}${quiet(t('ui.260'), 'end', !active && connected && !potLock, active ? t('ui.261') : t('ui.262'), ICON.flag)}</nav><div class="ledger">${t('ui.266')}<br><b>${s.paused ? t('ui.263') : choosing ? t('ui.264') : t('ui.231')}</b></div></footer>`;
}
function streetSteps(s) {
  const h = s.hand, steps = [...STREETS.map((_, i) => localized(streetMessage(i))), t('ui.042')];
  const at = !h ? -1 : h.phase === 'showdown' || (h.phase === 'settled' && digitalOf(s)) ? 4 : h.street;
  return `<div class="street" aria-hidden="true">${steps.map((name, i) => (i === 4 && at !== 4) ? '' : `${i ? '<i></i>' : ''}<span class="${i === at ? 'on' : i < at ? 'done' : ''}">${name}</span>`).join('')}</div>`;
}
function potArea(s) {
  const bets = s.players.reduce((sum, p) => sum + (p.bet || 0), 0);
  const actor = player(s, s.hand?.actor), legal = legalActions(s, actor?.id);
  const afterCall = actor && legal ? actor.contribution - (actor.id === s.hand.big ? s.hand.bigBlindAnte || 0 : 0) + Math.min(legal.call, actor.stack) : 0;
  const joinsOnCall = p => !!legal && !p.eligible.includes(actor.id) && afterCall >= p.cap;
  if (data.pots.length > 1 && s.hand?.phase === 'betting') {
    const joins = data.pots.some(joinsOnCall);
    return `<div class="pot" id="table-pot">${chipStackHtml(potTotal(s), false, { width: 26 })}<span class="lbl">${t('ui.269')}</span><span class="amt num">${n(potTotal(s))}</span>${bets ? `<span class="sub">${t('ui.267')}<span class="num">${n(bets)}</span></span>` : ''}</div><p class="note pot-split">${t('ui.270', { p0: data.pots.map(p => `${esc(potName(p))} <b class="num">${n(p.amount)}</b>`).join(' · '), p1: joins ? t('ui.268', { p0: esc(actor.name) }) : '' })}</p>`;
  }
  if (data.pots.length <= 1 || s.hand?.runs > 1 || s.hand?.phase === 'runChoice') return `<div class="pot" id="table-pot">${chipStackHtml(potTotal(s), false, { width: 26 })}<span class="lbl">${t('ui.269')}</span><span class="amt num">${n(potTotal(s))}</span>${bets && s.hand?.phase === 'betting' ? `<span class="sub">${t('ui.267')}<span class="num">${n(bets)}</span></span>` : ''}</div>`;
  return `<div class="pots" id="table-pot">${data.pots.map((p, i) => { const win = s.hand?.phase === 'showdown' ? (selections[p.id] || s.hand.selections?.[p.id] || []) : []; return `<div class="potcard ${i === 0 ? 'is-main' : ''} ${p.forming ? 'is-forming' : ''}" id="pot-${p.id}">${chipStackHtml(p.amount, false, { width: 24 })}<div><div class="k">${esc(potName(p))}${p.forming ? t('ui.271') : ''}</div><div class="a num">${n(p.amount)}</div></div><span class="to">${win.length ? `→ ${win.map(id => esc(player(s, id)?.name)).join(listSeparator())}` : esc(p.eligible.map(id => player(s, id)?.name).join(' · ') || t('ui.272'))}</span>${joinsOnCall(p) ? `<small>${t('ui.273', { p0: esc(actor.name) })}</small>` : ''}</div>`; }).join('')}</div>`;
}
const reviewClass = s => s.hand?.runs > 1 || s.hand?.phase === 'runChoice' ? 'is-review' : '';
function runAwardRows(s, details) {
  return `<ul class="run-awards">${details.map(d => {
    const winners = d.winners || [];
    return `<li id="pot-${esc(d.id)}"><span>${esc(potName(d))} <b class="num">${n(d.amount)}</b>${d.runOdd ? ` <small>${t('ui.274')}</small>` : ''}</span><span>${winners.length ? winners.map(id => `${esc(seatName(s, id))}${d.shares ? ` <b class="num">+${n(d.shares[id])}</b>${d.oddRecipients?.includes(id) ? ` <small>${t('ui.275')}</small>` : ''}` : ''}`).join(' · ') : t('ui.276')}</span></li>`;
  }).join('')}</ul>`;
}
function runBoards(s, me = null) {
  const h = s.hand, digital = h.holeDealt;
  const details = h.preview?.details || settlementPots(data).map(pot => ({ ...pot, winners: (data.role === 'host' ? selections : h.selections)?.[pot.id] }));
  return `<div class="run-boards" aria-label="${t('ui.278')}">${Array.from({ length: h.runs }, (_, i) => {
    const run = i + 1, board = h.boards?.[i] || (i === 0 ? h.board : []) || [];
    const runDetails = details.filter(d => d.run === run), winners = new Set(runDetails.flatMap(d => d.winners || []));
    const names = Object.entries(h.boardHandNames?.[i] || {}).filter(([id]) => !me || (id !== me.id && winners.has(id)));
    const mine = digital && me && data.hole ? handDetail([...data.hole, ...board]) : '';
    return `<section class="run-board" data-run-board="${run}" aria-label="${runName(run)}"><h2>${runName(run)}</h2>${digital ? boardSlots(board, { size: 'is-mini' }) : ''}${mine ? `<p class="run-my-hand">${t('ui.277', { p0: esc(mine) })}</p>` : ''}${names.length ? `<ul class="run-hand-names">${names.map(([id, name]) => `<li>${esc(seatName(s, id))} · ${esc(localized(h.boardHandNamesMessage?.[i]?.[id] || name))}</li>`).join('')}</ul>` : ''}${runAwardRows(s, runDetails)}</section>`;
  }).join('')}</div>`;
}
function arena(s, fx = {}) {
  const seated = ordered(s).filter(p => !p.waiting), waiting = s.players.filter(p => p.waiting), [title, subtitle] = turnInfo(s);
  const h = s.hand, digital = digitalOf(s), choosing = h?.phase === 'runChoice';
  const board = h?.runs > 1 ? runBoards(s) : digital && h ? boardSlots(h.board || [], { marks: fx.marks || {} }) : '';
  return `<section class="arena ${reviewClass(s)} ${seated.length > 7 ? 'crowded' : ''} ${digital ? 'is-digital' : 'is-physical'}"><div class="rail" aria-hidden="true"></div><div class="felt" aria-hidden="true"><i class="line"></i><span class="brand">${t('ui.284')}</span></div>
<div class="center">${streetSteps(s)}${s.paused ? pauseCard(s) : `<div class="callout">${fx.quietTitle ? `<p class="turn">${esc(title)}</p>` : `<h1 class="turn" aria-live="polite">${esc(title)}</h1>`}<p class="turn-sub">${esc(subtitle)}</p>${data.role === 'host' && timeoutReady(s) ? timeoutButton(s) : ''}</div>`}${choosing ? runChoiceHost(s) : h?.runResolved ? `<p class="run-count">${runResultLabel(s)}</p>` : ''}${board}${h ? potArea(s) : `<div class="pot" id="table-pot"><span class="lbl">${t('ui.279')}</span><span class="amt num">${n(s.total)}</span></div>`}${h?.phase === 'betting' && h.shortAllIn ? `<p class="note">${t('ui.280')}</p>` : ''}${!choosing && h?.runs <= 1 && h?.participants.length === 2 ? `<p class="note">${t('ui.281')}</p>` : ''}${!seated.length ? nav(t('ui.282'), 'share', 'amber') : ''}</div>
${seated.map((p, i) => seatCard(s, p, i, seated.length, fx)).join('')}${seated.map((p, i) => betChip(s, p, i, seated.length)).join('')}${waiting.length ? `<div class="waiting-strip">${waiting.map(p => `<span class="pill">${t('ui.283', { p0: esc(p.name) })}</span>`).join('')}</div>` : ''}</section>`;
}
function pauseCard(s) {
  return `<div class="pause-card glass" role="status"><span class="eyebrow">${t('ui.285', { p0: ICON.pause })}</span><b class="num" data-since="${esc(s.paused.at)}">0:00</b><p>${t('ui.286')}</p>${data.role === 'host' ? btn(t('ui.025'), 'resume', 'amber', !connected) : ''}</div>`;
}
function timeoutButton(s) {
  const p = player(s, s.hand.actor), l = legalActions(s, p.id), offline = !data.online.includes(p.id);
  return `<button class="btn btn-ghost has-icon timeout-btn" data-do="timeout" ${busy || !connected ? 'disabled' : ''}>${ICON.clock}<span>${t('ui.290', { p0: esc(p.name), p1: l?.check ? t('ui.287') : t('ui.176') })}</span><small>${offline ? t('ui.288') : t('ui.289')}</small></button>`;
}
// 主持需要处理的请求：换手机认领座位、申请补码。
function hostAlerts(s) {
  if (data.role !== 'host' || s.status === 'ended') return '';
  const claims = (data.claims || []).map(c => { const r = s.roster?.[c.playerId] || {}; return `<div class="alert glass" role="alert">${avatar({ seat: r.seat, name: c.name })}<div class="t"><b>${t('ui.293', { p0: esc(c.name) })}</b><span>${t('ui.294', { p0: hhmm(new Date(c.at).toISOString()) })}</span></div>${btn(t('ui.291'), 'claim-deny', 'ghost', false, `data-id="${c.id}"`)}${btn(t('ui.292'), 'claim-ok', 'amber', false, `data-id="${c.id}"`)}</div>`; });
  const asks = (data.asks || []).map(a => { const p = player(s, a.playerId); if (!p) return ''; return `<div class="alert glass" role="alert">${avatar(p)}<div class="t"><b>${t('ui.298', { p0: esc(a.name) })}</b><span>${t('ui.299', { p0: n(p.stack), p1: ongoing(s) ? t('ui.295') : t('ui.296') })}</span></div><label class="ask-amt"><span class="sr-only">${t('ui.300')}</span><input id="ask-${a.id}" class="num" type="number" min="1" step="1" value="${s.config.startingStack}" aria-label="${t('ui.301', { p0: esc(a.name) })}"></label>${btn(t('ui.297'), 'ask-deny', 'ghost', false, `data-id="${a.id}"`)}${btn(t('ui.159'), 'ask-ok', 'amber', ongoing(s), `data-id="${a.id}"`)}</div>`; });
  const all = [...claims, ...asks].filter(Boolean);
  return all.length ? `<div class="alerts" aria-label="${t('ui.302')}">${all.join('')}</div>` : '';
}
function table(s) {
  if (s.status === 'ended') return recap(s);
  return `${topbar(s)}<main class="tablepage ${reviewClass(s)}">${arena(s, showdownFx(s))}${hostAlerts(s)}</main>${hostbar(s)}`;
}
function phoneHead(s) {
  return `<header class="p-head"><a class="seal" href="${link('share')}" aria-label="${t('ui.304', { p0: code })}">${t('ui.008')}</a><div class="t"><b>${esc(s.config.name)}</b><span>${s.status === 'ended' ? t('ui.144', { p0: s.handNumber }) : `${t('ui.303', { p0: s.handNumber, p1: s.paused ? t('ui.249') : street(s) })}<span class="num">${n(data.blinds?.small ?? s.config.smallBlind)}/${n(data.blinds?.big ?? s.config.bigBlind)}</span>`}</span></div>${languagePicker()}${muteButton()}</header>`;
}
function raisePresets(s, l, p) {
  const potAfterCall = potTotal(s) + l.call, base = s.hand.currentBet;
  const list = [[t('ui.305'), l.minRaiseTo], [t('ui.306'), Math.round(base + potAfterCall / 2)], [t('ui.307'), base + potAfterCall], [t('ui.179'), l.maxRaiseTo]];
  const seen = new Set();
  return list.map(([label, v]) => [label, Math.max(l.minRaiseTo, Math.min(l.maxRaiseTo, v))]).filter(([label, v]) => label === t('ui.179') || label === t('ui.305') || (!seen.has(v) && v > l.minRaiseTo && v < l.maxRaiseTo)).filter(([, v]) => { if (seen.has(v)) return false; seen.add(v); return true; });
}
function actionSheet(s, p, l) {
  const label = s.hand.currentBet ? t('ui.308') : t('ui.309');
  if (raiseOpen && l.raise) {
    const v = Math.max(l.minRaiseTo, Math.min(l.maxRaiseTo, raiseValue || l.minRaiseTo)), pct = l.maxRaiseTo > l.minRaiseTo ? ((v - l.minRaiseTo) / (l.maxRaiseTo - l.minRaiseTo)) * 100 : 100;
    return `<section class="sheet is-raise" aria-labelledby="sheet-title"><div class="turn-row"><h1 id="sheet-title" class="turn-label">${t('ui.313', { p0: label })}</h1><span class="ctx">${t('ui.314')}<b class="num">${n(l.call)}</b>${t('ui.315')}<b class="num">${n(l.minRaiseTo)}</b></span></div>
<div class="amt"><label class="amt-field"><span class="lbl sr-only">${t('ui.313', { p0: label })}</span><input id="raise-amount" class="num" type="number" inputmode="numeric" step="1" min="${l.minRaiseTo}" max="${l.maxRaiseTo}" value="${v}" aria-label="${t('ui.313', { p0: label })}"></label><div class="step"><button type="button" class="iconbtn" data-do="step" data-step="-1" aria-label="${t('ui.316')}">${ICON.minus}</button><button type="button" class="iconbtn" data-do="step" data-step="1" aria-label="${t('ui.317')}">${ICON.plus}</button></div></div>
<p id="raise-error" class="error" role="status"></p><input type="range" id="raise-range" min="${l.minRaiseTo}" max="${l.maxRaiseTo}" value="${v}" step="1" aria-label="${t('ui.318', { p0: label })}" style="--pct:${pct}%">
<div class="presets">${raisePresets(s, l, p).map(([name, value]) => `<button type="button" data-do="preset" data-value="${value}" class="${value === v ? 'is-on' : ''}">${name}<b class="num">${n(value)}</b></button>`).join('')}</div>
<div class="pair"><span>${t('ui.319')}<b id="raise-add" class="num">${n(v - p.bet)}</b></span><span id="raise-allin-note"></span></div>
<div class="acts acts-raise">${btn(t('ui.310'), 'raise-cancel', 'ghost')}${btn(v === l.maxRaiseTo ? t('ui.311') : t('ui.312', { p0: label, p1: n(v) }), 'raise-submit', 'amber', !connected, 'id="raise-submit"')}</div><p class="rule">${t('ui.320', { p0: label })}</p></section>`;
  }
  const call = l.check ? btn(t('ui.287'), 'check', 'paper', !connected) : l.canCall ? btn(t('ui.321', { p0: n(l.call) }), 'call', 'paper', !connected) : '';
  return `<section class="sheet" aria-labelledby="sheet-title"><div class="turn-row"><h1 id="sheet-title" class="turn-label" aria-live="assertive">${t('ui.011')}</h1><span class="ctx">${esc(capability(l, p))}</span></div>${timerBar(s)}
<div class="acts ${call ? '' : 'two'} ${l.raise ? '' : 'no-raise'}">${btn(t('ui.176'), 'fold', 'clay', !connected)}${call}${l.raise ? btn(label, 'raise', 'amber', !connected) : ''}</div>${l.allIn ? `<div class="acts-all">${btn(t('ui.322', { p0: n(p.stack) }), 'allin', 'brass', !connected)}</div>` : ''}<p class="fine">${t('ui.323')}</p>${phoneNav(s, p)}</section>`;
}
function timerBar(s) {
  const deadline = deadlineOf(s);
  return deadline ? `<i class="timer has-clock" aria-hidden="true" data-deadline="${deadline}" data-total="${s.config.actionClock * 1000}"></i><span class="sr-only">${t('ui.324', { p0: secondsLeft(deadline) })}</span>` : '<i class="timer" aria-hidden="true"></i>';
}
function phoneNav(s, p) {
  return `<nav class="phone-nav"><a href="${link('log')}">${t('ui.065')}</a><a href="${link('hands')}">${t('ui.063')}</a><a href="${link('table')}">${t('ui.326')}</a><button class="link-btn" data-do="sit-toggle" ${busy ? 'disabled' : ''}>${p.sittingOut ? t('ui.325') : t('ui.171')}</button><button class="link-btn more-btn" data-do="phone-more" aria-label="${t('ui.327')}">${t('ui.328')}</button></nav>`;
}
function phoneMore(s, p) {
  const leaveLabel = p.leaving ? t('ui.329') : ongoing(s) ? t('ui.330') : t('ui.331');
  const rows = [
    s.config.rebuy ? `<button class="menu-row" data-do="ask" ${data.asked ? 'disabled' : ''}><b>${data.asked ? t('ui.332') : t('ui.333')}</b><span>${data.asked ? t('ui.139') : t('ui.334')}</span></button>` : '',
    `<button class="menu-row" data-do="sit-toggle"><b>${p.sittingOut ? t('ui.325') : t('ui.335')}</b><span>${p.sittingOut ? t('ui.336') : t('ui.337')}</span></button>`,
    `<label class="menu-row switch-row"><span><b>${t('ui.338')}</b><span>${t('ui.339')}</span></span><input id="awake-setting" type="checkbox" ${awakePreferred() ? 'checked' : ''}></label>`,
    `<button class="menu-row is-danger" data-do="leave" ${p.leaving ? 'disabled' : ''}><b>${leaveLabel}</b><span>${t('ui.340')}</span></button>`
  ].join('');
  showModal(`<h3 id="dialog-title">${esc(p.name)}</h3><div class="menu">${languagePicker()}${rows}</div><p class="fine">${t('ui.342')}</p>${btn(t('ui.341'), 'cancel')}`, false, true);
  modal.dataset.kind = 'phone-more';
}
function nextStraddlePlayer(s) {
  return s.config.straddle && !ongoing(s) ? player(s, nextPositions(s)?.utg) : null;
}
function straddleControl(s, p, host = false) {
  const next = nextStraddlePlayer(s);
  if (!next || (!host && next.id !== p.id)) return '';
  const c = s.config, nextLevel = s.level + Number(c.levelEvery > 0 && s.handNumber + 1 - s.levelHand >= c.levelEvery);
  const amount = levelBlinds(s, nextLevel).big * 2;
  return `<label class="switch-row straddle-control"><span><b>${host ? t('ui.343', { p0: esc(next.name) }) : t('ui.344')}</b><span>${t('ui.347', { p0: host ? t('ui.345') : t('ui.346') })}<strong class="num">${n(amount)}</strong></span></span><input id="${host ? 'host' : 'player'}-straddle" data-id="${esc(next.id)}" type="checkbox" role="switch" aria-label="${host ? t('ui.343', { p0: esc(next.name) }) : t('ui.344')}" ${s.nextStraddle === next.id ? 'checked' : ''} ${busy || !connected ? 'disabled' : ''}></label>`;
}
function play(s) {
  if (s.status === 'ended' || data.role === 'departed') return phoneSummary(s);
  const p = player(s, data.playerId);
  if (!p) return join(s);
  const h = s.hand, choosing = h?.phase === 'runChoice', multi = h?.runs > 1;
  const l = choosing ? null : data.legal, [title, subtitle] = turnInfo(s);
  let wait = title, sub = t('ui.348', { p0: n(p.bet) });
  if (s.paused) { wait = t('ui.195'); sub = t('ui.349'); }
  else if (p.sittingOut && (!s.hand || !p.inHand || p.folded || s.hand.phase === 'settled')) { wait = t('ui.350'); sub = t('ui.351'); }
  else if (!s.hand) { wait = t('ui.352'); sub = t('ui.353'); }
  else if (s.hand.phase === 'settled') { wait = t('ui.043'); sub = p.stack ? t('ui.354') : t('ui.355'); }
  else if (p.waiting) { wait = t('ui.356'); sub = t('ui.357'); }
  else if (p.folded) { wait = t('ui.358'); sub = t('ui.359'); }
  else if (s.hand.phase === 'showdown') { wait = digitalOf(s) && s.hand.autoJudged ? t('ui.201') : t('ui.360'); sub = t('ui.363', { p0: s.hand.preview ? t('ui.361', { p0: n(s.hand.preview.awards[p.id]) }) : '', p1: !multi && s.hand.handNames?.[p.id] ? t('ui.362', { p0: localized(s.hand.handNamesMessage?.[p.id] || s.hand.handNames[p.id]) }) : '' }); }
  else if (p.stack === 0) { wait = t('ui.364'); sub = t('ui.359'); }
  else if (s.hand.phase === 'roundEnd') sub = digitalOf(s) ? t('ui.365') : t('ui.366');
  else if (!data.online.includes(s.hand.actor)) sub = subtitle;
  const digital = digitalOf(s), board = s.hand?.board || [];
  const made = digital && data.hole && !multi ? handDetail([...data.hole, ...board]) : '';
  const opps = ordered(s).filter(q => q.id !== p.id);
  const oppHtml = `<section class="opps seatstrip" aria-label="${t('ui.367')}">${opps.map(q => { const st = seatStatus(s, q); return `<div class="opp pill-like ${s.hand?.actor === q.id ? 'is-act' : ''} ${q.folded ? 'is-fold' : ''}">${avatar(q)}${s.hand?.dealer === q.id ? `<i class="d">${t('ui.226')}</i>` : ''}<span class="n">${esc(q.name)}</span><em class="b num ${q.bet ? '' : 'muted'}">${q.bet && s.hand?.phase === 'betting' ? `${n(q.bet)}` : st === t('ui.174') ? n(q.stack) : st}</em></div>`; }).join('')}</section>`;
  const boardHtml = `<section class="p-board felt-surface ${digital ? '' : 'is-physical'} ${multi ? 'has-runs' : ''}"><div class="top"><span class="potv">${t('ui.370', { p0: chipStackHtml(potTotal(s), true, { width: 20 }) })}<b class="num">${n(potTotal(s))}</b></span>${multi ? `<span data-testid="run-result" role="status">${runResultLabel(s)}</span>` : `<span>${h?.currentBet && h.phase === 'betting' ? `${t('ui.368')}<b class="num small">${n(h.currentBet)}</b> · ` : ''}${street(s)}</span>`}</div>${multi ? runBoards(s, p) : digital ? `<div class="row">${boardSlots(board, { size: 'is-mini' })}</div>` : `<p class="phys-note">${h ? t('ui.369') : t('ui.352')}</p>`}</section>`;
  const hero = `<section class="hero ${digital && data.hole ? 'has-cards' : ''}">${digital && data.hole ? `<div class="hero-cards" data-testid="hole-cards">${data.hole.map(c => playingCard(c, { size: 'is-hero', flipped: true })).join('')}</div>` : ''}<div class="made">${made ? `<span class="tag" data-testid="my-hand">${esc(made)}</span>` : ''}<div class="me"><h2 class="me-name">${esc(p.name)}</h2><span class="me-stack">${t('ui.371')}<b class="num" data-testid="my-stack">${n(p.stack)}</b></span></div></div><p class="me-sub">${t('ui.372')}<span class="num">${n(p.contribution)}</span>${t('ui.224')}<span class="num">${n(p.bet)}</span>${t('ui.373')}<span class="num">${n(s.total)}</span></p></section>`;
  const canShow = digital && s.hand && ['showdown', 'settled'].includes(s.hand.phase) && s.hand.participants?.includes(p.id) && data.hole && !s.hand.revealed?.[p.id];
  const mucked = canShow && s.hand.mucked?.includes(p.id);
  const extraBtns = [
    p.sittingOut && !l ? btn(t('ui.325'), 'sit-toggle', 'amber', !connected) : '',
    canShow ? btn(mucked ? t('ui.374') : t('ui.375'), 'show', 'paper', !connected) : '',
    !l && s.config.rebuy && p.stack === 0 && !p.inHand ? (data.asked ? `<p class="fine left">${t('ui.376')}</p>` : btn(t('ui.333'), 'ask', 'amber', !connected)) : ''
  ].filter(Boolean).join('');
  const sheet = l ? actionSheet(s, p, l) : `<section class="sheet is-wait"><div class="waitblock" aria-live="polite"><strong>${esc(wait)}</strong><p>${esc(sub)}</p>${h?.runResolved && !multi ? `<p class="run-count" data-testid="run-result">${runResultLabel(s)}</p>` : ''}${mucked ? `<p class="mucked">${t('ui.377')}</p>` : ''}</div>${extraBtns ? `<div class="wait-acts">${extraBtns}</div>` : ''}${straddleControl(s, p)}${phoneNav(s, p)}</section>`;
  return `<main class="phone-app ${raiseOpen && l?.raise ? 'is-raising' : ''} ${s.paused ? 'is-paused' : ''} ${choosing ? 'is-choosing-run' : ''}">${phoneHead(s)}${connectionBanner()}${oppHtml}${choosing ? `${runChoicePhone(s, p)}${hero}${boardHtml}` : `${boardHtml}${hero}${sheet}`}</main>`;
}
function localPreview(s) { try { return previewSettlement(s, selections); } catch { return null; } }
function remainderText(s, preview) {
  if (!preview) return t('ui.378');
  return preview.details.map(d => t('ui.382', { p0: runPotName(s, d), p1: n(d.amount), p2: d.runOdd ? t('ui.379') : '', p3: d.winners.length, p4: n(d.each), p5: d.remainder, p6: d.remainder ? t('ui.381', { p0: seatName(s, s.hand.dealer) || t('ui.380', { p0: s.hand.dealerSeat }), p1: d.oddRecipients.map(id => seatName(s, id)).join(' → ') }) : '' })).join(' ');
}
function digitalSettle(s) {
  const preview = s.hand.preview || localPreview(s);
  const rows = s.hand.runs > 1 ? '' : `<div class="rows">${data.pots.map(pot => `<span>${esc(potName(pot))} <b class="num">${n(pot.amount)}</b> → <em>${(s.hand.selections?.[pot.id] || []).map(id => esc(seatName(s, id))).join(listSeparator())}</em></span>`).join('')}</div>`;
  const odd = preview?.details?.some(d => d.remainder || d.runOdd);
  return `${topbar(s)}<main class="tablepage is-settle ${reviewClass(s)}">${arena(s, { ...showdownFx(s), quietTitle: true })}</main><footer class="hostbar"><nav class="settlebar glass" aria-label="${t('ui.387')}"><div class="ttl"><h2>${t('ui.201')}</h2><span>${t('ui.388')}</span></div>${rows}<div class="bal" title="${esc(remainderText(s, preview))}"><span class="ok-dot"></span>${preview ? `${t('ui.385')}<b class="num">${n(preview.afterTotal)}</b> · ${odd ? t('ui.383') : t('ui.384')}` : ''}<span class="sr-only remainder">${esc(remainderText(s, preview))}</span></div>${nav(t('ui.164'), 'table', 'quiet')}${btn(t('ui.386'), 'settle-confirm', 'amber', !preview || !preview.balanced || !connected)}</nav></footer>`;
}
function settle(s) {
  if (data.role !== 'host' || s.hand?.phase !== 'showdown') return table(s);
  if (digitalOf(s) && s.hand.autoJudged) return digitalSettle(s);
  const pots = settlementPots(data), pot = pots[selectedPot] || pots[0], preview = localPreview(s);
  if (!pot) return table(s);
  const chosen = selections[pot.id] || [];
  const fx = { awards: preview?.awards || {}, winners: new Set(Object.values(selections).flat()), marks: {} };
  const panel = `<aside class="settle-panel glass" aria-label="${t('ui.251')}"><div class="settle-fields"><h2>${t('ui.244')}</h2><p class="hint">${s.hand.runs > 1 ? t('ui.389') : t('ui.390')}</p>
<div class="potpick">${pots.map((p, i) => `<button class="${i === selectedPot ? 'is-on' : ''}" data-do="pot" data-index="${i}" data-run="${p.run ?? 1}" data-pot-id="${esc(p.potId ?? p.id)}" aria-pressed="${i === selectedPot}"><span class="t"><b>${esc(runPotName(s, p))}</b><span class="num">${n(p.amount)}</span></span><span class="w">${p.runOdd ? t('ui.391') : ''}${selections[p.id]?.length ? t('ui.392', { p0: selections[p.id].map(id => esc(seatName(s, id))).join(listSeparator()) }) : t('ui.393')}</span></button>`).join('')}</div>
<h3>${esc(runPotName(s, pot))} <span class="num">${n(pot.amount)}</span>${t('ui.402')}</h3><div class="winners">${pot.eligible.map(id => { const p = player(s, id), on = chosen.includes(id); return `<button class="winner ${on ? 'is-on' : ''}" data-do="winner" data-id="${id}" aria-pressed="${on}" ${busy ? 'disabled' : ''}>${avatar(p)}<span class="name">${esc(p.name)}</span><span class="tick">${on ? chosen.length > 1 ? t('ui.394') : t('ui.395') : t('ui.396')}</span></button>`; }).join('')}</div>
<div class="locked">${s.players.filter(p => !pot.eligible.includes(p.id)).map(p => `<div><b>${esc(p.name)}</b>${p.folded ? t('ui.397') : t('ui.398')}</div>`).join('')}</div>
<div class="preview" aria-live="polite"><p class="remainder">${esc(remainderText(s, preview))}</p>${s.players.filter(p => preview?.awards[p.id]).map(p => `<div class="line"><span>${esc(p.name)}</span><span class="num">+${n(preview.awards[p.id])}</span></div>`).join('')}<div class="balance-foot">${preview ? `<span class="ok-dot"></span>${t('ui.399')}<b class="num">${n(preview.distributed)}</b>${t('ui.400')}<b class="num">${n(preview.afterTotal)}</b>` : t('ui.401')}</div></div></div>
<div class="panel-actions">${nav(t('ui.164'), 'table', 'ghost')}${btn(t('ui.386'), 'settle-confirm', 'amber', !preview || !preview.balanced || !connected)}</div></aside>`;
  return `${topbar(s)}<main class="tablepage has-panel ${reviewClass(s)}">${arena(s, fx)}${panel}</main>`;
}
function logPage(s) {
  if (extra.logs) s = { ...s, logs: extra.logs };
  return `${topbar(s)}<main class="pagewrap"><div class="panel logsheet"><h2>${t('ui.406')}</h2><p class="lead">${t('ui.407')}</p><label>${t('ui.408')}<select id="log-hand"><option value="all" ${logHand === 'all' ? 'selected' : ''}>${t('ui.409')}</option>${Array.from({ length: s.handNumber + 1 }, (_, i) => `<option value="${i}" ${Number(logHand ?? s.handNumber) === i ? 'selected' : ''}>${i ? t('ui.403', { p0: i }) : t('ui.404')}</option>`).join('')}</select></label>${transcript(s, logHand ?? s.handNumber)}<div class="panel-actions">${nav(data.role === 'player' ? t('ui.405') : t('ui.164'), data.role === 'player' ? 'play' : 'table')}${undoButton()}</div></div></main>`;
}
const LEVEL_OPTIONS = [0, 5, 8, 10, 15, 20, 30];
function blindSettings(s) {
  const b = data.blinds, c = s.config;
  return `<section class="manage-sec"><div class="sec-head"><h2>${t('ui.412')}</h2><span class="muted">${t('ui.413')}</span></div>
<div class="level-row"><div class="level-now"><span>${t('ui.414')}</span><b class="num">${n(b.small)} / ${n(b.big)}</b>${b.ante ? `<small class="num">${c.anteMode === 'bigBlind' ? t('ui.066') : t('ui.067')} ${n(b.ante)}</small>` : ''}<em>${t('ui.415', { p0: b.level + 1 })}</em></div>${btn(`${ICON.minus}<span>${t('ui.410')}</span>`, 'level-down', 'ghost has-icon', b.level === 0)}${btn(`${ICON.plus}<span>${t('ui.411')}</span>`, 'level-up', 'ghost has-icon')}</div>
<form id="settings-form" class="settings-grid" data-config="${esc(JSON.stringify(c))}"><label>${t('ui.106')}<select name="levelEvery">${options(LEVEL_OPTIONS.includes(c.levelEvery) ? LEVEL_OPTIONS : [...LEVEL_OPTIONS, c.levelEvery], c.levelEvery, v => v ? t('ui.083', { p0: v }) : t('ui.084'))}</select></label>
<label>${t('ui.416')}<input name="ante" class="num" type="number" min="0" step="1" max="${c.bigBlind}" value="${c.ante}" aria-label="${t('ui.105')}"></label>
<label>${t('ui.107')}<select name="actionClock">${options([0, 20, 30, 45, 60, 90], c.actionClock, v => v ? t('ui.085', { p0: v }) : t('ui.084'))}</select></label>
${ruleFields(c)}<button class="btn btn-ghost" type="submit" ${busy || !connected ? 'disabled' : ''}>${t('ui.417')}</button></form>
${straddleControl(s, null, true)}</section>`;
}
function manage(s) {
  if (data.role !== 'host' || ongoing(s)) return table(s);
  const seatOpts = p => Array.from({ length: 10 }, (_, i) => i + 1).map(seat => { const o = s.players.find(q => q.seat === seat); return `<option value="${seat}" ${seat === p.seat ? 'selected' : ''}>${t('ui.421', { p0: seat, p1: o && o.id !== p.id ? t('ui.418') : o ? t('ui.419') : t('ui.420') })}</option>`; }).join('');
  return `${topbar(s)}<main class="pagewrap"><div class="panel manage"><h1>${t('ui.253')}</h1><p class="lead">${t('ui.432')}</p><fieldset class="field modes"><legend>${t('ui.093')}</legend><label class="mode" data-do="set-mode" data-mode="digital"><input type="radio" name="dealMode" value="digital" aria-label="${t('ui.048')}" ${digitalOf(s) ? 'checked' : ''}><i class="tick">${ICON.check}</i><b>${t('ui.048')}</b><span>${t('ui.433')}</span></label><label class="mode" data-do="set-mode" data-mode="physical"><input type="radio" name="dealMode" value="physical" aria-label="${t('ui.049')}" ${digitalOf(s) ? '' : 'checked'}><i class="tick">${ICON.check}</i><b>${t('ui.049')}</b><span>${t('ui.434')}</span></label></fieldset>${blindSettings(s)}<label class="switch-row"><span><b>${t('ui.102')}</b><span>${s.config.rebuy ? t('ui.422') : t('ui.423')}</span></span><input id="rebuy-setting" type="checkbox" ${s.config.rebuy ? 'checked' : ''}></label>
<div class="manage-list">${ordered(s).map(p => `<div class="manage-row ${p.sittingOut ? 'is-away' : ''}">${avatar(p)}<strong>${p.seat} · ${esc(p.name)}<small class="num">${n(p.stack)}${p.sittingOut ? t('ui.424') : ''}${data.online.includes(p.id) ? '' : t('ui.425')}</small></strong><label class="seat-to"><span class="sr-only">${t('ui.430', { p0: esc(p.name) })}</span><select data-seat-for="${p.id}" aria-label="${t('ui.430', { p0: esc(p.name) })}">${seatOpts(p)}</select></label>${btn(t('ui.426'), 'move', 'ghost', false, `data-id="${p.id}" data-direction="-1"`)}${btn(t('ui.427'), 'move', 'ghost', false, `data-id="${p.id}" data-direction="1"`)}${btn(p.sittingOut ? t('ui.428') : t('ui.171'), 'host-sit', 'ghost', false, `data-id="${p.id}" data-away="${!p.sittingOut}"`)}${s.config.rebuy ? `<label class="rebuy-amt"><span class="sr-only">${t('ui.301', { p0: esc(p.name) })}</span><input id="rebuy-${p.id}" class="num" type="number" min="1" step="1" value="500" aria-label="${t('ui.301', { p0: esc(p.name) })}"></label>${btn(t('ui.159'), 'rebuy', 'ghost', false, `data-id="${p.id}"`)}` : ''}${btn(t('ui.429'), 'remove', 'clay', false, `data-id="${p.id}"`)}</div>`).join('')}</div><p class="fine left">${t('ui.435')}</p><div class="panel-actions">${nav(t('ui.164'), 'table')}${btn(t('ui.431'), 'end', 'clay', !connected)}</div></div></main>`;
}
// ───────── 散场总结 / 战况 ─────────
const summaryOf = () => data.summary || extra.summary;
function recap(s) {
  const sum = summaryOf(), ended = s.status === 'ended', host = data.role === 'host';
  if (!sum) return `${topbar(s)}<main class="recappage is-loading"><p class="muted">${t('ui.436')}</p></main>`;
  const me = data.playerId;
  const next = s.nextRoom;
  const dock = `<footer class="hostbar recapbar"><nav class="dock glass" aria-label="${t('ui.445')}">
${btn(`${ICON.copy}<span>${t('ui.437')}</span>`, 'recap-copy', 'quiet has-icon')}${btn(`${ICON.image}<span>${t('ui.438')}</span>`, 'recap-image', 'quiet has-icon')}<a class="btn btn-quiet has-icon" href="${link('hands')}">${ICON.book}<span>${t('ui.062')}</span></a>
${ended ? (host ? `<i class="sep"></i>${btn(`${ICON.undo}<span>${t('ui.439')}</span>`, 'undo', 'quiet has-icon', !data.lastUndo || !connected)}${next ? `<a class="btn btn-amber has-icon" href="/share?room=${next}">${ICON.play}<span>${t('ui.440', { p0: next })}</span></a>` : btn(`${ICON.play}<span>${t('ui.441')}</span>`, 'rematch', 'amber has-icon', !connected)}` : next ? `<i class="sep"></i><a class="btn btn-amber has-icon" href="/join?room=${next}${me && player(s, me) ? `&name=${encodeURIComponent(player(s, me).name)}` : ''}">${ICON.play}<span>${t('ui.143', { p0: next })}</span></a>` : '') : `<i class="sep"></i>${nav(`${ICON.back}<span>${t('ui.444', { p0: data.role === 'player' ? t('ui.442') : t('ui.443') })}</span>`, data.role === 'player' ? 'play' : 'table', 'amber has-icon')}`}</nav></footer>`;
  return `${topbar(s)}<main class="recappage ${ended ? 'is-ended' : 'is-live'} ${sum.players.length > 7 ? 'is-crowded' : ''}">${recapBody(sum, { me })}</main>${dock}`;
}
function rankMini(sum, me) {
  return `<ol class="ps-rank">${sum.players.map(p => `<li class="${p.id === me ? 'is-me' : ''} ${p.net > 0 ? 'is-up' : p.net < 0 ? 'is-down' : ''}"><span class="num r">${p.rank}</span>${avatar(p)}<b>${esc(p.name)}${p.status === 'left' ? `<small>${t('ui.446')}</small>` : ''}</b><span class="num v">${signed(p.net)}</span></li>`).join('')}</ol>`;
}
function phoneSummary(s) {
  const sum = data.summary, me = data.playerId, mine = sum?.players.find(p => p.id === me);
  if (!sum || !mine) return `<main class="phone-app">${phoneHead(s)}<div class="j-wrap"><p class="muted">${t('ui.447')}</p></div></main>`;
  const departed = data.role === 'departed', next = s.nextRoom;
  const live = departed && s.status !== 'ended';
  const cta = next ? `<a class="btn btn-amber btn-block" href="/join?room=${next}&name=${encodeURIComponent(mine.name)}">${t('ui.143', { p0: next })}</a>` : live ? `<a class="btn btn-amber btn-block" href="${link('join')}">${t('ui.428')}</a>` : '';
  return `<main class="phone-app summary-app">${phoneHead(s)}${connectionBanner()}<div class="ps-wrap" data-testid="personal-summary">${personalBody(sum, me)}
${live ? `<p class="ps-live"><span class="ok-dot"></span><span>${t('ui.448')}<b class="num">${s.handNumber}</b>${t('ui.449')}</span></p>` : ''}
<section class="ps-table"><div class="ps-table-head"><h2>${s.status === 'ended' ? t('ui.450') : t('ui.451')}</h2><a href="${link('recap')}">${t('ui.455')}</a></div>${rankMini(sum, me)}<p class="ps-bal"><span class="ok-dot ${sum.balance.ok ? '' : 'is-off'}"></span>${sum.balance.ok ? `${t('ui.452')}<b class="num">${n(sum.balance.buyIn)}</b>` : t('ui.453')}</p></section></div>
<footer class="sheet ps-actions">${cta}<div class="ps-btns">${btn(`${ICON.image}<span>${t('ui.438')}</span>`, 'my-image', next || live ? 'paper has-icon' : 'amber has-icon')}${btn(`${ICON.copy}<span>${t('ui.454')}</span>`, 'my-copy', 'paper has-icon')}<a class="btn btn-paper has-icon" href="${link('hands')}">${ICON.book}<span>${t('ui.063')}</span></a></div><p class="fine">${t('ui.456')}</p></footer></main>`;
}
async function showImage(me) {
  const sum = summaryOf(); if (!sum) return;
  notice(t('ui.457'));
  try {
    const url = await shareImage(sum, me);
    const fileName = t('ui.458', { p0: sum.room.name, p1: me ? '-' + (sum.players.find(p => p.id === me)?.name || '') : '' });
    showModal(`<h3 id="dialog-title">${me ? t('ui.459') : t('ui.460')}</h3><p>${t('ui.461')}</p><img class="share-img" src="${url}" alt="${t('ui.462', { p0: esc(sum.room.name) })}"><div class="stack-btns">${btn(t('ui.341'), 'cancel')}<a class="btn btn-amber" href="${url}" download="${esc(fileName)}">${t('ui.463')}</a></div>`, false);
    document.querySelector('#toast').hidden = true;
  } catch (e) { notice(t('ui.464', { p0: e.message })); }
}
async function copySummary(me) {
  const sum = summaryOf(); if (!sum) return;
  const text = me ? personalText(sum, me) : recapText(sum);
  if (await copyText(text)) { notice(t('ui.465')); return; }
  showModal(`<h3 id="dialog-title">${t('ui.437')}</h3><p>${t('ui.466')}</p><textarea class="copy-area" readonly rows="12">${esc(text)}</textarea>${btn(t('ui.341'), 'cancel')}`, false);
  modal.querySelector('textarea')?.select();
}
// ───────── 牌谱 ─────────
function handsPage(s) {
  const back = data.role === 'player' ? nav(`${ICON.back}<span>${t('ui.467')}</span>`, 'play', 'quiet has-icon') : data.role === 'departed' ? nav(`${ICON.back}<span>${t('ui.468')}</span>`, 'play', 'quiet has-icon') : nav(`${ICON.back}<span>${s.status === 'ended' ? t('ui.057') : t('ui.164')}</span>`, s.status === 'ended' ? 'recap' : 'table', 'quiet has-icon');
  return `${topbar(s)}<main class="handspage"><div class="hv-top">${back}<span class="muted">${extra.hands ? t('ui.469', { p0: extra.hands.records.length }) : ''}</span></div><div class="hv-grid">${extra.hands ? handsBody(extra.hands, handPick) : `<p class="muted">${t('ui.470')}</p>`}</div></main>`;
}
function render() {
  const active = document.activeElement;
  const createDraft = [...app.querySelectorAll('#create-form input[name], #create-form select[name]')].map(el => ({ name: el.name, value: el.value, type: el.type, checked: el.checked }));
  const expanded = [...app.querySelectorAll('details')].map(el => el.open);
  const focusAttrs = active && app.contains(active) ? [...active.attributes].filter(a => a.name.startsWith('data-') || ['href', 'name', 'type'].includes(a.name)).map(a => [a.name, a.value]) : [];
  const fields = [...app.querySelectorAll('input')].filter(el => el.id).map(el => [el.id, el.value]);
  const oldSettings = app.querySelector('#settings-form');
  const settingsDraft = oldSettings ? [...oldSettings.querySelectorAll('input[name], select[name]')].map(el => [el.name, el.type === 'checkbox' ? el.checked : el.value]) : [];
  const focusId = active?.id, start = active?.selectionStart, end = active?.selectionEnd;
  const transcriptScroll = app.querySelector('.transcript')?.scrollTop;
  const scrollOffsets = ['.pagewrap', '.arena.is-review', '.settle-fields'].map(selector => [selector, app.querySelector(selector)?.scrollTop || 0]);
  document.body.className = page === 'home' ? 'is-home' : ['play', 'join'].includes(page) || !code || !data ? 'is-phone' : 'is-screen';
  if (data && ['table', 'settle', 'manage'].includes(page) && data.state.status === 'ended') page = 'recap';
  if (page === 'home') { document.body.className = network && !network.local ? 'is-phone' : 'is-home'; app.innerHTML = home(); }
  else if (page === 'transfer') { document.body.className = 'is-phone'; app.innerHTML = `<main class="phone-app join-app"><header class="p-head"><span class="seal">${t('ui.008')}</span><div class="t"><b>${t('ui.086')}</b><span>${t('ui.472')}</span></div></header><div class="j-wrap"><div class="eyebrow">${t('ui.473')}</div><h1>${t('ui.474')}</h1><p class="lead">${t('ui.475')}</p></div><div class="sheet j-form">${btn(t('ui.471'), 'accept-transfer', 'amber')}</div></main>`; }
  else if (!code) app.innerHTML = joinLookup();
  else if (!data) app.innerHTML = loadingPage();
  else app.innerHTML = ({ join, share, play, table, settle, log: logPage, manage, recap, hands: handsPage }[page] || table)(data.state);
  for (const [id, value] of fields) { const el = document.getElementById(id); if (el && el.type !== 'checkbox') el.value = value; }
  for (const draft of createDraft) {
    const el = [...app.querySelectorAll('#create-form input[name], #create-form select[name]')].find(el => el.name === draft.name && (draft.type !== 'radio' || el.value === draft.value));
    if (!el) continue;
    if (['checkbox', 'radio'].includes(draft.type)) el.checked = draft.checked;
    else el.value = draft.value;
  }
  app.querySelectorAll('details').forEach((el, i) => { if (expanded[i] !== undefined) el.open = expanded[i]; });
  const settings = app.querySelector('#settings-form');
  // 在线状态等广播不应打断未提交的桌规；服务端桌规变更后则使用新值。
  if (settings && oldSettings?.dataset.config === settings.dataset.config) {
    for (const [name, value] of settingsDraft) {
      const el = settings.elements.namedItem(name);
      if (el.type === 'checkbox') el.checked = value; else el.value = value;
    }
  }
  const fresh = focusId ? document.getElementById(focusId) : focusAttrs.length ? [...app.querySelectorAll('button, a, select, input')].find(el => el.tagName === active.tagName && focusAttrs.every(([k, v]) => el.getAttribute(k) === v)) : null;
  const settingsChanged = oldSettings?.contains(active) && oldSettings.dataset.config !== settings?.dataset.config;
  if (fresh && !settingsChanged && active.tagName === 'INPUT' && !['checkbox', 'radio'].includes(active.type) && fresh.tagName === 'INPUT' && fresh.type === active.type) {
    // Keep the live input node so caret/selection (not readable on number inputs) survives a state push mid-edit.
    for (const a of [...active.attributes]) if (a.name !== 'value' && !fresh.hasAttribute(a.name)) active.removeAttribute(a.name);
    for (const a of [...fresh.attributes]) if (a.name !== 'value') active.setAttribute(a.name, a.value);
    fresh.replaceWith(active); active.focus({ preventScroll: true });
    try { active.setSelectionRange(start, end); } catch { /* number input keeps its own selection */ }
  } else if (fresh) { fresh.focus({ preventScroll: true }); try { fresh.setSelectionRange(start, end); } catch { /* number input */ } }
  const transcriptEl = app.querySelector('.transcript');
  if (transcriptEl) transcriptEl.scrollTop = page === 'table' ? transcriptEl.scrollHeight : transcriptScroll || 0;
  for (const [selector, top] of scrollOffsets) { const el = app.querySelector(selector); if (el && top) el.scrollTop = top; }
  const nameEl = document.querySelector('#join-name');
  if (nameEl) document.querySelector('#join-form button[type=submit]').disabled = !nameEl.value.trim() || !connected || !seatChoice;
  if (document.querySelector('#raise-amount')) updateRaise();
  const dock = document.querySelector('#sound-dock');
  if (dock) dock.innerHTML = tableSound.blocked ? `<button type="button" class="sound-unlock" data-do="unlock-sound">${t('ui.476')}</button>` : '';
}
function closeModal() { if (modal.open) modal.close(); modal.innerHTML = ''; delete modal.dataset.version; delete modal.dataset.kind; }
function showModal(html, actionSensitive = true, sheet = false) {
  returnFocus = document.activeElement;
  modal.innerHTML = html; modal.className = sheet ? 'raise-modal' : '';
  if (actionSensitive) modal.dataset.version = String(data.state.version);
  modal.showModal(); modal.querySelector('[data-do="cancel"]')?.focus();
}
function confirm(title, text, action, kind = 'clay-fill', quote = '', extra = '') {
  showModal(`<h3 id="dialog-title">${esc(title)}</h3><p>${esc(text)}</p>${quote ? `<div class="quote">${esc(quote)}</div>` : ''}<div class="stack-btns">${btn(t('ui.341'), 'cancel')}${btn(action === 'undo-submit' ? t('ui.477') : esc(title.replace('？', '')), action, kind, false, extra)}</div>`);
}
function allinText(s, p, l) {
  if (p.stack <= l.call) return t('ui.480', { p0: n(p.stack), p1: p.stack < l.call ? t('ui.478') : t('ui.479'), p2: n(p.stack) });
  return l.shortAllIn ? t('ui.481') : t('ui.482');
}
function updateRaise(value) {
  const amount = document.querySelector('#raise-amount');
  if (!amount || !data.legal) return;
  if (value !== undefined) amount.value = String(value);
  const l = data.legal, p = player(data.state, data.playerId), target = Number(amount.value), label = data.state.hand.currentBet ? t('ui.308') : t('ui.309');
  const valid = amount.value !== '' && Number.isSafeInteger(target) && target >= l.minRaiseTo && target <= l.maxRaiseTo;
  if (valid) raiseValue = target;
  document.querySelector('#raise-error').textContent = valid ? '' : t('ui.483', { p0: n(l.minRaiseTo), p1: n(l.maxRaiseTo) });
  document.querySelector('#raise-add').textContent = valid ? n(target - p.bet) : '—';
  const range = document.querySelector('#raise-range');
  if (valid) range.value = String(target);
  range.style.setProperty('--pct', `${l.maxRaiseTo > l.minRaiseTo ? ((Number(range.value) - l.minRaiseTo) / (l.maxRaiseTo - l.minRaiseTo)) * 100 : 100}%`);
  const submit = document.querySelector('#raise-submit'); submit.disabled = !valid || busy || !connected;
  submit.textContent = target === l.maxRaiseTo ? t('ui.311') : t('ui.312', { p0: label, p1: valid ? n(target) : '—' });
  document.querySelector('#raise-allin-note').textContent = target === l.maxRaiseTo ? allinText(data.state, p, l) : '';
  document.querySelectorAll('[data-do=preset]').forEach(el => el.classList.toggle('is-on', Number(el.dataset.value) === target));
}
app.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target, values = new FormData(form);
  const submit = form.querySelector('button[type=submit]'); if (submit) submit.disabled = true;
  try {
    if (form.id === 'create-form') {
      const result = await api('/api/rooms', { name: values.get('name'), smallBlind: Number(values.get('smallBlind')), bigBlind: Number(values.get('bigBlind')), startingStack: Number(values.get('startingStack')), rebuy: values.has('rebuy'), dealMode: values.get('dealMode') || 'digital', ante: Number(values.get('ante') || 0), levelEvery: Number(values.get('levelEvery') || 0), actionClock: Number(values.get('actionClock') || 0), ...ruleSettings(values) }, '');
      localStorage.setItem(`night-table.host.${result.code}`, result.token); location.assign(`/share?room=${result.code}`);
    } else if (form.id === 'lookup-form') {
      const room = values.get('code').toUpperCase(); await api(`/api/rooms/${room}`, undefined, ''); location.assign(`/join?room=${room}`);
    } else if (form.id === 'settings-form') {
      await command('settings', { ante: Number(values.get('ante')), levelEvery: Number(values.get('levelEvery')), actionClock: Number(values.get('actionClock')), ...ruleSettings(values) });
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
    const error = ![small, big, starting].every(x => Number.isSafeInteger(x) && x > 0 && x <= 1_000_000_000) ? t('ui.484') : big < small ? t('ui.485') : starting < big ? t('ui.486') : '';
    document.querySelector('#create-error').textContent = error; f.querySelector('button[type=submit]').disabled = !!error || !v.get('name').trim();
    const hint = document.querySelector('#bb-hint'); if (hint) hint.textContent = big > 0 && starting > 0 ? t('ui.bigBlindHint', { amount: Math.round(starting / big * 10) / 10 }) : '';
    f.querySelectorAll('[data-do=stack-preset]').forEach(b => b.classList.toggle('is-on', big * Number(b.dataset.bb) === starting));
  }
});
document.addEventListener('change', event => {
  if (event.target.matches('[data-language]')) { setLanguage(event.target.value); return; }
  if (event.target.id === 'log-hand') { logHand = event.target.value; render(); }
  if (event.target.id === 'rebuy-setting') command('rebuySetting', { enabled: event.target.checked });
  if (event.target.id === 'awake-setting') setAwakePreferred(event.target.checked);
  if (event.target.id === 'player-straddle') command('straddle', { enabled: event.target.checked });
  if (event.target.id === 'host-straddle') command('straddle', { enabled: event.target.checked, playerId: event.target.dataset.id });
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
    case 'fold': confirm(t('ui.487'), t('ui.488'), 'fold-submit'); break;
    case 'fold-submit': await command('act', { action: 'fold' }); break;
    case 'allin': confirm(t('ui.311'), allinText(s, p, data.legal), 'allin-submit', 'brass', t('ui.322', { p0: n(p.stack) })); break;
    case 'allin-submit': await command('act', { action: 'allin' }); break;
    case 'raise': raiseOpen = true; raiseValue = data.legal?.minRaiseTo || 0; render(); break;
    case 'raise-cancel': raiseOpen = false; render(); document.querySelector('[data-do="raise"]')?.focus(); break;
    case 'field-step': { const input = document.getElementById(el.dataset.field), v = Number(input.value) || 0, step = v < 10 ? 1 : v < 50 ? 5 : v < 200 ? 10 : 50; input.value = String(Math.max(1, v + Number(el.dataset.step) * step)); input.dispatchEvent(new Event('input', { bubbles: true })); break; }
    case 'stack-preset': { const f = document.querySelector('#create-form'), big = Number(f.bigBlind.value) || 0; if (big > 0) { f.startingStack.value = String(big * Number(el.dataset.bb)); f.startingStack.dispatchEvent(new Event('input', { bubbles: true })); } break; }
    case 'preset': updateRaise(Number(el.dataset.value)); break;
    case 'step': { const current = Number(document.querySelector('#raise-amount').value), l = data.legal; updateRaise(Math.max(l.minRaiseTo, Math.min(l.maxRaiseTo, current + Number(el.dataset.step) * s.config.bigBlind))); break; }
    case 'raise-submit': { const target = Number(document.querySelector('#raise-amount').value); await command('act', target === data.legal.maxRaiseTo ? { action: 'allin' } : { action: 'raise', to: target }); break; }
    case 'undo': confirm(t('ui.489'), t('ui.490'), 'undo-submit', 'clay-fill', localized(data.lastUndoMessage || data.lastUndo)); break;
    case 'undo-submit': await command('undo'); break;
    case 'settlement': location.assign(link('settle')); break;
    case 'pot': selectedPot = Number(el.dataset.index); render(); break;
    case 'winner': {
      const pot = settlementPots(data)[selectedPot], current = selections[pot.id] || [];
      selections = { ...selections, [pot.id]: current.includes(el.dataset.id) ? current.filter(id => id !== el.dataset.id) : [...current, el.dataset.id] };
      render(); await command('preview', { selections: localPreview(s) ? selections : null }); break;
    }
    case 'settle-confirm': { const preview = localPreview(s); if (preview) confirm(t('ui.386'), t('ui.491', { p0: remainderText(s, preview), p1: n(s.total) }), 'settle-submit', 'amber', t('ui.492', { p0: n(preview.distributed) })); break; }
    case 'settle-submit': { const preview = localPreview(s); if (preview) { await command('settle', { selections, expectedTotal: preview.distributed }); if (data.state.hand.phase === 'settled') location.assign(link('table')); } break; }
    case 'manage': location.assign(link('manage')); break;
    case 'move': await command('move', { playerId: el.dataset.id, direction: Number(el.dataset.direction) }); break;
    case 'rebuy': await command('rebuy', { playerId: el.dataset.id, amount: Number(document.getElementById(`rebuy-${el.dataset.id}`).value) }); break;
    case 'leave': case 'remove': { const who = action === 'remove' ? player(s, el.dataset.id) : p; confirm(ongoing(s) ? t('ui.493') : t('ui.494'), ongoing(s) ? t('ui.495') : t('ui.496', { p0: n(who.stack) }), 'leave-submit', 'clay-fill', who.name, `data-id="${who.id}"`); break; }
    case 'leave-submit': await command('leave', { playerId: el.dataset.id }); break;
    case 'transfer': {
      try { const result = await api(`/api/rooms/${code}/transfer`, {}); showModal(`<h3 id="dialog-title">${t('ui.165')}</h3><p>${t('ui.497')}</p>${result.qr ? `<div class="qr-paper transfer-qr">${result.qr}</div>` : ''}<p class="transfer-link mono">${esc(result.url)}</p>${btn(t('ui.341'), 'cancel')}`, false); } catch (e) { notice(e.message); } break;
    }
    case 'accept-transfer': {
      try { const result = await api(`/api/rooms/${code}/accept-transfer`, { secret: location.hash.slice(1) }, ''); localStorage.setItem(tokenKey('host'), result.token); location.replace(link('table')); } catch (e) { notice(e.message); } break;
    }
    case 'toggle-sound': tableSound.toggle(); render(); break;
    case 'unlock-sound': await tableSound.unlock(); render(); break;
    case 'set-mode': await command('setDealMode', { dealMode: el.dataset.mode || el.value }); break;
    case 'pause': await command('pause', { on: true }); break;
    case 'resume': await command('pause', { on: false }); break;
    case 'run-vote': await command('runVote', { runs: Number(el.dataset.runs) }); break;
    case 'run-once': confirm(t('ui.498'), t('ui.499'), 'run-once-submit', 'brass'); break;
    case 'run-once-submit': await command('runOnce'); break;
    case 'run-proxy': {
      const who = player(s, el.dataset.id);
      if (who && !data.online.includes(who.id) && waitingToVote(s, who.id)) showModal(`<h3 id="dialog-title">${t('ui.500', { p0: esc(who.name) })}</h3><p>${t('ui.501')}</p>${runVoteButtons(s, 'run-proxy-submit', who.id)}${btn(t('ui.341'), 'cancel')}`);
      break;
    }
    case 'run-proxy-submit': await command('runVote', { playerId: el.dataset.id, runs: Number(el.dataset.runs) }); break;
    case 'end': confirm(t('ui.502'), t('ui.503', { p0: s.handNumber }), 'end-submit', 'clay-fill', t('ui.504')); break;
    case 'end-submit': await command('end'); if (data.state.status === 'ended' && page !== 'recap') { page = 'recap'; history.replaceState(null, '', link('recap')); render(); } break;
    case 'timeout': { const actor = player(s, s.hand?.actor), l = actor && legalActions(s, actor.id); if (actor) confirm(t('ui.505', { p0: actor.name, p1: l?.check ? t('ui.287') : t('ui.176') }), t('ui.508', { p0: data.online.includes(actor.id) ? t('ui.506') : t('ui.507') }), 'timeout-submit', 'clay-fill', actor.name); break; }
    case 'timeout-submit': await command('timeout'); break;
    case 'show': await command('show'); break;
    case 'sit-toggle': closeModal(); await command('sitOut', { away: !p.sittingOut }); break;
    case 'host-sit': await command('sitOut', { playerId: el.dataset.id, away: el.dataset.away === 'true' }); break;
    case 'phone-more': phoneMore(s, p); break;
    case 'ask': closeModal(); try { accept(await api(`/api/rooms/${code}/ask`, {})); notice(t('ui.509')); } catch (e) { notice(e.message); } break;
    case 'ask-ok': case 'ask-deny': { const amount = Number(document.getElementById(`ask-${el.dataset.id}`)?.value); try { accept(await api(`/api/rooms/${code}/decide-ask`, { askId: el.dataset.id, approve: action === 'ask-ok', amount, requestId: randomToken() })); notice(action === 'ask-ok' ? t('ui.510', { p0: n(amount) }) : t('ui.511')); } catch (e) { notice(e.message); } break; }
    case 'claim-ok': case 'claim-deny': try { const r = await api(`/api/rooms/${code}/decide-claim`, { claimId: el.dataset.id, approve: action === 'claim-ok' }); accept(r); notice(r.approved ? t('ui.512', { p0: r.name }) : t('ui.513')); } catch (e) { notice(e.message); } break;
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
function syncTableReveal(previous, s) {
  const h = s.hand;
  if (!h || !['showdown', 'settled'].includes(h.phase)) { tableReveal = null; return; }
  if (!previous || h.phase !== 'showdown' || previous.hand?.phase === 'showdown' || reducedMotion()) return;
  if (previous.hand?.phase === 'settled' && previous.hand.number === h.number) return;
  const order = h.showOrder || [];
  const previousBoard = previous.hand?.number === h.number ? previous.hand.board || [] : [];
  const boardDelay = Math.max(0, (h.board?.length || 0) - previousBoard.length) * 80;
  tableReveal = { number: h.number, at: Date.now(), delays: new Map(order.map((id, i) => [id, boardDelay + i * 120])) };
}
function playTransition(prev, next) {
  if (prev?.state.version === next.state.version) return;
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
    const before = s0.hand?.number === s1.hand.number ? s0.hand.board.length : 0;
    document.querySelectorAll('.board-slots').forEach(board => board.querySelectorAll('.board-slot').forEach(slot => {
      const el = slot.querySelector('.npcard.is-flipped'), i = Number(slot.dataset.slot);
      if (!el || i < before) return;
      el.classList.remove('is-flipped');
      requestAnimationFrame(() => setTimeout(() => { if (gen === fxGen) el.classList.add('is-flipped'); }, 80 * (i - before)));
    }));
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
      const source = document.getElementById(`pot-${detail.id}`) || document.querySelector('#table-pot');
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
          flyChips(document.getElementById(`pot-${detail.id}`) || document.querySelector('#table-pot'), seat, 1, { duration: 280, odd: true, onDone: resolve });
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
    else if (code && page !== 'transfer') { if (sessionStorage.getItem('night-table.revoked')) { sessionStorage.removeItem('night-table.revoked'); setTimeout(() => notice(t('ui.514')), 300); } accept(await api(`/api/rooms/${code}`)); subscribe(); if (page === 'settle' && data.role !== 'host') notice(t('ui.515')); }
  } catch (error) {
    loadError = error.message; render();
    if (!error.status || error.status >= 500 || error.status === 429) scheduleRetry(boot);
  } finally { bootBusy = false; }
}
window.addEventListener('languagechange', () => {
  const more = modal.open && modal.dataset.kind === 'phone-more';
  render();
  if (page === 'play' && data) titleAlert(data.legal ? t('ui.011') : data.state.hand?.phase === 'runChoice' && waitingToVote(data.state, data.playerId) ? t('ui.012') : null);
  if (more && data) phoneMore(data.state, player(data.state, data.playerId));
});
boot();
