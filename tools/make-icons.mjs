// 生成 PWA / 主屏幕图标：朱砂印章「夜」在墨黑底上。用 Playwright 截图，字体用仓库自带的 Noto Serif SC 子集。
// 用法：node tools/make-icons.mjs
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const font = (await readFile(path.join(root, 'public/fonts/noto-serif-sc-700.woff2'))).toString('base64');
const html = (size, pad) => `<!doctype html><style>@font-face{font-family:S;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:700}
html,body{margin:0;width:${size}px;height:${size}px;background:#060807}
body{display:grid;place-items:center;background:radial-gradient(70% 70% at 50% 40%,#10201c,#060807 75%)}
.s{--s:${size - pad * 2}px;width:var(--s);height:var(--s);border-radius:calc(var(--s)*.22);display:grid;place-items:center;position:relative;
background:linear-gradient(160deg,#e06a4f,#d4573e 45%,#a83c28);color:#fff4ea;font:700 calc(var(--s)*.56)/1 S;
box-shadow:inset 0 ${size / 64}px 0 rgba(255,255,255,.28),inset 0 -${size / 32}px ${size / 16}px rgba(0,0,0,.25)}
.s::before{content:'';position:absolute;inset:calc(var(--s)*.06);border:${Math.max(1, size / 96)}px solid rgba(255,240,225,.38);border-radius:calc(var(--s)*.16)}
.s span{transform:translateY(-2%)}</style><div class="s"><span>夜</span></div>`;
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [name, size, pad] of [['icon-192.png', 192, 20], ['icon-512.png', 512, 52], ['icon-maskable-512.png', 512, 104], ['apple-touch-icon.png', 180, 18]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(html(size, pad)); await page.evaluate(() => document.fonts.ready);
  await writeFile(path.join(root, 'public/icons', name), await page.screenshot({ type: 'png' }));
  console.log(name);
}
await browser.close();
