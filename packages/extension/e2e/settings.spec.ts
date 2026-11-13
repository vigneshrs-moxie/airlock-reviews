import {
  LatestReplySchema, PrSummarySchema, ReviewDocumentSchema, candidate, minimalDocument, type LatestReply, type PrSummary,
} from '@airlock/shared';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeService, type FakeService } from './fake-service';

// Settings, the text and button size and the tour, in the built extension, in a side panel 320 px wide beside a pull
// request with a stored review. The steps share one browser, whose storage carries from one to the next, and run in order.
test.describe.configure({ mode: 'serial' });

const EXTENSION_ID = 'nbcmjckbkploiemllhkmhegjimgeimoa';
const BUILT = fileURLToPath(new URL('../.output-e2e/chrome-mv3', import.meta.url));
const TOKEN = 'a'.repeat(64);
const HEAD = 'c'.repeat(40);
const PR_URL = 'https://github.com/acme/widgets/pull/3';
const TITLE = 'Pause skips the guard';

function pull(): { pr: PrSummary; latest: LatestReply } {
  const pr = PrSummarySchema.parse({
    repo: 'acme/widgets', number: 3, title: 'Let a person pause a subscription', author: 'alice', viewer: 'alice', isOwn: true,
    stage: 'pr1', baseRef: 'main', headRef: 'feature/pause', headSha: HEAD, additions: 3, deletions: 1, changedFiles: 1,
    packs: [{ id: 'generic', title: 'Generic' }], suggestedDepth: 'quick',
  });
  const base = minimalDocument();
  const document = ReviewDocumentSchema.parse({
    ...base, id: 'r_0000000003',
    pr: { ...base.pr, number: 3, headSha: HEAD, url: PR_URL },
    range: { ...base.range, headSha: HEAD },
    files: [{ path: 'src/pause.ts', tier: 'read', reason: '' }],
    verdict: { label: 'approve-after-fixes', sentence: 'One thing to fix.', counts: { block: 0, fix: 1, ask: 0, note: 0 } },
    findings: [{
      ...candidate(), id: 'c_00000001', title: TITLE, path: 'src/pause.ts', quote: 'code - 11', lineHint: 11,
      anchor: { status: 'in-diff', startLine: 11, endLine: 11 }, fingerprint: '0123456789abcdef', checked: 'Read the file.',
      bucket: 'top', rank: 1, status: 'new',
    }],
  });
  return { pr, latest: LatestReplySchema.parse({ document, dismissals: [] }) };
}

let service: FakeService | undefined;
let profile: string | undefined;
let context: BrowserContext | undefined;
let worker: Worker;
let panel: Page;

