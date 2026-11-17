import test from 'node:test';
import assert from 'node:assert/strict';
import { dictionaries, matchLanguage, translate, message, format } from '../public/i18n/core.js';

const placeholders = value => [...String(value).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
for (const language of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'es']) {
  test(`dictionary completeness and parameters: ${language}`, () => {
    assert.deepEqual(Object.keys(dictionaries[language]).sort(), Object.keys(dictionaries['zh-CN']).sort());
    for (const [key, value] of Object.entries(dictionaries[language])) {
      assert.equal(typeof value, 'string', key);
      assert.ok(value.trim(), key);
      assert.deepEqual(placeholders(value), placeholders(dictionaries['zh-CN'][key]), key);
    }
  });
}
test('language matching respects preference order and Chinese scripts', () => {
  for (const lang of ['zh-TW', 'zh-HK', 'zh-Hant', 'zh-Hant-HK']) assert.equal(matchLanguage([lang]), 'zh-TW');
  for (const lang of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans']) assert.equal(matchLanguage([lang]), 'zh-CN');
  assert.equal(matchLanguage(['fr-FR', 'ja-JP', 'en']), 'ja');
  for (const lang of ['en', 'ja', 'ko', 'es']) assert.equal(matchLanguage([`${lang}-XX`]), lang);
  assert.equal(matchLanguage(['fr']), 'en');
  assert.equal(matchLanguage([]), 'en');
});
test('missing values fall back to English, then Simplified Chinese', () => {
  const samples = { en: { label: 'Hello {name}' }, 'zh-CN': { label: '你好 {name}', only: '仅中文' }, ja: {} };
  assert.equal(format(samples, 'label', { name: '<Yexi>' }, 'ja'), 'Hello <Yexi>');
  assert.equal(format(samples, 'only', {}, 'ja'), '仅中文');
  assert.equal(format(samples, 'unknown', {}, 'ja'), 'unknown');
});
test('legacy log and error text stays verbatim', () => {
  assert.equal(message('旧记录：小明过牌', 'en'), '旧记录：小明过牌');
  assert.equal(message({ text: '旧记录：小明过牌' }, 'ja'), '旧记录：小明过牌');
  assert.equal(message({ error: '旧错误' }, 'en'), '旧错误');
  assert.equal(message({ key: 'unknown', text: '旧版本文案' }, 'en'), '旧版本文案');
});
test('parameters are inserted once without interpreting player input', () => {
  assert.equal(format({ en: { label: '{name}: {amount}' } }, 'label', { name: '{amount}', amount: 20 }, 'en'), '{amount}: 20');
  assert.equal(translate('language.label', {}, 'en'), 'Language');
});
