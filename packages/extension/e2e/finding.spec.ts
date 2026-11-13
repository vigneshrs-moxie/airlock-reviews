import {
  LatestReplySchema, PrSummarySchema, ReviewDocumentSchema, candidate, minimalDocument, type Finding, type LatestReply, type PrSummary,
} from '@airlock/shared';
import { chromium, expect, test, type BrowserContext, type Locator, type Page, type Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeService, type FakeService } from './fake-service';

// The finding screen, its pinned actions and its two bottom sheets, in a real Chrome at the panel's narrowest and widest.
const EXTENSION_ID = 'nbcmjckbkploiemllhkmhegjimgeimoa';
const BUILT = fileURLToPath(new URL('../.output-e2e/chrome-mv3', import.meta.url));
const TOKEN = 'f'.repeat(64);
const HEAD = 'b'.repeat(40);
const URL_ = 'https://github.com/acme/widgets/pull/1/files';
const LONG_TITLE = 'The pause handler calls the billing guard only after the account state is written, so a paused account can still order.';
const LONG_PATH = `src/${'a-folder-with-a-long-name/'.repeat(4)}pause-limit.ts`;
const LONG_TEXT = `${'A paused account can still place an order, because the guard is asked too late. '.repeat(12)}End.`;

function pull(): { pr: PrSummary; latest: LatestReply } {
  const pr = PrSummarySchema.parse({
    repo: 'acme/widgets', number: 1, title: 'Pause', author: 'alice', viewer: 'bob', isOwn: false, stage: 'pr1',
    baseRef: 'main', headRef: 'feature/pause', headSha: HEAD, additions: 3, deletions: 1, changedFiles: 2, packs: [],
    suggestedDepth: 'quick',
  });
  const one = (n: number, over: Partial<Finding>): Finding => ({
    ...candidate(), id: `c_0000000${n}`, path: 'src/pause.ts', quote: `code - ${10 + n}`, lineHint: 10 + n,
    anchor: { status: 'in-diff', startLine: 10 + n, endLine: 10 + n, comment: { line: 10 + n, startLine: null } },
    fingerprint: String(n).repeat(16), checked: 'Read both files.', bucket: 'top', rank: n, status: 'new', ...over,
  });
  const findings = [
    one(1, {
      severity: 'block', title: LONG_TITLE, happens: LONG_TEXT, why: LONG_TEXT, suggestedChange: 'Ask the guard before writing the state.',
      quote: Array.from({ length: 30 }, (_, i) => `const line${i} = ${'x'.repeat(i * 3)};`).join('\n'),
      connected: [{ path: 'src/guard.ts', line: 4, role: 'caller', quote: 'code - 4' }],
    }),
    one(2, { severity: 'ask', title: 'Is a paused account billed?' }),
    one(3, { severity: 'note', title: 'Name the pause limit', path: LONG_PATH }),
  ];
  const base = minimalDocument();
  const document = ReviewDocumentSchema.parse({
    ...base, id: 'r_0000000001',
    pr: { ...base.pr, number: 1, headSha: HEAD, url: 'https://github.com/acme/widgets/pull/1' },
    range: { ...base.range, headSha: HEAD },
    files: [{ path: 'src/pause.ts', tier: 'read', reason: '' }, { path: 'src/guard.ts', tier: 'read', reason: '' }],
    verdict: { label: 'request-changes', sentence: 'One thing blocks this.', counts: { block: 1, fix: 0, ask: 1, note: 1 } },
    findings,
  });
  return { pr, latest: LatestReplySchema.parse({ document, dismissals: [] }) };
}

let service: FakeService;
let profile: string;
let context: BrowserContext;
let worker: Worker;
let github: Page;
let panel: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  service = await startFakeService({ token: TOKEN, pulls: [pull()] });
  profile = await mkdtemp(join(tmpdir(), 'airlock-e2e-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${BUILT}`, `--load-extension=${BUILT}`],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await context.route(URL_, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>files</title><p>Files changed.</p>' }));
  github = await context.newPage();
  await github.goto(URL_);
  await activate();
  panel = await context.newPage();
  await panel.setViewportSize({ width: 320, height: 640 });
  await panel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
  await panel.evaluate(async (token) => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    // Paired, and the tour already seen, so it does not open over the review (settings.spec.ts and the flow show it).
    await chrome.storage.local.set({ 'airlock.token': token, 'airlock.tourSeen': true });
  }, TOKEN);
  await github.bringToFront();
  await activate();
  await panel.reload();
});

