import { test, expect } from '@playwright/test';
import { createServer, lanAddresses } from '../server/index.js';
import { freshToken } from '../server/store.js';
import { randomUUID } from 'node:crypto';
import { potTotal } from '../server/engine.js';
import { makeDeck, setNextDeck } from '../server/cards.js';

let app, base;
test.beforeAll(async () => { app = await createServer({ file: ':memory:', port: 0 }); base = `http://${lanAddresses()[0] || '127.0.0.1'}:${app.port}`; });
test.afterAll(async () => { await app.close(); });
function fixture({ names = ['阿宁', '林川'], digital = true } = {}) {
  const f = app.store.create({ dealMode: digital ? 'digital' : 'physical', name: '<b>夜席</b>', startingStack: 1000 });
  f.tokens = names.map(() => freshToken());
  f.tokens.forEach((token, i) => app.store.join(f.code, { token, name: names[i], seat: i + 1 }));
  f.state = () => app.store.get(f.code).state;
  f.command = (type, args = {}, token = f.token) => { app.store.command(f.code, token, { type, args, version: f.state().version, requestId: randomUUID() }); app.broadcast(f.code); };
  return f;
}
async function login(page, f, role = 'player', token = f.tokens[0]) {
  await page.addInitScript(({ code, role, token }) => {
    localStorage.setItem(`night-table.${role}.${code}`, token);
    localStorage.setItem('night-table.sound', 'off'); localStorage.setItem('night-table.awake', 'off');
  }, { code: f.code, role, token });
}

test('audit: first snapshot failure retries automatically and restores the player without refresh', async ({ page }) => {
  const f = fixture(); f.command('start'); await login(page, f);
  let attempts = 0;
  await page.route(`**/api/rooms/${f.code}`, route => { attempts++; return attempts <= 2 ? route.abort('failed') : route.continue(); });
  await page.goto(`${base}/play?room=${f.code}`);
  await expect(page.getByRole('status').filter({ hasText: /连接|重试/ }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: '轮到你', exact: true })).toBeVisible({ timeout: 12000 });
  expect(attempts).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId('hole-cards')).toBeVisible();
});

test('audit: WebSocket retry backs off and an offline phone recovers without reloading', async ({ page, context }) => {
  const f = fixture(); f.command('start'); await login(page, f);
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.attemptTimes = []; window.blockSockets = true;
    window.WebSocket = class extends Real {
      constructor(url, protocols) { window.attemptTimes.push(performance.now()); super(window.blockSockets ? url.replace('/ws', '/bad-ws') : url, protocols); }
    };
  });
  await page.goto(`${base}/play?room=${f.code}`);
  await expect.poll(() => page.evaluate(() => window.attemptTimes.length), { timeout: 12000 }).toBeGreaterThanOrEqual(4);
  const times = await page.evaluate(() => window.attemptTimes);
  expect(times[3] - times[2]).toBeGreaterThan((times[1] - times[0]) * 2);
  await page.evaluate(() => { window.blockSockets = false; dispatchEvent(new Event('online')); });
  await expect(page.getByRole('button', { name: '跟注 10', exact: true })).toBeEnabled();
  const before = f.state();
  await context.setOffline(true);
  await expect(page.locator('.connection')).toContainText(/网络|连接/);
  await expect(page.getByRole('button', { name: '跟注 10', exact: true })).toBeDisabled();
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: '跟注 10', exact: true })).toBeEnabled();
  expect(f.state()).toEqual(before);
});

test('audit: 320px long names and large stacks remain visible with keyboard focus, readable controls and reduced motion', async ({ page }, info) => {
  const f = fixture({ names: ['一二三四五六七八', '<b>甲</b>'] });
  const raw = app.store.get(f.code); raw.state.players[0].stack = 1_000_000_000; raw.state.total += 999_999_000; raw.state.roster[raw.state.players[0].id].buyIn = 1_000_000_000; app.store.save(raw);
  const prefix = ['As', 'Kh', 'Ad', 'Kd']; setNextDeck([...prefix, ...makeDeck().filter(c => !prefix.includes(c))]);
  f.command('start'); await login(page, f); await page.setViewportSize({ width: 320, height: 667 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${base}/play?room=${f.code}`);
  await expect(page.getByRole('heading', { name: '轮到你', exact: true })).toHaveAttribute('aria-live', 'assertive');
  await expect(page.locator('.opp .n')).toHaveText('<b>甲</b>'); await expect(page.locator('.opp .n b')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await page.locator('.hero .made').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(320);
  const button = page.getByRole('button', { name: '加注', exact: true }); await button.focus();
  expect(await button.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
  app.broadcast(f.code); await expect(button).toBeFocused();
  for (const button of await page.getByRole('button').all()) await expect(button).toHaveAccessibleName(/.+/);
  const animations = await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length); expect(animations).toBe(0);
  await page.screenshot({ path: info.outputPath('audit-phone-320.png'), fullPage: true });
});

test('audit: 160-hand replay renders on a 320px LAN browser and exposes only public cards', async ({ page }, info) => {
  const f = fixture();
  for (let n = 0; n < 160; n++) {
    f.command('start'); f.command('act', { action: 'fold' }, f.tokens[f.state().players.findIndex(p => p.id === f.state().hand.actor)]);
    f.command('settle', { selections: f.state().hand.selections, expectedTotal: potTotal(f.state()) });
  }
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 320, height: 667 }); const begin = Date.now();
  await page.goto(`${base}/hands?room=${f.code}`);
  await expect(page.locator('.hv-item')).toHaveCount(160);
  await page.locator('.hv-item').last().click(); await expect(page.getByRole('heading', { name: '第 1 手', exact: true })).toBeVisible();
  await expect(page.locator('.hv-cards')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await info.attach('replay-measurement', { body: JSON.stringify({ hands: 160, elapsedMs: Date.now() - begin, width: 320 }), contentType: 'application/json' });
});
