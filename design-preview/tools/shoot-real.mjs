// 启动真实服务，按脚本打一手电子牌和一手实体牌，截桌面 1440×900@2x 与手机 390×844@3x 实机界面。
// 用法：node design-preview/tools/shoot-real.mjs <输出目录>
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, lanAddresses } from '../../server/index.js';

const out = path.resolve(process.argv[2] || 'night-table-v3-real');
await mkdir(out, { recursive: true });
const server = await createServer({ file: path.join(await mkdtemp(path.join(tmpdir(), 'nt-real-')), 'rooms.sqlite'), port: 0, rateLimit: false });
const base = `http://localhost:${server.port}`, phoneBase = `http://${lanAddresses()[0] || 'localhost'}:${server.port}`;
const browser = await chromium.launch();
const quiet = ctx => ctx.addInitScript(() => localStorage.setItem('night-table.sound', 'off'));
const settle = ms => new Promise(r => setTimeout(r, ms));
async function shot(page, name) { await settle(1300); await page.screenshot({ path: path.join(out, `${name}.png`) }); console.log('shot', name); }

async function room({ name, dealMode, names, rebuys = {} }) {
  const hostCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }); await quiet(hostCtx);
  const host = await hostCtx.newPage();
  await host.goto(base);
  await host.getByLabel('房间名', { exact: true }).fill(name);
  await host.getByLabel('小盲', { exact: true }).fill('10');
  await host.getByLabel('大盲', { exact: true }).fill('20');
  await host.getByLabel('起始筹码', { exact: true }).fill('2000');
  await host.getByLabel('打开补码').check();
  await host.getByRole('radio', { name: dealMode === 'digital' ? '电子牌' : '实体牌', exact: true }).check();
  if (dealMode === 'digital') await shot(host, 'desktop-create-room');
  await host.getByRole('button', { name: '创建房间', exact: true }).click();
  await host.waitForURL(/\/share/);
  const code = new URL(host.url()).searchParams.get('room');
  const phones = {};
  for (const n of names) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }); await quiet(ctx);
    const p = await ctx.newPage(); await p.goto(`${phoneBase}/join?room=${code}`);
    if (dealMode === 'digital' && n === names[names.length - 1]) await shot(p, 'phone-join');
    await p.getByLabel('你的名字', { exact: true }).fill(n);
    await p.getByRole('button', { name: /^坐到/ }).click(); await p.waitForURL(/\/play/);
    phones[n] = p;
  }
  if (dealMode === 'digital') { await host.reload(); await shot(host, 'desktop-share'); }
  const snap = async () => (await host.request.get(`${base}/api/rooms/${code}`)).json();
  await host.goto(`${base}/table?room=${code}`);
  if (Object.keys(rebuys).length) {
    await host.getByRole('button', { name: /^座位/ }).click();
    for (const [n, amount] of Object.entries(rebuys)) {
      const row = host.locator('.manage-row').filter({ hasText: n });
      await row.getByRole('spinbutton').fill(String(amount));
      await row.getByRole('button', { name: '补码', exact: true }).click();
      await settle(300);
    }
    await host.getByRole('link', { name: '返回牌桌', exact: true }).click();
  }
  const actor = async () => { const s = (await snap()).state; return s.hand?.actor ? s.players.find(p => p.id === s.hand.actor).name : null; };
  const act = async (n, label) => {
    const p = phones[n];
    if (label === 'fold') { await p.getByRole('button', { name: '弃牌', exact: true }).click(); await p.getByRole('dialog').getByRole('button', { name: '确认弃牌', exact: true }).click(); }
    else if (label === 'allin') { await p.getByRole('button', { name: /^全下 / }).click(); await p.getByRole('dialog').getByRole('button', { name: '确认全下', exact: true }).click(); }
    else if (label === 'passive') { const b = p.getByRole('button', { name: /^(过牌|跟注 )/ }).first(); await b.click(); }
    else if (typeof label === 'number') { await p.getByRole('button', { name: /^(加注|下注)$/ }).click(); await p.getByRole('spinbutton', { name: /^(加注|下注)到$/ }).fill(String(label)); await p.locator('#raise-submit').click(); }
    const before = (await snap()).state.version; await settle(250);
    for (let i = 0; i < 20 && (await snap()).state.version === before; i++) await settle(100);
  };
  const nextStreet = async () => { await host.getByRole('button', { name: /^下一轮/ }).click(); await settle(500); };
  return { host, phones, code, snap, actor, act, nextStreet, base };
}

