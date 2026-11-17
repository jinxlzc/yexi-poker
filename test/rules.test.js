import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import * as E from '../server/engine.js';
import { makeDeck, setNextDeck, useCryptoRandom } from '../server/cards.js';
import { Store, freshToken } from '../server/store.js';
import { summarize } from '../server/summary.js';

useCryptoRandom(randomInt);
function table(stacks = [100, 100], config = {}) {
  let s = E.newRoom('RULE', { startingStack: 1000, dealMode: 'digital', ...config });
  for (const [i, stack] of stacks.entries()) {
    const id = `p${i + 1}`;
    s = E.apply(s, 'join', { id, name: `玩家${i + 1}`, seat: i + 1 });
    s.total += stack - 1000; E.player(s, id).stack = stack; s.roster[id].buyIn = stack;
  }
  E.assertConservation(s); return s;
}
const act = (s, action, to) => E.apply(s, 'act', { action, to }, s.hand.actor);
const vote = (s, id, runs) => E.apply(s, 'runVote', { runs }, id);
const deck = prefix => setNextDeck([...prefix, ...makeDeck().filter(c => !prefix.includes(c))]);
const settle = s => E.apply(s, 'settle', { selections: s.hand.selections, expectedTotal: E.potTotal(s) });
const check = s => { E.assertConservation(s); assert.equal(s.players.reduce((n, p) => n + p.stack + p.contribution, 0), s.total); return s; };
function allin(s) { s = E.apply(s, 'start'); while (s.hand.phase === 'betting') s = act(s, 'allin'); return check(s); }
function river(s) {
  s = E.apply(s, 'start');
  while (s.hand.street < 3) {
    if (s.hand.phase === 'roundEnd') s = E.apply(s, 'next');
    else { const l = E.legalActions(s, s.hand.actor); s = act(s, l.check ? 'check' : 'call'); }
  }
  return check(s);
}
// 大盲 p2 的 AA 对庄家 p1 的 KK；第一轮 AA 胜，第二轮 KK 胜。
const twice = ['As', 'Ks', 'Ad', 'Kd', '4c', '2h', '7d', '9c', '5c', 'Jh', '6c', '3s', '8c', 'Kh', '2d', '7h', 'Tc', '9h', 'Qc', '4d'];

test('两轮分别判定：各赢一轮平分总池，底牌与烧牌不重复', () => {
  deck(twice); let s = allin(table());
  assert.equal(s.hand.phase, 'runChoice'); assert.deepEqual(s.hand.board, []);
  s = vote(s, 'p1', 2); assert.equal(s.hand.phase, 'runChoice');
  s = vote(s, 'p2', 3);
  assert.equal(s.hand.runs, 2); assert.equal(s.hand.phase, 'showdown');
  assert.deepEqual(s.hand.boards, [['2h', '7d', '9c', 'Jh', '3s'], ['Kh', '2d', '7h', '9h', '4d']]);
  assert.deepEqual(s.hand.board, s.hand.boards[0]); assert.equal(s.hand.burned.length, 6);
  assert.deepEqual(s.hand.selections, { 'run-1:pot-0': ['p2'], 'run-2:pot-0': ['p1'] });
  assert.deepEqual(s.hand.preview.awards, { p1: 100, p2: 100 });
  assert.deepEqual(Object.keys(s.hand.revealed).sort(), ['p1', 'p2']);
  assert.equal(s.hand.boardHandNames[1].p1, '三条');
  s = check(settle(s)); assert.deepEqual(s.players.map(p => p.stack), [100, 100]);
  assert.equal(s.records[0].pots.length, 2); assert.deepEqual(s.records[0].boards, s.hand.boards);
  assert.ok(summarize(s).players.every(p => p.won === 1));
});

