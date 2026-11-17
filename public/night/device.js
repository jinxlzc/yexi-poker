import { t } from '../i18n/index.js';
// 手机设备能力：屏幕常亮、震动、上次的房间。全部是渐进增强，不支持就安静地跳过。
const AWAKE_KEY = 'night-table.awake';
let lock = null, video = null, want = false, armed = false;
export const awakePreferred = () => localStorage.getItem(AWAKE_KEY) !== 'off';
export function setAwakePreferred(on) { localStorage.setItem(AWAKE_KEY, on ? 'on' : 'off'); keepAwake(on && want); }
export const awakeActive = () => !!lock || !!(video && !video.paused);
async function viaApi() {
  if (!('wakeLock' in navigator) || !window.isSecureContext) return false;
  try { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); return true; } catch { return false; }
}
// 局域网 http 不是安全上下文，Wake Lock 不可用：退回到循环播放一段静音小视频（需要一次用户点击）。
function viaVideo() {
  if (!video) {
    video = document.createElement('video');
    video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); video.muted = true; video.loop = true;
    video.setAttribute('aria-hidden', 'true'); video.src = '/night/awake.mp4';
    video.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none';
    document.body.append(video);
  }
  return video.play().then(() => true).catch(() => false);
}
async function acquire() {
  if (!want || !awakePreferred() || document.hidden) return;
  if (lock || (video && !video.paused)) return;
  if (await viaApi()) return;
  if (!(await viaVideo()) && !armed) {
    armed = true;
    const once = () => { armed = false; window.removeEventListener('pointerdown', once); acquire(); };
    window.addEventListener('pointerdown', once);
  }
}
export function keepAwake(on) {
  want = on;
  if (on) acquire();
  else { lock?.release().catch(() => {}); lock = null; video?.pause(); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) acquire(); });

export function buzz(pattern = [40, 70, 40]) { try { navigator.vibrate?.(pattern); } catch { /* iOS 不支持 */ } }

const LAST = 'night-table.last';
export function rememberRoom(code, page) { try { localStorage.setItem(LAST, JSON.stringify({ code, page, at: Date.now() })); } catch { /* 隐私模式 */ } }
export function lastRoom() { try { const v = JSON.parse(localStorage.getItem(LAST) || 'null'); return v && Date.now() - v.at < 3 * 24 * 3600_000 ? v : null; } catch { return null; } }

// 标题栏提示：轮到自己时在标签页标题前加一个点。
export function titleAlert(text) { document.title = text ? t('night.alertTitle', { text }) : t('app.title'); }
