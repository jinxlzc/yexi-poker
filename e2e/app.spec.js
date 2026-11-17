import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { createServer, lanAddresses } from '../server/index.js';

let server, dir, base, phoneBase;
test.beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'night-table-e2e-'));
  server = await createServer({ file: path.join(dir, 'rooms.sqlite'), port: 0 });
  base = `http://localhost:${server.port}`;
  phoneBase = `http://${lanAddresses()[0] || 'localhost'}:${server.port}`;
});
test.afterAll(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
async function setup(page, browser, config = {}) {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('night-table.sound', 'off'));
  await page.goto(base);
  await page.getByLabel('房间名', { exact: true }).fill('朋友的夜席');
  if (config.smallBlind) await page.getByLabel('小盲', { exact: true }).fill(String(config.smallBlind));
  if (config.bigBlind) await page.getByLabel('大盲', { exact: true }).fill(String(config.bigBlind));
  if (config.startingStack) await page.getByLabel('起始筹码', { exact: true }).fill(String(config.startingStack));
  if (config.rebuy) await page.getByLabel('打开补码', { exact: false }).check();
  if (config.runouts) {
    await page.locator('.more-set summary').click();
    await page.locator('[name=runouts]').selectOption(String(config.runouts));
  }
  if (config.dealMode === 'digital') await page.getByRole('radio', { name: '电子牌', exact: true }).check();
  else await page.getByRole('radio', { name: '实体牌', exact: true }).check();
  await page.getByRole('button', { name: '创建房间', exact: true }).click();
  await expect(page).toHaveURL(/\/share\?room=/);
  const code = new URL(page.url()).searchParams.get('room');
  const contexts = [], phones = [];
  for (const name of config.names || ['阿宁', '林川', '小满']) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 375, height: 667 }, isMobile: true, deviceScaleFactor: 1 });
    await context.addInitScript(() => localStorage.setItem('night-table.sound', 'off'));
    contexts.push(context);
    const phone = await context.newPage(); phones.push(phone); phone.on('pageerror', e => errors.push(e.message));
    await phone.goto(`${phoneBase}/join?room=${code}`);
    await phone.getByLabel('你的名字', { exact: true }).fill(name);
    await phone.getByRole('button', { name: /^坐到/ }).click();
    await expect(phone).toHaveURL(/\/play/);
    await expect(phone.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  return { code, phones, contexts, errors, async close() { for (const context of contexts) await context.close(); },
    async table() { await page.goto(`${base}/table?room=${code}`); await expect(page.getByRole('button', { name: /^新的一手/ })).toBeEnabled(); },
    async snapshot() { return (await page.request.get(`${base}/api/rooms/${code}`)).json(); }
  };
}
async function clickAction(phone, name) { await expect(phone.getByRole('button', { name, exact: true })).toBeEnabled(); await phone.getByRole('button', { name, exact: true }).click(); }
test('real QR, mobile play, manual streets, split odd chips, shared preview, settlement and undo', async ({ page, browser }, info) => {
  const f = await setup(page, browser, { smallBlind: 1, bigBlind: 2, startingStack: 100 });
  try {
    const qr = page.locator('.qrbox img'); await expect(qr).toBeVisible();
    const png = PNG.sync.read(await qr.screenshot());
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(decoded?.data).toBe(`${phoneBase}/join?room=${f.code}`);
    expect(decoded.data).not.toMatch(/token|host|secret/);
    await page.screenshot({ path: info.outputPath('share.png'), fullPage: true });
    await f.table(); await page.getByRole('button', { name: /^新的一手/ }).click();
    const [a, b, c] = f.phones;
    await expect(a.getByRole('heading', { name: '轮到你', exact: true })).toBeVisible();
    await expect(a.getByRole('button', { name: /撤销|分池|新的一手/ })).toHaveCount(0);
    const callBox = await a.getByRole('button', { name: '跟注 2', exact: true }).boundingBox(); expect(callBox.y + callBox.height).toBeLessThanOrEqual(667);
    await a.screenshot({ path: info.outputPath('phone-action.png'), fullPage: true });
    await clickAction(a, '跟注 2');
    await clickAction(b, '弃牌');
    await expect(b.getByRole('dialog')).toBeVisible(); await expect(b.getByRole('button', { name: '返回', exact: true })).toBeFocused();
    expect((await f.snapshot()).state.players[1].folded).toBe(false);
    await clickAction(b, '确认弃牌'); await clickAction(c, '过牌');
    await expect(page.getByRole('heading', { name: '这一轮结束 · 请看牌', exact: true })).toBeVisible();
    expect((await f.snapshot()).state.hand.street).toBe(0);
    for (let street = 1; street <= 3; street++) {
      await page.getByRole('button', { name: /^下一轮/ }).click();
      await clickAction(c, '过牌'); await clickAction(a, '过牌');
      await expect.poll(async () => (await f.snapshot()).state.hand.phase).toBe(street === 3 ? 'showdown' : 'roundEnd');
    }
    await page.getByRole('button', { name: /^分池/ }).click();
    await expect(page.getByRole('heading', { name: '指定每个池的赢家' })).toBeVisible();
    await expect(page.getByRole('button', { name: '确认这样分池', exact: true })).toBeDisabled();
    await page.locator('.winner').filter({ hasText: '阿宁' }).click();
    await expect(page.locator('.winner').filter({ hasText: '小满' })).toBeEnabled();
    await page.locator('.winner').filter({ hasText: '小满' }).click();
    await expect(page.locator('.remainder')).toContainText('余数按顺序给：小满');
    await expect(c.locator('.waitblock')).toContainText('预览里你是 +3');
    await expect(page.locator('.locked')).toContainText('林川');
    await page.screenshot({ path: info.outputPath('settlement.png'), fullPage: true });
    await page.getByRole('button', { name: '确认这样分池', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('全场仍是 300');
    await page.getByRole('dialog').getByRole('button', { name: '确认这样分池', exact: true }).click();
    await expect(page).toHaveURL(/\/table/);
    await expect(c.getByTestId('my-stack')).toHaveText('101');
    expect((await f.snapshot()).state.players.map(p => p.stack)).toEqual([100, 99, 101]);
    await page.getByRole('button', { name: /^撤销上一步/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认撤销', exact: true }).click();
    await expect.poll(async () => (await f.snapshot()).state.hand.phase).toBe('showdown');
    await c.reload(); await expect(c.getByTestId('my-stack')).toHaveText('98');
    await expect(c.locator('.waitblock')).toContainText('主持人正在分池');
    await page.screenshot({ path: info.outputPath('table.png'), fullPage: true });
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
test('raise validation, cancel, all-in confirmation, refresh/reconnect, and permission denial', async ({ page, browser }, info) => {
  const f = await setup(page, browser);
  try {
    await f.table(); await page.getByRole('button', { name: /^新的一手/ }).click();
    const [a, b] = f.phones;
    await clickAction(a, '加注');
    const initial = await f.snapshot();
    await a.getByRole('spinbutton', { name: '加注到', exact: true }).fill('39');
    await expect(a.locator('#raise-submit')).toBeDisabled();
    await a.getByRole('spinbutton', { name: '加注到', exact: true }).fill('60.5'); await expect(a.locator('#raise-submit')).toBeDisabled();
    await a.getByRole('spinbutton', { name: '加注到', exact: true }).fill('60'); await expect(a.locator('#raise-submit')).toBeEnabled();
    await a.screenshot({ path: info.outputPath('raise.png'), fullPage: true });
    await clickAction(a, '取消'); expect((await f.snapshot()).state).toEqual(initial.state);
    await clickAction(a, '加注'); await a.getByRole('spinbutton', { name: '加注到', exact: true }).fill('60'); await clickAction(a, '确认加注到 60');
    await expect(b.getByRole('heading', { name: '轮到你', exact: true })).toBeVisible();
    await clickAction(b, '全下 1,990');
    expect((await f.snapshot()).state.players[1].stack).toBe(1990);
    await clickAction(b, '返回');
    await b.reload(); await expect(b.getByRole('heading', { name: '轮到你', exact: true })).toBeVisible();
    await f.contexts[1].setOffline(true);
    await expect(page.getByRole('heading', { name: '林川不在线', exact: true })).toBeVisible();
    const whileOffline = (await f.snapshot()).state;
    expect(whileOffline.players[1].folded).toBe(false);
    await f.contexts[1].setOffline(false); await b.reload();
    await expect(b.getByRole('button', { name: '跟注 50', exact: true })).toBeVisible();
    expect((await f.snapshot()).state).toEqual(whileOffline);
    await b.goto(`${phoneBase}/settle?room=${f.code}`);
    await expect(b.locator('#toast')).toContainText('没有主持权限');
    await expect(b.locator('.winner')).toHaveCount(0);
    await expect(b.getByRole('button', { name: /撤销|分池|新的一手/ })).toHaveCount(0);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
test('heads-up markers, 320px and 10-player layouts, spectator view, and local-only host creation', async ({ page, browser }, info) => {
  const f = await setup(page, browser, { names: ['周可', '何麦'], rebuy: true });
  const extra = [];
  try {
    await f.table(); await page.getByRole('button', { name: /^新的一手/ }).click();
    await expect(page.locator('.seat').filter({ hasText: '周可' }).locator('.mark')).toHaveText(['庄', '小']);
    await expect(f.phones[0].getByRole('heading', { name: '轮到你', exact: true })).toBeVisible();
    await f.phones[0].setViewportSize({ width: 320, height: 667 });
    expect(await f.phones[0].evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await f.phones[0].screenshot({ path: info.outputPath('phone-320.png'), fullPage: true });
    await page.screenshot({ path: info.outputPath('heads-up.png'), fullPage: true });
    await page.getByRole('button', { name: /^撤销上一步/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认撤销', exact: true }).click();
    for (let i = 3; i <= 10; i++) {
      const token = (await import('node:crypto')).randomBytes(32).toString('hex');
      const result = await page.request.post(`${base}/api/rooms/${f.code}/join`, { data: { name: `同桌${i}`, seat: i, token } }); expect(result.ok()).toBe(true);
    }
    await expect(page.locator('.seat')).toHaveCount(10);
    await page.getByRole('button', { name: /^新的一手/ }).click();
    await page.screenshot({ path: info.outputPath('ten-seats.png'), fullPage: true });
    const boxes = await page.locator('.seat').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(boxes[i].right <= boxes[j].x || boxes[j].right <= boxes[i].x || boxes[i].bottom <= boxes[j].y || boxes[j].bottom <= boxes[i].y).toBe(true);
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 375, height: 667 } }); extra.push(context);
    const spectator = await context.newPage(); await spectator.goto(`${phoneBase}/table?room=${f.code}`);
    await expect(spectator.getByRole('link', { name: '我要加入', exact: true })).toBeVisible();
    await expect(spectator.locator('.hostbar')).toHaveCount(0);
    expect(await spectator.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await spectator.goto(phoneBase);
    if (phoneBase !== base && !phoneBase.includes('localhost')) {
      await expect(spectator.getByRole('heading', { name: '加入牌桌', exact: true })).toBeVisible();
      await expect(spectator.getByRole('button', { name: '创建房间', exact: true })).toHaveCount(0);
      const response = await spectator.request.post(`${phoneBase}/api/rooms`, { data: {} }); expect(response.status()).toBe(403);
    }
    expect(f.errors).toEqual([]);
  } finally { await f.close(); for (const c of extra) await c.close(); }
});

test('host rebuy creates unequal stacks, selects different side-pot winners, settles and undoes', async ({ page, browser }, info) => {
  const f = await setup(page, browser, { startingStack: 100, rebuy: true, runouts: 1 });
  try {
    await f.table(); await page.getByRole('button', { name: /^座位/ }).click();
    for (const [name, amount] of [['林川', 100], ['小满', 200]]) {
      const row = page.locator('.manage-row').filter({ hasText: name });
      await row.getByRole('spinbutton').fill(String(amount));
      await row.getByRole('button', { name: '补码', exact: true }).click();
      await expect.poll(async () => (await f.snapshot()).state.players.find(p => p.name === name).stack).toBe(100 + amount);
    }
    await page.getByRole('link', { name: '返回牌桌', exact: true }).click();
    await page.getByRole('button', { name: /^新的一手/ }).click();
    for (let i = 0; i < f.phones.length; i++) {
      const phone = f.phones[i];
      await expect(phone.getByRole('button', { name: /^全下 / })).toBeEnabled();
      await phone.getByRole('button', { name: /^全下 / }).click();
      await phone.getByRole('dialog').getByRole('button', { name: '确认全下', exact: true }).click();
    }
    await expect(page.getByRole('button', { name: /^分池/ })).toBeEnabled();
    await page.getByRole('button', { name: /^分池/ }).click();
    await expect(page.locator('.potpick button')).toHaveCount(2);
    await page.locator('.winner').filter({ hasText: '阿宁' }).click();
    await page.locator('.potpick button').filter({ hasText: '边池' }).click();
    await expect(page.locator('.winner').filter({ hasText: '阿宁' })).toHaveCount(0);
    await expect(page.locator('.locked')).toContainText('未投入这个池');
    await page.locator('.winner').filter({ hasText: '林川' }).click();
    await expect(page.locator('.balance-foot')).toContainText('分出 500');
    await page.screenshot({ path: info.outputPath('side-pots.png'), fullPage: true });
    await page.getByRole('button', { name: '确认这样分池', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认这样分池', exact: true }).click();
    await expect.poll(async () => (await f.snapshot()).state.hand.phase).toBe('settled');
    expect((await f.snapshot()).state.players.map(p => p.stack)).toEqual([300, 200, 100]);
    await page.getByRole('button', { name: /^撤销上一步/ }).click();
    await page.getByRole('button', { name: '确认撤销', exact: true }).click();
    await expect.poll(async () => (await f.snapshot()).pots.map(p => p.amount)).toEqual([300, 200]);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('digital mode: private hole cards, board after all-in, auto judgment and conserved settlement', async ({ page, browser }, info) => {
  const f = await setup(page, browser, { names: ['阿宁', '林川'], dealMode: 'digital', smallBlind: 10, bigBlind: 20, startingStack: 100, runouts: 1 });
  try {
    await f.table();
    await page.getByRole('button', { name: /^新的一手/ }).click();
    await expect(page.locator('.seat-holes .npcard')).toHaveCount(4);
    await expect(page.locator('.seat-holes [data-card="back"]')).toHaveCount(4);
    const tokenOf = async (target, prefix) => target.evaluate(p => { const key = Object.keys(localStorage).find(k => k.startsWith(p)); return localStorage.getItem(key); }, prefix);
    const hostTok = await tokenOf(page, 'night-table.host.');
    const aTok = await tokenOf(f.phones[0], 'night-table.player.');
    const bTok = await tokenOf(f.phones[1], 'night-table.player.');
    const view = async token => (await page.request.get(`${base}/api/rooms/${f.code}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })).json();
    const aView = await view(aTok), bView = await view(bTok), hView = await view(hostTok), gView = await view('');
    expect(aView.hole).toHaveLength(2);
    expect(bView.hole).toHaveLength(2);
    expect(hView.hole).toBeNull();
    expect(gView.hole).toBeNull();
    const secret = [...aView.hole, ...bView.hole];
    for (const card of secret) {
      expect(JSON.stringify(hView).includes(`"${card}"`)).toBe(false);
      expect(JSON.stringify(gView).includes(`"${card}"`)).toBe(false);
    }
    for (const card of bView.hole.filter(c => !aView.hole.includes(c))) expect(JSON.stringify(aView).includes(`"${card}"`)).toBe(false);
    await expect(f.phones[0].getByTestId('hole-cards')).toBeVisible();
    const aDom = await f.phones[0].locator('[data-testid=hole-cards] [data-card]').evaluateAll(els => els.map(e => e.getAttribute('data-card')));
    expect([...aDom].sort()).toEqual([...aView.hole].sort());
    const bHtml = await f.phones[1].content();
    const tableHtml = await page.content();
    for (const card of aView.hole.filter(c => !bView.hole.includes(c))) expect(bHtml).not.toContain(`data-card="${card}"`);
    for (const card of secret) expect(tableHtml).not.toContain(`data-card="${card}"`);
    const clickAllin = async phone => {
      const button = phone.getByRole('button', { name: /^全下 / });
      await expect(button).toBeEnabled();
      await button.click();
      await phone.getByRole('dialog').getByRole('button', { name: '确认全下', exact: true }).click();
    };
    await clickAllin(f.phones[0]);
    await clickAllin(f.phones[1]);
    await expect.poll(async () => (await f.snapshot()).state.hand.phase).toBe('showdown');
    expect((await f.snapshot()).state.hand.board).toHaveLength(5);
    await expect(page.locator('.board-slot [data-card]:not([data-card="back"])')).toHaveCount(5);
    await page.getByRole('button', { name: /^分池/ }).click();
    await expect(page.getByRole('heading', { name: '系统已按牌力判定' })).toBeVisible();
    await expect(page.locator('.winner[data-do="winner"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '确认这样分池', exact: true })).toBeEnabled();
    const total = (await f.snapshot()).state.total;
    await page.getByRole('button', { name: '确认这样分池', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认这样分池', exact: true }).click();
    await expect.poll(async () => (await f.snapshot()).state.hand.phase).toBe('settled');
    const settled = await f.snapshot();
    expect(settled.state.players.reduce((sum, pl) => sum + pl.stack, 0)).toBe(total);
    expect(settled.state.players.reduce((sum, pl) => sum + pl.contribution, 0)).toBe(0);
    // Settlement redirects to /table; do not start a screenshot in the outgoing document.
    await expect(page).toHaveURL(/\/table\?room=/);
    await expect(page.locator('.tablepage .arena')).toBeVisible();
    await page.screenshot({ path: info.outputPath('digital-settled.png'), fullPage: true });
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
