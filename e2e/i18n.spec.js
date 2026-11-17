import { test, expect } from '@playwright/test';
import { createServer } from '../server/index.js';
import {
  languages, openI18nRoom, reachDigitalFlop, setUiLanguage, clickTableAction, expectPhoneGeometry
} from '../tools/shoot-i18n.mjs';

let server, base;
test.use({ locale: 'zh-CN', reducedMotion: 'reduce' });
test.beforeAll(async () => {
  server = await createServer({ file: ':memory:', host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});
test.afterAll(async () => server?.close());

test('switch to English and Japanese during one complete digital hand without changing table state', async ({ page, browser }) => {
  const room = await openI18nRoom(browser, page, base);
  try {
    await reachDigitalFlop(page, room);
    const active = room.phones[1];
    const before = (await room.snapshot()).state;
    await setUiLanguage(active, 'en');
    await expect(active.locator('[data-do=check]')).toHaveText('Check');
    await expect(active.locator('select[data-language]')).toHaveAccessibleName('Language');
    expect((await room.snapshot()).state).toEqual(before);
    await active.reload();
    await expect(active.locator('html')).toHaveAttribute('lang', 'en');
    await expect(active.locator('[data-do=check]')).toHaveText('Check');
    await setUiLanguage(page, 'en');
    await expect(page.locator('[data-do=next]')).toContainText('Next street');
    await clickTableAction(active, 'check');
    await clickTableAction(room.phones[2], 'check');
    await clickTableAction(room.phones[0], 'check');

    await clickTableAction(page, 'next');
    await setUiLanguage(active, 'ja');
    await expect(active.locator('[data-do=check]')).toHaveText('チェック');
    await expect(active.locator('select[data-language]')).toHaveAccessibleName('言語');
    await clickTableAction(active, 'phone-more');
    await active.getByRole('dialog').locator('select[data-language]').selectOption('en');
    await expect(active.getByRole('dialog')).toContainText('Keep screen awake');
    await active.getByRole('dialog').locator('select[data-language]').selectOption('ja');
    await expect(active.getByRole('dialog').locator('select[data-language]')).toHaveAccessibleName('言語');
    await active.getByRole('dialog').locator('[data-do=cancel]').click();
    await setUiLanguage(page, 'ja');
    await expect(page.locator('[data-do=next]')).toContainText('次のストリート');
    for (const street of [2, 3]) {
      for (const phone of [room.phones[1], room.phones[2], room.phones[0]]) {
        await clickTableAction(phone, 'check');
      }
      if (street === 2) await clickTableAction(page, 'next');
    }
    await expect.poll(async () => (await room.snapshot()).state.hand.phase).toBe('showdown');
    await clickTableAction(page, 'settlement');
    await clickTableAction(page, 'settle-confirm');
    await page.getByRole('dialog').locator('[data-do=settle-submit]').click();
    await expect(page).toHaveURL(/\/table\?room=/);
    await expect.poll(async () => (await room.snapshot()).state.hand.phase).toBe('settled');
    const settled = (await room.snapshot()).state;
    expect(settled.players.reduce((sum, player) => sum + player.stack, 0)).toBe(before.total);
    expect(settled.players.reduce((sum, player) => sum + player.contribution, 0)).toBe(0);
    expect(settled.handNumber).toBe(1);
    expect(room.errors).toEqual([]);
  } finally {
    await room.close();
  }
});

test('browser preferences and saved language select the home page language', async ({ browser }) => {
  for (const [locale, expected] of [['zh-HK', 'zh-TW'], ['en-US', 'en'], ['ja-JP', 'ja'], ['fr-FR', 'en']]) {
    const context = await browser.newContext({ locale });
    try {
      const page = await context.newPage();
      await page.goto(base);
      await expect(page.locator('html')).toHaveAttribute('lang', expected);
      await expect(page.locator('select[data-language]')).toHaveValue(expected);
      await page.locator('select[data-language]').selectOption('es');
      await expect(page.locator('#create-form button[type=submit]')).toHaveText('Crear sala');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', 'es');
      const manifest = await page.locator('link[rel=manifest]').getAttribute('href');
      const response = await page.request.get(`${base}${manifest}`);
      expect((await response.json()).lang).toBe('es');
    } finally { await context.close(); }
  }
});

test('changing language preserves an unsent room setup', async ({ page }) => {
  await page.goto(base);
  await page.locator('[name=dealMode][value=physical]').check();
  await page.locator('[name=rebuy]').check();
  await page.locator('.more-set summary').click();
  await page.locator('[name=ante]').fill('5');
  await page.locator('[name=levelEvery]').selectOption('10');
  await page.locator('[name=actionClock]').selectOption('30');
  await page.locator('[name=runouts]').selectOption('2');
  await page.locator('[name=anteMode]').selectOption('bigBlind');
  await page.locator('[name=straddle]').check();
  const draft = () => page.locator('#create-form').evaluate(form => [...new FormData(form)]);
  const before = await draft();
  await page.locator('select[data-language]').selectOption('en');
  expect(await draft()).toEqual(before);
  await expect(page.locator('.more-set')).toHaveAttribute('open', '');
  await page.locator('select[data-language]').selectOption('ja');
  expect(await draft()).toEqual(before);
});

test('six languages fit the live mobile table, including English and Spanish at 320px', async ({ page, browser }) => {
  const room = await openI18nRoom(browser, page, base);
  try {
    await reachDigitalFlop(page, room);
    const phone = room.phones[1];
    const initial = (await room.snapshot()).state;
    for (const language of languages) {
      await setUiLanguage(phone, language);
      await expectPhoneGeometry(phone);
      await expect(phone.locator('[data-do=check]')).toBeEnabled();
      await expect(phone.getByTestId('hole-cards').locator('[data-card]')).toHaveCount(2);
    }
    await phone.setViewportSize({ width: 320, height: 667 });
    for (const language of ['en', 'es']) {
      await setUiLanguage(phone, language);
      await expectPhoneGeometry(phone);
      await clickTableAction(phone, 'raise');
      await expect(phone.locator('#raise-amount')).toBeVisible();
      expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expectPhoneGeometry(phone);
      await clickTableAction(phone, 'raise-cancel');
    }
    expect((await room.snapshot()).state).toEqual(initial);
    expect(room.errors).toEqual([]);
  } finally {
    await room.close();
  }
});