test.afterAll(async () => {
  await context?.close();
  await service?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

async function activate(): Promise<void> {
  await worker.evaluate(async (address) => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    const [tab] = await chrome.tabs.query({ url: address });
    if (tab?.id === undefined) throw new Error(`no tab at ${address}`);
    await chrome.tabs.update(tab.id, { active: true });
  }, URL_);
}

const bar = (): Locator => panel.locator('.ap-bar');
const fold = (name: string): Locator => panel.getByRole('button', { name: new RegExp(`^${name}`) });
/** Nothing in the panel is wider than the panel: no sideways scrolling. */
const noSideways = async (): Promise<void> => {
  expect(await panel.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
};
/** The pinned actions sit at the bottom edge of the panel, every button whole and at least 40 px high. */
async function pinned(): Promise<void> {
  const height = panel.viewportSize()?.height ?? 0;
  const box = await bar().boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.y + box!.height)).toBeGreaterThanOrEqual(height - 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);
  for (const button of await bar().getByRole('button').all()) {
    const b = await button.boundingBox();
    expect(b!.height).toBeGreaterThanOrEqual(40);
    await expect(button).toBeInViewport({ ratio: 1 });
  }
}

test('1. the finding screen leads with the short version, and its actions stay pinned at 320 px with every fold open', async () => {
  // The finding's line in the review list starts with the same words, whichever way the list shows its title.
  await panel.getByRole('button', { name: /The pause handler calls/ }).first().click();
  await expect(panel.getByRole('heading', { name: 'The pause handler calls the billing guard only after the…' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Back to the review' })).toHaveText('Review');
  await expect(panel.locator('.ap-tag')).toHaveText('Block');
  await expect(panel.getByRole('button', { name: 'Show in diff' })).toBeVisible();
  await expect(panel.locator('.ap-do')).toContainText('Ask the guard before writing the state.');
  await expect(bar().getByRole('button')).toHaveText(['Copy fix prompt', 'Comment on GitHub', 'Dismiss']);
  await expect(bar().locator('.btn.primary')).toHaveText('Copy fix prompt');
  await expect(bar()).toContainText('for your coding agent');
  await noSideways();
  await pinned();

  for (const name of ['What happens', 'Why it matters', 'The code', 'Also involves', 'How sure is this']) await fold(name).click();
  await expect(panel.getByText(LONG_TITLE, { exact: true })).toBeVisible();
  // The screen is now much taller than the panel: the actions stay at its bottom edge at the top and at the end.
  expect(await panel.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(640 * 2);
  await pinned();
  await panel.mouse.wheel(0, 100_000);
  await expect.poll(() => panel.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await pinned();
  await noSideways();

  // Tab from the top through every control: none it reaches before the actions is ever behind them.
  await panel.evaluate(() => { window.scrollTo(0, 0); (document.activeElement as HTMLElement | null)?.blur(); });
  let reachedBar = false;
  for (let i = 0; i < 40 && !reachedBar; i += 1) {
    await panel.keyboard.press('Tab');
    const seen = await panel.evaluate(() => {
      const focused = document.activeElement as HTMLElement | null;
      const bar = document.querySelector('.ap-pinned');
      if (focused === null || bar === null || focused === document.body) return { inBar: false, overlap: 0, what: '' };
      if (bar.contains(focused)) return { inBar: true, overlap: 0, what: focused.textContent ?? '' };
      const a = focused.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      return { inBar: false, overlap: Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)), what: focused.textContent ?? '' };
    });
    reachedBar = seen.inBar;
    expect(seen.overlap, seen.what).toBe(0);
  }
  expect(reachedBar).toBe(true);

  // The hard case: the next control is already on screen but in the strip the actions cover. Tab must bring it clear.
  const behindBar = await panel.evaluate(() => {
    const target = [...document.querySelectorAll<HTMLElement>('.ap-fold')].find((b) => b.textContent === 'How sure is this')!;
    const before = [...document.querySelectorAll<HTMLElement>('.ap-folds button')];
    before[before.indexOf(target) - 1]!.focus({ preventScroll: true });
    window.scrollBy(0, target.getBoundingClientRect().bottom - (window.innerHeight - 20));
    const bar = document.querySelector('.ap-pinned')!.getBoundingClientRect();
    return target.getBoundingClientRect().bottom > bar.top;
  });
  expect(behindBar).toBe(true);
  await panel.keyboard.press('Tab');
  const clear = await panel.evaluate(() => {
    const focused = document.activeElement!.getBoundingClientRect();
    return { name: document.activeElement!.textContent, clear: focused.bottom <= document.querySelector('.ap-pinned')!.getBoundingClientRect().top };
  });
  expect(clear).toEqual({ name: 'How sure is this', clear: true });
});

test('2. Next keeps the folds open and fills Comment on GitHub for a question; at 420 px nothing moves sideways', async () => {
  await panel.setViewportSize({ width: 420, height: 640 });
  await panel.getByRole('button', { name: 'Next finding' }).click();
  await expect(panel.getByRole('heading', { name: 'Is a paused account billed?' })).toBeVisible();
  await expect(fold('The code')).toHaveAttribute('aria-expanded', 'true');
  await expect(bar().locator('.btn.primary')).toHaveText('Comment on GitHub');
  await noSideways();
  await pinned();
  await panel.getByRole('button', { name: 'Next finding' }).click();
  await expect(bar().locator('.btn.primary')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Next finding' })).toBeDisabled();
  // A place too long for its row is cut at its start: the file name and line number show, the start does not.
  const place = panel.locator('.ap-where code');
  await expect(place).toHaveText(`${LONG_PATH}:13`);
  const ends = await place.evaluate((code) => {
    const text = code.querySelector('span')!.firstChild as Text;
    const at = (i: number) => { const r = document.createRange(); r.setStart(text, i); r.setEnd(text, i + 1); return r.getBoundingClientRect(); };
    const box = code.getBoundingClientRect();
    const last = at(text.length - 1);
    const first = at(0);
    return { lastInside: last.right <= box.right + 1 && last.left >= box.left - 1, firstOutside: first.right <= box.left + 1 };
  });
  expect(ends).toEqual({ lastInside: true, firstOutside: true });
  // Inside The code it is shown whole, wrapped, never cut.
  const whole = panel.locator('.ap-place-whole');
  await expect(whole).toHaveText(`${LONG_PATH}:13`);
  await expect(whole).toBeVisible();
  expect(await whole.evaluate((p) => p.scrollWidth <= p.clientWidth)).toBe(true);
  await noSideways();
  await panel.getByRole('button', { name: 'Previous finding' }).click();
  await panel.getByRole('button', { name: 'Previous finding' }).click();
  await expect(panel.getByRole('button', { name: 'Previous finding' })).toBeDisabled();
});

test('3. the comment sheet rises from the bottom, leads with where the comment goes, and fits a 320 px panel', async () => {
  await panel.setViewportSize({ width: 320, height: 640 });
  await panel.getByRole('button', { name: 'Comment on GitHub' }).click();
  const sheet = panel.getByRole('dialog', { name: 'Comment on GitHub' });
  await expect(sheet.getByText('Where it goes')).toBeVisible();
  await expect(sheet.getByText('On the line', { exact: true })).toBeVisible();
  await expect(sheet.getByText('src/pause.ts, line 11. It shows in Files changed, next to the code.')).toBeVisible();
  await expect(sheet.getByText('Posts as bob on acme/widgets#1, as a comment. Airlock never approves, requests changes or merges. Nothing has been sent yet.')).toBeAttached();
  const where = await sheet.getByText('Where it goes').boundingBox();
  const exact = await sheet.getByText('The exact text', { exact: true }).boundingBox();
  expect(where!.y).toBeLessThan(exact!.y);
  const body = await panel.locator('.sheet.bottom .sheet-body').boundingBox();
  expect(Math.round(body!.y + body!.height)).toBeGreaterThanOrEqual(639);
  expect(body!.height).toBeLessThanOrEqual(640 * 0.9 + 1);
  expect(body!.width).toBeLessThanOrEqual(320);
  await noSideways();
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Comment on GitHub' })).toBeFocused();
  // Nothing was posted: only the preview was asked for.
  expect(service.requests.filter((r) => r.method === 'POST' && r.url === '/posts')).toEqual([]);
});

test('4. the dismiss sheet says nothing goes to GitHub, and shows the line Airlock will remember for a mistaken finding', async () => {
  await panel.getByRole('button', { name: 'Dismiss', exact: true }).click();
  const sheet = panel.getByRole('dialog', { name: 'Dismiss this finding' });
  await expect(sheet.getByText('It leaves this review. Nothing is sent to GitHub. You can bring it back under More.')).toBeVisible();
  await expect(sheet.getByRole('textbox')).toHaveCount(0);
  await sheet.getByRole('radio', { name: 'The finding is mistaken' }).check();
  await expect(sheet.getByRole('textbox', { name: 'The line Airlock will remember' })).toBeVisible();
  await expect(sheet.getByText('Airlock reads this line in every later review of this repository. You can remove it in Settings.')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Dismiss', exact: true })).toBeDisabled();
  // A press anywhere in a reason's box picks it: its words are covered by the label's click area.
  await sheet.locator('.ap-opt', { hasText: 'Nothing is saved.' }).click({ position: { x: 200, y: 30 } });
  await expect(sheet.getByRole('radio', { name: 'Hide it on this pull request only' })).toBeChecked();
  await expect(sheet.getByRole('textbox')).toHaveCount(0);
  const body = await panel.locator('.sheet.bottom .sheet-body').boundingBox();
  expect(Math.round(body!.y + body!.height)).toBeGreaterThanOrEqual(639);
  await noSideways();
  await panel.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Dismiss', exact: true })).toBeFocused();
  expect(service.requests.filter((r) => r.url.startsWith('/dismissals'))).toEqual([]);
});
