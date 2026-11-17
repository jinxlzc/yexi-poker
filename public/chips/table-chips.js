export const DENOMS = [
  { value: 1000, name: 'amber' },
  { value: 500, name: 'purple' },
  { value: 100, name: 'black' },
  { value: 25, name: 'green' },
  { value: 5, name: 'blue' },
  { value: 1, name: 'white' }
];

export function breakChips(amount, limit = 10) {
  const chips = [];
  let left = Math.max(0, Math.floor(amount || 0));
  for (const d of DENOMS) {
    let n = Math.floor(left / d.value);
    left -= n * d.value;
    const show = Math.min(n, Math.max(1, limit - chips.length));
    for (let i = 0; i < show && chips.length < limit; i++) chips.push(d);
    if (n > show) chips[chips.length - 1] = { ...d, more: n - show };
  }
  return chips;
}

// 陶瓷筹码：按面额拆成最多 3 列，每列最多 7 片；compact 用于飞行与小尺寸。
export function chipStackHtml(amount, compact = false, { width } = {}) {
  let left = Math.max(0, Math.floor(amount || 0));
  const cols = [];
  for (const d of DENOMS) { const n = Math.floor(left / d.value); if (n) { cols.push([d, n]); left -= n * d.value; } if (cols.length === 3) break; }
  if (!cols.length) return '';
  const w = width || (compact ? 20 : 26), max = compact ? 5 : 7;
  return `<div class="chipstack" style="--cw:${w}px" aria-hidden="true">${cols.map(([d, n]) => { const k = Math.min(n, max); return `<span class="chipcol" style="--n:${k}">${Array.from({ length: k }, (_, i) => `<i class="chip chip-${d.name}${i === k - 1 ? ' is-cap' : ''}" style="--i:${i}"></i>`).join('')}</span>`; }).join('')}</div>`;
}

export function flyChips(from, to, amount, { duration = 400, onDone, odd = false } = {}) {
  const fx = document.getElementById('fx');
  if (!fx || !from || !to || amount <= 0) { onDone?.(); return; }
  const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
  const ghost = document.createElement('div');
  ghost.className = `chip-flight ${odd ? 'is-odd' : ''}`;
  ghost.innerHTML = chipStackHtml(odd ? 1 : amount, true);
  ghost.style.left = '0'; ghost.style.top = '0';
  fx.append(ghost);
  const x1 = a.left + a.width / 2 - 20, y1 = a.top + a.height / 2 - 10;
  const x2 = b.left + b.width / 2 - 20, y2 = b.top + b.height / 2 - 10;
  const midX = (x1 + x2) / 2, midY = Math.min(y1, y2) - 36;
  const anim = ghost.animate([
    { transform: `translate(${x1}px, ${y1}px) scale(0.9)`, opacity: 0.2, offset: 0 },
    { transform: `translate(${midX}px, ${midY}px) scale(1.05)`, opacity: 1, offset: 0.45 },
    { transform: `translate(${x2}px, ${y2}px) scale(0.95)`, opacity: 1, offset: 1 }
  ], { duration, easing: 'cubic-bezier(0.22, 0.8, 0.24, 1)', fill: 'forwards' });
  anim.finished.then(() => { ghost.remove(); onDone?.(); }).catch(() => { ghost.remove(); onDone?.(); });
  return anim;
}

export function clearFlights() {
  const fx = document.getElementById('fx');
  if (fx) fx.replaceChildren();
}
