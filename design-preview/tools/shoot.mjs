import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
const dir = new URL('..', import.meta.url).pathname;
const out = process.argv[2] || 'design-preview/out';
const only = process.argv[3];
const shots = [
  ['01-table-flop', 1440, 900, 2],
  ['02-phone-action', 390, 844, 3],
  ['03-showdown-split', 1440, 900, 2],
  ['04-create-room', 1440, 900, 2],
  ['05-phone-join', 390, 844, 3],
  ['06-table-physical', 1440, 900, 2]
];
const browser = await chromium.launch();
for (const [name, w, h, s] of shots) {
  if (only && !name.startsWith(only)) continue;
  try {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: s, isMobile: w < 500, hasTouch: w < 500 });
    const p = await ctx.newPage();
    await p.goto(pathToFileURL(dir + name + '.html').href);
    await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
    await p.screenshot({ path: `${out}/${name}.png` });
    await ctx.close(); console.log('shot', name);
  } catch (e) { console.log('skip', name, e.message.split('\n')[0]); }
}
await browser.close();