test('三轮顺序发完且每轮每街烧牌，十人桌牌叠仍完整', () => {
  deck(makeDeck()); let s = allin(table(Array(10).fill(100)));
  for (const p of E.live(s)) s = vote(s, p.id, 3);
  assert.equal(s.hand.runs, 3); assert.equal(s.hand.boards.length, 3); assert.equal(s.hand.burned.length, 9);
  const used = [...Object.values(s.hand.holes).flat(), ...s.hand.boards.flat(), ...s.hand.burned, ...s.hand.deck];
  assert.equal(used.length, 52); assert.equal(new Set(used).size, 52);
  assert.equal(s.hand.deck.length, 8); check(settle(s));
});

test('固定牌叠两轮与三轮分别判定主池及两个边池，各层资格不串池', () => {
  const cards = ['As', 'Qs', 'Js', 'Ks', 'Ad', 'Qd', 'Jd', 'Kd',
    '4c', '2h', '7d', '9c', '5c', '8s', '6c', '3s',
    '8c', 'Kh', '2d', '7h', 'Tc', '9h', 'Qc', '4d',
    '5h', 'Qh', '3d', '8h', '6h', 'Jc', 'Td', '2c'];
  for (const runs of [2, 3]) {
    deck(cards); let s = allin(table([100, 200, 300, 400]));
    for (const p of E.live(s)) s = vote(s, p.id, runs);
    assert.deepEqual(E.pots(s).map(p => p.amount), [400, 300, 200]);
    const expected = {
      'run-1:pot-0': ['p2'], 'run-1:pot-1': ['p2'], 'run-1:pot-2': ['p3'],
      'run-2:pot-0': ['p1'], 'run-2:pot-1': ['p2'], 'run-2:pot-2': ['p3'],
      ...(runs === 3 ? { 'run-3:pot-0': ['p3'], 'run-3:pot-1': ['p3'], 'run-3:pot-2': ['p3'] } : {})
    };
    assert.deepEqual(s.hand.selections, expected);
    assert.deepEqual(s.hand.preview.awards, runs === 2 ? { p1: 200, p2: 500, p3: 200, p4: 0 } : { p1: 133, p2: 334, p3: 433, p4: 0 });
    s = check(settle(s)); assert.equal(E.player(s, 'p4').stack, 100);
    assert.equal(s.records[0].pots.length, 3 * runs);
  }
});

test('翻牌之后跑两轮共享已发三张，后续转河独立烧牌', () => {
  deck(twice); let s = E.apply(table(), 'start'); s = act(s, 'call'); s = act(s, 'check'); s = E.apply(s, 'next');
  const flop = [...s.hand.board]; s = act(s, 'allin'); s = act(s, 'allin');
  s = vote(s, 'p1', 2); s = vote(s, 'p2', 2);
  assert.equal(s.hand.sharedBoardCount, 3); assert.equal(s.hand.burned.length, 5);
  for (const b of s.hand.boards) assert.deepEqual(b.slice(0, 3), flop);
  const consumed = [...s.hand.boards[0], ...s.hand.boards[1].slice(3), ...Object.values(s.hand.holes).flat(), ...s.hand.burned, ...s.hand.deck];
  assert.equal(new Set(consumed).size, 52); assert.equal(consumed.length, 52); check(settle(s));
});

test('任意一人选一次只跑一次，设置关闭时自动跑一次，河牌不投票', () => {
  let s = allin(table()); s = vote(s, 'p1', 1); assert.equal(s.hand.phase, 'runChoice');
  s = vote(s, 'p2', 3); assert.equal(s.hand.runs, 1); assert.deepEqual(Object.keys(s.hand.selections), ['pot-0']); check(settle(s));
  s = allin(table([100, 100], { runouts: 1 })); assert.equal(s.hand.phase, 'showdown'); check(settle(s));
  s = river(table()); s = act(s, 'allin'); s = act(s, 'allin');
  assert.equal(s.hand.phase, 'showdown'); assert.equal(s.hand.runs, 1); check(settle(s));
});

