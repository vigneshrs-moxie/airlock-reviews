import { expect, test, type Locator } from '@playwright/test';
import { NOTHING_READ, RUNNING, Screens, SIZES, type SizeName } from './screens-fixture';

// Every screen of the panel at 320 and 420 px wide and at each of the four text and button sizes, chosen in Settings as a
// person would: nothing scrolls sideways, no button's words are cut or broken inside a word, a place too long for its
// box keeps its end in view, a pinned bar is wholly in view on the bottom edge and a control reached with Tab is never
// under it, and a sheet is never taller than the panel. At Default every button, choice row and checkbox is at least
// 32 px high. A refused copy, in each bar, is also tried in a panel 480 px tall. One browser, one fake service; the steps
// run in order.
test.describe.configure({ mode: 'serial' });

const WIDTHS = [320, 420] as const;
const HEIGHT = 600;
/** A short panel, where a bar with a refused prompt reaches its cap of 60% of the panel. */
const SHORT = 480;
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
async function atEverySize(
  check: (where: string, size: SizeName, width: number) => Promise<void>, ready?: () => Promise<void>, height: number = HEIGHT,
): Promise<void> {
  for (const width of WIDTHS) {
    await panel().setViewportSize({ width, height });
    for (const size of SIZES) {
      await s.size(size);
      if (ready !== undefined) await ready();
      await check(`${width} px${height === HEIGHT ? '' : ` by ${height}`}, ${size}`, size, width);
    }
  }
  await panel().setViewportSize({ width: WIDTHS[0], height: HEIGHT });
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
    // A word broken inside (overflow-wrap lets a button break one rather than spill): the word's own box is taller than
    // one line of the button's text.
    const brokenWord = drawn('button').filter((el) => {
      const line = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.2;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if ((node.parentElement?.closest('[aria-hidden="true"]') ?? null) !== null) continue;
        for (const match of (node.textContent ?? '').matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          if (range.getBoundingClientRect().height > line * 1.5) return true;
        }
      }
      return false;
    }).map(name);
    // A place (a path and its line) too long for its box is cut at its start: its words' right edge is inside the box, so the
    // file name and the line number are in view.
    const endLost = drawn('.path').filter((el) => {
      if (el.scrollWidth <= el.clientWidth + 1) return false;
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().right > el.getBoundingClientRect().right + 1;
    }).map(name);
    return { scroll: root.scrollWidth, client: root.clientWidth, cut, squeezed, endLost, brokenWord };
  });
  expect(m.scroll, `${where}: sideways scroll`).toBeLessThanOrEqual(m.client);
  expect(m.cut, `${where}: words cut`).toEqual([]);
  expect(m.squeezed, `${where}: on more than one line`).toEqual([]);
  expect(m.endLost, `${where}: a place cut at its end`).toEqual([]);
  expect(m.brokenWord, `${where}: a word broken inside`).toEqual([]);
}

