import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RUNNING, RUNNING_TOO, Screens, type SizeName } from './screens-fixture';

// A picture of every screen in a panel 360 px wide, at Default in light and dark and at Largest in light, for the person
// who checks the redesign by eye. Not part of `npm run e2e`: run `npm run e2e:shots` at the repository's root. The pictures
// go to .superpowers/sdd/2026-11-12-panel-redesign/shots/ (ignored by git), named <screen>-<size>-<scheme>.png.
// A screen is pictured whole (taller than the panel when it is); a sheet and the tour as the panel shows them.
test.describe.configure({ mode: 'serial' });

const WIDTH = 360;
const HEIGHT = 640;
const SHOTS = fileURLToPath(new URL('../../../.superpowers/sdd/2026-11-12-panel-redesign/shots/', import.meta.url));
const SETTLE = 350;

const s = new Screens();
const panel = () => s.panel;

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
  await s.open(WIDTH, HEIGHT);
});

test.afterAll(async () => {
  await s.close();
});

const VARIANTS: Array<{ size: SizeName; scheme: 'light' | 'dark' }> = [
  { size: 'Default', scheme: 'light' },
  { size: 'Default', scheme: 'dark' },
  { size: 'Largest', scheme: 'light' },
];

for (const [i, { size, scheme }] of VARIANTS.entries()) {
  const variant = `${size.toLowerCase()}-${scheme}`;
  test(`every screen at ${size}, ${scheme}`, async () => {
    await panel().emulateMedia({ colorScheme: scheme });
    await panel().setViewportSize({ width: WIDTH, height: HEIGHT });
    /**
     * The screen whole, or (a sheet) the panel as it is. A whole screen is pictured in a panel made as tall as the screen,
     * not with Playwright's full page, which leaves a pinned bar where the first screenful ended, over the content.
     */
    const shot = async (name: string, whole = true): Promise<void> => {
      // Nothing moving: the fold arrows' turn, the focus ring's place.
      await panel().waitForTimeout(250);
      if (whole) {
        for (let i = 0; i < 4; i += 1) {
          const height = panel().viewportSize()?.height ?? HEIGHT;
          const [scroll, client] = await panel().evaluate(() => {
            const root = document.scrollingElement ?? document.documentElement;
            return [root.scrollHeight, root.clientHeight];
          });
          if (scroll <= client) break;
          await panel().setViewportSize({ width: WIDTH, height: Math.ceil((height * scroll) / client) + 1 });
        }
        await panel().waitForTimeout(150);
      }
      await panel().screenshot({ path: `${SHOTS}${name}-${variant}.png`, animations: 'disabled' });
      await panel().setViewportSize({ width: WIDTH, height: HEIGHT });
    };
    const top = () => panel().evaluate(() => window.scrollTo(0, 0));

    await s.start();
    await s.size(size);
    await top();
    await shot('start');
    await s.button('Packs').click();
    await shot('start-packs');
    await s.button('Packs').click();

    // A review started from this panel each time, so the bar shows its share of the steps.
    await s.progress(i === 0 ? RUNNING : RUNNING_TOO[i - 1]);
    await panel().getByRole('button', { name: /^Show the steps/ }).click();
    await top();
    await shot('progress');

    await s.review();
    await s.tab('Findings').click();
    await top();
    await shot('review-findings');
    await s.openFolds();
    await shot('review-findings-open');
    await s.button('Select').click();
    await panel().getByRole('checkbox').nth(1).check();
    await top();
    await shot('review-findings-select');
    await s.button('Done').click();
    await s.tab('The change').click();
    await s.openFolds();
    await top();
    await shot('review-change');
    await s.tab('More').click();
    await s.openFolds();
    await top();
    await shot('review-more');

    await panel().getByRole('button', { name: /^Dropped: \d+$/ }).click();
    await expect(panel().getByRole('dialog')).toBeVisible();
    await shot('sheet-dropped', false);
    await panel().keyboard.press('Escape');

    // A finding as it opens, then with every fold open; the one with the long title, then the posted one.
    await s.finding(0);
    await top();
    await shot('finding');
    await s.openFolds();
    await shot('finding-open');
    await s.button('Comment on GitHub').click();
    await expect(panel().getByRole('dialog', { name: 'Comment on GitHub' }).getByRole('button', { name: 'Post comment' })).toBeVisible();
    await shot('sheet-comment', false);
    await panel().getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await s.button('Dismiss').click();
    const dismiss = panel().getByRole('dialog', { name: 'Dismiss this finding' });
    await dismiss.getByRole('radio', { name: 'The finding is mistaken' }).check();
    await shot('sheet-dismiss', false);
    await panel().keyboard.press('Escape');
    await s.button('Back to the review').click();
    await s.finding(2);
    await top();
    await shot('finding-posted');
    await s.button('Back to the review').click();

    // The comment sheet with several comments, from Select.
    await s.tab('Findings').click();
    await s.button('Select').click();
    await panel().getByRole('checkbox').nth(0).check();
    await panel().getByRole('checkbox').nth(1).check();
    await panel().getByRole('button', { name: /^Comment on GitHub \(\d+\)$/ }).click();
    const several = panel().getByRole('dialog', { name: /^Comment on GitHub: \d+ comments$/ });
    await expect(several.getByRole('button', { name: /^Post \d+ comments$/ })).toBeVisible();
    await shot('sheet-comment-several', false);
    await several.getByRole('button', { name: 'Cancel' }).click();
    await s.button('Done').click();

    // A refused copy on each bar: the prompt to copy by hand above the buttons. Copying works again after a reload.
    await s.refuseCopy();
    const refused = panel().locator('.ap-pinned-above pre');
    const closeRefused = () => panel().locator('.ap-pinned-above').getByRole('button', { name: 'Close' }).click();
    await top();
    await panel().getByRole('button', { name: /^Copy fix prompt for the \d+ fixes$/ }).click();
    await expect(refused).toBeVisible();
    await shot('review-refused-copy', false);
    await closeRefused();
    await s.button('Select').click();
    await panel().getByRole('checkbox').first().check();
    await s.button('Copy fix prompt (1)').click();
    await expect(refused).toBeVisible();
    await shot('review-select-refused-copy', false);
    await closeRefused();
    await s.button('Done').click();
    await s.finding(0);
    await top();
    await s.button('Copy fix prompt').click();
    await expect(refused).toBeVisible();
    await shot('finding-refused-copy', false);
    await closeRefused();
    await s.button('Back to the review').click();
    await panel().reload();
    await s.review();

    // A first review with nothing open: About this review starts open.
    await s.firstReview();
    await top();
    await shot('review-first');
    await s.review();

    await s.button('Settings').click();
    await top();
    await shot('settings');
    await s.button('Packs and learned lines').click();
    await expect(panel().getByRole('heading', { name: 'Packs and learned lines' })).toBeVisible();
    await shot('packs');
    await s.button('Back').click();
    await s.button('Service').click();
    await expect(panel().getByText('Running, version test')).toBeVisible();
    await shot('service');
    await s.button('Back').click();
    await s.button('Show the tour again').click();
    for (const [i, step] of ['Start at the top', 'Three things you can do with a finding', 'Notes and size'].entries()) {
      const dialog = panel().getByRole('dialog', { name: step });
      await expect(dialog).toBeVisible();
      await shot(`tour-${i + 1}`, false);
      await panel().waitForTimeout(SETTLE);
      await dialog.getByRole('button', { name: step === 'Notes and size' ? 'Done' : 'Next' }).click();
    }

    await s.problem();
    await shot('problem');

    await s.unpair();
    await shot('pair');
    await s.pair();

    await s.review();
    await s.offline();
    await top();
    await shot('offline');
    await s.online();
    await s.size('Default');
  });
}