test('投票限于存活者和房间上限，已选不可改，暂停不能投票或主持结束', () => {
  let s = allin(table([100, 100], { runouts: 2 }));
  for (const runs of [0, 3, 1.5, '2']) assert.throws(() => vote(s, 'p1', runs));
  assert.throws(() => vote(s, 'stranger', 2)); assert.throws(() => act(s, 'check'));
  s = vote(s, 'p1', 2); assert.throws(() => vote(s, 'p1', 1));
  s = E.apply(s, 'pause', { on: true }); assert.throws(() => vote(s, 'p2', 2), /休息/); assert.throws(() => E.apply(s, 'runOnce'), /休息/);
  s = E.apply(s, 'pause', { on: false }); s = E.apply(s, 'runOnce');
  assert.equal(s.hand.runs, 1); assert.ok(s.logs.some(e => e.text.includes('主持') && e.text.includes('一次'))); check(settle(s));
});

test('实体牌奇数筹码先给靠前轮，再给按钮左侧最近赢家；漏选和无资格者拒绝', () => {
  let s = E.apply(table([3, 100, 3], { smallBlind: 1, bigBlind: 2, dealMode: 'physical' }), 'start');
  s = act(s, 'allin'); s = act(s, 'fold'); s = act(s, 'allin');
  s = vote(s, 'p1', 2); s = vote(s, 'p3', 2);
  assert.equal(E.potTotal(s), 7); assert.deepEqual(s.hand.boards, [[], []]);
  const selections = { 'run-1:pot-0': ['p1', 'p3'], 'run-2:pot-0': ['p1', 'p3'] };
  assert.throws(() => E.previewSettlement(s, { 'run-1:pot-0': ['p1'] }), /每.*池/);
  assert.throws(() => E.previewSettlement(s, { ...selections, 'run-2:pot-0': ['p2'] }), /资格/);
  assert.throws(() => E.previewSettlement(s, { ...selections, 'run-2:pot-0': ['p1', 'p1'] }));
  s = E.apply(s, 'preview', { selections });
  assert.deepEqual(s.hand.preview.details.map(d => d.amount), [4, 3]);
  assert.deepEqual(s.hand.preview.awards, { p1: 3, p2: 0, p3: 4 });
  assert.deepEqual(s.hand.preview.details[1].oddRecipients, ['p3']); check(settle(s));
});

test('两轮多边池逐池分别限资格，退款不再参与分轮', () => {
  let s = allin(table([100, 200, 300, 400], { dealMode: 'physical' }));
  for (const p of E.live(s)) s = vote(s, p.id, 2);
  assert.deepEqual(E.pots(s).map(p => p.amount), [400, 300, 200]); assert.equal(E.player(s, 'p4').stack, 100);
  const selections = { 'run-1:pot-0': ['p1'], 'run-1:pot-1': ['p2'], 'run-1:pot-2': ['p3'], 'run-2:pot-0': ['p4'], 'run-2:pot-1': ['p4'], 'run-2:pot-2': ['p4'] };
  s = E.apply(s, 'preview', { selections }); assert.deepEqual(s.hand.preview.awards, { p1: 200, p2: 150, p3: 100, p4: 450 });
  s = check(settle(s)); assert.deepEqual(s.players.map(p => p.stack), [200, 150, 100, 550]);
});

test('多轮公开视图没有牌叠、烧牌或弃牌者底牌，投票时不亮出其他人的牌', () => {
  let s = E.apply(table([100, 100, 100]), 'start'); s = act(s, 'fold'); s = act(s, 'allin'); s = act(s, 'allin');
  const hidden = [...s.hand.holes.p1, ...s.hand.deck, ...s.hand.burned];
  for (const identity of [{}, { role: 'host' }, { role: 'player', playerId: 'p2' }]) {
    const view = E.clipView(s, identity); assert.equal(view.state.hand.deck, undefined); assert.equal(view.state.hand.burned, undefined); assert.equal(view.state.hand.holes, undefined);
    assert.deepEqual(view.state.hand.revealed, {});
  }
  s = vote(s, 'p2', 3); s = vote(s, 'p3', 3); check(s);
  for (const secret of [...s.hand.holes.p1, ...s.hand.burned, ...s.hand.deck]) assert.ok(!JSON.stringify(E.clipView(s)).includes(`"${secret}"`));
  assert.ok(hidden.length); s = check(settle(s));
  for (const c of s.hand.holes.p1) assert.ok(!JSON.stringify(s.records).includes(`"${c}"`));
});

