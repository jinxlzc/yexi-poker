import { t } from '../i18n/index.js';
// 夜席 v3 牌面：大角标排版 + 原创花色路径。牌是有正反两面的 3D 物体，翻面动画由 .is-flipped 控制。
export const SUIT_PATH = {
  s: 'M50 5C41 21 9 37 9 60c0 13 10 21 21 21 7 0 13-3 17-9-1 9-5 15-13 20h32c-8-5-12-11-13-20 4 6 10 9 17 9 11 0 21-8 21-21C91 37 59 21 50 5Z',
  h: 'M50 91C23 70 6 54 6 33 6 19 17 9 30 9c9 0 16 5 20 13 4-8 11-13 20-13 13 0 24 10 24 24 0 21-17 37-44 58Z',
  d: 'M50 3c10 17 23 33 41 47C73 64 60 80 50 97 40 80 27 64 9 50 27 36 40 20 50 3Z',
  c: 'M50 7a20 20 0 0 0-17 31 20 20 0 1 0 14 34c-1 8-5 14-13 20h32c-8-6-12-12-13-20a20 20 0 1 0 14-34A20 20 0 0 0 50 7Z'
};
const RED = new Set(['h', 'd']);
const RANK_LABEL = { T: '10' };
const CREST = { J: 'night.crestJ', Q: 'night.crestQ', K: 'night.crestK' };
export const rankLabel = rank => RANK_LABEL[rank] || rank;

export const suitGlyph = (suit, className = '') =>
  `<svg class="suit ${className}" viewBox="0 0 100 100" aria-hidden="true"><path d="${SUIT_PATH[suit]}"/></svg>`;

export function cardFace(code) {
  const rank = code[0], suit = code[1];
  const kind = 'JQK'.includes(rank) ? 'is-face' : rank === 'A' ? 'is-ace' : '';
  return `<div class="npcard-face npcard-front ${RED.has(suit) ? 'is-red' : 'is-black'} ${kind}">${kind === 'is-face' ? `<i class="frame"></i><i class="crest">${t(CREST[rank])}</i>` : ''}<span class="rank ${rank === 'T' ? 'is-ten' : ''}">${rankLabel(rank)}</span>${suitGlyph(suit, 'pip-s')}${suitGlyph(suit, 'pip-l')}<i class="foil"></i></div>`;
}

export function cardBack() {
  return `<div class="npcard-face npcard-back"><i class="bk-frame"></i><i class="bk-seal">${t('night.seal')}</i></div>`;
}

export function playingCard(code, { size = '', flipped = false, extra = '', cls = '' } = {}) {
  const up = !!(code && flipped);
  const inner = `<div class="npcard-inner">${code ? cardFace(code) : '<div class="npcard-face npcard-front is-blank"></div>'}${cardBack()}</div>`;
  return `<div class="npcard ${size} ${cls} ${up ? 'is-flipped' : 'is-down'}" data-card="${up ? code : 'back'}" ${extra}>${inner}</div>`;
}

export function boardSlots(board = [], { size = 'is-board', marks = {} } = {}) {
  return `<div class="board-slots" aria-label="${t('night.board')}">${[0, 1, 2, 3, 4].map(i => {
    const code = board[i];
    return `<div class="board-slot" data-slot="${i}">${code ? playingCard(code, { size, flipped: true, cls: marks[code] || '' }) : '<div class="slot-empty"></div>'}</div>`;
  }).join('')}</div>`;
}
