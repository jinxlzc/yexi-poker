import { writeFile } from 'node:fs/promises';
import { card, slot, chips, fmt, ICON, page } from './parts.mjs';
const out = new URL('..', import.meta.url).pathname;

// Seat anchor points on a 1440×900 board (table center 720,452)
const POS = { tl: [500, 166], tr: [940, 166], r: [1296, 440], br: [940, 716], bl: [500, 716], l: [144, 440] };
const BET = { tl: [540, 292], tr: [900, 292], r: [1108, 440], br: [900, 590], bl: [540, 590], l: [332, 440] };
function seat(p) {
  const [x, y] = POS[p.pos];
  const ring = p.acting ? `<svg class="ring" viewBox="0 0 76 76"><circle class="bg" cx="38" cy="38" r="36"/><circle class="fg" cx="38" cy="38" r="36" stroke-dasharray="${2 * Math.PI * 36}" stroke-dashoffset="${2 * Math.PI * 36 * (1 - p.timer)}"/></svg>` : '';
  const holes = p.holes ? `<div class="holes">${p.holes.map(c => card(c, { w: p.holeW || 40 })).join('')}</div>` : '';
  return `<div class="seat ${p.folded ? 'folded' : ''} ${p.acting ? 'acting' : ''} ${p.win ? 'win' : ''}" style="left:${x}px;top:${y}px">
    ${holes}${ring}<div class="avatar ${p.hue}">${p.name[0]}</div>
    ${p.blind ? `<span class="blind">${p.blind}</span>` : ''}
    <div class="plate"><div class="name">${p.name}</div><div class="stk num">${p.allin ? '<span class="allin">全下</span>' : fmt(p.stack)}</div>
    <div class="status">${p.status || '等待'}</div></div></div>`;
}
const bet = p => { if (!p.bet) return ''; const [x, y] = BET[p.pos]; const rev = ['r', 'tr', 'br'].includes(p.pos); const c = chips(p.bet, { w: 30 }), v = `<span class="v num">${fmt(p.bet)}</span>`; return `<div class="bet" style="left:${x}px;top:${y}px">${rev ? v + c : c + v}</div>`; };

// ── Screen 1: desktop, flop in progress, 6 players
{
  const players = [
    { pos: 'tl', name: '阿宁', hue: 'h1', stack: 2320, bet: 120, holes: ['back', 'back'], status: '下注 120', blind: '大' },
    { pos: 'tr', name: '林川', hue: 'h2', stack: 1800, bet: 120, holes: ['back', 'back'], status: '跟注 120' },
    { pos: 'r', name: '小满', hue: 'h3', stack: 1260, holes: ['back', 'back'], acting: true, timer: .62, status: '思考中 · 18 秒' },
    { pos: 'br', name: '周可', hue: 'h4', stack: 1960, holes: ['back', 'back'], status: '等待' },
    { pos: 'bl', name: '何麦', hue: 'h5', stack: 1920, holes: ['back', 'back'], status: '等待', dealer: true },
    { pos: 'l', name: '苏禾', hue: 'h6', stack: 2290, folded: true, status: '已弃牌', blind: '小' }
  ];
  const body = `<main class="board">
  <header class="topbar">
    <span class="seal">夜</span>
    <div class="room"><b>周六夜席</b><span>电子牌 · 盲注 10 / 20</span></div>
    <div class="mid"><span class="pill">第 <b class="num">12</b> 手</span><span class="pill"><span class="ok-dot"></span>全场 <b class="num">12,000</b> · 账平</span></div>
    <div class="right"><span class="pill">${ICON.qr}<span>扫码入座</span><span class="code">QZFV</span></span><span class="iconbtn">${ICON.sound}</span><span class="iconbtn">${ICON.more}</span></div>
  </header>
  <section class="table"><div class="rail"></div><div class="felt"><i class="line"></i><span class="brand">夜 席</span></div></section>
  <div class="center" style="left:720px;top:440px;position:absolute">
    <div class="street"><span>翻前</span><i></i><span class="on">翻牌圈</span><i></i><span>转牌</span><i></i><span>河牌</span></div>
    <div class="boardrow">${['K♠', '10♥', '6♦'].map(c => card(c.replace('♠', 's').replace('♥', 'h').replace('♦', 'd'))).join('')}${slot()}${slot()}</div>
    <div class="pot">${chips(210, { w: 26 })}<span class="lbl">底池</span><span class="amt num">210</span><span class="sub">本轮 +240</span></div>
  </div>
  ${players.map(seat).join('')}${players.map(bet).join('')}
  <div class="dealer" style="left:${POS.bl[0] + 58}px;top:${POS.bl[1] - 52}px">庄</div>
  <div class="ticker">
    <div class="row"><time class="num">22:41</time><span>进入翻牌圈 · <b>K♠ 10♥ 6♦</b></span></div>
    <div class="row"><time class="num">22:41</time><span><b>阿宁</b> 下注 120</span></div>
    <div class="row"><time class="num">22:42</time><span><b>林川</b> 跟注 120</span></div>
  </div>
  <nav class="dock">
    <span class="btn disabled">${ICON.play}新的一手</span>
    <span class="btn disabled">${ICON.next}下一轮</span>
    <span class="btn disabled">${ICON.split}分池</span>
    <i class="sep"></i>
    <span class="btn quiet">${ICON.undo}撤销</span>
    <span class="btn quiet">${ICON.seats}座位</span>
    <span class="btn quiet">${ICON.list}记录</span>
  </nav>
  <div class="ledger">主持 · 这台电脑<br><b>行动在各自手机上</b></div>
</main>`;
  await writeFile(out + '01-table-flop.html', page('夜席 · 翻牌圈', body, ['table.css']));
}
console.log('built');