test('抓是新的活盲：翻前从左侧行动，最小加注到四倍大盲，抓者有最后选项', () => {
  let s = table([1000, 1000, 1000, 1000], { straddle: true, dealMode: 'physical' });
  assert.equal(E.nextPositions(s).utg, 'p4'); s = E.apply(s, 'straddle', { enabled: true }, 'p4'); s = E.apply(s, 'start');
  assert.equal(s.nextStraddle, null); assert.equal(s.hand.straddle, 'p4'); assert.equal(s.hand.actor, 'p1');
  assert.equal(s.hand.currentBet, 40); assert.equal(s.hand.lastFullRaise, 40); assert.equal(E.legalActions(s, 'p1').minRaiseTo, 80);
  assert.throws(() => act(s, 'raise', 79)); assert.deepEqual(s.hand.vpip, []);
  for (const id of ['p1', 'p2', 'p3']) { assert.equal(s.hand.actor, id); s = act(s, 'call'); }
  assert.equal(s.hand.actor, 'p4'); assert.equal(E.legalActions(s, 'p4').check, true); assert.equal(E.legalActions(s, 'p4').raise, true);
  s = act(s, 'check'); assert.ok(!s.hand.vpip.includes('p4')); s = E.apply(s, 'next'); assert.equal(s.hand.actor, 'p2'); check(s);
});

test('抓预约仅下一手，离开枪口位忽略；短码抓按全下，单挑不能抓', () => {
  let s = table([1000, 1000, 1000, 30], { straddle: true }); s = E.apply(s, 'straddle', { enabled: true }, 'p4');
  s = E.apply(s, 'start'); assert.equal(E.player(s, 'p4').bet, 30); assert.equal(E.player(s, 'p4').stack, 0); assert.equal(s.hand.currentBet, 40); check(s);
  s = table([100, 100, 100, 100], { straddle: true }); s = E.apply(s, 'straddle', { enabled: true }, 'p4');
  s = E.apply(s, 'seat', { playerId: 'p4', seat: 1 }); s = E.apply(s, 'start'); assert.equal(s.hand.straddle, null); assert.equal(s.nextStraddle, null); assert.ok(s.logs.some(e => e.text.includes('忽略'))); check(s);
  s = table([100, 100], { straddle: true }); assert.throws(() => E.apply(s, 'straddle', { enabled: true }, 'p1')); check(s);
});

test('大盲前注先付盲：短码余钱付单份前注，死钱全归主池不制造边池', () => {
  for (const [stack, blind, ante] of [[15, 15, 0], [20, 20, 0], [25, 20, 5], [100, 20, 10]]) {
    let s = E.apply(table([100, 100, stack], { ante: 10, anteMode: 'bigBlind', dealMode: 'physical' }), 'start');
    assert.equal(E.player(s, 'p3').bet, blind); assert.equal(E.player(s, 'p3').contribution, blind + ante);
    assert.equal(E.player(s, 'p1').contribution, 0); assert.equal(E.player(s, 'p2').contribution, 10); check(s);
    s = act(s, 'call'); s = act(s, 'call'); if (s.hand.phase === 'betting') s = act(s, 'check');
    assert.equal(E.pots(s).length, stack < 20 ? 2 : 1);
    if (stack >= 20) assert.equal(E.pots(s)[0].amount, 60 + ante); check(s);
  }
});

