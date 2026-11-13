import { expect, test, type Locator } from '@playwright/test';
import { Screens, SIZES, type SizeName } from './screens-fixture';

// Every screen of the panel at 320 and 420 px wide and at each of the four text and button sizes, chosen in Settings as a
// person would: nothing scrolls sideways, no button's words are cut, a pinned bar is wholly in view on the bottom edge and
// a control reached with Tab is never under it, and a sheet is never taller than the panel. At Default every button and
// choice row is at least 32 px high. One browser, one fake service; the steps run in order.
test.describe.configure({ mode: 'serial' });

const WIDTHS = [320, 420] as const;
const HEIGHT = 600;
/** Longer than the tour's 300 ms after a step changes, in which a second press of Next or Done is ignored. */
const SETTLE = 350;

const s = new Screens();
const panel = () => s.panel;

test.beforeAll(async () => {
  await s.open(WIDTHS[0], HEIGHT);
});

test.afterAll(async () => {
  await s.close();
});

test.afterEach(() => {
  expect(s.service?.problems ?? []).toEqual([]);
});

/** The steps go through 8 widths and sizes each. */
test.beforeEach(() => {
  test.setTimeout(240_000);
});

/** Runs `check` at each width and each size, the size chosen in Settings from the screen `ready` brings back. */
async function atEverySize(check: (where: string, size: SizeName, width: number) => Promise<void>, ready?: () => Promise<void>): Promise<void> {
  for (const width of WIDTHS) {
    await panel().setViewportSize({ width, height: HEIGHT });
    for (const size of SIZES) {
      await s.size(size);
      if (ready !== undefined) await ready();
      await check(`${width} px, ${size}`, size, width);
    }
  }
}

/**
 * Nothing is wider than the panel, and every button and choice drawn shows all its words: none is cut or spills out of
 * its box (a tab's "Findings · n" included). A kind, a state or a count in a small box stays on one line (not squeezed
 * into a letter a line).
 */
async function fits(where: string): Promise<void> {
  const m = await panel().evaluate(() => {
    const root = document.documentElement;
    const drawn = (selector: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((el) => el.getClientRects().length > 0 && el.closest('[aria-hidden="true"]') === null);
    const name = (el: HTMLElement): string => `${el.tagName.toLowerCase()}.${el.className}: ${el.textContent ?? ''}`;
    const cut = drawn('button, .ap-seg > label, label.choice, .ap-tag, .ap-chip, .tag')
      .filter((el) => el.scrollWidth > el.clientWidth + 1).map(name);
    // The lines its words are laid out on, by their tops.
    const lines = (el: HTMLElement): number => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
    };
    const squeezed = drawn('.ap-tag, .ap-chip, .tag, .ap-sev').filter((el) => lines(el) > 1).map(name);
    return { scroll: root.scrollWidth, client: root.clientWidth, cut, squeezed };
  });
  expect(m.scroll, `${where}: sideways scroll`).toBeLessThanOrEqual(m.client);
  expect(m.cut, `${where}: words cut`).toEqual([]);
  expect(m.squeezed, `${where}: on more than one line`).toEqual([]);
}

/** At Default, every button and choice row drawn is at least 32 px high (40 in a pinned bar). */
async function bigEnough(where: string): Promise<void> {
  const small = await panel().evaluate(() => [...document.querySelectorAll<HTMLElement>('button, .ap-seg > label, label.choice')]
    .filter((el) => el.getClientRects().length > 0 && el.closest('[aria-hidden="true"]') === null)
    .map((el) => ({ what: `${el.tagName.toLowerCase()}.${el.className}: ${el.textContent ?? ''}`, height: el.getBoundingClientRect().height, pinned: el.closest('.ap-pinned') !== null }))
    .filter((b) => b.height < (b.pinned ? 40 : 32) - 0.5)
    .map((b) => `${b.what} (${b.height})`));
  expect(small, `${where}: under 32 px`).toEqual([]);
}

/** The pinned bar is wholly inside the panel on its bottom edge, every button inside it, and the room under the content as tall as it. */
async function barInView(where: string): Promise<void> {
  await expect.poll(() => panel().evaluate(() =>
    document.querySelector<HTMLElement>('.ap-pinned-room')!.offsetHeight - document.querySelector<HTMLElement>('.ap-pinned')!.offsetHeight), { message: `${where}: room` }).toBe(0);
  const m = await panel().evaluate(() => {
    const bar = document.querySelector<HTMLElement>('.ap-pinned')!.getBoundingClientRect();
    const outside = [...document.querySelectorAll<HTMLElement>('.ap-pinned button')]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.left < bar.left - 0.5 || r.right > bar.right + 0.5 || r.top < bar.top - 0.5 || r.bottom > bar.bottom + 0.5; })
      .map((b) => b.textContent);
    return { left: bar.left, right: bar.right, top: bar.top, bottom: bar.bottom, width: innerWidth, height: innerHeight, outside };
  });
  expect(m.left, `${where}: bar left`).toBeGreaterThanOrEqual(-0.5);
  expect(m.right, `${where}: bar right`).toBeLessThanOrEqual(m.width + 0.5);
  expect(m.top, `${where}: bar top`).toBeGreaterThanOrEqual(0);
  expect(Math.abs(m.bottom - m.height), `${where}: bar on the bottom edge`).toBeLessThanOrEqual(1);
  expect(m.outside, `${where}: buttons outside the bar`).toEqual([]);
}

