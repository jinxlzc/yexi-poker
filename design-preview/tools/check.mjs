import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
const dir = new URL('..', import.meta.url).pathname;
const screens = [['01-table-flop', 1440, 900], ['02-phone-action', 390, 844], ['03-showdown-split', 1440, 900], ['04-create-room', 1440, 900], ['05-phone-join', 390, 844], ['06-table-physical', 1440, 900]];
const b = await chromium.launch();
for (const [name, w, h] of screens) {
  const p = await b.newPage({viewport:{width:w,height:h}});
  const errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.goto(pathToFileURL(dir+name+'.html').href);await p.evaluate(()=>document.fonts.ready);
  const report = await p.evaluate(() => {
    const bad=[...document.querySelectorAll('body *')].filter(e=>!e.closest('svg')&& e.getBoundingClientRect().width && getComputedStyle(e).position!=='absolute' && !e.classList.contains('vignette')).filter(e=>{const r=e.getBoundingClientRect();return r.left < -1||r.right>innerWidth+1||r.top < -1||r.bottom>innerHeight+1});
    return {w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight,fonts:document.fonts.status,overflow:bad.map(e=>e.tagName+'.'+e.className)};
  });
  console.log(name,JSON.stringify({...report,errors}));await p.close();
}
await b.close();
