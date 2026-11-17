import zhCN from './zh-CN.js';
import zhTW from './zh-TW.js';
import en from './en.js';
import ja from './ja.js';
import ko from './ko.js';
import es from './es.js';

export const dictionaries = { 'zh-CN': zhCN, 'zh-TW': zhTW, en, ja, ko, es };
export const languages = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語', ko: '한국어', es: 'Español' };

export function matchLanguage(preferences = []) {
  for (const preference of preferences) {
    const tag = String(preference).toLowerCase().replaceAll('_', '-');
    if (/^zh(?:-|$)/.test(tag)) return /(?:^|-)(?:tw|hk|hant)(?:-|$)/.test(tag) ? 'zh-TW' : 'zh-CN';
    const base = tag.split('-')[0];
    if (['en', 'ja', 'ko', 'es'].includes(base)) return base;
  }
  return 'en';
}

function template(catalogues, key, language) {
  return [language, 'en', 'zh-CN'].map(lang => catalogues[lang]?.[key]).find(value => typeof value === 'string' && value.trim());
}

export function format(catalogues, key, params = {}, language = 'zh-CN') {
  const value = template(catalogues, key, language) ?? key;
  return String(value).replace(/\{(\w+)\}/g, (token, name) => Object.hasOwn(params, name) ? String(params[name] ?? '') : token);
}

function parameter(value, language) {
  if (Array.isArray(value)) return value.map(item => parameter(item, language)).join(' · ');
  if (value && typeof value === 'object') {
    if (Array.isArray(value.list)) return value.list.map(item => parameter(item, language)).join(parameter(value.separator ?? ' · ', language));
    return message(value, language);
  }
  return value ?? '';
}

export function translate(key, params = {}, language = 'zh-CN') {
  return format(dictionaries, key, Object.fromEntries(Object.entries(params).map(([name, value]) => [name, parameter(value, language)])), language);
}

export function message(value, language = 'zh-CN') {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  if (value.key && template(dictionaries, value.key, language)) return translate(value.key, value.params || {}, language);
  return String(value.text ?? value.error ?? value.message ?? value.key ?? '');
}
