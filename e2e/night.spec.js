// v4：散场总结、提前离席的个人总结、换手机认领座位。
import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, lanAddresses } from '../server/index.js';

let server, dir, base, phoneBase;
test.beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'night-table-v4-'));
  server = await createServer({ file: path.join(dir, 'rooms.sqlite'), port: 0 });
  base = `http://localhost:${server.port}`;
  phoneBase = `http://${lanAddresses()[0] || 'localhost'}:${server.port}`;
});
test.afterAll(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });

const signed = v => (v > 0 ? `+${v.toLocaleString('en-US')}` : v < 0 ? `−${(-v).toLocaleString('en-US')}` : '±0');
async function phoneFor(name, browser, f) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 });
  await context.addInitScript(() => localStorage.setItem('night-table.sound', 'off'));
  f.contexts.push(context);
  const phone = await context.newPage(); phone.on('pageerror', e => f.errors.push(e.message));
  return phone;
}
async function setup(page, browser, { names = ['阿宁', '林川', '小满'], rebuy = true } = {}) {
  const f = { contexts: [], phones: [], errors: [] };
  page.on('pageerror', e => f.errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('night-table.sound', 'off'));
  await page.goto(base);
  await page.getByLabel('房间名', { exact: true }).fill('周五夜席');
  await page.getByLabel('小盲', { exact: true }).fill('5');
  await page.getByLabel('大盲', { exact: true }).fill('10');
  await page.getByLabel('起始筹码', { exact: true }).fill('200');
  if (rebuy) await page.getByLabel('打开补码', { exact: false }).check();
  await page.getByRole('radio', { name: '电子牌', exact: true }).check();
  await page.getByRole('button', { name: '创建房间', exact: true }).click();
  await expect(page).toHaveURL(/\/share\?room=/);
  f.code = new URL(page.url()).searchParams.get('room');
  for (const name of names) {
    const phone = await phoneFor(name, browser, f); f.phones.push(phone);
    await phone.goto(`${phoneBase}/join?room=${f.code}`);
    await phone.getByLabel('你的名字', { exact: true }).fill(name);
    await phone.getByRole('button', { name: /^坐到/ }).click();
    await expect(phone).toHaveURL(/\/play/);
  }
  f.snapshot = async () => (await page.request.get(`${base}/api/rooms/${f.code}`)).json();
  f.summary = async () => (await page.request.get(`${base}/api/rooms/${f.code}/summary`)).json();
  f.byName = name => f.phones[names.indexOf(name)];
  f.close = async () => { for (const c of f.contexts) await c.close(); };
  await page.goto(`${base}/table?room=${f.code}`);
  return f;
}
// 由当前行动者在自己手机上点按钮，直到这一手只剩一人或进入摊牌。
async function foldAround(f) {
  for (let guard = 0; guard < 12; guard++) {
    const { state } = await f.snapshot();
    if (state.hand.phase !== 'betting') return;
    const actor = state.players.find(p => p.id === state.hand.actor);
    const phone = f.byName(actor.name);
    const fold = phone.getByRole('button', { name: '弃牌', exact: true });
    await expect(fold).toBeEnabled();
    await fold.click();
    await phone.getByRole('dialog').getByRole('button', { name: /^确认弃牌|^弃牌/ }).click();
    await expect.poll(async () => (await f.snapshot()).state.version).toBeGreaterThan(state.version);
  }
}
async function playHand(page, f) {
  await page.getByRole('button', { name: /^新的一手/ }).click();
  await expect.poll(async () => (await f.snapshot()).state.hand?.phase).toBe('betting');
  await foldAround(f);
  await expect.poll(async () => (await f.snapshot()).state.hand.phase).toBe('showdown');
  await page.getByRole('button', { name: /^分池/ }).click();
  await page.getByRole('button', { name: '确认这样分池', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认这样分池', exact: true }).click();
  await expect.poll(async () => (await f.snapshot()).state.hand.phase).toBe('settled');
  await page.waitForURL(/\/table\?room=/);
  await expect(page.getByRole('button', { name: /^新的一手/ })).toBeEnabled();
}

test('end the night: personal summaries on every phone, big-screen ranking, conservation, copy/image, history and same-settings rematch', async ({ page, browser }) => {
  const f = await setup(page, browser);
  try {
    await playHand(page, f);
    // 主持给林川补码，计入总带入。
    await page.goto(`${base}/manage?room=${f.code}`);
    const row = page.locator('.manage-row').filter({ hasText: '林川' });
    await row.getByRole('spinbutton', { name: '给林川补码' }).fill('50');
    await row.getByRole('button', { name: '补码', exact: true }).click();
    await expect.poll(async () => (await f.snapshot()).state.players.find(p => p.name === '林川').stack).toBeGreaterThanOrEqual(240);
    await page.goto(`${base}/table?room=${f.code}`);
    await playHand(page, f);
    await playHand(page, f);
    const before = await f.snapshot();
    // 散场：二次确认。
    await page.getByRole('button', { name: '散场', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '确认散场？' })).toBeVisible();
    await dialog.getByRole('button', { name: '确认散场', exact: true }).click();
    await expect(page).toHaveURL(/\/recap\?room=/);
    await expect(page.getByRole('heading', { name: '周五夜席', exact: true })).toBeVisible();
    const sum = await f.summary();
    expect(sum.room.ended).toBe(true);
    expect(sum.room.hands).toBe(3);
    expect(sum.balance.ok).toBe(true);
    expect(sum.balance.buyIn).toBe(650);
    expect(sum.balance.final).toBe(before.state.total);
    expect(sum.players.reduce((a, p) => a + p.net, 0)).toBe(0);
    for (const p of sum.players) {
      expect(p.consistent).toBe(true);
      expect(p.hands).toBe(3);
      expect(p.final - p.buyIn).toBe(p.net);
    }
    expect(sum.players.find(p => p.name === '林川').buyIn).toBe(250);
    expect(sum.players.find(p => p.name === '林川').rebuys).toBe(1);
    // 大屏排行：顺序与净值一致，账平。
    const rows = page.locator('.rc-row');
    await expect(rows).toHaveCount(3);
    for (const [i, p] of sum.players.entries()) {
      await expect(rows.nth(i)).toContainText(p.name);
      await expect(rows.nth(i).locator('.rc-net b')).toHaveText(signed(p.net));
    }
    await expect(page.locator('.rc-balance')).toContainText('账平');
    await expect(page.locator('.rc-balance')).toContainText('650');
    await expect(page.getByText('谁该给谁', { exact: false })).toHaveCount(0);
    // 每台手机自动切到个人总结。
    for (const p of sum.players) {
      const phone = f.byName(p.name);
      const card = phone.getByTestId('personal-summary');
      await expect(card).toBeVisible();
      await expect(card.locator('.pc-net')).toHaveText(signed(p.net));
      await expect(card.locator('.pc-stats')).toContainText(String(p.buyIn.toLocaleString('en-US')));
      await expect(card.locator('.pc-stats')).toContainText(`${p.hands} 手`);
      await expect(phone.getByRole('button', { name: '弃牌' })).toHaveCount(0);
    }
    // 只读：散场后任何操作都被拒绝。
    const tokenOf = async (target, prefix) => target.evaluate(p => localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith(p))), prefix);
    const hostTok = await tokenOf(page, 'night-table.host.');
    const denied = await page.request.post(`${base}/api/rooms/${f.code}/command`, { headers: { Authorization: `Bearer ${hostTok}`, 'Content-Type': 'application/json', Origin: base }, data: { type: 'start', args: {}, version: (await f.snapshot()).state.version, requestId: 'a'.repeat(32) } });
    expect(denied.status()).toBe(400);
    expect((await denied.json()).error).toContain('牌局已经结束');
    // 文字战报与图片。
    await page.getByRole('button', { name: '复制战报' }).click();
    await expect(page.locator('#toast, dialog[open]').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '保存为图片' }).click();
    const img = page.getByRole('dialog').locator('img.share-img');
    await expect(img).toBeVisible();
    expect(await img.evaluate(el => el.naturalWidth)).toBe(1080);
    await expect(page.getByRole('dialog').getByRole('link', { name: '下载图片' })).toHaveAttribute('download', /\.png$/);
    await page.getByRole('dialog').getByRole('button', { name: '返回' }).click();
    // 牌谱可回看。
    await page.goto(`${base}/hands?room=${f.code}`);
    await expect(page.locator('.hv-item')).toHaveCount(3);
    await page.locator('.hv-item').last().click();
    await expect(page.getByRole('heading', { name: '第 1 手' })).toBeVisible();
    // 首页的历史牌局。
    await page.goto(base);
    await expect(page.locator('.hist-row').filter({ hasText: '周五夜席' })).toBeVisible();
    await page.locator('.hist-row').filter({ hasText: '周五夜席' }).click();
    await expect(page).toHaveURL(/\/recap\?room=/);
    // 用同样设置再开一桌：手机上出现去新桌的入口。
    await page.getByRole('button', { name: '用同样设置再开一桌' }).click();
    await expect(page).toHaveURL(/\/share\?room=/);
    const next = new URL(page.url()).searchParams.get('room');
    expect(next).not.toBe(f.code);
    const fresh = await (await page.request.get(`${base}/api/rooms/${next}`)).json();
    expect(fresh.state.config).toMatchObject({ smallBlind: 5, bigBlind: 10, startingStack: 200, rebuy: true, dealMode: 'digital' });
    const phone = f.phones[0];
    await expect(phone.getByRole('link', { name: new RegExp(`去新桌 ${next}`) })).toBeVisible();
    await phone.getByRole('link', { name: new RegExp(`去新桌 ${next}`) }).click();
    await expect(phone.getByLabel('你的名字', { exact: true })).toHaveValue('阿宁');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('leaving mid-game shows a personal summary at once; the night goes on; the summary stays correct after the end', async ({ page, browser }) => {
  const f = await setup(page, browser);
  try {
    await playHand(page, f);
    const phone = f.byName('小满');
    await phone.getByRole('button', { name: /更多/ }).click();
    await phone.getByRole('dialog').getByRole('button', { name: /^离开/ }).click();
    await phone.getByRole('dialog').getByRole('button', { name: '确认离开', exact: true }).click();
    const card = phone.getByTestId('personal-summary');
    await expect(card).toBeVisible();
    await expect(card).toContainText('你提前离席了');
    const mid = await f.summary();
    const me = mid.players.find(p => p.name === '小满');
    expect(me.status).toBe('left');
    await expect(card.locator('.pc-net')).toHaveText(signed(me.net));
    await expect(phone.locator('.ps-live')).toContainText('牌局还在继续');
    // 他走后其他人继续打。
    await expect(page.locator('.seat')).toHaveCount(2);
    await playHand(page, f);
    await page.getByRole('button', { name: '散场', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认散场', exact: true }).click();
    const sum = await f.summary();
    const after = sum.players.find(p => p.name === '小满');
    expect(after).toMatchObject({ net: me.net, cashOut: me.cashOut, hands: 1, status: 'left' });
    expect(sum.balance).toMatchObject({ ok: true, buyIn: 600 });
    expect(sum.balance.final + sum.balance.cashOut).toBe(600);
    await expect(page.locator('.rc-row.is-left')).toContainText('提前离席');
    await expect(phone.locator('.ps-live')).toHaveCount(0);
    await expect(card.locator('.pc-net')).toHaveText(signed(after.net));
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('a player on a new phone claims the old seat; the host approves; the old phone loses control', async ({ page, browser }) => {
  const f = await setup(page, browser, { names: ['阿宁', '林川'] });
  try {
    await playHand(page, f);
    const stack = (await f.snapshot()).state.players.find(p => p.name === '林川').stack;
    const fresh = await phoneFor('林川-新', browser, f);
    await fresh.goto(`${phoneBase}/join?room=${f.code}`);
    await fresh.getByText('之前坐过？').click();
    await fresh.getByRole('button', { name: /林川/ }).first().click();
    await fresh.getByRole('button', { name: '请主持人确认我是「林川」' }).click();
    await expect(fresh.getByRole('heading', { name: '接回 林川 的座位' })).toBeVisible();
    // 先拒绝一次再重来：拒绝后新手机回到入座页并看到提示。
    const alert = page.locator('.alert').filter({ hasText: '林川 想在新手机上接回座位' });
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: '同意接回' }).click();
    await expect(fresh).toHaveURL(/\/play/);
    await expect(fresh.getByRole('heading', { name: '林川', exact: true })).toBeVisible();
    expect((await f.snapshot()).state.players.find(p => p.name === '林川').stack).toBe(stack);
    // 旧手机不再能操作。
    const old = f.byName('林川');
    await old.reload();
    await expect(old.getByRole('button', { name: /^坐到/ })).toBeVisible();
    const oldTok = await old.evaluate(() => localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('night-table.player.'))));
    const view = await (await page.request.get(`${base}/api/rooms/${f.code}`, { headers: oldTok ? { Authorization: `Bearer ${oldTok}` } : {} })).json();
    expect(view.role).not.toBe('player');
    // 新手机能正常打下一手。
    f.byName = n => (n === '林川' ? fresh : f.phones[0]);
    await playHand(page, f);
    expect((await f.snapshot()).state.handNumber).toBe(2);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