/** Tab from the top of the screen to the pinned bar: no control it reaches on the way is under the bar. */
async function tabClear(where: string): Promise<void> {
  await panel().evaluate(() => { window.scrollTo(0, 0); (document.activeElement as HTMLElement | null)?.blur(); });
  let reached = false;
  for (let i = 0; i < 150 && !reached; i += 1) {
    await panel().keyboard.press('Tab');
    const seen = await panel().evaluate(() => {
      const focused = document.activeElement as HTMLElement | null;
      const bar = document.querySelector('.ap-pinned');
      if (focused === null || bar === null || focused === document.body) return { inBar: false, overlap: 0, what: '' };
      if (bar.contains(focused)) return { inBar: true, overlap: 0, what: '' };
      const a = focused.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      // A tab panel taller than the room above the bar cannot be wholly above it: its start must be.
      const overlap = a.height >= b.top
        ? Math.max(0, a.top + 20 - b.top)
        : Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return { inBar: false, overlap, what: `${focused.tagName.toLowerCase()}.${focused.className}: ${(focused.textContent ?? '').slice(0, 60)}` };
    });
    reached = seen.inBar;
    expect(seen.overlap, `${where}: ${seen.what} under the bar`).toBe(0);
  }
  expect(reached, `${where}: Tab reached the bar`).toBe(true);
}

/** The open sheet (the dialog's box) is inside the panel and no taller than it. */
async function sheetFits(where: string, dialog: Locator): Promise<void> {
  await expect(dialog).toBeVisible();
  const m = await panel().evaluate(() => {
    const body = [...document.querySelectorAll<HTMLElement>('.sheet-body')].at(-1)!.getBoundingClientRect();
    return { top: body.top, bottom: body.bottom, left: body.left, right: body.right, height: body.height, width: innerWidth, panel: innerHeight };
  });
  expect(m.top, `${where}: sheet top`).toBeGreaterThanOrEqual(-0.5);
  expect(m.bottom, `${where}: sheet bottom`).toBeLessThanOrEqual(m.panel + 1);
  expect(m.height, `${where}: sheet height`).toBeLessThanOrEqual(m.panel);
  expect(m.left, `${where}: sheet left`).toBeGreaterThanOrEqual(-0.5);
  expect(m.right, `${where}: sheet right`).toBeLessThanOrEqual(m.width + 0.5);
  await fits(where);
}

test('1. the start screen, with the pack choice open: the bar in view and Tab clear of it', async () => {
  await s.start();
  await s.button('Packs').click();
  await expect(panel().getByRole('switch', { name: 'Generic' })).toBeVisible();
  await atEverySize(async (where, size) => {
    await fits(where);
    if (size === 'Default') await bigEnough(where);
    await barInView(where);
    await tabClear(where);
  });
});

test('2. the progress screen, with Show the steps and What it has found so far open', async () => {
  await s.progress();
  await s.openFolds();
  await expect(panel().getByRole('list', { name: 'Stages' })).toBeVisible();
  await atEverySize(async (where, size) => {
    await expect(panel().getByRole('heading', { name: 'Reviewing' })).toBeVisible();
    await fits(where);
    if (size === 'Default') await bigEnough(where);
    // No bar: the service cannot stop a run, so the screen has nothing to pin.
    await expect(panel().locator('.ap-pinned')).toHaveCount(0);
  });
});

test('3. the review: each tab with its folds open, the bar in and out of select mode, Tab clear of the bar', async () => {
  await s.review();
  await atEverySize(async (where, size) => {
    for (const name of ['Findings', 'The change', 'More'] as const) {
      await s.tab(name).click();
      await s.openFolds();
      await fits(`${where}, ${name}`);
      if (size === 'Default') await bigEnough(`${where}, ${name}`);
      await barInView(`${where}, ${name}`);
    }
    // The tab's count is never cut ("Findings…").
    await expect(s.tab('Findings')).toHaveText(/^Findings · \d+$/);
    await s.tab('Findings').click();
    await tabClear(`${where}, Findings`);
    await s.button('Select').click();
    await fits(`${where}, selecting`);
    await barInView(`${where}, selecting`);
    await s.button('Done').click();
  });
});

test('4. a finding with every fold open: the actions in view and Tab clear of them', async () => {
  await s.review();
  await s.finding(0);
  await s.openFolds();
  await atEverySize(async (where, size) => {
    await expect(s.button('Back to the review')).toBeVisible();
    await fits(where);
    if (size === 'Default') await bigEnough(where);
    await barInView(where);
    await tabClear(where);
  });
  await s.button('Back to the review').click();
});

