// v4 实机截图：起一个真实服务，打完一整晚（补码、申请补码、换手机认领、提前离席、休息、涨盲、散场），
// 截桌面 1440×900@2x 与手机 390×844@3x。用法：node tools/shoot-v4.mjs <输出目录>
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createServer, lanAddresses } from '../server/index.js';
import { potTotal } from '../server/engine.js';

const out = path.resolve(process.argv[2] || 'night-table-v4-real');
const only = process.argv[3] ? new Set(process.argv[3].split(',')) : null;
await mkdir(out, { recursive: true });
const server = await createServer({ file: path.join(await mkdtemp(path.join(tmpdir(), 'nt-v4-')), 'rooms.sqlite'), port: 0, rateLimit: false });
const base = `http://localhost:${server.port}`, phoneBase = `http://${lanAddresses()[0] || 'localhost'}:${server.port}`;
const browser = await chromium.launch();
const quiet = ctx => ctx.addInitScript(() => localStorage.setItem('night-table.sound', 'off'));
const wait = ms => new Promise(r => setTimeout(r, ms));
async function shot(page, name, ms = 1100) { if (only && !only.has(name)) return; await wait(ms); await page.screenshot({ path: path.join(out, `${name}.png`) }); console.log('shot', name); }
const phoneCtx = async () => { const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }); await quiet(c); return c; };
let seed = 20261116; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const hostCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }); await quiet(hostCtx);
const host = await hostCtx.newPage();
await host.goto(base);
await host.getByLabel('房间名', { exact: true }).fill('周六夜席');
await host.getByLabel('小盲', { exact: true }).fill('10');
await host.getByLabel('大盲', { exact: true }).fill('20');
await host.getByLabel('起始筹码', { exact: true }).fill('2000');
await host.getByLabel('打开补码').check();
await host.getByRole('radio', { name: '电子牌', exact: true }).check();
await host.locator('.more-set summary').click();
await host.getByLabel('自动涨盲').selectOption('8');
await host.getByLabel('行动计时').selectOption('30');
await shot(host, 'desktop-create-more');
await host.getByRole('button', { name: '创建房间', exact: true }).click();
await host.waitForURL(/\/share/);
const code = new URL(host.url()).searchParams.get('room');
const hostTok = await host.evaluate(c => localStorage.getItem(`night-table.host.${c}`), code);
const names = ['阿宁', '林川', '小满', '苏禾', '何夏', '周可'];
const phones = {}, toks = {}, ids = {};
for (const n of names) {
  const ctx = await phoneCtx(); const p = await ctx.newPage();
  await p.goto(`${phoneBase}/join?room=${code}`);
  await p.getByLabel('你的名字', { exact: true }).fill(n);
  await p.getByRole('button', { name: /^坐到/ }).click(); await p.waitForURL(/\/play/);
  phones[n] = p;
  toks[n] = await p.evaluate(() => localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('night-table.player.'))));
}
const get = async (tok = hostTok, sub = '') => (await host.request.get(`${base}/api/rooms/${code}${sub}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} })).json();
const post = async (tok, sub, data) => { const r = await host.request.post(`${base}/api/rooms/${code}${sub}`, { headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', Origin: base }, data }); const j = await r.json(); if (!r.ok()) throw new Error(`${sub} ${JSON.stringify(data)} → ${j.error}`); return j; };
const cmd = async (tok, type, args = {}) => post(tok, '/command', { type, args, version: (await get()).state.version, requestId: randomBytes(12).toString('hex') });
for (const n of names) ids[n] = (await get(toks[n])).playerId;
const nameOf = id => names.find(n => ids[n] === id);

async function step(style = 'mixed') {
  const v = await get(), s = v.state, h = s.hand;
  if (!h || h.phase === 'settled') return 'done';
  if (h.phase === 'roundEnd') { await cmd(hostTok, 'next'); return 'next'; }
  if (h.phase === 'showdown') { await cmd(hostTok, 'settle', { selections: h.selections, expectedTotal: potTotal(s) }); return 'settled'; }
  const n = nameOf(h.actor), l = (await get(toks[n])).legal, r = rnd(), pre = h.street === 0;
  let a = { action: l.check ? 'check' : 'call' };
  if (style === 'allin' ) a = { action: 'allin' };
  else if (!l.check && r < (pre ? .32 : .28)) a = { action: 'fold' };
  else if (l.raise && r > (pre ? .86 : .8)) a = { action: 'raise', to: Math.min(l.maxRaiseTo, Math.round((l.minRaiseTo * (1.2 + rnd())) / 10) * 10) };
  else if (r > .985) a = { action: 'allin' };
  if (a.action === 'call' && !l.canCall) a = { action: 'allin' };
  await cmd(toks[n], 'act', a);
  return 'act';
}
async function playHands(k, style) {
  for (let i = 0; i < k; i++) {
    for (const p of (await get()).state.players) if (p.stack === 0 && !p.leaving) await cmd(hostTok, 'rebuy', { playerId: p.id, amount: 2000 });
    await cmd(hostTok, 'start');
    for (let g = 0; g < 80 && (await step(style)) !== 'done'; g++);
  }
}
async function toActor(name, max = 40) { for (let g = 0; g < max; g++) { const h = (await get()).state.hand; if (h?.phase === 'betting' && h.actor === ids[name]) return; await step(); } }

await playHands(5);
await cmd(hostTok, 'rebuy', { playerId: ids['林川'], amount: 1000 });
await playHands(2);
// 第 8 手：行动计时 + 请求提醒。
await cmd(hostTok, 'start');
await toActor('小满');
await post(toks['何夏'], '/ask', {});
const claimCtx = await phoneCtx(); const claimer = await claimCtx.newPage();
await claimer.goto(`${phoneBase}/join?room=${code}`);
await claimer.locator('.claim-box summary').click();
await claimer.locator('.claim-who').filter({ hasText: '苏禾' }).click();
await shot(claimer, 'phone-claim-pick', 500);
await claimer.locator('.claim-box .btn').click();
await claimer.waitForSelector('.claim-wait');
await host.goto(`${base}/table?room=${code}`);
await wait(6000);
await shot(host, 'desktop-table-clock-alerts');
await shot(phones['小满'], 'phone-turn-clock');
await shot(claimer, 'phone-claim-wait', 300);
await host.locator('.alert').filter({ hasText: '苏禾' }).getByRole('button', { name: '不是本人' }).click();
await shot(claimer, 'phone-claim-denied');
await claimCtx.close();
await phones['阿宁'].getByRole('button', { name: '更多' }).click();
await shot(phones['阿宁'], 'phone-more-menu', 600);
await phones['阿宁'].keyboard.press('Escape');
for (let g = 0; g < 80 && (await step()) !== 'done'; g++);
await host.locator('.alert').filter({ hasText: '何夏' }).getByRole('button', { name: '补码', exact: true }).click();
await wait(400);
// 苏禾提前离席。
await phones['苏禾'].getByRole('button', { name: '更多' }).click();
await phones['苏禾'].getByRole('dialog').getByRole('button', { name: /^离开/ }).click();
await phones['苏禾'].getByRole('dialog').getByRole('button', { name: '确认离开', exact: true }).click();
await phones['苏禾'].waitForSelector('[data-testid=personal-summary]');
await shot(phones['苏禾'], 'phone-left-summary');
// 周可暂离一手，休息一下。
await cmd(toks['周可'], 'sitOut', { away: true });
await cmd(hostTok, 'start');
await toActor('阿宁');
await host.reload();
await host.getByRole('button', { name: /^休息/ }).click();
await wait(4000);
await shot(host, 'desktop-pause');
await shot(phones['阿宁'], 'phone-pause');
await host.getByRole('button', { name: '继续打牌' }).click();
for (let g = 0; g < 80 && (await step()) !== 'done'; g++);
await cmd(toks['周可'], 'sitOut', { away: false });
await playHands(4);
await cmd(hostTok, 'start');
for (let g = 0; g < 80 && (await step('allin')) !== 'done'; g++);
await playHands(2);
await host.goto(`${base}/manage?room=${code}`);
await shot(host, 'desktop-manage');
await host.goto(`${base}/hands?room=${code}`);
await host.locator('.hv-item').nth(3).click();
await shot(host, 'desktop-hands');
// 散场。
await host.goto(`${base}/table?room=${code}`);
await host.getByRole('button', { name: '散场', exact: true }).click();
await shot(host, 'desktop-end-confirm', 600);
await host.getByRole('dialog').getByRole('button', { name: '确认散场', exact: true }).click();
await host.waitForURL(/\/recap/);
await shot(host, 'desktop-recap', 1600);
const sum = await get(hostTok, '/summary');
const winner = sum.players[0].name, loser = sum.players.at(-1).name;
await shot(phones[winner], 'phone-summary-winner', 1400);
await shot(phones[loser], 'phone-summary-loser', 600);
await phones[winner].evaluate(() => window.scrollTo(0, 9999));
await shot(phones[winner], 'phone-summary-winner-scrolled', 600);
await host.getByRole('button', { name: '保存为图片' }).click();
await host.waitForSelector('dialog img.share-img');
await shot(host, 'desktop-recap-image', 800);
const dataUrl = await host.locator('dialog img.share-img').getAttribute('src');
if (!only || only.has('share-recap')) await writeFile(path.join(out, 'share-recap.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
await host.keyboard.press('Escape');
await phones[winner].getByRole('button', { name: '保存为图片' }).click();
await phones[winner].waitForSelector('dialog img.share-img');
const mine = await phones[winner].locator('dialog img.share-img').getAttribute('src');
if (!only || only.has('share-personal')) await writeFile(path.join(out, 'share-personal.png'), Buffer.from(mine.split(',')[1], 'base64'));
await shot(phones[winner], 'phone-share-image', 600);
await phones[winner].keyboard.press('Escape');
await phones[loser].goto(`${phoneBase}/hands?room=${code}`);
await shot(phones[loser], 'phone-hands');
await phones[loser].goto(`${phoneBase}/recap?room=${code}`);
await shot(phones[loser], 'phone-recap');
await host.goto(base);
await shot(host, 'desktop-home-history');
await host.goto(`${base}/recap?room=${code}`);
await host.getByRole('button', { name: '用同样设置再开一桌' }).click();
await host.waitForURL(/\/share/);
await shot(phones[loser], 'phone-recap-next', 1500);
await phones[winner].reload();
await shot(phones[winner], 'phone-summary-next', 1500);
await browser.close(); await server.close();
