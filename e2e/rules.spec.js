import { test, expect } from '@playwright/test';
import { createServer } from '../server/index.js';
import {
  openRulesRoom, physicalSettings, startAllIn, deckForTwoBoards, addDifferentStacks,
  voteButton, poolButton, winnerButton, settleButton
} from '../tools/shoot-rules.mjs';

let server, base;
test.use({ reducedMotion: 'reduce' });
test.beforeAll(async () => {
  server = await createServer({ file: ':memory:', host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});
test.afterAll(async () => server?.close());

test('phone votes deal two electronic boards with different winners and conserve chips on confirmation', async ({ page, browser }) => {
  const room = await openRulesRoom(browser, page, base);
  const [a, b, c] = room.phones;
  try {
    await startAllIn(page, room.phones, deckForTwoBoards());
    for (const phone of room.phones) await expect(phone.getByTestId('run-choice')).toBeVisible();
    const { state: { players, config, hand } } = await room.snapshot();
    expect(config.runouts).toBe(3);
    expect(hand.phase).toBe('runChoice');
    expect(hand.board).toEqual([]);
    expect(hand.revealed).toEqual({});
    await expect(page.getByRole('button', { name: /^分池/ })).toBeDisabled();
    await page.getByRole('button', { name: '休息', exact: true }).click();
    await expect(voteButton(a, 3)).toBeDisabled();
    await page.getByRole('button', { name: '继续打牌', exact: true }).click();
    await expect(voteButton(a, 3)).toBeEnabled();

    await voteButton(a, 3).click();
    await voteButton(b, 2).click();
    await expect.poll(async () => (await room.snapshot()).state.hand.runVotes).toMatchObject({
      [players[0].id]: 3, [players[1].id]: 2
    });
    expect((await room.snapshot()).state.hand.phase).toBe('runChoice');
    await voteButton(c, 2).click();

    await expect(page.locator('[data-run-board]')).toHaveCount(2);
    const boards = [['Ah', '7d', '4s', 'Jd', '2h'], ['Kh', '8h', '5d', 'Tc', '3c']];
    for (const [index, cards] of boards.entries()) {
      const row = page.locator(`[data-run-board="${index + 1}"]`);
      await expect(row).toBeVisible();
      await expect(row.locator('[data-card]')).toHaveCount(5);
      expect(await row.locator('[data-card]').evaluateAll(elements => elements.map(el => el.dataset.card))).toEqual(cards);
    }
    const result = (await room.snapshot()).state.hand;
    expect(result.runs).toBe(2);
    expect(result.boards).toEqual(boards);
    expect(result.board).toEqual(boards[0]);
    expect(result.selections).toEqual({ 'run-1:pot-0': [players[1].id], 'run-2:pot-0': [players[0].id] });
    await expect(a.getByTestId('run-result')).toContainText(/跑\s*2\s*次/);
    await page.getByRole('button', { name: /^分池/ }).click();
    await expect(page.getByRole('heading', { name: '系统已按牌力判定' })).toBeVisible();
    await settleButton(page).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('全场仍是 300');
    await settleButton(dialog).click();
    await expect(page).toHaveURL(/\/table\?room=/);
    await expect(a.getByTestId('my-stack')).toHaveText('150');
    const settled = (await room.snapshot()).state;
    expect(settled.hand.phase).toBe('settled');
    expect(settled.players.map(p => p.stack)).toEqual([150, 150, 0]);
    expect(settled.players.map(p => p.contribution)).toEqual([0, 0, 0]);
    expect((await room.snapshot('/summary')).balance).toMatchObject({ total: 300, pot: 0, ok: true });
    await page.getByRole('link', { name: '牌谱回放', exact: true }).click();
    await expect(page.locator('.hv-run[data-run]')).toHaveCount(2);
    await expect(page.locator('.hv-run[data-run="1"] li')).toContainText('林川');
    await expect(page.locator('.hv-run[data-run="2"] li')).toContainText('阿宁');
    expect(room.errors).toEqual([]);
  } finally {
    await room.close();
  }
});

test('physical two-run main and side pools require eligible winners in every round', async ({ page, browser }) => {
  const room = await openRulesRoom(browser, page, base, { ...physicalSettings, runouts: 2 });
  const [a, b, c] = room.phones;
  try {
    await addDifferentStacks(page, room);
    await startAllIn(page, room.phones);
    const [first, second, third] = (await room.snapshot()).state.players;
    await expect(a.getByTestId('run-choice')).toBeVisible();
    await expect(voteButton(a, 3)).toHaveCount(0);
    const proxy = page.locator(`[data-do=run-proxy][data-id="${second.id}"]`);
    await expect(proxy).toHaveCount(0);
    await b.close();
    await proxy.click();
    await page.getByRole('dialog').locator('[data-do=run-proxy-submit][data-runs="2"]').click();
    await expect.poll(async () => (await room.snapshot()).state.hand.runVotes[second.id]).toBe(2);
    await voteButton(a, 2).click();
    await voteButton(c, 2).click();

    await page.getByRole('button', { name: /^分池/ }).click();
    const confirm = settleButton(page);
    await expect(confirm).toBeDisabled();
    const pots = [
      [1, 'pot-0', 155, '阿宁'], [1, 'pot-1', 61, '林川'],
      [2, 'pot-0', 154, '小满'], [2, 'pot-1', 61, '小满']
    ];
    await expect(page.locator('.potpick button')).toHaveCount(4);
    for (const [index, [run, pot, amount, winner]] of pots.entries()) {
      const choice = poolButton(page, run, pot);
      await expect(choice).toContainText(String(amount));
      await choice.click();
      await expect(confirm).toBeDisabled();
      if (pot === 'pot-1') {
        await expect(winnerButton(page, '阿宁')).toHaveCount(0);
        await expect(page.locator('.locked')).toContainText('阿宁');
      }
      await winnerButton(page, winner).click();
      if (index < pots.length - 1) await expect(confirm).toBeDisabled();
    }
    await expect(confirm).toBeEnabled();
    await expect(page.locator('.balance-foot')).toContainText('分出 431');
    await expect(c.locator('.waitblock')).toContainText('预览里你是 +215');
    const { preview } = (await room.snapshot()).state.hand;
    expect(preview.awards).toMatchObject({ [first.id]: 155, [second.id]: 61, [third.id]: 215 });
    await winnerButton(page, '小满').click();
    await expect(confirm).toBeDisabled();
    await expect(c.locator('.waitblock')).not.toContainText('预览里你是');
    await winnerButton(page, '小满').click();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('全场仍是 484');
    await settleButton(dialog).click();
    await expect(page).toHaveURL(/\/table\?room=/);
    await expect(c.getByTestId('my-stack')).toHaveText('268');
    const settled = (await room.snapshot()).state;
    expect(settled.hand.phase).toBe('settled');
    expect(settled.players.map(p => p.stack)).toEqual([155, 61, 268]);
    expect((await room.snapshot('/summary')).balance).toMatchObject({ total: 484, pot: 0, ok: true });
    expect(room.errors).toEqual([]);
  } finally {
    await room.close();
  }
});

test('320px phone keeps all three vote choices visible and clear of each other', async ({ page, browser }) => {
  const room = await openRulesRoom(browser, page, base, { widths: [320, 390, 390] });
  const [phone] = room.phones;
  try {
    await startAllIn(page, room.phones, deckForTwoBoards());
    const card = phone.getByTestId('run-choice');
    await expect(card).toBeVisible();
    await phone.evaluate(() => document.fonts.ready.then(() => {}));
    for (const runs of [1, 2, 3]) await expect(voteButton(phone, runs)).toBeInViewport();
    const layout = await card.evaluate(el => {
      const rect = node => {
        const { left, top, right, bottom } = node.getBoundingClientRect();
        return { left, top, right, bottom };
      };
      return {
        card: rect(el), controls: [...el.querySelectorAll('[data-do=run-vote]')].map(rect),
        cardWidth: el.clientWidth, cardScrollWidth: el.scrollWidth,
        width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth
      };
    });
    expect(layout.width).toBe(320);
    expect(layout.scrollWidth).toBeLessThanOrEqual(320);
    expect(layout.cardScrollWidth).toBeLessThanOrEqual(layout.cardWidth);
    expect(layout.card.left).toBeGreaterThanOrEqual(0);
    expect(layout.card.right).toBeLessThanOrEqual(320);
    expect(layout.card.top).toBeGreaterThanOrEqual(0);
    expect(layout.card.bottom).toBeLessThanOrEqual(layout.height);
    expect(layout.controls).toHaveLength(3);
    for (const [i, button] of layout.controls.entries()) {
      expect(button.left).toBeGreaterThanOrEqual(layout.card.left);
      expect(button.right).toBeLessThanOrEqual(layout.card.right);
      expect(button.top).toBeGreaterThanOrEqual(layout.card.top);
      expect(button.bottom).toBeLessThanOrEqual(layout.card.bottom);
      for (const other of layout.controls.slice(i + 1)) {
        expect(button.right <= other.left || other.right <= button.left || button.bottom <= other.top || other.bottom <= button.top).toBe(true);
      }
    }
    await voteButton(phone, 1).click();
    await expect(voteButton(phone, 1)).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-do=run-once]').click();
    await page.getByRole('dialog').locator('[data-do=run-once-submit]').click();
    await expect(page.getByRole('button', { name: /^分池/ })).toBeEnabled();
    expect((await room.snapshot()).state.hand.runs).toBe(1);
    expect(room.errors).toEqual([]);
  } finally {
    await room.close();
  }
});

test('table settings apply a big-blind ante and next-hand UTG straddle', async ({ page, browser }) => {
  const room = await openRulesRoom(browser, page, base, { dealMode: 'physical', runouts: 1, ante: 5 });
  const [a, b, c] = room.phones;
  try {
    await page.getByRole('button', { name: /^座位/ }).click();
    const settings = page.locator('#settings-form');
    await expect(settings.locator('[name=runouts]')).toHaveValue('1');
    await expect(settings.locator('[name=ante]')).toHaveValue('5');
    await settings.locator('[name=runouts]').selectOption('2');
    await settings.locator('[name=anteMode]').selectOption('bigBlind');
    await settings.locator('[name=straddle]').check();
    await settings.locator('button[type=submit]').click();
    await expect.poll(async () => (await room.snapshot()).state.config).toMatchObject({ runouts: 2, anteMode: 'bigBlind', straddle: true });
    const playerSwitch = a.locator('#player-straddle');
    await expect(playerSwitch).toBeVisible();
    await expect(b.locator('#player-straddle')).toHaveCount(0);
    await expect(c.locator('#player-straddle')).toHaveCount(0);
    await playerSwitch.check();
    await expect(page.locator('#host-straddle')).toBeChecked();
    await page.getByRole('link', { name: '返回牌桌', exact: true }).click();
    await page.getByRole('button', { name: /^新的一手/ }).click();
    await expect(b.getByRole('heading', { name: '轮到你', exact: true })).toBeVisible();
    await expect(b.getByRole('button', { name: '跟注 30', exact: true })).toBeEnabled();
    await expect(a.locator('#player-straddle')).toHaveCount(0);
    const started = (await room.snapshot()).state;
    expect(started.players.map(p => p.bet)).toEqual([40, 10, 20]);
    expect(started.players.map(p => p.contribution)).toEqual([40, 10, 25]);
    expect(room.errors).toEqual([]);
  } finally {
    await room.close();
  }
});

test('unsaved rule settings survive player presence updates before saving', async ({ page, browser }) => {
  const room = await openRulesRoom(browser, page, base);
  try {
    await page.getByRole('button', { name: /^座位/ }).click();
    const settings = page.locator('#settings-form');
    await settings.locator('[name=runouts]').selectOption('2');
    await settings.locator('[name=anteMode]').selectOption('bigBlind');
    await settings.locator('[name=straddle]').check();
    await room.phones[1].close();
    await expect(page.locator('.manage-row').filter({ hasText: '林川' })).toContainText('离线');
    await expect(settings.locator('[name=runouts]')).toHaveValue('2');
    await expect(settings.locator('[name=anteMode]')).toHaveValue('bigBlind');
    await expect(settings.locator('[name=straddle]')).toBeChecked();
    expect((await room.snapshot()).state.config).toMatchObject({ runouts: 3, anteMode: 'each', straddle: false });
    await settings.locator('button[type=submit]').click();
    await expect.poll(async () => (await room.snapshot()).state.config).toMatchObject({ runouts: 2, anteMode: 'bigBlind', straddle: true });
    await settings.locator('[name=ante]').fill('7');
    const secondHost = await page.context().newPage();
    try {
      await secondHost.goto(page.url());
      await secondHost.locator('#settings-form [name=ante]').fill('5');
      await secondHost.locator('#settings-form button[type=submit]').click();
      await expect.poll(async () => (await room.snapshot()).state.config.ante).toBe(5);
      await expect(settings.locator('[name=ante]')).toHaveValue('5');
    } finally { await secondHost.close(); }
    expect(room.errors).toEqual([]);
  } finally {
    await room.close();
  }
});
