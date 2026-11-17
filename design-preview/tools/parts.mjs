// Shared markup helpers for the static v3 preview. Output is plain HTML.
export const SUITS = {
  s: 'M50 5C41 21 9 37 9 60c0 13 10 21 21 21 7 0 13-3 17-9-1 9-5 15-13 20h32c-8-5-12-11-13-20 4 6 10 9 17 9 11 0 21-8 21-21C91 37 59 21 50 5Z',
  h: 'M50 91C23 70 6 54 6 33 6 19 17 9 30 9c9 0 16 5 20 13 4-8 11-13 20-13 13 0 24 10 24 24 0 21-17 37-44 58Z',
  d: 'M50 3c10 17 23 33 41 47C73 64 60 80 50 97 40 80 27 64 9 50 27 36 40 20 50 3Z',
  c: 'M50 7a20 20 0 0 0-17 31 20 20 0 1 0 14 34c-1 8-5 14-13 20h32c-8-6-12-12-13-20a20 20 0 1 0 14-34A20 20 0 0 0 50 7Z'
};
export const sprite = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${Object.entries(SUITS).map(([k, d]) => `<symbol id="suit-${k}" viewBox="0 0 100 100"><path d="${d}"/></symbol>`).join('')}</defs></svg>`;
const suit = (s, cls) => `<svg class="${cls}" viewBox="0 0 100 100"><use href="#suit-${s}"/></svg>`;
const CREST = { J: '侍', Q: '后', K: '王' };
export function card(code, { w = 84, cls = '' } = {}) {
  if (!code || code === 'back') return `<div class="card back ${w < 40 ? 'tiny' : ''} ${cls}" style="--w:${w}px"><i class="bk-frame"></i><i class="bk-seal">夜</i></div>`;
  const r = code.slice(0, -1), s = code.slice(-1);
  const red = 'hd'.includes(s) ? 'red' : '';
  const face = 'JQK'.includes(r) ? 'face' : r === 'A' ? 'ace' : '';
  return `<div class="card ${red} ${face} ${cls}" style="--w:${w}px">${face === 'face' ? `<i class="frame"></i><i class="crest">${CREST[r]}</i>` : ''}<span class="rank ${r === '10' ? 'ten' : ''}">${r}</span>${suit(s, 'pip-s')}${suit(s, 'pip-l')}</div>`;
}
export const slot = (w = 84) => `<div class="slot" style="--w:${w}px"></div>`;
const DENOMS = [1000, 500, 100, 25, 5, 1];
export function chips(amount, { w = 26, max = 7, cols = 3, groups: given } = {}) {
  const groups = given ? [...given] : [];
  let left = amount;
  if (!given) for (const d of DENOMS) { const n = Math.floor(left / d); if (n) { groups.push([d, n]); left -= n * d; } }
  return `<div class="chips">${groups.slice(0, cols).map(([d, n]) => {
    const k = Math.min(n, max);
    return `<div class="stack" style="--n:${k};--cw:${w}px">${Array.from({ length: k }, (_, i) => `<i class="chip c${d} ${i === k - 1 ? 'cap' : ''}" style="--i:${i};--cw:${w}px"></i>`).join('')}</div>`;
  }).join('')}</div>`;
}
export const fmt = n => n.toLocaleString('en-US');
export const ICON = {
  sound: '<svg class="icon" viewBox="0 0 24 24"><path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4Z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  qr: '<svg class="icon" viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/></svg>',
  undo: '<svg class="icon" viewBox="0 0 24 24"><path d="M9 7 5 11l4 4"/><path d="M5 11h9a5 5 0 0 1 0 10h-2"/></svg>',
  play: '<svg class="icon" viewBox="0 0 24 24"><path d="M7 5.5v13l11-6.5-11-6.5Z"/></svg>',
  next: '<svg class="icon" viewBox="0 0 24 24"><path d="M5 12h12M13 7l5 5-5 5"/></svg>',
  split: '<svg class="icon" viewBox="0 0 24 24"><path d="M12 4v6M12 10l-6 6M12 10l6 6"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  seats: '<svg class="icon" viewBox="0 0 24 24"><circle cx="9" cy="9" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 6.5a3 3 0 0 1 0 5.5M18 14.5a5.5 5.5 0 0 1 3 4.5"/></svg>',
  list: '<svg class="icon" viewBox="0 0 24 24"><path d="M9 7h11M9 12h11M9 17h11"/><circle cx="4.5" cy="7" r=".6"/><circle cx="4.5" cy="12" r=".6"/><circle cx="4.5" cy="17" r=".6"/></svg>',
  check: '<svg class="icon" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  wifi: '<svg class="icon" viewBox="0 0 24 24"><path d="M3 9a13 13 0 0 1 18 0M6 12.5a8.5 8.5 0 0 1 12 0M9 16a4 4 0 0 1 6 0"/><circle cx="12" cy="19" r=".8"/></svg>',
  minus: '<svg class="icon" viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
  plus: '<svg class="icon" viewBox="0 0 24 24"><path d="M6 12h12M12 6v12"/></svg>',
  more: '<svg class="icon" viewBox="0 0 24 24"><circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/></svg>',
  lock: '<svg class="icon" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>'
};
export const page = (title, body, css, cls = '') => `<!doctype html>
<html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title><link rel="stylesheet" href="v3.css">${css.map(c => `<link rel="stylesheet" href="${c}">`).join('')}</head>
<body class="${cls}">${sprite}${body}</body></html>`;
