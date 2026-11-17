// 实机规则截图：node tools/shoot-rules.mjs <输出目录>
import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeDeck, setNextDeck } from '../server/cards.js';
import { createServer } from '../server/index.js';

const names = ['阿宁', '林川', '小满'];
export const physicalSettings = { dealMode: 'physical', startingStack: 103, rebuy: true };
const mute = () => { if (location.protocol === 'http:') localStorage.setItem('night-table.sound', 'off'); };

export async function openRulesRoom(browser, host, base, settings = {}) {
  const {
    dealMode = 'digital', startingStack = 100, rebuy = false, runouts, straddle,
    ante, anteMode, scale = 1, widths = [390, 390, 390]
  } = settings;
  const forms = [runouts, straddle, ante, anteMode];
  const contexts = [], phones = [], errors = [];
  const onError = error => errors.push(error.message);
  host.on('pageerror', onError);
  const close = async () => {
    host.off('pageerror', onError);
    for (const context of contexts) await context.close();
  };
  try {
    await host.addInitScript(mute);
    await host.goto(base);
    await host.getByRole('radio', { name: dealMode === 'digital' ? '电子牌' : '实体牌', exact: true }).check();
    await host.getByLabel('房间名', { exact: true }).fill(dealMode === 'digital' ? '周六夜席' : '围桌牌局');
    await host.getByLabel('起始筹码', { exact: true }).fill(String(startingStack));
    if (rebuy) await host.getByLabel('打开补码').check();
    if (forms.some(value => value !== undefined)) {
      await host.locator('.more-set summary').click();
      if (runouts !== undefined) await host.locator('[name=runouts]').selectOption(String(runouts));
      if (straddle !== undefined) await host.locator('[name=straddle]').setChecked(straddle);
      if (ante !== undefined) await host.locator('[name=ante]').fill(String(ante));
      if (anteMode !== undefined) await host.locator('[name=anteMode]').selectOption(anteMode);
    }
    await host.getByRole('button', { name: '创建房间', exact: true }).click();
    await expect(host).toHaveURL(/\/share\?room=/);
    const code = new URL(host.url()).searchParams.get('room');
    const url = route => `${base}/${route}?room=${code}`;
    const snapshot = async (suffix = '') => {
      const response = await host.request.get(`${base}/api/rooms/${code}${suffix}`);
      expect(response.ok()).toBe(true);
      return response.json();
    };
    for (const [index, width] of widths.entries()) {
      const context = await browser.newContext({ locale: 'zh-CN',
        viewport: { width, height: width === 320 ? 667 : 844 },
        isMobile: true, hasTouch: true, deviceScaleFactor: scale, reducedMotion: 'reduce'
      });
      contexts.push(context);
      await context.addInitScript(mute);
      const phone = await context.newPage();
      phones.push(phone);
      phone.setDefaultTimeout(8000);
      phone.on('pageerror', onError);
      await phone.goto(url('join'));
      await phone.getByLabel('你的名字', { exact: true }).fill(names[index]);
      const join = phone.getByRole('button', { name: /^坐到/ });
      await expect(join).toBeEnabled();
      await join.click();
      await expect(phone).toHaveURL(/\/play\?room=/);
      await expect(phone.getByRole('heading', { name: names[index], exact: true })).toBeVisible();
    }
    await host.goto(url('table'));
    await expect(host.getByRole('button', { name: /^新的一手/ })).toBeEnabled();
    return { phones, contexts, snapshot, errors, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export function deckForTwoBoards() {
  // 三人局发牌顺序为 2、3、1 号位。第一跑林川三条 A，第二跑阿宁三条 K。
  const top = ['As', 'Qh', 'Ks', 'Ad', 'Qd', 'Kd',
    '4c', 'Ah', '7d', '4s', '9s', 'Jd', '6h', '2h',
    '2s', 'Kh', '8h', '5d', 'Jc', 'Tc', '6s', '3c'];
  return [...top, ...makeDeck().filter(card => !top.includes(card))];
}

export async function startAllIn(host, phones, deck = null) {
  if (deck) setNextDeck(deck);
  try {
    await host.getByRole('button', { name: /^新的一手/ }).click();
    for (const phone of phones) {
      await phone.getByRole('button', { name: /^全下 / }).click();
      await phone.getByRole('dialog').getByRole('button', { name: '确认全下', exact: true }).click();
    }
  } finally {
    if (deck) setNextDeck(null);
  }
}

export const voteButton = (phone, runs) => phone.locator(`[data-do=run-vote][data-runs="${runs}"]`);
export const poolButton = (host, run, pot) => host.locator(`.potpick button[data-run="${run}"][data-pot-id="${pot}"]`);
export const winnerButton = (host, name) => host.locator('.winner').filter({ hasText: name });
export const settleButton = page => page.getByRole('button', { name: '确认这样分池', exact: true });

export async function addDifferentStacks(host, room) {
  await host.getByRole('button', { name: /^座位/ }).click();
  for (const [name, amount, stack] of [['林川', 61, 164], ['小满', 114, 217]]) {
    const row = host.locator('.manage-row').filter({ hasText: name });
    await row.getByRole('spinbutton', { name: `给${name}补码` }).fill(String(amount));
    await row.getByRole('button', { name: '补码', exact: true }).click();
    await expect.poll(async () => (await room.snapshot()).state.players.find(p => p.name === name).stack).toBe(stack);
  }
  await host.getByRole('link', { name: '返回牌桌', exact: true }).click();
}

async function confirmSettlement(host) {
  await settleButton(host).click();
  await settleButton(host.getByRole('dialog')).click();
  await expect(host).toHaveURL(/\/table\?room=/);
}

async function capture(out) {
  await mkdir(out, { recursive: true });
  const dir = await mkdtemp(path.join(tmpdir(), 'night-table-rules-'));
  let server, browser;
  try {
    server = await createServer({ file: path.join(dir, 'rooms.sqlite'), host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
    const host = await browser.newPage({ locale: 'zh-CN',
      viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce'
    });
    host.setDefaultTimeout(8000);
    const shot = async (page, name) => {
      await page.evaluate(() => document.fonts.ready.then(() => {}));
      await expect(page.locator('#toast')).toBeHidden();
      await page.screenshot({ path: path.join(out, `${name}.png`), animations: 'disabled', caret: 'hide' });
      console.log('截图', name);
    };

    const digital = await openRulesRoom(browser, host, base, { scale: 3, widths: [390, 320, 390] });
    const [first, narrow, third] = digital.phones;
    await startAllIn(host, digital.phones, deckForTwoBoards());
    await voteButton(third, 2).click();
    await expect(first.getByTestId('run-choice')).toBeVisible();
    await expect(narrow.getByTestId('run-choice')).toBeVisible();
    await expect(first.locator('.run-vote-status')).toContainText(/小满（2\s*次）/);
    await expect(narrow.locator('.run-vote-status')).toContainText(/小满（2\s*次）/);
    await shot(first, 'phone-run-choice-390');
    await shot(narrow, 'phone-run-choice-320');
    await voteButton(first, 2).click();
    await voteButton(narrow, 2).click();
    await expect(host.locator('[data-run-board]')).toHaveCount(2);
    await expect(host.locator('[data-run-board] [data-card]:not([data-card="back"])')).toHaveCount(10);
    await shot(host, 'desktop-two-boards');
    await host.getByRole('button', { name: /^分池/ }).click();
    await confirmSettlement(host);
    await host.getByRole('link', { name: '牌谱回放', exact: true }).click();
    await expect(host.locator('.hv-run[data-run]')).toHaveCount(2);
    await expect(host.locator('.hv-run[data-run="2"] li')).toBeInViewport({ ratio: 1 });
    await shot(host, 'desktop-multi-run-replay');
    expect(digital.errors).toEqual([]);
    await digital.close();

    const physical = await openRulesRoom(browser, host, base, { ...physicalSettings, scale: 3, straddle: true });
    await addDifferentStacks(host, physical);
    const straddle = physical.phones[0].locator('#player-straddle');
    await straddle.check();
    await expect(straddle).toBeChecked();
    await expect.poll(async () => (await physical.snapshot()).state.nextStraddle).toBeTruthy();
    await shot(physical.phones[0], 'phone-straddle');
    await straddle.uncheck();
    await expect.poll(async () => (await physical.snapshot()).state.nextStraddle).toBeFalsy();
    await startAllIn(host, physical.phones);
    for (const phone of physical.phones) await voteButton(phone, 2).click();
    await host.getByRole('button', { name: /^分池/ }).click();
    for (const [run, pot, winner] of [[1, 'pot-0', '阿宁'], [1, 'pot-1', '林川'], [2, 'pot-0', '小满'], [2, 'pot-1', '小满']]) {
      await poolButton(host, run, pot).click();
      await winnerButton(host, winner).click();
    }
    await expect(settleButton(host)).toBeEnabled();
    await settleButton(host).scrollIntoViewIfNeeded();
    await shot(host, 'desktop-physical-round-pools');
    await confirmSettlement(host);
    expect(physical.errors).toEqual([]);
    await physical.close();
  } finally {
    await browser?.close();
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('用法：node tools/shoot-rules.mjs <输出目录>');
  await capture(path.resolve(process.argv[2]));
}
