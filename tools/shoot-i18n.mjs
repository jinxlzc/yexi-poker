// Capture the live interface: node tools/shoot-i18n.mjs <output-directory>
import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from '../server/index.js';

export const languages = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'es'];
const prepareBrowser = () => {
  localStorage.setItem('night-table.sound', 'off');
  if (!localStorage.getItem('yexi.language')) localStorage.setItem('yexi.language', 'zh-CN');
};

export async function setUiLanguage(page, language) {
  const picker = page.locator('select[data-language]');
  await expect(picker).toBeVisible();
  await picker.selectOption(language);
  await expect(page.locator('html')).toHaveAttribute('lang', language);
  await expect(page.locator('select[data-language]')).toHaveValue(language);
  expect(await page.evaluate(() => localStorage.getItem('yexi.language'))).toBe(language);
}

export async function openI18nRoom(browser, host, base, { scale = 1 } = {}) {
  const contexts = [], phones = [], errors = [];
  const onError = error => errors.push(error.message);
  host.on('pageerror', onError);
  const close = async () => {
    host.off('pageerror', onError);
    for (const context of contexts) await context.close();
  };
  try {
    await host.addInitScript(prepareBrowser);
    await host.goto(base);
    await host.locator('[name=dealMode][value=digital]').check();
    await host.locator('#room-name').fill('Saturday table');
    await host.locator('#startingStack').fill('2000');
    await host.locator('#create-form button[type=submit]').click();
    await expect(host).toHaveURL(/\/share\?room=/);
    const code = new URL(host.url()).searchParams.get('room');
    const url = route => `${base}/${route}?room=${code}`;
    const snapshot = async () => {
      const response = await host.request.get(`${base}/api/rooms/${code}`);
      expect(response.ok()).toBe(true);
      return response.json();
    };
    for (const name of ['Alex', 'Emi', 'Luca']) {
      const context = await browser.newContext({
        locale: 'zh-CN', viewport: { width: 390, height: 844 },
        isMobile: true, hasTouch: true, deviceScaleFactor: scale, reducedMotion: 'reduce'
      });
      contexts.push(context);
      await context.addInitScript(prepareBrowser);
      const phone = await context.newPage();
      phones.push(phone);
      phone.on('pageerror', onError);
      await phone.goto(url('join'));
      await phone.locator('#join-name').fill(name);
      await phone.locator('#join-form button[type=submit]').click();
      await expect(phone).toHaveURL(/\/play\?room=/);
      await expect(phone.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    await host.goto(url('table'));
    await expect(host.locator('[data-do=start]')).toBeEnabled();
    return { code, phones, contexts, snapshot, errors, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function clickTableAction(page, action) {
  const button = page.locator(`[data-do="${action}"]`);
  await expect(button).toBeEnabled();
  await button.click();
}

export async function reachDigitalFlop(host, room) {
  await clickTableAction(host, 'start');
  await clickTableAction(room.phones[0], 'call');
  await clickTableAction(room.phones[1], 'call');
  await clickTableAction(room.phones[2], 'check');
  await expect.poll(async () => (await room.snapshot()).state.hand.phase).toBe('roundEnd');
  await clickTableAction(host, 'next');
  await expect.poll(async () => (await room.snapshot()).state.hand.board.length).toBe(3);
  await expect(room.phones[1].locator('[data-do=check]')).toBeEnabled();
  await expect(room.phones[1].getByTestId('hole-cards').locator('[data-card]')).toHaveCount(2);
}

export async function expectPhoneGeometry(page) {
  const geometry = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('.sheet .acts button, .sheet .acts-all button')];
    const picker = document.querySelector('.p-head select[data-language]');
    const style = getComputedStyle(picker), canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    ctx.font = style.font;
    const label = picker.selectedOptions[0].text;
    const labelWidth = ctx.measureText(label).width + (parseFloat(style.letterSpacing) || 0) * label.length;
    return {
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      pickerTextWidth: labelWidth,
      pickerAvailableWidth: picker.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      controls: controls.map(el => {
        const { x, y, width, height, right, bottom } = el.getBoundingClientRect();
        return { x, y, width, height, right, bottom, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
      })
    };
  });
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
  expect(geometry.pickerTextWidth).toBeLessThanOrEqual(geometry.pickerAvailableWidth);
  expect(geometry.controls.length).toBeGreaterThanOrEqual(2);
  for (const control of geometry.controls) {
    expect(control.x).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(geometry.width + 1);
    expect(control.width).toBeGreaterThanOrEqual(44);
    expect(control.height).toBeGreaterThanOrEqual(40);
    expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
  }
  for (let i = 0; i < geometry.controls.length; i++) {
    for (let j = i + 1; j < geometry.controls.length; j++) {
      const a = geometry.controls[i], b = geometry.controls[j];
      expect(a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1).toBe(true);
    }
  }
}

export async function captureI18n(out) {
  await mkdir(out, { recursive: true });
  const temporary = await mkdtemp(path.join(tmpdir(), 'yexi-i18n-'));
  let server, browser, room;
  try {
    server = await createServer({ file: path.join(temporary, 'rooms.sqlite'), host: '127.0.0.1', port: 0 });
    browser = await chromium.launch();
    const host = await browser.newPage({
      locale: 'zh-CN', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce'
    });
    room = await openI18nRoom(browser, host, `http://127.0.0.1:${server.port}`, { scale: 3 });
    await reachDigitalFlop(host, room);
    const phone = room.phones[1];
    const shot = async (page, filename) => {
      await page.evaluate(() => document.fonts.ready.then(() => {}));
      await expect(page.locator('#toast')).toBeHidden();
      await page.screenshot({ path: path.join(out, filename), fullPage: filename.startsWith('phone-'), animations: 'disabled', caret: 'hide' });
      console.log(filename);
    };
    for (const language of languages) {
      await setUiLanguage(host, language);
      await setUiLanguage(phone, language);
      await expectPhoneGeometry(phone);
      await shot(host, `desktop-${language}.png`);
      await shot(phone, `phone-${language}-390.png`);
    }
    await phone.setViewportSize({ width: 320, height: 667 });
    for (const language of ['en', 'es']) {
      await setUiLanguage(phone, language);
      await expectPhoneGeometry(phone);
      await shot(phone, `phone-${language}-320.png`);
    }
    expect(room.errors).toEqual([]);
  } finally {
    await room?.close();
    await browser?.close();
    await server?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const output = process.argv[2] || process.env.YEXI_SCREENSHOT_DIR;
  if (!output) throw new Error('Usage: node tools/shoot-i18n.mjs <output-directory>');
  await captureI18n(path.resolve(output));
}
