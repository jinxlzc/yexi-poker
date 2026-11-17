import ui from './ui/ko.js';
import server from './server/ko.js';
import night from './night/ko.js';

export default { ...ui, ...server, ...night,

  "language.label": "언어",
  "app.title": "야석 · 포커 테이블",
  "app.name": "야석",
  "app.description": "야석: 같은 네트워크에서 친구와 즐기는 포커. 실제 카드와 전자 카드, 놀이용 칩을 지원합니다.",
  "manifest.name": "야석 · 친구와 포커",
  "manifest.description": "같은 네트워크에서 즐기는 포커. 실제 카드 또는 전자 카드, 놀이용 칩만 사용합니다.",
  "app.loading": "테이블에 연결하는 중입니다.",
  "app.noscript": "테이블 동기화와 플레이를 위해 JavaScript를 켜 주세요.",
  "run.1": "한 번 진행",
  "run.2": "두 번 진행",
  "run.3": "세 번 진행"
};
