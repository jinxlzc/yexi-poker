// 生成本仓库原创的短 WAV：安静私人牌局，木头、陶瓷、纸牌。禁止采样商业或第三方游戏音频。
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 22050;
const outDir = join(dirname(fileURLToPath(import.meta.url)), '../public/audio');
mkdirSync(outDir, { recursive: true });

function env(samples, fn) {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = fn(i / RATE, i, samples);
  return out;
}
function clamp(v) { return Math.max(-1, Math.min(1, v)); }
function exp(t, tau) { return Math.exp(-t / tau); }
function noise() { return Math.random() * 2 - 1; }
function sin(t, f, p = 0) { return Math.sin(2 * Math.PI * f * t + p); }
function band(t, f, q = 0.0008) { return noise() * Math.exp(-((t % 1) * f) * q); }
function mix(...parts) {
  const n = Math.max(...parts.map(p => p.length));
  const out = new Float32Array(n);
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i];
  return out;
}
function at(offset, src, destLen) {
  const out = new Float32Array(destLen);
  const start = Math.floor(offset * RATE);
  for (let i = 0; i < src.length && start + i < destLen; i++) out[start + i] += src[i];
  return out;
}
function woodKnock(duration = 0.16, freq = 210) {
  const n = Math.floor(duration * RATE);
  return env(n, (t) => {
    const thud = sin(t, freq) * exp(t, 0.035) * 0.55 + sin(t, freq * 2.1) * exp(t, 0.02) * 0.18;
    const tick = (t < 0.008 ? noise() * (1 - t / 0.008) * 0.22 : 0);
    const body = sin(t, 92) * exp(t, 0.05) * 0.2;
    return clamp(thud + tick + body);
  });
}
function ceramicChip(duration = 0.14, pitch = 2100) {
  const n = Math.floor(duration * RATE);
  return env(n, (t) => {
    const click = sin(t, pitch + 400 * Math.sin(t * 40)) * exp(t, 0.012) * 0.42;
    const mid = sin(t, 480) * exp(t, 0.03) * 0.22;
    const felt = (t < 0.025 ? noise() * exp(t, 0.012) * 0.18 : 0);
    const ring = sin(t, pitch * 0.48) * exp(t, 0.025) * 0.12;
    return clamp(click + mid + felt + ring);
  });
}
function chipStack(count, heavier = false) {
  const times = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    times.push(t);
    t += 0.028 + Math.random() * 0.024;
  }
  const len = Math.floor((t + 0.18) * RATE);
  const parts = times.map((when, i) => at(when, ceramicChip(0.15, (heavier ? 1400 : 2000) - i * 80 + Math.random() * 180), len));
  if (heavier) parts.push(at(0, env(Math.floor(0.18 * RATE), (tt) => sin(tt, 140) * exp(tt, 0.06) * 0.28), len));
  return mix(...parts);
}
function cardSlide() {
  const n = Math.floor(0.22 * RATE);
  return env(n, (t) => {
    const slip = noise() * exp(t, 0.07) * (0.12 + 0.08 * Math.sin(2 * Math.PI * 18 * t));
    const paper = sin(t, 1450 + t * 400) * exp(t, 0.03) * 0.08;
    const tap = t > 0.12 && t < 0.16 ? sin(t, 520) * exp(t - 0.12, 0.015) * 0.28 + noise() * 0.06 : 0;
    return clamp(slip + paper + tap);
  });
}
function riffle() {
  const events = [];
  let t = 0;
  for (let i = 0; i < 14; i++) {
    events.push(t);
    t += 0.018 + Math.random() * 0.012;
  }
  const len = Math.floor((t + 0.12) * RATE);
  const flicks = events.map((when, i) => at(when, env(Math.floor(0.05 * RATE), (tt) => {
    return clamp(noise() * exp(tt, 0.012) * 0.22 + sin(tt, 1800 + i * 40) * exp(tt, 0.01) * 0.16);
  }), len));
  return mix(...flicks);
}
function dealSnap(pitch = 1680) {
  const n = Math.floor(0.11 * RATE);
  return env(n, (t) => {
    const snap = sin(t, pitch) * exp(t, 0.01) * 0.4 + (t < 0.006 ? noise() * 0.28 : 0);
    const paper = sin(t, 620) * exp(t, 0.02) * 0.16;
    return clamp(snap + paper);
  });
}
function flipSlap() {
  const deal = dealSnap(1500);
  const slap = at(0.05, env(Math.floor(0.12 * RATE), (t) => {
    return clamp(sin(t, 240) * exp(t, 0.03) * 0.32 + noise() * exp(t, 0.018) * 0.14);
  }), Math.floor(0.2 * RATE));
  return mix(at(0, deal, slap.length), slap);
}
function buttonSlide() {
  const n = Math.floor(0.16 * RATE);
  return env(n, (t) => clamp(noise() * exp(t, 0.05) * 0.08 + sin(t, 900 - t * 800) * exp(t, 0.04) * 0.12));
}
function potPush() {
  const pour = chipStack(6, true);
  const extra = at(0.12, ceramicChip(0.16, 1600), pour.length + 2000);
  return mix(pour, extra.length === pour.length ? extra : at(0, extra, pour.length));
}
function oddChip() { return ceramicChip(0.13, 2400); }
function failClick() {
  const n = Math.floor(0.07 * RATE);
  return env(n, (t) => clamp(sin(t, 380) * exp(t, 0.012) * 0.18 + (t < 0.004 ? noise() * 0.08 : 0)));
}
function allinPour() {
  const pour = chipStack(9, true);
  const thud = at(0.16, env(Math.floor(0.2 * RATE), (t) => clamp(sin(t, 90) * exp(t, 0.07) * 0.4 + sin(t, 180) * exp(t, 0.04) * 0.16)), pour.length + 3000);
  const n = Math.max(pour.length, thud.length);
  return mix(at(0, pour, n), at(0, thud, n));
}