test.beforeAll(async () => {
  service = await startFakeService({ token: TOKEN, pulls: [pull()] });
  profile = await mkdtemp(join(tmpdir(), 'airlock-e2e-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 320, height: 640 },
    args: [`--disable-extensions-except=${BUILT}`, `--load-extension=${BUILT}`],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await context.route(PR_URL, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>pull request</title><p>The pull request.</p>' }));
});

test.afterAll(async () => {
  await context?.close();
  await service?.close();
  if (profile !== undefined) await rm(profile, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(service?.problems ?? []).toEqual([]);
});

const stored = (key: string): Promise<unknown> => worker.evaluate(async (k) => {
  const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
  return (await chrome.storage.local.get(k))[k];
}, key);
const tour = () => panel.getByRole('dialog', { name: /^(Start at the top|Three things you can do with a finding|Notes and size)$/ });
const button = (name: string) => panel.getByRole('button', { name, exact: true });
/** Nothing in the panel is wider than the panel. */
const noSidewaysScroll = async (): Promise<void> => {
  const widths = await panel.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
};

test('1. the tour opens by itself over the first finished review, walks three steps to Done, and not again after a reload', async () => {
  if (context === undefined) throw new Error('no browser');
  const github = await context.newPage();
  await github.goto(PR_URL);
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
  await panel.evaluate(async (token) => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    await chrome.storage.local.set({ 'airlock.token': token });
  }, TOKEN);
  await github.bringToFront();
  await worker.evaluate(async (address) => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    const [tab] = await chrome.tabs.query({ url: address });
    if (tab?.id === undefined) throw new Error('no pull request tab');
    await chrome.tabs.update(tab.id, { active: true });
  }, PR_URL);
  await panel.reload();

  const one = panel.getByRole('dialog', { name: 'Start at the top' });
  await expect(one).toBeVisible();
  await expect(one.getByText('Step 1 of 3', { exact: true })).toBeVisible();
  await expect(one.getByRole('button', { name: 'Next' })).toBeFocused();
  await one.getByRole('button', { name: 'Next' }).click();
  const two = panel.getByRole('dialog', { name: 'Three things you can do with a finding' });
  await expect(two.getByText('Step 2 of 3', { exact: true })).toBeVisible();
  await expect(two.getByText('hides the finding here and teaches Airlock. Nothing goes to GitHub.')).toBeVisible();
  await two.getByRole('button', { name: 'Next' }).click();
  const three = panel.getByRole('dialog', { name: 'Notes and size' });
  await expect(three.getByRole('button', { name: 'Skip' })).toHaveCount(0);
  await three.getByRole('button', { name: 'Done' }).click();
  await expect(tour()).toHaveCount(0);
  await expect.poll(() => stored('airlock.tourSeen')).toBe(true);

  await panel.reload();
  await expect(panel.getByText(TITLE).first()).toBeVisible();
  // Long enough for the stored flag and the review to have been read and the tour to have had its chance.
  await panel.waitForTimeout(500);
  await expect(tour()).toHaveCount(0);
});

test('2. Show the tour again in Settings closes Settings and opens it at step 1; Escape closes it and focus returns to Settings', async () => {
  await button('Settings').click();
  await expect(panel.getByRole('heading', { name: 'Settings', level: 2 })).toBeFocused();
  await button('Show the tour again').click();
  await expect(panel.getByRole('heading', { name: 'Settings', level: 2 })).toHaveCount(0);
  await expect(panel.getByRole('dialog', { name: 'Start at the top' })).toBeVisible();
  await panel.keyboard.press('Escape');
  await expect(tour()).toHaveCount(0);
  await expect(button('Settings')).toBeFocused();
});

test('3. the size: Largest zooms the whole panel at once, is stored, and the panel opens at it again', async () => {
  await button('Settings').click();
  const sizes = panel.getByRole('radiogroup', { name: 'Text and button size' });
  await expect(sizes.getByRole('radio', { name: 'Default' })).toBeChecked();
  await sizes.getByRole('radio', { name: 'Largest' }).check();
  await expect.poll(() => panel.evaluate(() => document.documentElement.style.zoom)).toBe('1.3');
  await expect.poll(() => stored('airlock.size')).toBe('xl');
  expect(await panel.evaluate(() => localStorage.getItem('airlock.size'))).toBe('xl');
  await expect(panel.getByRole('alert')).toHaveCount(0);

  await panel.reload();
  // Applied from the page's own copy before the panel draws anything.
  expect(await panel.evaluate(() => document.documentElement.style.zoom)).toBe('1.3');
  await button('Settings').click();
  await expect(panel.getByRole('radio', { name: 'Largest' })).toBeChecked();
  await button('Back').click();
});

test('4. at Largest in a 320 px panel nothing scrolls sideways, and the tour and the header keep their buttons in view', async () => {
  await expect(panel.getByText(TITLE).first()).toBeVisible();
  await noSidewaysScroll();
  await expect(button('Settings')).toBeInViewport();

  await button('Settings').click();
  await noSidewaysScroll();
  await expect(button('Packs and learned lines')).toBeVisible();
  await button('Packs and learned lines').click();
  await expect(panel.getByRole('heading', { name: 'Packs and learned lines' })).toBeVisible();
  await noSidewaysScroll();
  await button('Back').click();
  await button('Service').click();
  await expect(panel.getByText('Running, version test')).toBeVisible();
  await noSidewaysScroll();
  await button('Back').click();

  await button('Show the tour again').click();
  for (const step of ['Start at the top', 'Three things you can do with a finding', 'Notes and size']) {
    const dialog = panel.getByRole('dialog', { name: step });
    await expect(dialog).toBeVisible();
    await noSidewaysScroll();
    const primary = dialog.getByRole('button', { name: step === 'Notes and size' ? 'Done' : 'Next' });
    await primary.scrollIntoViewIfNeeded();
    await expect(primary).toBeInViewport();
    await primary.click();
  }
  await expect(tour()).toHaveCount(0);
});

/**
 * The bar pinned to the bottom, measured in the page: inside the panel, every button whole inside it and its words inside
 * the button, the room under the content as tall as the bar, and, scrolled to the end, the content ending above the bar.
 */
async function pinnedBarFits(tall = false): Promise<void> {
  // The room follows the bar's height once the bar has been measured (a frame after its buttons change).
  await expect.poll(() => panel.evaluate(() =>
    document.querySelector<HTMLElement>('.ap-pinned-room')!.offsetHeight - document.querySelector<HTMLElement>('.ap-pinned')!.offsetHeight)).toBe(0);
  await panel.evaluate(() => { const s = document.scrollingElement ?? document.documentElement; s.scrollTop = s.scrollHeight; });
  const m = await panel.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('.ap-pinned')!;
    const room = document.querySelector<HTMLElement>('.ap-pinned-room')!;
    const box = bar.getBoundingClientRect();
    const buttons = [...bar.querySelectorAll<HTMLButtonElement>('button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { name: b.textContent, inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5, words: b.scrollWidth <= b.clientWidth };
    });
    const content = room.previousElementSibling!.getBoundingClientRect();
    const scroller = document.scrollingElement ?? document.documentElement;
    return {
      scrolls: scroller.scrollHeight > scroller.clientHeight,
      zoom: document.documentElement.style.zoom, width: innerWidth, height: innerHeight, box: box.toJSON() as DOMRect, buttons,
      room: room.offsetHeight, bar: bar.offsetHeight, contentBottom: content.bottom,
    };
  });
  expect(m.zoom).toBe('1.3');
  expect(m.box.left).toBeGreaterThanOrEqual(0);
  expect(m.box.right).toBeLessThanOrEqual(m.width + 0.5);
  expect(Math.abs(m.box.bottom - m.height)).toBeLessThanOrEqual(1);
  expect(m.buttons.length).toBeGreaterThan(0);
  for (const b of m.buttons) expect(b, b.name ?? '').toMatchObject({ inside: true, words: true });
  expect(m.room).toBe(m.bar);
  expect(m.contentBottom).toBeLessThanOrEqual(m.box.top + 0.5);
  // Scrolled to the end of a screen taller than the panel, what is left between the end of the content and the bar is
  // the body's own padding (12 CSS px, 15.6 at Largest), not a second bar's height.
  if (tall) expect(m.scrolls).toBe(true);
  if (m.scrolls) expect(m.box.top - m.contentBottom).toBeLessThanOrEqual(24);
  await noSidewaysScroll();
}

test('5. at Largest in a 320 px panel the review\'s bar and a finding\'s actions keep their buttons whole, with room above them', async () => {
  await button('Settings').click();
  await panel.getByRole('radio', { name: 'Largest' }).check();
  await expect.poll(() => panel.evaluate(() => document.documentElement.style.zoom)).toBe('1.3');
  await button('Back').click();

  await expect(button('Select')).toBeVisible();
  await pinnedBarFits();
  await button('Select').click();
  await expect(panel.getByRole('button', { name: /^Comment on GitHub \(\d+\)$/ })).toBeVisible();
  await pinnedBarFits();
  await button('Done').click();

  await panel.locator('.finding-card button').first().click();
  await expect(panel.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
  await pinnedBarFits();
  for (const name of ['What happens', 'Why it matters', 'The code', 'How sure is this']) {
    await panel.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  }
  await pinnedBarFits(true);
  await button('Back to the review').click();

  // Back to Default, which the next run of this spec starts from anyway.
  await button('Settings').click();
  await panel.getByRole('radio', { name: 'Default' }).check();
  await expect.poll(() => panel.evaluate(() => document.documentElement.style.zoom)).toBe('1');
});