/** At Default, every button, choice row and checkbox's label drawn is at least 32 px high (40 in a pinned bar). */
async function bigEnough(where: string): Promise<void> {
  const small = await panel().evaluate(() => [...document.querySelectorAll<HTMLElement>('button, .ap-seg > label, label.choice, label.ap-pick-hit')]
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
    // The bar's own buttons; what sits above them (a prompt to copy by hand, with its Close) scrolls on its own.
    const outside = [...document.querySelectorAll<HTMLElement>('.ap-pinned > .ap-bar button')]
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
  await atEverySize(async (where, size, width) => {
    if (size === 'Largest' && width === 320) {
      // Some rows' places are too long here, so fits() proves they are cut at their start.
      const cutPlaces = await panel().evaluate(() => [...document.querySelectorAll<HTMLElement>('.ap-row-sub .path')]
        .filter((el) => el.getClientRects().length > 0 && el.scrollWidth > el.clientWidth + 1).length);
      expect(cutPlaces, `${where}: rows with a cut place`).toBeGreaterThan(0);
    }
    for (const name of ['Findings', 'The change', 'More'] as const) {
      await s.tab(name).click();
      await s.openFolds();
      await fits(`${where}, ${name}`);
      if (size === 'Default') await bigEnough(`${where}, ${name}`);
      await barInView(`${where}, ${name}`);
    }
    // The tab's count is never cut ("Findings…"): its words are no wider than its box.
    expect(await s.tab('Findings').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${where}: Findings tab cut`).toBe(true);
    await s.tab('Findings').click();
    await tabClear(`${where}, Findings`);
    await s.button('Select').click();
    await fits(`${where}, selecting`);
    if (size === 'Default') await bigEnough(`${where}, selecting`);
    // Each checkbox's label, the place to press, is at least 32 px each way at every size.
    const hits = await panel().evaluate(() => [...document.querySelectorAll<HTMLElement>('label.ap-pick-hit')]
      .map((el) => Math.min(el.offsetWidth, el.offsetHeight)));
    expect(hits.length, `${where}: checkboxes`).toBeGreaterThan(0);
    for (const side of hits) expect(side, `${where}: checkbox hit area`).toBeGreaterThanOrEqual(32);
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
    // The review's bar is hidden behind Settings, so it gives Settings no scroll padding.
    expect(await panel().evaluate(() => getComputedStyle(document.documentElement).scrollPaddingBottom), `${where}: scroll padding`).toBe('auto');
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

/** The Copy button that was pressed, and the bar's other button that must not stretch with the refused prompt. */
async function refusedIn(where: string, copy: Locator, other: Locator | null): Promise<void> {
  await copy.click();
  const box = panel().locator('.ap-pinned-above pre');
  await expect(box, `${where}: the prompt to copy by hand`).toBeVisible();
  // Above the buttons, not in their row.
  expect(await box.evaluate((el) => el.closest('.ap-bar') === null), `${where}: prompt outside the row`).toBe(true);
  if (other !== null) {
    const [copyHeight, otherHeight] = [await copy.evaluate((el) => (el as HTMLElement).offsetHeight), await other.evaluate((el) => (el as HTMLElement).offsetHeight)];
    expect(otherHeight, `${where}: the other button stretched`).toBeLessThanOrEqual(copyHeight + 1);
  }
  await fits(where);
  await barInView(where);
  await panel().locator('.ap-pinned-above').getByRole('button', { name: 'Close' }).click();
  await expect(box).toHaveCount(0);
  await expect(copy, `${where}: focus back on Copy`).toBeFocused();
}

test('11. a refused copy in each bar, in a 600 px and a 480 px tall panel: the prompt above the buttons, nothing stretched, Close back to Copy', async () => {
  await s.review();
  await s.refuseCopy();
  for (const height of [HEIGHT, SHORT]) {
    await atEverySize(async (where) => {
      await s.tab('Findings').click();
      await refusedIn(`${where}, review bar`, panel().getByRole('button', { name: /^Copy fix prompt for the \d+ fixes$/ }), s.button('Select'));
      await s.button('Select').click();
      await panel().getByRole('checkbox').first().check();
      await refusedIn(`${where}, select bar`, s.button('Copy fix prompt (1)'), s.button('Done'));
      await s.button('Done').click();
      await s.finding(0);
      await refusedIn(`${where}, finding bar`, s.button('Copy fix prompt'), null);
      await s.button('Back to the review').click();
    }, undefined, height);
  }
  // Copying works again for what runs next in this browser.
  await panel().reload();
  await s.review();
});

test('12. the comment sheet with several comments fits the panel', async () => {
  await s.review();
  await s.tab('Findings').click();
  await atEverySize(async (where, size) => {
    await s.button('Select').click();
    const boxes = panel().getByRole('checkbox');
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await panel().getByRole('button', { name: /^Comment on GitHub \(\d+\)$/ }).click();
    const sheet = panel().getByRole('dialog', { name: /^Comment on GitHub: \d+ comments$/ });
    await expect(sheet.getByRole('button', { name: /^Post \d+ comments$/ })).toBeVisible();
    await expect(sheet.getByText('Where they go')).toBeVisible();
    await sheetFits(`${where}, several comments`, sheet);
    if (size === 'Default') await bigEnough(`${where}, several comments`);
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(sheet).toHaveCount(0);
    await s.button('Done').click();
  });
});

test('13. the finding with a very long place, and the posted finding', async () => {
  await s.review();
  for (const index of [1, 2]) {
    await s.finding(index);
    await s.openFolds();
    await atEverySize(async (where, size) => {
      await expect(s.button('Back to the review')).toBeVisible();
      await fits(`${where}, finding ${index + 1}`);
      if (size === 'Default') await bigEnough(`${where}, finding ${index + 1}`);
      await barInView(`${where}, finding ${index + 1}`);
    });
    await s.button('Back to the review').click();
  }
  // The long place is cut at its start in the heading.
  await s.finding(1);
  await s.size('Largest');
  const place = panel().locator('.ap-heading .path');
  expect(await place.evaluate((el) => el.scrollWidth > el.clientWidth + 1), 'the long place is cut').toBe(true);
  await s.size('Default');
  await s.button('Back to the review').click();
});

test('14. the start screen with a refusal in its bar, and offline over it', async () => {
  await s.start();
  // The fake has no review to run for this pull request: the start is refused, and the notice is in the bar.
  await s.button('Review this pull request').click();
  const notice = panel().locator('.ap-pinned-above [role="alert"]');
  await expect(notice).toBeVisible();
  await atEverySize(async (where, size) => {
    await expect(notice).toBeVisible();
    await fits(`${where}, refused`);
    if (size === 'Default') await bigEnough(`${where}, refused`);
    await barInView(`${where}, refused`);
    await tabClear(`${where}, refused`);
  });
  await s.offline();
  await atEverySize(async (where, size) => {
    await expect(panel().getByRole('heading', { name: "Airlock's service on this Mac is not running." })).toBeVisible();
    await fits(`${where}, offline over start`);
    if (size === 'Default') await bigEnough(`${where}, offline over start`);
    await barInView(`${where}, offline over start`);
  });
  await s.online();
  await s.size('Default');
});

test('15. the progress screen with no total (followed after the panel was loaded again), and offline over it', async () => {
  // A panel loaded again does not know the depth of the run it started before, so it counts only the steps it sees.
  await panel().reload();
  await s.progress(RUNNING);
  const bar = panel().getByRole('progressbar', { name: 'Progress' });
  await expect(bar).toHaveAttribute('aria-valuetext', 'Step 7');
  await expect(bar).toHaveClass(/unknown/);
  await atEverySize(async (where, size) => {
    await expect(bar).toHaveAttribute('aria-valuetext', 'Step 7');
    await fits(`${where}, no total`);
    if (size === 'Default') await bigEnough(`${where}, no total`);
  });
  await s.offline();
  await s.openFolds();
  await atEverySize(async (where, size) => {
    await expect(panel().getByRole('heading', { name: 'Reviewing' })).toBeVisible();
    await fits(`${where}, offline over progress`);
    if (size === 'Default') await bigEnough(`${where}, offline over progress`);
  });
  await s.online();
  await s.size('Default');
});

test('16. a first review with nothing open: About this review open, the empty Findings tab with Show dismissed', async () => {
  await s.firstReview();
  const about = panel().getByRole('button', { name: /^About this review/ });
  await expect(about).toHaveAttribute('aria-expanded', 'true');
  await expect(panel().getByText(NOTHING_READ)).toBeVisible();
  await atEverySize(async (where, size) => {
    await s.tab('Findings').click();
    await expect(about).toHaveAttribute('aria-expanded', 'true');
    await expect(s.button('Show dismissed')).toBeVisible();
    await fits(where);
    if (size === 'Default') await bigEnough(where);
  });
});
