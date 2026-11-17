const KEY = 'night-table.sound';
const FILES = ['check', 'bet', 'raise', 'allin', 'fold', 'shuffle', 'deal', 'flip', 'button', 'pot', 'odd', 'fail', 'turn'];
const ACTION = { check: 'check', call: 'bet', raise: 'raise', allin: 'allin', fold: 'fold' };

let ctx, unlocked = false, blocked = false, buffers = new Map();
const isOn = () => localStorage.getItem(KEY) !== 'off';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

async function ensure() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') await ctx.resume();
  unlocked = ctx.state === 'running';
  blocked = !unlocked;
  return unlocked;
}

async function load() {
  if (!ctx) return;
  await Promise.all(FILES.map(async name => {
    if (buffers.has(name)) return;
    try {
      const res = await fetch(`/audio/${name}.wav`);
      if (!res.ok) return;
      buffers.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
    } catch { /* 测试或无音频设备时保持静默 */ }
  }));
}

function jitter() { return 0.96 + Math.random() * 0.09; }

function playBuffer(name, when = 0, gain = 0.7) {
  if (!isOn() || !unlocked || !ctx || !buffers.has(name)) return;
  const src = ctx.createBufferSource();
  src.buffer = buffers.get(name);
  src.playbackRate.value = jitter();
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(ctx.destination);
  src.start(ctx.currentTime + when);
}

export const tableSound = {
  get unlocked() { return unlocked; },
  get blocked() { return blocked && isOn(); },
  isOn,
  setOn(on) { localStorage.setItem(KEY, on ? 'on' : 'off'); },
  toggle() { this.setOn(!isOn()); return isOn(); },
  async unlock() {
    try {
      if (await ensure()) { await load(); blocked = false; }
    } catch { blocked = true; }
    return unlocked;
  },
  play(name, { copies = 1, gap = 0.02, gain } = {}) {
    if (!isOn() || !unlocked) return;
    const vol = gain ?? (name === 'fail' ? 0.22 : 0.7);
    for (let i = 0; i < copies; i++) playBuffer(name, i * (gap + Math.random() * 0.02), vol);
  },
  action(type) { this.play(ACTION[type] || 'fail'); },
  fail() { this.play('fail'); }
};

function arm() {
  const once = () => { tableSound.unlock(); window.removeEventListener('pointerdown', once); window.removeEventListener('keydown', once); };
  window.addEventListener('pointerdown', once);
  window.addEventListener('keydown', once);
}
arm();