test('非全下摊牌河牌最后加注者先列；无人下注则从按钮左侧存活者开始', () => {
  let s = river(table([1000, 1000, 1000])); s = act(s, 'check'); s = act(s, 'raise', 20); s = act(s, 'call'); s = act(s, 'call');
  assert.deepEqual(s.hand.showOrder, ['p3', 'p1', 'p2']); check(settle(s));
  s = river(table([1000, 1000, 1000])); for (let i = 0; i < 3; i++) s = act(s, 'check');
  assert.deepEqual(s.hand.showOrder, ['p2', 'p3', 'p1']); s = check(settle(s)); assert.deepEqual(s.records[0].showOrder, ['p2', 'p3', 'p1']);
});

test('旧房间补齐规则默认值，配置只在两手之间且合法取值', () => {
  let s = table(); for (const k of ['runouts', 'straddle', 'anteMode']) delete s.config[k];
  delete s.nextStraddle; s = E.normalizeRoom(s);
  assert.equal(s.config.runouts, 3); assert.equal(s.config.straddle, false); assert.equal(s.config.anteMode, 'each'); check(s);
  for (const patch of [{ runouts: 4 }, { runouts: '2' }, { straddle: 1 }, { anteMode: 'all' }]) assert.throws(() => E.apply(s, 'settings', patch));
  s = E.apply(s, 'settings', { runouts: 2, straddle: true, anteMode: 'bigBlind' }); assert.ok(s.logs.at(-1).text.includes('跑')); s = E.apply(s, 'start');
  assert.throws(() => E.apply(s, 'settings', { runouts: 1 }), /结束再调/); check(s);
});

test('旧版本河牌途中升级，从既有动作恢复最后主动下注者的摊牌顺序', () => {
  let s = river(table([1000, 1000, 1000]));
  s = act(s, 'check'); s = act(s, 'raise', 20);
  for (const key of ['riverAggressor', 'boards', 'runs', 'runVotes', 'sharedBoardCount', 'boardHandNames', 'showOrder']) delete s.hand[key];
  s = act(s, 'call'); s = act(s, 'call');
  assert.deepEqual(s.hand.showOrder, ['p3', 'p1', 'p2']);
  s = check(settle(s)); assert.deepEqual(s.records[0].showOrder, ['p3', 'p1', 'p2']);
});

function stored(config = {}, count = 2) {
  const store = new Store(':memory:'), host = store.create({ startingStack: 100, dealMode: 'digital', ...config });
  const tokens = Array.from({ length: count }, () => freshToken());
  tokens.forEach((token, i) => store.join(host.code, { token, name: `玩家${i + 1}`, seat: i + 1 }));
  const state = () => store.get(host.code).state, ids = state().players.map(p => p.id);
  const cmd = (type, args = {}, token = host.token, context) => {
    store.command(host.code, token, { type, args, version: state().version, requestId: randomUUID() }, context);
    return check(state());
  };
  return { store, host, tokens, ids, state, cmd };
}

test('持久化撤销逐步恢复投票、已发牌叠与分池，重做得到完全相同公共牌', () => {
  const f = stored();
  try {
    deck(twice); f.cmd('start'); f.cmd('act', { action: 'call' }, f.tokens[0]); f.cmd('act', { action: 'check' }, f.tokens[1]); f.cmd('next');
    f.cmd('act', { action: 'allin' }, f.tokens[1]); f.cmd('act', { action: 'allin' }, f.tokens[0]);
    const voting = f.state(); f.cmd('runVote', { runs: 2 }, f.tokens[0]); const partial = f.state();
    f.cmd('runVote', { runs: 3 }, f.tokens[1]); const shown = f.state();
    assert.equal(shown.hand.boards.length, 2); assert.equal(f.store.view(f.host.code, '').runPots.length, 2);
    f.cmd('settle', { selections: shown.hand.selections, expectedTotal: 200 }); assert.equal(f.store.hands(f.host.code).records.length, 1);
    for (const before of [shown, partial, voting]) {
      f.cmd('undo'); assert.deepEqual({ ...f.state(), version: before.version }, before);
    }
    f.cmd('runVote', { runs: 2 }, f.tokens[0]); f.cmd('runVote', { runs: 3 }, f.tokens[1]);
    assert.deepEqual(f.state().hand.boards, shown.hand.boards); assert.deepEqual(f.state().hand.deck, shown.hand.deck);
    assert.equal(f.store.hands(f.host.code).records.length, 0);
  } finally { f.store.close(); }
});

