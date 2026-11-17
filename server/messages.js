import { message, translate } from '../public/i18n/core.js';

export function msg(key, params = {}) {
  const fullKey = key.startsWith('server.') ? key : `server.${key}`;
  return { key: fullKey, params, text: translate(fullKey, params) };
}

export function joinMessages(items, separator = ' · ') {
  return msg('list', { items: { list: items, separator } });
}

export function describe(value) {
  return typeof value === 'string' ? { text: value } : value;
}

export const defaultText = value => message(value);

export function errorResponse(value) {
  const descriptor = describe(value);
  const text = value instanceof Error ? value.message : defaultText(descriptor);
  return { error: text, message: text, ...(descriptor.key ? { key: descriptor.key, params: descriptor.params || {} } : {}) };
}