// 轮到你：两声很轻的木琴式敲击，比筹码声更柔，避免像闹钟。
function turnChime() {
  const n = Math.floor(0.62 * RATE);
  const tone = (t, f) => (sin(t, f) * 0.5 + sin(t, f * 2.01) * 0.16 + sin(t, f * 3.98) * 0.05) * exp(t, 0.16);
  return env(n, (t) => clamp((t < 0.6 ? tone(t, 784) : 0) * 0.55 + (t > 0.16 ? tone(t - 0.16, 1046.5) : 0) * 0.5 + (t < 0.006 ? noise() * 0.05 : 0)));
}
const only = new Set(process.argv.slice(2));
function writeWav(name, samples) {
  if (only.size && !only.has(name.replace('.wav', ''))) return;
  const peak = Math.max(...samples.map(v => Math.abs(v)), 1e-6);
  const norm = samples.map(v => clamp(v / peak * 0.86));
  const data = Buffer.alloc(norm.length * 2);
  for (let i = 0; i < norm.length; i++) data.writeInt16LE(Math.round(norm[i] * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(join(outDir, name), Buffer.concat([header, data]));
}

writeWav('check.wav', woodKnock());
writeWav('bet.wav', chipStack(4, false));
writeWav('raise.wav', mix(chipStack(3, true), at(0.09, ceramicChip(0.14, 1900), 8000), at(0.13, ceramicChip(0.12, 2100), 8000)));
writeWav('allin.wav', allinPour());
writeWav('fold.wav', cardSlide());
writeWav('shuffle.wav', riffle());
writeWav('deal.wav', dealSnap());
writeWav('flip.wav', flipSlap());
writeWav('button.wav', buttonSlide());
writeWav('pot.wav', potPush());
writeWav('odd.wav', oddChip());
writeWav('fail.wav', failClick());
writeWav('turn.wav', turnChime());
console.log('wrote original wavs to', outDir);