test('主持按一次跑可撤销，代掉线者投票由在线名单校验并记录 by，玩家不能代他人', () => {
  const f = stored();
  try {
    f.cmd('start'); f.cmd('act', { action: 'allin' }, f.tokens[0]); f.cmd('act', { action: 'allin' }, f.tokens[1]);
    const before = f.state();
    assert.throws(() => f.cmd('runOnce', {}, f.tokens[0]), /主持权限/);
    assert.throws(() => f.cmd('runVote', { runs: 2, playerId: f.ids[1] }, f.tokens[0]), /自己的座位/);
    assert.throws(() => f.cmd('runVote', { runs: 2, playerId: f.ids[1], actorOffline: true }, f.host.token, { online: f.ids }), /在线/);
    f.cmd('runOnce'); assert.equal(f.state().hand.runs, 1);
    f.cmd('undo'); assert.deepEqual({ ...f.state(), version: before.version }, before);
    f.cmd('runVote', { runs: 2 }, f.tokens[0]);
    f.cmd('runVote', { runs: 2, playerId: f.ids[1] }, f.host.token, { online: [f.ids[0]] });
    assert.equal(f.state().hand.runs, 2); assert.equal(f.state().hand.actions.find(a => a.a === 'runVote' && a.id === f.ids[1]).by, '掉线');
    f.cmd('settle', { selections: f.state().hand.selections, expectedTotal: 200 });
  } finally { f.store.close(); }
});

test('实体牌分轮预览后确认和撤销都保留逐轮选择与份额', () => {
  const f = stored({ dealMode: 'physical' });
  try {
    f.cmd('start'); f.cmd('act', { action: 'allin' }, f.tokens[0]); f.cmd('act', { action: 'allin' }, f.tokens[1]);
    f.cmd('runVote', { runs: 3 }, f.tokens[0]); f.cmd('runVote', { runs: 3 }, f.tokens[1]);
    const selections = { 'run-1:pot-0': [f.ids[0]], 'run-2:pot-0': [f.ids[1]], 'run-3:pot-0': f.ids };
    f.cmd('preview', { selections }); const before = f.state();
    assert.deepEqual(before.hand.preview.details.map(p => p.amount), [67, 67, 66]);
    assert.throws(() => f.cmd('settle', { selections, expectedTotal: 201 }), /预览/);
    f.cmd('settle', { selections, expectedTotal: 200 }); f.cmd('undo'); assert.deepEqual({ ...f.state(), version: before.version }, before);
  } finally { f.store.close(); }
});

test('跑多轮的持久化损坏不能通过共享公共牌前缀掩盖重复牌', () => {
  const f = stored();
  try {
    f.cmd('start'); f.cmd('act', { action: 'allin' }, f.tokens[0]); f.cmd('act', { action: 'allin' }, f.tokens[1]);
    f.cmd('runVote', { runs: 2 }, f.tokens[0]); f.cmd('runVote', { runs: 2 }, f.tokens[1]);
    const good = f.store.get(f.host.code);
    for (const damage of [h => { h.boards[1][0] = h.boards[0][0]; }, h => { h.board[0] = h.deck[0]; }, h => { h.sharedBoardCount = 5; }, h => { h.boards.pop(); }]) {
      const bad = structuredClone(good); damage(bad.state.hand);
      assert.throws(() => f.store.parse(JSON.stringify(bad)), /损坏/);
    }
    check(f.state());
  } finally { f.store.close(); }
});

