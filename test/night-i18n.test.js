import test from 'node:test';
import assert from 'node:assert/strict';
import { recapBody, recapText, personalText } from '../public/night/recap.js';

const summary = () => ({
  room: { name: 'Home game', ended: true, hands: 2, durationMs: 60000, mode: 'digital', smallBlind: 5, bigBlind: 10 },
  players: [{ id: 'p1', name: '林 <J>', seat: 1, rank: 1, status: 'seated', net: 20, buyIn: 100, final: 120, hands: 2, won: 1, vpip: 50, rebuys: 0, allins: 0, biggest: 20, biggestHand: 1, best: { name: 'legacy hand name', nameMessage: { key: 'night.showdown', text: '摊牌' }, cards: ['As', 'Ks'], hand: 1 } }],
  balance: { ok: true, buyIn: 100, final: 100, cashOut: 0, pot: 0 },
  highlights: [{ kind: 'pot', title: 'legacy title', titleMessage: { key: 'night.highlights', text: '高光' }, text: 'legacy text', textMessage: { key: 'night.hand', params: { count: 2 }, text: '第 2 手' }, value: 20, players: ['p1'] }]
});

test('recaps use structured labels while preserving names and older free text', () => {
  const sum = summary();
  const html = recapBody(sum);
  assert.match(html, /rc-hl-title">高光<\/span>/);
  assert.match(html, /rc-hl-text">第 2 手<\/p>/);
  assert.match(html, /林 &lt;J&gt;/);
  assert.match(recapText(sum), /· 高光 20 · 第 2 手/);
  assert.match(personalText(sum, 'p1'), /亮过最好的一手 · 摊牌（第 1 手）/);
  delete sum.highlights[0].titleMessage;
  delete sum.highlights[0].textMessage;
  assert.match(recapText(sum), /· legacy title 20 · legacy text/);
});

const { setLanguage } = await import('../public/i18n/index.js');
const { duration, day, n } = await import('../public/night/recap.js');
const { handsBody } = await import('../public/night/replay.js');

test.afterEach(() => setLanguage('zh-CN', { persist: false }));

test('report exports follow language changes without changing player names or older messages', () => {
  const titles = {
    'zh-CN': '【夜席战报】Home game', 'zh-TW': '【夜席戰報】Home game',
    en: '【Yexi results】Home game', ja: '【Yexi 成績】Home game',
    ko: '【Yexi 결과】Home game', es: '【Resultados de Yexi】Home game'
  };
  for (const [language, title] of Object.entries(titles)) {
    setLanguage(language, { persist: false });
    const sum = summary();
    assert.equal(recapText(sum).split('\n')[0], title);
    assert.match(recapText(sum), /林 <J>/);
    assert.doesNotMatch(recapText(sum), /\{\w+\}|night\./);
    assert.doesNotMatch(personalText(sum, 'p1'), /legacy hand name|\{\w+\}|night\./);
  }
  setLanguage('en', { persist: false });
  const sum = summary();
  delete sum.highlights[0].titleMessage;
  delete sum.highlights[0].textMessage;
  sum.highlights[0].text = '旧版原始记录';
  assert.match(recapText(sum), /· legacy title 20 · 旧版原始记录/);
  assert.match(personalText(sum, 'p1'), /Best shown hand · Showdown \(Hand 1\)/);
});

test('duration, dates and numbers use the selected locale while retaining the original Chinese format', () => {
  setLanguage('zh-CN', { persist: false });
  assert.equal(duration(1000), '不到 1 分钟');
  assert.equal(duration(65 * 60000), '1 小时 5 分');
  assert.equal(day('2026-11-18T12:00:00'), '11月18日 周三');
  setLanguage('en', { persist: false });
  assert.equal(duration(65 * 60000), '1 hr 5 min');
  assert.match(day('2026-11-18T12:00:00'), /Nov/);
  setLanguage('es', { persist: false });
  assert.equal(n(12345.5), new Intl.NumberFormat('es').format(12345.5));
  assert.equal(duration(1000), 'Menos de 1 minuto');
});

test('replay localizes run labels and structured pot and hand names, escaping player names', () => {
  const record = {
    n: 2, at: '2026-11-18T12:00:00', end: '2026-11-18T12:01:05', mode: 'digital', runs: 2,
    seats: { p1: { name: '<Pat>', seat: 1, start: 100 }, p2: { name: 'Jo', seat: 2, start: 100 } },
    dealer: 'p1', straddle: 'p1', blinds: { small: 5, big: 10, ante: 1 },
    awards: { p1: 20 }, contrib: { p1: 10, p2: 10 }, folded: [], showdown: true,
    shown: { p1: ['As', 'Ks'] }, showOrder: ['p1', 'p2'],
    boards: [['Qs', 'Js', 'Ts', '2h', '3h'], ['4s', '5s', '6s', '7h', '8h']],
    boardHands: [{ p1: 'legacy hand one' }, { p1: 'legacy hand two' }],
    boardHandsMessage: [{ p1: { key: 'night.showdown', text: '摊牌' } }, {}],
    pots: [{ name: 'legacy pot', nameMessage: { key: 'night.pot', text: '底池' }, amount: 20, run: 1, winners: ['p1'], shares: { p1: 20 }, runOdd: true, oddRecipients: ['p1'] }],
    actions: [{ a: 'check', id: 'p1', pot: 20, by: 'legacy reason', byMessage: { key: 'night.table', text: '牌桌' } }, { a: 'street', street: 1, run: 1, board: ['Qs', 'Js', 'Ts'] }]
  };
  setLanguage('en', { persist: false });
  const html = handsBody({ records: [record], roster: {} }, 2);
  assert.match(html, /<h2>Hand 2<\/h2>/);
  assert.match(html, /<h4>Run 1<\/h4>/);
  assert.match(html, /&lt;Pat&gt; · Showdown/);
  assert.match(html, /legacy hand two/);
  assert.match(html, /Pot <b class="num">20<\/b>/);
  assert.match(html, /Host action · Table/);
  assert.match(html, /Duration 1 min 5 sec/);
  assert.doesNotMatch(html, /<Pat>|legacy hand one|legacy pot|legacy reason/);
  setLanguage('es', { persist: false });
  assert.match(handsBody({ records: [record], roster: {} }, 2), /Pasar/);
  assert.match(handsBody({ records: [] }, 2), /Todavía no hay manos terminadas/);
});

test('share-image font stacks follow Japanese and Korean without a Simplified Chinese font ahead of them', async () => {
  const { imageFonts } = await import('../public/night/recap.js');
  assert.equal(typeof imageFonts, 'function');
  for (const language of ['ja', 'ko']) {
    setLanguage(language, { persist: false });
    const fonts = imageFonts();
    for (const family of Object.values(fonts)) assert.doesNotMatch(family, /\bSC\b/);
    assert.match(fonts.sans, language === 'ja' ? /Hiragino|Gothic|JP/ : /Malgun|Gothic|KR/);
  }
  setLanguage('zh-CN', { persist: false });
  assert.equal(imageFonts().serif, "'NT Serif SC', 'Songti SC', 'STSong', serif");
});
