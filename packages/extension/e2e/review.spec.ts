import {
  PrSummarySchema, ReviewDocumentSchema, candidate, fixPrompt, minimalDocument, type Finding, type PrSummary, type ReviewDocument,
} from '@airlock/shared';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeService, type FakeService } from './fake-service';

// The review screen in the built extension, in a panel 320 pixels wide, against the fake service: the verdict strip, the
// three tabs, one row per finding, the bar pinned to the bottom, coming back from a finding to the same place, and a
// review that did not finish saying so in the first screenful. Each step is its own test; they share one browser.
test.describe.configure({ mode: 'serial' });

const EXTENSION_ID = 'nbcmjckbkploiemllhkmhegjimgeimoa';
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const BUILT = fileURLToPath(new URL('../.output-e2e/chrome-mv3', import.meta.url));
const TOKEN = '0123456789abcdef'.repeat(4);
const HEAD = 'a1b2c3d'.padEnd(40, '0');
const REPO = 'acme/widgets';
const NUMBER = 31;
const UNFINISHED = 32;
const url = (n: number): string => `https://github.com/${REPO}/pull/${n}/files`;
const PAGE = '<!doctype html><title>files</title><p>Files changed.</p>';
const WIDTH = 320;

const prOf = (number: number, title: string): PrSummary => PrSummarySchema.parse({
  repo: REPO, number, title, author: 'alice', viewer: 'alice', isOwn: true, stage: 'pr1', baseRef: 'main', headRef: 'feature/x',
  headSha: HEAD, additions: 10, deletions: 2, changedFiles: 3, packs: [{ id: 'generic', title: 'Generic' }], suggestedDepth: 'standard',
});

function finding(n: number, over: Partial<Finding>): Finding {
  const hex = n.toString(16).padStart(2, '0');
  return {
    ...candidate(), id: `c_000000${hex}`, path: `src/a/very/long/folder/name/that/keeps/going/file${n}.ts`, lineHint: n,
    title: `Finding number ${n}`, anchor: { status: 'in-diff', startLine: n, endLine: n }, fingerprint: hex.repeat(8), checked: 'Checked.',
    bucket: 'top', rank: n, status: null, source: { pack: 'generic', lens: 'correctness', ruleId: null }, ...over,
  };
}

const LONG = 'The totals module rounds each line before adding them, so an order of many small items can be a cent or more off the amount the customer pays';
const top = [
  finding(1, { severity: 'block', title: LONG }),
  finding(2, { severity: 'fix', short: 'Resume forgets the plan' }),
  ...Array.from({ length: 10 }, (_, i) => finding(i + 3, { severity: 'ask' })),
];
const alsoFound = [finding(20, { severity: 'note', bucket: 'also', rank: null }), finding(21, { severity: 'fix', bucket: 'also', rank: null })];

function reviewDocument(): ReviewDocument {
  const base = minimalDocument();
  return ReviewDocumentSchema.parse({
    ...base, id: 'r_0000000031',
    pr: { ...base.pr, repo: REPO, number: NUMBER, title: 'Pause a subscription', headSha: HEAD, url: `https://github.com/${REPO}/pull/${NUMBER}` },
    range: { ...base.range, headSha: HEAD },
    packs: [{ id: 'generic', version: 'v1' }],
    brief: { whatItDoes: ['Adds a pause button.', 'Stops billing while paused.'], claims: [], inShort: 'Lets a person pause a subscription.' },
    verdict: { label: 'request-changes', sentence: 'One thing blocks this.', counts: { block: 1, fix: 2, ask: 10, note: 1 } },
    findings: [...alsoFound, ...top],
    whoseCall: ['Billing decides what a pause costs.'],
    notes: ['A note from the review.'],
    dropped: [{ candidate: { ...candidate(), id: 'c_000000d1', title: 'The same as the first' }, stage: 'merge', reason: 'Same place and cause.', refutation: null, mergedInto: top[0]!.id }],
  });
}

function unfinishedDocument(): ReviewDocument {
  const base = minimalDocument();
  return ReviewDocumentSchema.parse({
    ...base, id: 'r_0000000032',
    pr: { ...base.pr, repo: REPO, number: UNFINISHED, title: 'Resume a subscription', headSha: HEAD, url: `https://github.com/${REPO}/pull/${UNFINISHED}` },
    range: { ...base.range, headSha: HEAD },
    verdict: { label: 'incomplete', sentence: 'The review did not finish: a stage failed.', counts: { block: 0, fix: 1, ask: 0, note: 0 } },
    findings: [finding(1, { severity: 'fix' })],
    stageErrors: [{ stage: 'lenses', cohortId: null, message: 'The model run timed out.' }],
  });
}

const reviewed = reviewDocument();
let service: FakeService | undefined;
let profile: string | undefined;
let context: BrowserContext | undefined;
let worker: Worker;
let github: Page;
let panel: Page;