test('抓与大盲前注同时启用：前注不退，活盲超额退款与边池仍正确', () => {
  let s = table([30, 100, 100], { straddle: true, anteMode: 'bigBlind', ante: 10, dealMode: 'physical' });
  s = E.apply(s, 'straddle', { enabled: true }, 'p1'); s = E.apply(s, 'start');
  assert.equal(s.hand.actor, 'p2'); assert.equal(E.player(s, 'p1').bet, 30);
  s = act(s, 'fold'); s = act(s, 'allin');
  assert.equal(E.player(s, 'p3').stack, 60); assert.equal(E.player(s, 'p3').contribution, 40);
  assert.deepEqual(E.pots(s).map(p => [p.amount, p.eligible]), [[80, ['p1', 'p3']]]);
  s = vote(s, 'p1', 2); s = vote(s, 'p3', 2); check(s);
  s = E.apply(s, 'settle', { selections: { 'run-1:pot-0': ['p1'], 'run-2:pot-0': ['p3'] }, expectedTotal: 80 });
  check(s); assert.equal(summarize(s).balance.ok, true);
});

test('固定种子九百局：多轮、抓和大盲前注组合守恒、合法资格、牌叠完整且必然终止', () => {
  let seed = 0x42a17;
  const rand = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 2 ** 32 * n); };
  let multi = 0, straddles = 0, bbas = 0;
  for (let run = 0; run < 900; run++) {
    const count = 2 + rand(9), mode = run % 2 ? 'physical' : 'digital';
    const cards = makeDeck(); for (let i = 51; i > 0; i--) { const j = rand(i + 1); [cards[i], cards[j]] = [cards[j], cards[i]]; }
    if (mode === 'digital') setNextDeck(cards);
    let s = table(Array.from({ length: count }, () => 1 + rand(300)), { smallBlind: 2, bigBlind: 4, ante: rand(5), anteMode: run % 3 ? 'bigBlind' : 'each', straddle: true, runouts: 1 + rand(3), dealMode: mode });
    const utg = E.nextPositions(s).utg;
    if (utg && rand(2)) { s = E.apply(s, 'straddle', { enabled: true }, utg); straddles++; }
    const total = s.total; s = E.apply(s, 'start'); if (s.hand.bigBlindAnte) bbas++;
    for (let step = 0; s.hand.phase !== 'showdown'; step++) {
      assert.ok(step < 200, `牌局 ${run} 未结束`);
      if (s.hand.phase === 'runChoice') {
        for (const p of E.live(s)) s = vote(s, p.id, run % 3 ? s.hand.runMax : 1 + rand(s.hand.runMax));
      } else if (s.hand.phase === 'roundEnd') {
        const bets = s.players.filter(p => p.inHand && !p.folded && p.stack > 0).map(p => p.bet);
        assert.equal(new Set(bets).size, 1); s = E.apply(s, 'next');
      } else {
        const l = E.legalActions(s, s.hand.actor), choices = ['fold'];
        if (l.check) choices.push('check', 'check'); if (l.canCall) choices.push('call', 'call'); if (l.raise) choices.push('raise'); if (l.allIn) choices.push('allin', 'allin');
        s = act(s, choices[rand(choices.length)], l.minRaiseTo);
      }
      check(s); assert.equal(s.total, total);
    }
    if (s.hand.runs > 1) multi++;
    assert.ok(E.pots(s).every(p => p.eligible.length > 0));
    if (mode === 'digital') {
      const h = s.hand, all = [...Object.values(h.holes).flat(), ...h.boards.flatMap((b, i) => b.slice(i ? h.sharedBoardCount : 0)), ...h.burned, ...h.deck];
      assert.equal(all.length, 52); assert.equal(new Set(all).size, 52);
    } else {
      const selections = Object.fromEntries(E.runPots(s).map(p => [p.id, p.eligible.filter((_, i) => !i || rand(2))]));
      s = E.apply(s, 'preview', { selections });
    }
    const preview = s.hand.preview;
    assert.equal(Object.values(preview.awards).reduce((a, b) => a + b, 0), E.potTotal(s));
    s = check(settle(s)); assert.equal(E.potTotal(s), 0); assert.equal(summarize(s).balance.ok, true);
  }
  assert.ok(multi > 100); assert.ok(straddles > 200); assert.ok(bbas > 200);
});
