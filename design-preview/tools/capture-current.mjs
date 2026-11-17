// Captures the current (v2) UI for the design audit. Not part of the test suite.
import { chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../../server/index.js';
const out = process.argv[2] || 'design-preview/out/before';
const dir = await mkdtemp(path.join(tmpdir(), 'nt-cap-'));
const server = await createServer({ file: path.join(dir, 'r.sqlite'), port: 0, host: '127.0.0.1', rateLimit: false });
const base = `http://localhost:${server.port}`;
const browser = await chromium.launch();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function room(mode, names, shotCreate) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => localStorage.setItem('night-table.sound', 'off'));
  const page = await ctx.newPage();
  await page.goto(base);
  await page.getByLabel('房间名', { exact: true }).fill('周六夜席');
  if (shotCreate) await page.screenshot({ path: `${out}/create-desktop.png`, fullPage: true });
  await page.getByRole('radio', { name: mode, exact: true }).check();
  await page.getByRole('button', { name: '创建房间', exact: true }).click();
  await page.waitForURL(/\/share\?room=/);
  const code = new URL(page.url()).searchParams.get('room');
  const phones = [];
  for (const name of names) {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 });
    await c.addInitScript(() => localStorage.setItem('night-table.sound', 'off'));
    const p = await c.newPage(); await p.goto(`${base}/join?room=${code}`);
    if (shotCreate && phones.length === 0) await p.screenshot({ path: `${out}/join-phone.png`, fullPage: true });
    await p.getByLabel('你的名字', { exact: true }).fill(name);
    await p.getByRole('button', { name: /^坐到/ }).click(); await p.waitForURL(/\/play/);
    phones.push(p);
  }
  if (shotCreate) { await page.reload(); await sleep(500); await page.screenshot({ path: `${out}/share-desktop.png`, fullPage: true }); }
  await page.goto(`${base}/table?room=${code}`);
  await page.getByRole('button', { name: /^新的一手/ }).click();
  const snap = async () => (await page.request.get(`${base}/api/rooms/${code}`)).json();
  return { page, phones, code, snap };
}
async function actUntil(r, done, prefer = ['过牌', /^跟注/]) {
  for (let i = 0; i < 60; i++) {
    const s = await r.snap(); if (done(s)) return;
    let acted = false;
    for (const p of r.phones) {
      if (await p.getByRole('heading', { name: '轮到你', exact: true }).isVisible().catch(() => false)) {
        for (const name of prefer) { const b = p.getByRole('button', { name, exact: typeof name === 'string' }); if (await b.count() && await b.first().isEnabled()) { await b.first().click(); acted = true; break; } }
        if (acted) break;
      }
    }
    if (!acted) { const nb = r.page.getByRole('button', { name: /^下一轮/ }); if (await nb.count() && await nb.isEnabled()) await nb.click(); }
    await sleep(350);
  }
}
const names = ['阿宁', '林川', '小满', '周可', '何麦', '苏禾'];
// digital, 6 players, flop in progress
const d = await room('电子牌', names, true);
await sleep(1200);
await actUntil(d, s => s.state.hand.street >= 1);
await sleep(1500);
await d.page.screenshot({ path: `${out}/table-digital-flop.png`, fullPage: true });
for (const p of d.phones) if (await p.getByRole('heading', { name: '轮到你', exact: true }).isVisible().catch(() => false)) { await p.screenshot({ path: `${out}/phone-turn-digital.png`, fullPage: true }); break; }
await d.phones[5].screenshot({ path: `${out}/phone-waiting-digital.png`, fullPage: true });
await actUntil(d, s => ['showdown', 'settled'].includes(s.state.hand.phase));
await sleep(1500);
await d.page.screenshot({ path: `${out}/table-digital-showdown.png`, fullPage: true });
const sb = d.page.getByRole('button', { name: /^分池/ }); if (await sb.count()) { await sb.click(); await sleep(800); await d.page.screenshot({ path: `${out}/settle-digital.png`, fullPage: true }); }
// physical, 4 players
const ph = await room('实体牌', names.slice(0, 4), false);
await sleep(800);
await ph.page.screenshot({ path: `${out}/table-physical-preflop.png`, fullPage: true });
for (const p of ph.phones) if (await p.getByRole('heading', { name: '轮到你', exact: true }).isVisible().catch(() => false)) { await p.screenshot({ path: `${out}/phone-turn-physical.png`, fullPage: true }); break; }
await actUntil(ph, s => s.state.hand.phase === 'showdown');
const sp = ph.page.getByRole('button', { name: /^分池/ }); if (await sp.count()) { await sp.click(); await sleep(600); await ph.page.locator('.winner').first().click(); await sleep(400); await ph.page.screenshot({ path: `${out}/settle-physical.png`, fullPage: true }); }
await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true });
console.log('done');