test('5. the comment sheet, the dismiss sheet with the line to remember, and the dropped sheet are never taller than the panel', async () => {
  await s.review();
  await s.finding(0);
  await atEverySize(async (where, size) => {
    await s.button('Comment on GitHub').click();
    const comment = panel().getByRole('dialog', { name: 'Comment on GitHub' });
    await expect(comment.getByText('Where it goes')).toBeVisible();
    await expect(comment.getByRole('button', { name: 'Post comment' })).toBeVisible();
    await sheetFits(`${where}, comment`, comment);
    if (size === 'Default') await bigEnough(`${where}, comment`);
    await comment.getByRole('button', { name: 'Cancel' }).click();
    await expect(comment).toHaveCount(0);

    await s.button('Dismiss').click();
    const dismiss = panel().getByRole('dialog', { name: 'Dismiss this finding' });
    await dismiss.getByRole('radio', { name: 'The finding is mistaken' }).check();
    await expect(dismiss.getByRole('textbox', { name: 'The line Airlock will remember' })).toBeVisible();
    await sheetFits(`${where}, dismiss`, dismiss);
    if (size === 'Default') await bigEnough(`${where}, dismiss`);
    await panel().keyboard.press('Escape');
    await expect(dismiss).toHaveCount(0);
  });
  await s.button('Back to the review').click();
  await s.tab('More').click();
  await atEverySize(async (where, size) => {
    await panel().getByRole('button', { name: /^Dropped: \d+$/ }).click();
    const dropped = panel().getByRole('dialog');
    await sheetFits(`${where}, dropped`, dropped);
    if (size === 'Default') await bigEnough(`${where}, dropped`);
    await panel().keyboard.press('Escape');
    await expect(dropped).toHaveCount(0);
  });
  await s.tab('Findings').click();
});

test('6. the tour\'s three steps fit the panel', async () => {
  await s.review();
  await atEverySize(async (where, size) => {
    await s.button('Settings').click();
    await s.button('Show the tour again').click();
    for (const step of ['Start at the top', 'Three things you can do with a finding', 'Notes and size']) {
      const dialog = panel().getByRole('dialog', { name: step });
      await sheetFits(`${where}, ${step}`, dialog);
      if (size === 'Default') await bigEnough(`${where}, ${step}`);
      const primary = dialog.getByRole('button', { name: step === 'Notes and size' ? 'Done' : 'Next' });
      await primary.scrollIntoViewIfNeeded();
      await expect(primary).toBeInViewport();
      await panel().waitForTimeout(SETTLE);
      await primary.click();
    }
    await expect(panel().getByRole('dialog')).toHaveCount(0);
  });
});

test('7. Settings, Packs and Service; at Largest in a 320 px panel the four sizes are all reachable and readable', async () => {
  await s.review();
  await atEverySize(async (where, size, width) => {
    await s.button('Settings').click();
    const sizes = panel().getByRole('radiogroup', { name: 'Text and button size' });
    await expect(sizes.getByRole('radio', { name: size, exact: true })).toBeChecked();
    await fits(`${where}, Settings`);
    if (size === 'Default') await bigEnough(`${where}, Settings`);
    if (size === 'Largest' && width === 320) {
      // Each choice is in view, whole, its word not cut, and can be reached with the arrow keys.
      for (const name of SIZES) {
        const label = sizes.locator('label').filter({ hasText: new RegExp(`^${name}$`) });
        await expect(label).toBeInViewport({ ratio: 1 });
        expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().width > 0), name).toBe(true);
      }
      await sizes.getByRole('radio', { name: 'Largest' }).focus();
      await panel().keyboard.press('ArrowLeft');
      await expect(sizes.getByRole('radio', { name: 'Large', exact: true })).toBeFocused();
      await panel().keyboard.press('ArrowRight');
      await expect(sizes.getByRole('radio', { name: 'Largest' })).toBeChecked();
    }
    await s.button('Packs and learned lines').click();
    await expect(panel().getByRole('heading', { name: 'Packs and learned lines' })).toBeVisible();
    await fits(`${where}, Packs`);
    if (size === 'Default') await bigEnough(`${where}, Packs`);
    await s.button('Back').click();
    await s.button('Service').click();
    await expect(panel().getByText('Running, version test')).toBeVisible();
    await fits(`${where}, Service`);
    if (size === 'Default') await bigEnough(`${where}, Service`);
    await s.button('Back').click();
    await s.button('Back').click();
  });
});

test('8. a problem', async () => {
  await s.problem();
  await atEverySize(async (where, size) => {
    await expect(s.button('Retry')).toBeVisible();
    await fits(where);
    if (size === 'Default') await bigEnough(where);
  });
});

test('9. Pair', async () => {
  await s.unpair();
  await atEverySize(async (where, size) => {
    await expect(panel().getByLabel('Pairing token')).toBeVisible();
    await fits(where);
    if (size === 'Default') await bigEnough(where);
  });
  await s.pair();
});

test('10. offline, over the review', async () => {
  await s.review();
  await s.offline();
  await atEverySize(async (where, size) => {
    await expect(panel().getByRole('heading', { name: "Airlock's service on this Mac is not running." })).toBeVisible();
    await fits(where);
    if (size === 'Default') await bigEnough(where);
    await barInView(where);
  });
  await s.online();
  // Back to Default for whatever runs next in this browser.
  await s.size('Default');
});
