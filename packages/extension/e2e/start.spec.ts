import {
  PrSummarySchema, ReviewDocumentSchema, StartReviewBodySchema, minimalDocument, type Brief, type ChangeMap, type PrSummary,
  type ServiceEvent,
} from '@airlock/shared';
import { chromium, expect, test, type BrowserContext, type Locator, type Page, type Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signal, startFakeService, type FakeService, type RunStep } from './fake-service';

// The start screen and the progress screen, in the built extension, in a side panel 320 px wide beside a pull request
// with no stored review: at Default, then at Largest (set through Settings), a deep review started and followed to its
// end. The steps share one browser and run in order.
test.describe.configure({ mode: 'serial' });

const EXTENSION_ID = 'nbcmjckbkploiemllhkmhegjimgeimoa';
const BUILT = fileURLToPath(new URL('../.output-e2e/chrome-mv3', import.meta.url));
const TOKEN = 'b'.repeat(64);
const HEAD = 'e'.repeat(40);
const PR_URL = 'https://github.com/acme/widgets/pull/5';
const WIDTH = 320;
const HEIGHT = 560;

const pr: PrSummary = PrSummarySchema.parse({
  repo: 'acme/widgets', number: 5, title: 'Let a person pause a subscription from the account page, and resume it later',
  author: 'alice', viewer: 'alice', isOwn: true, stage: 'pr1', baseRef: 'main', headRef: 'feature/pause', headSha: HEAD,
  additions: 612, deletions: 38, changedFiles: 14,
  packs: [{ id: 'orbit', title: 'Orbit' }, { id: 'generic', title: 'Generic' }], suggestedDepth: 'standard',
});

const brief: Brief = { whatItDoes: ['Lets a person pause a subscription from the account page.'], claims: [] };
const map: ChangeMap = {
  cohorts: [
    { id: 'g1', title: 'Pausing', summary: '', neighbours: [], inferredLinks: [], layers: [{ id: 'l1', title: 'The rule', kind: 'rules', files: ['src/pause.ts', 'src/resume.ts'], dependsOn: [], note: '' }] },
    { id: 'g2', title: 'Guarding', summary: '', neighbours: [], inferredLinks: [], layers: [{ id: 'l2', title: 'The write', kind: 'writes', files: ['src/guard.ts'], dependsOn: ['l1'], note: '' }] },
  ],
  standalone: [],
  links: [],
};

const base = minimalDocument();
const finished = ReviewDocumentSchema.parse({
  ...base, id: 'r_0000000005', depth: 'deep',
  pr: { ...base.pr, repo: 'acme/widgets', number: 5, title: pr.title, headSha: HEAD, url: PR_URL },
  range: { ...base.range, headSha: HEAD },
  verdict: { label: 'approve', sentence: 'Nothing to fix.', counts: { block: 0, fix: 0, ask: 0, note: 0 } },
  findings: [],
});

const stage = (name: string, status: 'start' | 'done', detail = ''): RunStep => ({ event: { type: 'stage', stage: name, status, detail } satisfies ServiceEvent });
const held = signal();
const script: RunStep[] = [
  stage('intake', 'start'), stage('intake', 'done'), stage('packs', 'start'), stage('packs', 'done'),
  stage('shape', 'start'), stage('shape', 'done', 'skipped: not a sync merge'), stage('facts', 'start'), stage('facts', 'done'),
  stage('map', 'start'), { event: { type: 'map', map } }, stage('map', 'done'),
  stage('brief', 'start'), { event: { type: 'brief', brief } }, stage('brief', 'done'),
  stage('lenses', 'start'),
  // The rest waits for the spec to have looked at the progress screen.
  { until: held.promise },
  stage('lenses', 'done'), { event: { type: 'done', document: finished } },
];

let service: FakeService | undefined;
let profile: string | undefined;
let context: BrowserContext | undefined;
let worker: Worker;
let panel: Page;