// ── Screen 2: phone, my turn on the flop (小满 holds K♥ K♣)
{
  const opps = [
    { n: '阿宁', h: 'h1', b: '下注 120' }, { n: '林川', h: 'h2', b: '跟注 120' },
    { n: '周可', h: 'h4', b: '1,960', muted: true }, { n: '何麦', h: 'h5', b: '1,920', muted: true, d: true },
    { n: '苏禾', h: 'h6', b: '弃牌', muted: true, folded: true }
  ];
  const body = `<main class="phone">
  <header class="p-head"><span class="seal">夜</span><div class="t"><b>周六夜席</b><span>第 12 手 · 翻牌圈 · 盲注 10/20</span></div><span class="iconbtn">${ICON.sound}</span></header>
  <section class="opps">${opps.map(o => `<div class="opp ${o.folded ? 'folded' : ''}"><div class="avatar ${o.h}">${o.n[0]}</div>${o.d ? '<i class="d">庄</i>' : ''}<span class="n">${o.n}</span><span class="b num ${o.muted ? 'muted' : ''}">${o.b}</span></div>`).join('')}</section>
  <section class="p-board">
    <div class="top"><span class="potv">${chips(210, { w: 20 })}底池 <b class="num">450</b></span><span>翻牌圈</span></div>
    <div class="row">${card('Ks', { w: 52 })}${card('10h', { w: 52 })}${card('6d', { w: 52 })}${slot(52)}${slot(52)}</div>
  </section>
  <section class="hero">
    <div class="hand" data-testid="hole-cards">${card('Kh', { w: 118 })}${card('Kc', { w: 118 })}</div>
    <div class="made"><span class="tag">三条 K</span><span class="me">小满 · 筹码<b class="num">1,260</b></span></div>
  </section>
  <section class="sheet">
    <div class="turn"><h2>轮到你</h2><span class="ctx">跟注 <b class="num">120</b> · 最少加到 <b class="num">240</b></span><span class="clock num">18 秒</span></div>
    <div class="timer"><i></i></div>
    <div class="amt"><div><div class="lbl">加注到</div><div class="v num">400</div></div><div class="step"><span>${ICON.minus}</span><span>${ICON.plus}</span></div></div>
    <div class="slider"><i class="track"></i><i class="fill"></i><i class="thumb"></i></div>
    <div class="presets"><span>最小<b class="num">240</b></span><span class="on">½ 池<b class="num">405</b></span><span>满池<b class="num">690</b></span><span>全下<b class="num">1,260</b></span></div>
    <div class="acts"><span class="btn ghost-danger">弃牌</span><span class="btn">跟注<small class="num">120</small></span><span class="btn primary">加注到 400<small>还剩 <span class="num">860</span></small></span></div>
    <i class="home"></i>
  </section>
</main>`;
  await writeFile(out + '02-phone-action.html', page('夜席 · 轮到你', body, ['phone.css']));
}