test.beforeAll(async () => {
  service = await startFakeService({
    token: TOKEN, unpaired: true,
    pulls: [
      { pr: prOf(NUMBER, 'Pause a subscription'), latest: { document: reviewed, dismissals: [], posts: [] } },
      { pr: prOf(UNFINISHED, 'Resume a subscription'), latest: { document: unfinishedDocument(), dismissals: [], posts: [] } },
    ],
  });
  profile = await mkdtemp(join(tmpdir(), 'airlock-e2e-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${BUILT}`, `--load-extension=${BUILT}`],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await context.route(/^https:\/\/github\.com\/acme\/widgets\/pull\/\d+\/files$/, (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
});

test.afterAll(async () => {
  await context?.close();
  await service?.close();
  if (profile !== undefined) await rm(profile, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(service?.problems ?? []).toEqual([]);
});

async function activate(address: string): Promise<void> {
  await worker.evaluate(async (address) => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    const [tab] = await chrome.tabs.query({ url: address });
    if (tab?.id === undefined) throw new Error(`no tab at ${address}`);
    await chrome.tabs.update(tab.id, { active: true });
  }, address);
}

const tab = (name: 'Findings' | 'The change' | 'More') => panel.getByRole('tab', { name: name === 'Findings' ? /^Findings · / : name });
const rows = () => panel.locator('.finding-card');
const strip = () => panel.locator('.ap-verdict');
/** The review's own pinned bar (a finding's actions are pinned the same way, in .ap-pinned-finding). */
const bar = () => panel.locator('.ap-pinned-review .ap-bar');
const scrollTop = () => panel.evaluate(() => (document.scrollingElement ?? document.documentElement).scrollTop);
/** Nothing in the panel is wider than the panel: no sideways scrolling. */
const noSideways = async () => {
  const [scroll, client] = await panel.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll).toBeLessThanOrEqual(client);
};

test('1. paired, the review opens on its verdict strip, the tabs and one row per finding, at 320 pixels wide', async () => {
  if (context === undefined) throw new Error('no browser');
  github = await context.newPage();
  await github.goto(url(NUMBER));
  panel = await context.newPage();
  await panel.setViewportSize({ width: WIDTH, height: 640 });
  await panel.goto(`${ORIGIN}/sidepanel.html`);
  // The tour already seen, so it does not open over the first review (settings.spec.ts and the flow show it).
  await panel.evaluate(async () => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    await chrome.storage.local.set({ 'airlock.tourSeen': true });
  });
  const cdp = await context.newCDPSession(panel);
  for (const name of ['clipboard-read', 'clipboard-write']) {
    await cdp.send('Browser.setPermission', { origin: ORIGIN, permission: { name }, setting: 'granted' });
  }
  await github.bringToFront();
  await activate(url(NUMBER));
  await panel.reload();
  await panel.getByLabel('Pairing token').fill(TOKEN);
  await panel.getByRole('button', { name: 'Pair' }).click();

  await expect(panel.getByRole('heading', { name: 'Request changes' })).toBeVisible();
  await expect(strip().getByText('One thing blocks this.')).toBeVisible();
  await expect(strip().getByRole('list', { name: 'Open findings' }).getByRole('listitem')).toHaveText(['1 blocking', '2 to fix', '10 questions', '1 note']);
  await expect(strip().getByText('Reviewed at a1b2c3d · Standard')).toBeVisible();
  await expect(panel.getByRole('tab')).toHaveText(['Findings · 14', 'The change', 'More']);
  await expect(tab('Findings')).toHaveAttribute('aria-selected', 'true');
  await expect(rows()).toHaveCount(12);
  await expect(rows().locator('.ap-sev').first()).toHaveText('Block');
  // A row's title: the short title when there is one, else the title cut at a word.
  await expect(rows().nth(0).locator('.title')).toHaveText('The totals module rounds each line before adding them, so…');
  await expect(rows().nth(1).locator('.title')).toHaveText('Resume forgets the plan');

  // Each row's place is one line, cut with an ellipsis; its title is at most two lines.
  for (const i of [0, 1, 11]) {
    const path = rows().nth(i).locator('.path');
    const [height, line, cut] = await path.evaluate((el) => [el.getBoundingClientRect().height, parseFloat(getComputedStyle(el).lineHeight), el.scrollWidth > el.clientWidth]);
    expect(height).toBeLessThanOrEqual(line + 1);
    expect(cut).toBe(true);
    const title = rows().nth(i).locator('.title');
    const [titleHeight, titleLine] = await title.evaluate((el) => [el.getBoundingClientRect().height, parseFloat(getComputedStyle(el).lineHeight)]);
    expect(titleHeight).toBeLessThanOrEqual(titleLine * 2 + 1);
  }
  await noSideways();

  // The bar is pinned to the bottom of the panel while the review scrolls, its buttons at least 40 pixels high.
  const box = await bar().boundingBox();
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(640);
  for (const button of await bar().getByRole('button').all()) expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(40);
  await expect(bar().getByRole('button')).toHaveText(['Copy fix prompt for the 3 fixes', 'Select']);
});