test.beforeAll(async () => {
  service = await startFakeService({ token: TOKEN, pulls: [{ pr, script }] });
  profile = await mkdtemp(join(tmpdir(), 'airlock-e2e-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: WIDTH, height: HEIGHT },
    args: [`--disable-extensions-except=${BUILT}`, `--load-extension=${BUILT}`],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await context.route(PR_URL, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>pull request</title><p>The pull request.</p>' }));
});

test.afterAll(async () => {
  held.open();
  await context?.close();
  await service?.close();
  if (profile !== undefined) await rm(profile, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(service?.problems ?? []).toEqual([]);
});

const button = (name: string) => panel.getByRole('button', { name, exact: true });
const startButton = () => button('Review this pull request');
const bar = () => panel.locator('.ap-pinned');
const progressbar = () => panel.getByRole('progressbar', { name: 'Progress' });

/** Nothing in the panel is wider than the panel. */
async function noSidewaysScroll(): Promise<void> {
  const widths = await panel.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
}

/** The pinned bar is wholly inside the panel, on its bottom edge, and each of its buttons' words fit inside the button. */
async function barInView(): Promise<void> {
  const box = await bar().boundingBox();
  if (box === null) throw new Error('no pinned bar');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(WIDTH + 0.5);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(Math.abs(box.y + box.height - HEIGHT)).toBeLessThanOrEqual(1);
  for (const b of await bar().getByRole('button').all()) {
    expect(await b.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
}

/** A control reached with Tab sits above the pinned bar, not under it. */
async function clearOfBar(control: Locator): Promise<void> {
  await expect(control).toBeFocused();
  const [own, pinned] = await Promise.all([control.boundingBox(), bar().boundingBox()]);
  if (own === null || pinned === null) throw new Error('not drawn');
  expect(own.y + own.height).toBeLessThanOrEqual(pinned.y + 0.5);
}

test('1. the start screen: the pull request, the depth as three choices, the packs in place, and the pinned button', async () => {
  if (context === undefined) throw new Error('no browser');
  const github = await context.newPage();
  await github.goto(PR_URL);
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
  await panel.evaluate(async (token) => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    await chrome.storage.local.set({ 'airlock.token': token, 'airlock.tourSeen': true });
  }, TOKEN);
  await github.bringToFront();
  await worker.evaluate(async (address) => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    const [tab] = await chrome.tabs.query({ url: address });
    if (tab?.id === undefined) throw new Error('no pull request tab');
    await chrome.tabs.update(tab.id, { active: true });
  }, PR_URL);
  await panel.reload();

  await expect(panel.getByRole('heading', { name: pr.title })).toBeVisible();
  await expect(panel.getByText('Pull request', { exact: true })).toBeVisible();
  await expect(panel.getByText('acme/widgets #5 · 14 files · 612 lines added, 38 removed')).toBeVisible();
  await expect(panel.getByText("Your pull request, first stage: your branch into the team's branch.")).toBeVisible();

  const depth = panel.getByRole('radiogroup', { name: 'Depth' });
  await expect(depth.getByRole('radio')).toHaveCount(3);
  await expect(depth.getByRole('radio', { name: 'Standard' })).toBeChecked();
  await expect(panel.getByText('Every finding is challenged before you see it.')).toBeVisible();
  await depth.getByRole('radio', { name: 'Quick' }).check();
  await expect(panel.getByText('One pass, no second opinion. For small changes.')).toBeVisible();
  await expect(panel.getByText('Every finding is challenged before you see it.')).toHaveCount(0);

  const packs = button('Packs');
  await expect(packs).toHaveAttribute('aria-expanded', 'false');
  await expect(packs).toContainText('Orbit, Generic');
  await packs.click();
  await expect(packs).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByRole('switch', { name: 'Orbit' })).toBeChecked();
  await expect(panel.getByRole('switch', { name: 'Generic' })).toBeChecked();
  // The pack choice opened in place: the start screen is still there around it.
  await expect(panel.getByRole('heading', { name: pr.title })).toBeVisible();

  await expect(startButton()).toBeVisible();
  await expect(bar().getByText('Runs on your Claude login. Nothing is posted to GitHub.')).toBeVisible();
  await barInView();
  await noSidewaysScroll();

  // Reached with Tab, the last switch is not under the bar.
  await packs.focus();
  await panel.keyboard.press('Tab');
  await panel.keyboard.press('Tab');
  await clearOfBar(panel.getByRole('switch', { name: 'Generic' }));
});

test('2. at Largest, set in Settings, the start screen still fits the panel and keeps its button in view', async () => {
  await button('Settings').click();
  await panel.getByRole('radiogroup', { name: 'Text and button size' }).getByRole('radio', { name: 'Largest' }).check();
  await expect.poll(() => panel.evaluate(() => document.documentElement.style.zoom)).toBe('1.3');
  await button('Back').click();

  // The choices made before Settings are kept.
  await expect(panel.getByRole('radio', { name: 'Quick' })).toBeChecked();
  await expect(button('Packs')).toHaveAttribute('aria-expanded', 'true');
  await expect(startButton()).toBeInViewport();
  await noSidewaysScroll();
  await barInView();
  await button('Packs').focus();
  await panel.keyboard.press('Tab');
  await panel.keyboard.press('Tab');
  await clearOfBar(panel.getByRole('switch', { name: 'Generic' }));
});

test('3. a deep review: the progress screen names the stage, counts its steps out of the deep review\'s, and folds the steps and what it found', async () => {
  await panel.getByRole('radio', { name: 'Deep' }).check();
  await expect(panel.getByText('Standard, plus a closer second pass over each layer.')).toBeVisible();
  await startButton().click();
  await expect.poll(() => service?.requests.filter((r) => r.method === 'POST' && r.url === '/reviews').length).toBe(1);
  const body = StartReviewBodySchema.parse(service?.requests.find((r) => r.method === 'POST' && r.url === '/reviews')?.body);
  expect(body).toEqual({ repo: 'acme/widgets', number: 5, depth: 'deep' });

  await expect(panel.getByRole('heading', { name: 'Reviewing' })).toBeVisible();
  await expect(panel.locator('.ap-title')).toHaveText('Looking through each lens');
  await expect(progressbar()).toHaveAttribute('aria-valuetext', 'Step 7 of 16');
  await expect(progressbar()).toHaveAttribute('aria-valuenow', '7');
  await expect(progressbar()).toHaveAttribute('aria-valuemax', '16');
  await expect(panel.getByText(/^Step 7 of 16 · \d+ s · 3 files in 2 groups$/)).toBeVisible();

  const steps = panel.getByRole('button', { name: /^Show the steps/ });
  await expect(steps).toContainText('16');
  await steps.click();
  const list = panel.getByRole('list', { name: 'Stages' });
  await expect(list.locator('li')).toHaveCount(16);
  await expect(list.locator('li').filter({ hasText: 'Reading the pull request' })).toHaveAttribute('data-status', 'done');
  await expect(list.locator('li').filter({ hasText: 'Checking for a sync merge' })).toHaveAttribute('data-status', 'skipped');
  await expect(list.locator('li').filter({ hasText: 'Looking through each lens' })).toHaveAttribute('data-status', 'now');
  await expect(list.locator('li').filter({ hasText: 'Taking a second, deeper look' })).toHaveAttribute('data-status', 'next');

  await panel.getByRole('button', { name: 'What it has found so far' }).click();
  await expect(panel.getByText('Lets a person pause a subscription from the account page.')).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Pausing' })).toBeVisible();
  await noSidewaysScroll();

  held.open();
  await expect(panel.getByText('Nothing to fix.')).toBeVisible();
  await expect(progressbar()).toHaveCount(0);
});