// ── Screen 3: desktop, digital showdown, auto-judged split with a side pot
{
  const players = [
    { pos: 'tl', name: '阿宁', hue: 'h1', stack: 1480, holes: ['As', '10d'], show: true, hand: '三条 10' },
    { pos: 'tr', name: '林川', hue: 'h2', stack: 960, holes: ['6s', '6c'], show: true, hand: '葫芦 · 6 带 10', win: true, delta: '+1,400' },
    { pos: 'r', name: '小满', hue: 'h3', stack: 0, allin: true, holes: ['Kh', 'Kc'], show: true, hand: '葫芦 · K 带 10', win: true, delta: '+930' },
    { pos: 'br', name: '周可', hue: 'h4', stack: 2620, folded: true, status: '已弃牌' },
    { pos: 'bl', name: '何麦', hue: 'h5', stack: 2320, folded: true, status: '已弃牌' },
    { pos: 'l', name: '苏禾', hue: 'h6', stack: 2290, folded: true, status: '已弃牌' }
  ];
  const seat3 = p => seat({ ...p, holeW: 46, status: p.hand || p.status }).replace('class="seat ', `class="seat ${p.show ? 'show' : ''} `).replace(p.hand ? '<div class="status">' : '@@', '<div class="status hand">');
  const deltas = players.filter(p => p.delta).map(p => { const [x, y] = POS[p.pos]; return `<div class="delta num" style="left:${x + 96}px;top:${y + 2}px">${p.delta}</div>`; }).join('');
  const body = `<main class="board">
  <header class="topbar">
    <span class="seal">夜</span>
    <div class="room"><b>周六夜席</b><span>电子牌 · 盲注 10 / 20</span></div>
    <div class="mid"><span class="pill">第 <b class="num">14</b> 手 · 摊牌</span><span class="pill"><span class="ok-dot"></span>全场 <b class="num">12,000</b> · 账平</span></div>
    <div class="right"><span class="pill">${ICON.qr}<span>扫码入座</span><span class="code">QZFV</span></span><span class="iconbtn">${ICON.sound}</span><span class="iconbtn">${ICON.more}</span></div>
  </header>
  <section class="table"><div class="rail"></div><div class="felt"><i class="line"></i><span class="brand">夜 席</span></div></section>
  <svg class="flights" viewBox="0 0 1440 900">
    <path d="M640 548 C 760 640, 1120 620, 1232 478"/><circle cx="1010" cy="606" r="3.5"/><circle cx="1150" cy="560" r="2.5" opacity=".6"/>
    <path d="M880 520 C 1010 520, 1020 330, 958 252"/><circle cx="1000" cy="420" r="3.5"/><circle cx="984" cy="320" r="2.5" opacity=".6"/>
  </svg>
  <div class="center" style="left:720px;top:440px;position:absolute">
    <div class="street"><span>翻前</span><i></i><span>翻牌圈</span><i></i><span>转牌</span><i></i><span>河牌</span><i></i><span class="on">摊牌</span></div>
    <div class="boardrow">${card('Ks', { cls: 'lift' })}${card('10h', { cls: 'lift' })}${card('6d', { cls: 'dim' })}${card('10c', { cls: 'lift' })}${card('2s', { cls: 'dim' })}</div>
    <div class="pots"><div class="potcard main">${chips(930, { w: 26 })}<div><div class="k">主池</div><div class="a num">930</div></div><span class="to">→ 小满</span></div><div class="potcard">${chips(1400, { w: 26 })}<div><div class="k">边池</div><div class="a num">1,400</div></div><span class="to">→ 林川</span></div></div>
  </div>
  ${players.map(seat3).join('')}${deltas}
  <div class="dealer" style="left:${POS.tl[0] + 92}px;top:${POS.tl[1] + 6}px">庄</div>
  <nav class="settlebar">
    <div class="ttl"><b>系统已按牌力判定</b><span>主持核对后确认，不能改判</span></div>
    <div class="rows"><span>主池 <b class="num">930</b> → <em>小满</em></span><span>边池 <b class="num">1,400</b> → <em>林川</em></span></div>
    <div class="bal"><span class="ok-dot"></span>分池后全场 <b class="num" style="color:var(--text)">12,000</b> · 无余数</div>
    <span class="btn quiet">返回</span><span class="btn primary">${ICON.check}确认分池</span>
  </nav>
</main>`;
  await writeFile(out + '03-showdown-split.html', page('夜席 · 摊牌分池', body, ['table.css']));
}