test('2. one fix prompt covers every open Block and Fix, top first, then also found', async () => {
  await bar().getByRole('button', { name: 'Copy fix prompt for the 3 fixes' }).click();
  await expect(bar().getByRole('button', { name: 'Copied' })).toBeVisible();
  const copied = await panel.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(fixPrompt(reviewed, [top[0]!, top[1]!, alsoFound[1]!]));
});

test('3. a finding opened from far down the list comes back to the same place, with focus on its row', async () => {
  await rows().nth(10).scrollIntoViewIfNeeded();
  await panel.evaluate(() => window.scrollBy(0, 40));
  const before = await scrollTop();
  expect(before).toBeGreaterThan(200);
  await rows().nth(10).getByRole('button').click();
  await expect(panel.getByRole('heading', { name: 'Finding number 11' })).toBeVisible();
  await expect(bar()).toHaveCount(0);
  await panel.getByRole('button', { name: 'Back to the review' }).click();
  await expect(rows().nth(10).getByRole('button')).toBeFocused();
  expect(Math.abs((await scrollTop()) - before)).toBeLessThanOrEqual(1);
});

test('4. the tabs move with the arrow keys, keep their place while a finding is open, and every tab fits the width', async () => {
  await panel.evaluate(() => window.scrollTo(0, 0));
  await tab('Findings').focus();
  await panel.keyboard.press('ArrowRight');
  await expect(tab('The change')).toBeFocused();
  await expect(tab('The change')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('Lets a person pause a subscription.', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'What it does 2 points' })).toHaveAttribute('aria-expanded', 'false');
  await panel.getByRole('button', { name: 'Whose call 1' }).click();
  await expect(panel.getByText('Billing decides what a pause costs.')).toBeVisible();
  await noSideways();
  await tab('The change').focus();
  await panel.keyboard.press('ArrowRight');
  await expect(tab('More')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('Reviewed at a1b2c3d · Standard depth · Packs: Generic')).toBeVisible();
  await noSideways();

  // From the dropped sheet on More, to the finding it was merged into, and Back: More again, focus on Dropped.
  await panel.getByRole('button', { name: 'Dropped: 1' }).click();
  await panel.getByRole('dialog').getByRole('button', { name: 'Show the finding it was merged into' }).click();
  // The finding is headed by its title cut at a word; the whole title is the first line of What happens.
  await expect(panel.getByRole('heading', { name: 'The totals module rounds each line before adding them, so…' })).toBeVisible();
  await panel.getByRole('button', { name: 'Back to the review' }).click();
  await expect(tab('More')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('button', { name: 'Dropped: 1' })).toBeFocused();
  await tab('More').focus();
  await panel.keyboard.press('Home');
  await expect(tab('Findings')).toHaveAttribute('aria-selected', 'true');
});

test('5. Select puts a checkbox on every row; Comment on GitHub opens the preview for the ticked ones; Done ends it', async () => {
  await bar().getByRole('button', { name: 'Select' }).click();
  await expect(panel.getByRole('checkbox')).toHaveCount(12);
  await expect(panel.getByRole('checkbox').first()).toBeFocused();
  await expect(bar().getByRole('button')).toHaveText(['Copy fix prompt (0)', 'Comment on GitHub (0)', 'Done']);
  await panel.getByRole('checkbox', { name: `Select: ${top[1]!.title}`, exact: true }).check();
  await panel.getByRole('checkbox', { name: `Select: ${top[2]!.title}`, exact: true }).check();
  await noSideways();
  for (const button of await bar().getByRole('button').all()) expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(40);
  const comment = bar().getByRole('button', { name: 'Comment on GitHub (2)' });
  await comment.click();
  const sheet = panel.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('textbox', { name: 'Comment 2' })).toBeVisible();
  await panel.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(comment).toBeFocused();
  // Nothing went to GitHub: a preview only.
  expect(service?.sent ?? []).toEqual([]);
  await bar().getByRole('button', { name: 'Done' }).click();
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await expect(bar().getByRole('button', { name: 'Select' })).toBeFocused();
});

test('6. a review that did not finish says so in the first screenful, without a tab being pressed', async () => {
  await github.goto(url(UNFINISHED));
  await activate(url(UNFINISHED));
  await expect(panel.getByRole('heading', { name: 'Review incomplete' })).toBeVisible();
  const errors = panel.getByRole('heading', { name: 'Stage errors' });
  await expect(errors).toBeVisible();
  await expect(panel.getByText('Failed while reading the code: The model run timed out.')).toBeVisible();
  const box = await errors.boundingBox();
  expect((box?.y ?? 1000) + (box?.height ?? 0)).toBeLessThan(640);
  await expect(tab('Findings')).toHaveAttribute('aria-selected', 'true');
  await noSideways();
});
