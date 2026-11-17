import { languages, matchLanguage, translate, message } from './core.js';

const storageKey = 'yexi.language';
let current = 'zh-CN';
if (typeof window !== 'undefined') {
  let saved;
  try { saved = window.localStorage.getItem(storageKey); } catch { /* Storage may be disabled. */ }
  current = Object.hasOwn(languages, saved) ? saved : matchLanguage(navigator.languages?.length ? navigator.languages : [navigator.language]);
}
export const getLanguage = () => current;
export const locale = getLanguage;
export const t = (key, params = {}) => translate(key, params, current);
export const localized = value => message(value, current);
export { languages };

function updateDocument() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = current;
  document.title = t('app.title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('app.description'));
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', t('app.name'));
  document.querySelector('link[rel="manifest"]')?.setAttribute('href', `/i18n/manifests/${current}.webmanifest`);
  document.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = t(element.dataset.i18n); });
}

export function setLanguage(language, { persist = true } = {}) {
  if (!Object.hasOwn(languages, language)) return current;
  current = language;
  if (persist && typeof window !== 'undefined') {
    try { window.localStorage.setItem(storageKey, current); } catch { /* Selection still works for this visit. */ }
  }
  updateDocument();
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('languagechange', { detail: current }));
  return current;
}

if (typeof window !== 'undefined') {
  updateDocument();
  window.addEventListener('storage', event => {
    if (event.key === storageKey) setLanguage(Object.hasOwn(languages, event.newValue) ? event.newValue : matchLanguage(navigator.languages), { persist: false });
  });
}