// ── Screen 4: create room on the host computer
{
  const body = `<main class="create">
  <div class="vignette"></div>
  <div class="c-top"><span class="seal">夜</span><span class="wordmark">夜席</span><span class="ver">开源 · 局域网牌桌</span></div>
  <section class="hero-l">
    <div class="eyebrow"><i></i>同一 Wi‑Fi · 朋友局 · 娱乐积分</div>
    <h1>夜席</h1>
    <div class="sub">一张桌子，几部手机，今晚的局就开了。</div>
    <p>这台电脑当牌桌，大家用手机扫码入座、下注。可以用电子牌让系统洗牌发牌，也可以照旧用实体牌，只把筹码交给夜席。</p>
    <div class="lan pill">${ICON.wifi}<span>手机连同一 Wi‑Fi，打开</span><b class="num">192.168.1.23:8787</b></div>
  </section>
  <div class="still">${card('Kh', { w: 108, cls: 'c1' })}${card('As', { w: 108, cls: 'c2' })}${card('back', { w: 108, cls: 'c3' })}${chips(0, { w: 46, cols: 3, groups: [[1000, 6], [500, 4], [100, 8]] })}</div>
  <section class="panel">
    <h2>开一张新桌</h2>
    <div class="lead">两分钟就好。牌局中途也能改盲注和补码。</div>
    <div class="field"><div class="l">打牌方式</div>
      <div class="modes">
        <div class="mode on"><i class="tick">${ICON.check}</i><div class="art"><i class="a1">${card('back', { w: 34 })}</i><i class="a2">${card('Ah', { w: 34 })}</i><i class="a3">${ICON.lock}</i></div><b>电子牌</b><span>系统洗牌发牌，底牌只在自己手机上，摊牌自动分池。</span></div>
        <div class="mode"><i class="tick"></i><div class="art"><i class="a4">${chips(0, { w: 34, groups: [[100, 6], [25, 4], [5, 7]] })}</i></div><b>实体牌</b><span>我们自己发牌，夜席只记筹码、提示轮到谁。</span></div>
      </div>
    </div>
    <div class="field"><label>房间名</label><div class="input focus">周六夜席<i class="caret"></i></div></div>
    <div class="field"><div class="l">盲注<em>常见：10 / 20</em></div>
      <div class="row2"><div class="stepper"><span class="k">小盲</span><span class="s">${ICON.minus}</span><span class="v num">10</span><span class="s">${ICON.plus}</span></div><div class="stepper"><span class="k">大盲</span><span class="s">${ICON.minus}</span><span class="v num">20</span><span class="s">${ICON.plus}</span></div></div>
    </div>
    <div class="field"><div class="l">起始筹码<em>按大盲计</em></div>
      <div class="seg"><span class="num">1,000<small>50 BB</small></span><span class="num on">2,000<small>100 BB · 推荐</small></span><span class="num">4,000<small>200 BB</small></span></div>
    </div>
    <div class="toggle"><div><b>允许补码</b><span>输光后由主持补，每次都写进记录</span></div><i class="switch"></i></div>
    <span class="btn primary go">创建房间</span>
    <div class="fine">仅娱乐积分 · 没有充值、提现或兑换</div>
  </section>
</main>`;
  await writeFile(out + '04-create-room.html', page('夜席 · 开一张新桌', body, ['create.css']));
}

// ── Screen 5: phone, scanning the QR and taking a seat
{
  const seats = [
    { x: 115, y: 34, n: '阿宁', h: 'h1' }, { x: 235, y: 34, n: '林川', h: 'h2' }, { x: 322, y: 136, n: '小满', h: 'h3' },
    { x: 235, y: 238, pick: true, n: '4 号' }, { x: 115, y: 238, free: true, n: '5 号' }, { x: 28, y: 136, n: '苏禾', h: 'h6' }
  ];
  const body = `<main class="phone">
  <header class="p-head"><span class="seal">夜</span><div class="t"><b>夜席</b><span>局域网牌桌</span></div><span class="iconbtn">${ICON.sound}</span></header>
  <div class="j-wrap">
    <div class="eyebrow">你被邀请入座</div>
    <h1>周六夜席</h1>
    <div class="meta"><span class="pill">电子牌</span><span class="pill">盲注 <b class="num">10 / 20</b></span><span class="pill">起始 <b class="num">2,000</b></span></div>
    <div class="mini"><div class="t"><span>夜席</span></div>
      ${seats.map(s => `<div class="s ${s.pick ? 'pick free' : s.free ? 'free' : ''}" style="left:${s.x}px;top:${s.y}px">${s.h ? `<div class="avatar ${s.h}">${s.n[0]}</div>` : `<i class="dot num">${s.pick ? '你' : s.n[0]}</i>`}<em>${s.pick ? '4 号 · 你' : s.n}</em></div>`).join('')}
    </div>
  </div>
  <section class="j-form">
    <label>你的名字</label>
    <div class="input">周可<i class="caret"></i></div>
    <div class="hint">名字会出现在牌桌上。换手机或刷新页面，会自动回到这个座位。</div>
    <span class="btn primary">坐到 4 号位</span>
    <i class="home"></i>
  </section>
</main>`;
  await writeFile(out + '05-phone-join.html', page('夜席 · 入座', body, ['phone.css']));
}

