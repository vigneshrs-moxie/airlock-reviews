import {
  LatestReplySchema, PrSummarySchema, ReviewDocumentSchema, candidate, diffAnchorId, minimalDocument,
  type Finding, type LatestReply, type PrSummary,
} from '@airlock/shared';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeService, type FakeService } from './fake-service';

const EXTENSION_ID = 'nbcmjckbkploiemllhkmhegjimgeimoa';
const BUILT = fileURLToPath(new URL('../.output-e2e/chrome-mv3', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const TOKEN = 'e'.repeat(64);
const HEAD = 'b'.repeat(40);
const TITLE = 'Pause skips the guard';

function pull(number: number): { pr: PrSummary; latest: LatestReply } {
  const pr = PrSummarySchema.parse({
    repo: 'acme/widgets', number, title: 'Pause', author: 'alice', viewer: 'bob', isOwn: false, stage: 'pr1',
    baseRef: 'main', headRef: 'feature/pause', headSha: HEAD, additions: 3, deletions: 1, changedFiles: 2, packs: [],
    suggestedDepth: 'quick',
  });
  const base = minimalDocument();
  const finding: Finding = {
    ...candidate(), id: 'c_00000001', title: TITLE, path: 'src/pause.ts', quote: 'code - 11', lineHint: 11,
    connected: [{ path: 'src/guard.ts', line: 4, role: 'caller', quote: 'code - 4' }],
    anchor: { status: 'in-diff', startLine: 11, endLine: 11 }, fingerprint: '0123456789abcdef', checked: 'Read both files.',
    bucket: 'top', rank: 1, status: 'new',
  };
  const document = ReviewDocumentSchema.parse({
    ...base, id: `r_00000000${number}`,
    pr: { ...base.pr, number, headSha: HEAD, url: `https://github.com/acme/widgets/pull/${number}` },
    range: { ...base.range, headSha: HEAD },
    files: [{ path: 'src/pause.ts', tier: 'read', reason: '' }, { path: 'src/guard.ts', tier: 'read', reason: '' }],
    verdict: { label: 'approve-after-fixes', sentence: 'One thing to fix.', counts: { block: 0, fix: 1, ask: 0, note: 0 } },
    findings: [finding],
  });
  return { pr, latest: LatestReplySchema.parse({ document, dismissals: [] }) };
}

let service: FakeService;
let profile: string;
let context: BrowserContext;
let worker: Worker;
let pause: string;

test.beforeAll(async () => {
  service = await startFakeService({ token: TOKEN, pulls: [pull(1), pull(2)] });
  profile = await mkdtemp(join(tmpdir(), 'airlock-e2e-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${BUILT}`, `--load-extension=${BUILT}`],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  pause = await diffAnchorId('src/pause.ts');
  const page = (name: string) => readFile(join(FIXTURES, name), 'utf8');
  const classic = await page('files-classic.html');
  const react = await page('files-react.html');
  const html = (body: string) => ({ contentType: 'text/html', body });
  await context.route('https://github.com/acme/widgets/pull/1/files', (route) => route.fulfill(html(classic)));
  await context.route('https://github.com/acme/widgets/pull/2/files', (route) => route.fulfill(html(react)));
  await context.route('https://github.com/acme/widgets/pull/1', (route) =>
    route.fulfill(html('<!doctype html><title>conversation</title><p>The conversation page.</p>')));
});

test.afterAll(async () => {
  await context?.close();
  await service?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

/** Makes the tab at `url` the active tab, from the extension's service worker. */
async function activate(url: string): Promise<void> {
  await worker.evaluate(async (address) => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    const [tab] = await chrome.tabs.query({ url: address });
    if (tab?.id === undefined) throw new Error(`no tab at ${address}`);
    await chrome.tabs.update(tab.id, { active: true });
  }, url);
}

/** A GitHub tab at `url` with the panel page beside it, paired, showing the stored review with its finding open. */
async function besideReview(url: string): Promise<{ github: Page; panel: Page }> {
  const github = await context.newPage();
  await github.goto(url);
  await activate(url);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
  await panel.evaluate(async (token) => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    await chrome.storage.local.set({ 'airlock.token': token });
  }, TOKEN);
  await github.bringToFront();
  await activate(url);
  await panel.reload();
  await panel.getByRole('button', { name: new RegExp(TITLE) }).click();
  return { github, panel };
}

const classicCell = (github: Page, anchor: string, line: number) => github.locator(`td[id="${anchor}R${line}"]`);

test('clicking Jump to line in the panel scrolls the classic fixture page to the row and marks it', async () => {
  const { github, panel } = await besideReview('https://github.com/acme/widgets/pull/1/files');
  await panel.getByRole('button', { name: 'Jump to line' }).click();
  await expect(panel.getByText('Showing src/pause.ts:11.')).toBeVisible();
  expect(github.url().endsWith(`#${pause}R11`)).toBe(true);
  const cell = classicCell(github, pause, 11);
  await expect(cell).toHaveClass(/(^| )airlock-target( |$)/);
  await expect(github.locator('tr', { has: cell }).locator('td.airlock-target')).toHaveCount(3);
  await expect(cell).toBeInViewport();
  await expect(github.locator('.airlock-target')).toHaveCount(3);

  // A connected place among the files moves the mark there.
  await panel.getByRole('button', { name: /src\/guard\.ts:4/ }).click();
  await expect(panel.getByText('Showing src/guard.ts:4.')).toBeVisible();
  await expect(cell).not.toHaveClass(/airlock-target/);
  const guard = await diffAnchorId('src/guard.ts');
  await expect(classicCell(github, guard, 4)).toHaveClass(/airlock-target/);

  // The script's own fragment change does not wipe its mark; any other change of address does, pushState included.
  await github.waitForTimeout(1_500);
  await expect(github.locator('.airlock-target')).toHaveCount(3);
  await github.evaluate(() => history.pushState(null, '', '/acme/widgets/pull/1/files?w=1'));
  await expect(github.locator('.airlock-target')).toHaveCount(0);
  await github.close();
  await panel.close();
});

test('clicking Jump to line in the panel scrolls the newer-view fixture page to the row and marks it', async () => {
  const { github, panel } = await besideReview('https://github.com/acme/widgets/pull/2/files');
  await panel.getByRole('button', { name: 'Jump to line' }).click();
  await expect(panel.getByText('Showing src/pause.ts:11.')).toBeVisible();
  expect(github.url().endsWith(`#${pause}R11`)).toBe(true);
  const row = github.locator('tr.airlock-target');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('code - 11');
  await expect(row).toBeInViewport();
  await panel.getByRole('button', { name: 'Back to the review' }).click();
  await panel.getByRole('button', { name: 'Packs' }).click();
  await expect(panel.getByText('Recognised as the newer view.')).toBeVisible();
  await github.close();
  await panel.close();
});

test('from the conversation page, Jump to line opens the Files changed page and marks the row', async () => {
  const { github, panel } = await besideReview('https://github.com/acme/widgets/pull/1');
  await panel.getByRole('button', { name: 'Jump to line' }).click();
  await expect(panel.getByText('Showing src/pause.ts:11.')).toBeVisible({ timeout: 20_000 });
  expect(github.url()).toBe(`https://github.com/acme/widgets/pull/1/files#${pause}R11`);
  const cell = classicCell(github, pause, 11);
  await expect(cell).toHaveClass(/airlock-target/);
  await expect(cell).toBeInViewport();
  await github.close();
  await panel.close();
});

test('the built content script is small and carries no schema library', async () => {
  const script = await readFile(join(BUILT, 'content-scripts', 'github.js'), 'utf8');
  expect(Buffer.byteLength(script)).toBeLessThan(15 * 1024);
  expect(script).not.toMatch(/zod/i);
  expect(script).not.toContain('ReviewDocument');
});