// ── 电子牌：6 人，翻牌圈进行中 → 全下摊牌分池
{
  const r = await room({ name: '周六夜席', dealMode: 'digital', names: ['阿宁', '林川', '小满', '苏禾', '何夏', '周可'], rebuys: { 阿宁: 600, 林川: 600 } });
  await r.host.getByRole('button', { name: /^新的一手/ }).click(); await settle(800);
  for (let a; (a = await r.actor());) await r.act(a, a === '苏禾' ? 'fold' : 'passive');
  await r.nextStreet();
  let bet = false;
  for (let a; (a = await r.actor());) {
    if (bet && a === '小满') break;
    if (!bet && a === '阿宁') { await r.act(a, 120); bet = true; } else await r.act(a, 'passive');
  }
  await shot(r.host, 'desktop-digital-flop');
  await shot(r.phones['小满'], 'phone-digital-action');
  await r.phones['小满'].getByRole('button', { name: /^(加注|下注)$/ }).click();
  await r.phones['小满'].getByRole('spinbutton', { name: /^(加注|下注)到$/ }).fill('480');
  await r.phones['小满'].locator('#raise-amount').dispatchEvent('input');
  await shot(r.phones['小满'], 'phone-digital-raise');
  await r.phones['小满'].getByRole('button', { name: '取消', exact: true }).click();
  await shot(r.phones['阿宁'], 'phone-digital-waiting');
  { const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }); await quiet(c); const sp = await c.newPage(); await sp.goto(`${phoneBase}/table?room=${r.code}`); await shot(sp, 'phone-spectator-table'); await c.close(); }
  for (let a; (a = await r.actor());) await r.act(a, ['小满', '阿宁', '林川'].includes(a) ? 'allin' : 'fold');
  for (let i = 0; i < 6 && (await r.snap()).state.hand.phase !== 'showdown'; i++) { if ((await r.snap()).state.hand.phase === 'roundEnd') await r.nextStreet(); else await settle(400); }
  await settle(2500);
  await shot(r.host, 'desktop-digital-showdown');
  await r.host.getByRole('button', { name: /^分池/ }).click(); await r.host.waitForURL(/\/settle/);
  await shot(r.host, 'desktop-digital-settle');
  await shot(r.phones['小满'], 'phone-digital-showdown');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }); await quiet(ctx);
  const ph = await ctx.newPage(); await ph.goto(base); await shot(ph, 'phone-create-room');
}
// ── 实体牌：4 人，翻牌圈 → 全下 → 主持指定主池/边池赢家
{
  const r = await room({ name: '周五实体局', dealMode: 'physical', names: ['阿宁', '林川', '小满', '何夏'], rebuys: { 林川: 600, 何夏: 600 } });
  await r.host.getByRole('button', { name: /^新的一手/ }).click(); await settle(800);
  for (let a; (a = await r.actor());) await r.act(a, 'passive');
  await r.nextStreet();
  let bet = false;
  for (let a; (a = await r.actor());) {
    if (bet) break;
    if (a === '林川') { await r.act(a, 80); bet = true; } else await r.act(a, 'passive');
  }
  const who = await r.actor();
  await shot(r.host, 'desktop-physical-flop');
  await shot(r.phones[who], 'phone-physical-action');
  for (let a; (a = await r.actor());) await r.act(a, 'allin');
  for (let i = 0; i < 8 && (await r.snap()).state.hand.phase !== 'showdown'; i++) { if ((await r.snap()).state.hand.phase === 'roundEnd') await r.nextStreet(); else await settle(400); }
  await r.host.getByRole('button', { name: /^分池/ }).click(); await r.host.waitForURL(/\/settle/);
  await r.host.locator('.winner').filter({ hasText: '小满' }).click();
  await r.host.locator('.potpick button').filter({ hasText: '边池' }).click();
  await r.host.locator('.winner').filter({ hasText: '林川' }).click();
  await shot(r.host, 'desktop-physical-settle');
  await shot(r.phones['小满'], 'phone-physical-showdown');
}
await browser.close(); await server.close();