// ── Screen 6: desktop, physical-card mode, preflop (no virtual cards; chips only)
{
  const players = [
    { pos: 'tl', name: '阿宁', hue: 'h1', stack: 2440, bet: 40, status: '加注到 40' },
    { pos: 'tr', name: '林川', hue: 'h2', stack: 1960, folded: true, status: '已弃牌' },
    { pos: 'r', name: '小满', hue: 'h3', stack: 1300, acting: true, timer: .35, status: '思考中 · 跟注 40?' },
    { pos: 'br', name: '周可', hue: 'h4', stack: 2000, status: '等待' },
    { pos: 'bl', name: '何麦', hue: 'h5', stack: 1950, bet: 10, status: '小盲 10', blind: '小' },
    { pos: 'l', name: '苏禾', hue: 'h6', stack: 2280, bet: 20, status: '大盲 20', blind: '大' }
  ];
  const body = `<main class="board">
  <header class="topbar">
    <span class="seal">夜</span>
    <div class="room"><b>周日小局</b><span>实体牌 · 盲注 10 / 20</span></div>
    <div class="mid"><span class="pill">第 <b class="num">3</b> 手</span><span class="pill"><span class="ok-dot"></span>全场 <b class="num">12,000</b> · 账平</span></div>
    <div class="right"><span class="pill">${ICON.qr}<span>扫码入座</span><span class="code">M7KD</span></span><span class="iconbtn">${ICON.sound}</span><span class="iconbtn">${ICON.more}</span></div>
  </header>
  <section class="table"><div class="rail"></div><div class="felt"><i class="line"></i><span class="brand">夜 席</span></div></section>
  <div class="center" style="left:720px;top:440px;position:absolute">
    <div class="street"><span class="on">翻前</span><i></i><span>翻牌圈</span><i></i><span>转牌</span><i></i><span>河牌</span></div>
    <div class="callout"><b>轮到 小满</b><span>跟注 <em class="num">40</em> · 或加注、弃牌</span></div>
    <div class="pot">${chips(70, { w: 26 })}<span class="lbl">本轮下注</span><span class="amt num">70</span><span class="sub">翻牌由你们自己发</span></div>
  </div>
  ${players.map(seat).join('')}${players.map(bet).join('')}
  <div class="dealer" style="left:${POS.br[0] - 66}px;top:${POS.br[1] - 54}px">庄</div>
  <div class="ticker">
    <div class="row"><time class="num">21:08</time><span>第 3 手 · 庄 <b>周可</b></span></div>
    <div class="row"><time class="num">21:08</time><span><b>阿宁</b> 加注到 40</span></div>
    <div class="row"><time class="num">21:09</time><span><b>林川</b> 弃牌</span></div>
  </div>
  <nav class="dock">
    <span class="btn disabled">${ICON.play}新的一手</span>
    <span class="btn disabled">${ICON.next}下一轮</span>
    <span class="btn disabled">${ICON.split}分池</span>
    <i class="sep"></i>
    <span class="btn quiet">${ICON.undo}撤销</span>
    <span class="btn quiet">${ICON.seats}座位</span>
    <span class="btn quiet">${ICON.list}记录</span>
  </nav>
  <div class="ledger">主持 · 这台电脑<br><b>行动在各自手机上</b></div>
</main>`;
  await writeFile(out + '06-table-physical.html', page('夜席 · 实体牌', body, ['table.css']));
}
