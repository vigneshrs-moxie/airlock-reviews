import {
  DismissBodySchema, LatestReplySchema, PrSummarySchema, RestoreBodySchema, ReviewDocumentSchema, StartReviewBodySchema,
  candidate, fixPrompt, minimalDocument, verdictWords,
  type Brief, type ChangeMap, type Finding, type PrSummary, type ReviewDocument, type ServiceEvent,
} from '@airlock/shared';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signal, startFakeService, type FakeService, type RunStep } from './fake-service';

// The whole flow a person goes through, in the built extension beside the classic Files changed fixture, against the
// fake service: pair, Ready, a running review whose brief arrives early, the verdict, a finding, the fix prompt, dismiss
// and restore, the service stopping and coming back. Each step is its own test; they share one browser and run in order.
test.describe.configure({ mode: 'serial' });

const EXTENSION_ID = 'nbcmjckbkploiemllhkmhegjimgeimoa';
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const BUILT = fileURLToPath(new URL('../.output-e2e/chrome-mv3', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const TOKEN = '0123456789abcdef'.repeat(4);
const HEAD = 'b'.repeat(40);
const REPO = 'acme/widgets';
const NUMBER = 7;
const FILES_URL = `https://github.com/${REPO}/pull/${NUMBER}/files`;
/**
 * Long enough for the panel to notice the service went or came back: it says Not running after two missed checks five
 * seconds apart, and while offline it checks again every five seconds.
 */
const RETRY_WAIT = { timeout: 25_000 };

const pr: PrSummary = PrSummarySchema.parse({
  repo: REPO, number: NUMBER, title: 'Let a person pause a subscription', author: 'alice', viewer: 'alice', isOwn: true,
  stage: 'pr1', baseRef: 'main', headRef: 'feature/pause', headSha: HEAD, additions: 160, deletions: 20, changedFiles: 3,
  packs: [{ id: 'orbit', title: 'Orbit' }, { id: 'generic', title: 'Generic' }], suggestedDepth: 'standard',
});

const brief: Brief = {
  whatItDoes: ['Lets a person pause a subscription from the account page.'],
  claims: [
    { text: 'Paused accounts are never billed', verdict: 'not-supported', evidence: 'billing.ts still bills a paused account.' },
    { text: 'Adds a Pause button', verdict: 'verified', evidence: 'src/pause.ts:11' },
  ],
};

const map: ChangeMap = {
  cohorts: [
    { id: 'g1', title: 'Pausing', summary: '', neighbours: [], inferredLinks: [], layers: [{ id: 'l1', title: 'The rule', kind: 'rules', files: ['src/pause.ts'], dependsOn: [], note: '' }] },
    { id: 'g2', title: 'Guarding', summary: '', neighbours: [], inferredLinks: [], layers: [{ id: 'l2', title: 'The write', kind: 'writes', files: ['src/guard.ts'], dependsOn: ['l1'], note: '' }] },
  ],
  standalone: [],
  links: [],
};

function finding(n: number, over: Partial<Finding>): Finding {
  const hex = n.toString(16);
  return {
    ...candidate(), id: `c_0000000${hex}`, path: 'src/pause.ts', quote: `code - ${10 + n}`, lineHint: 10 + n,
    anchor: { status: 'in-diff', startLine: 10 + n, endLine: 10 + n }, fingerprint: `${hex}`.repeat(16), checked: `Read src/pause.ts and its caller (${n}).`,
    bucket: 'top', rank: n, status: 'new', ...over,
  };
}

const top = [
  finding(1, {
    severity: 'block', title: 'Pause skips the guard', happens: 'A paused account can still place an order.',
    why: 'The guard is never asked when the account is paused.', suggestedChange: 'Call the guard before pausing.',
    connected: [{ path: 'src/guard.ts', line: 4, role: 'caller', quote: 'code - 4' }], wouldBeWrongIf: 'The guard runs earlier for every caller.',
    alsoRaisedBy: [{ pack: 'orbit', lens: null, ruleId: 'R-12' }],
  }),
  finding(2, { severity: 'fix', title: 'Resume forgets the plan', path: 'src/guard.ts', quote: 'code - 4', lineHint: 4, anchor: { status: 'in-diff', startLine: 4, endLine: 4 } }),
  finding(3, { severity: 'ask', title: 'Is a paused account billed?' }),
];
/** The line typed for the Wrong dismissal of the second finding. */
const WRONG_LINE = 'Flagged "Resume forgets the plan" in src/guard.ts. Wrong because: resume reads the plan from the saved account.';
const alsoFound = [
  finding(4, { severity: 'note', title: 'Name the pause limit', bucket: 'also', rank: null }),
  finding(5, { severity: 'note', title: 'Log each pause', bucket: 'also', rank: null }),
];

function reviewDocument(): ReviewDocument {
  const base = minimalDocument();
  return ReviewDocumentSchema.parse({
    ...base, id: 'r_0123456789',
    pr: { ...base.pr, repo: REPO, number: NUMBER, title: pr.title, author: 'alice', viewer: 'alice', headRef: 'feature/pause', headSha: HEAD, url: `https://github.com/${REPO}/pull/${NUMBER}` },
    range: { ...base.range, headSha: HEAD },
    packs: [{ id: 'orbit', version: 'v3' }, { id: 'generic', version: 'v1' }],
    files: [{ path: 'src/pause.ts', tier: 'read', reason: '' }, { path: 'src/guard.ts', tier: 'read', reason: '' }, { path: 'src/copy.ts', tier: 'skim', reason: '' }],
    map, brief,
    verdict: { label: 'request-changes', sentence: 'One thing blocks this, and two more need a look first.', counts: { block: 1, fix: 1, ask: 1, note: 2 } },
    findings: [...alsoFound, top[2], top[0], top[1]],
    questions: [{ text: 'Should a paused account keep its seat?', cohortId: 'g1', source: { pack: 'generic', lens: 'product', ruleId: null } }],
    dropped: [{
      candidate: { ...candidate(), id: 'c_000000d1', title: 'Pause is not awaited', path: 'src/pause.ts' },
      stage: 'challenge', reason: 'Every caller awaits it.', refutation: { path: 'src/guard.ts', line: 3, role: 'head', quote: 'code 3 3' },
    }],
    limits: ['The rule file docs/rules.md was left out because it is too long.'],
    notes: [NOTE],
  });
}

const NOTE = 'The team standard could not be refreshed; the copy from 2026-11-10 was used.';
const document = reviewDocument();
const stage = (name: string, status: 'start' | 'done', detail = ''): RunStep => ({ event: { type: 'stage', stage: name, status, detail } satisfies ServiceEvent });
const briefSeen = signal();
const PAUSE = { pause: 150 };
const script: RunStep[] = [
  stage('intake', 'start'), PAUSE, stage('intake', 'done', '3 files'), PAUSE,
  stage('packs', 'start'), stage('packs', 'done'), PAUSE,
  stage('brief', 'start'), PAUSE, { event: { type: 'brief', brief } }, stage('brief', 'done'), PAUSE,
  stage('map', 'start'), { event: { type: 'map', map } }, stage('map', 'done'),
  { comment: 'keep-alive' }, PAUSE,
  stage('lenses', 'start'),
  // The rest waits for the spec to have seen the brief while the lenses are still working.
  { until: briefSeen.promise }, PAUSE,
  stage('lenses', 'done', '9 candidates'), stage('challenge', 'start'), PAUSE, stage('challenge', 'done'),
  stage('select', 'start'), stage('select', 'done'), PAUSE,
  { event: { type: 'done', document } },
];

let service: FakeService | undefined;
let profile: string | undefined;
let context: BrowserContext | undefined;
let worker: Worker;
let github: Page;
let panel: Page;

test.beforeAll(async () => {
  service = await startFakeService({ token: TOKEN, unpaired: true, pulls: [{ pr, script }] });
  profile = await mkdtemp(join(tmpdir(), 'airlock-e2e-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${BUILT}`, `--load-extension=${BUILT}`],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const classic = await readFile(join(FIXTURES, 'files-classic.html'), 'utf8');
  await context.route(FILES_URL, (route) => route.fulfill({ contentType: 'text/html', body: classic }));
});

test.afterAll(async () => {
  await context?.close();
  await service?.close();
  if (profile !== undefined) await rm(profile, { recursive: true, force: true });
});

// Nothing the fake answered or wrote during a step broke the contract.
test.afterEach(() => {
  expect(service?.problems ?? []).toEqual([]);
});

/** Makes the GitHub tab the active one, from the extension's service worker. */
async function activate(): Promise<void> {
  await worker.evaluate(async (address) => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    const [tab] = await chrome.tabs.query({ url: address });
    if (tab?.id === undefined) throw new Error(`no tab at ${address}`);
    await chrome.tabs.update(tab.id, { active: true });
  }, FILES_URL);
}

const svc = (): FakeService => {
  if (service === undefined) throw new Error('the fake service did not start');
  return service;
};
const bodiesOf = (method: string, path: string): unknown[] =>
  svc().requests.filter((r) => r.method === method && r.url === path).map((r) => r.body);
const frameStatus = () => panel.locator('header .status');
const cards = () => panel.locator('.finding-card');
const cardTitles = () => cards().locator('.title');

test('1. not paired: the pairing screen, and the token typed into it pairs the panel', async () => {
  if (context === undefined) throw new Error('no browser');
  github = await context.newPage();
  await github.goto(FILES_URL);
  await activate();
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
  // Clipboard access for the extension's pages, in this browser only (the manifest asks for none). Playwright's
  // grantPermissions cannot be used: it reads a chrome-extension address as an opaque origin and refuses it. The
  // session stays open, as Chromium drops a session's permission overrides when it detaches.
  const cdp = await context.newCDPSession(panel);
  for (const name of ['clipboard-read', 'clipboard-write']) {
    await cdp.send('Browser.setPermission', { origin: ORIGIN, permission: { name }, setting: 'granted' });
  }
  await github.bringToFront();
  await activate();
  await panel.reload();

  await expect(frameStatus()).toHaveText('Not paired');
  await expect(panel.getByRole('heading', { name: 'Pair this panel with Airlock' })).toBeVisible();
  await panel.getByLabel('Pairing token').fill(TOKEN);
  await panel.getByRole('button', { name: 'Pair' }).click();

  await expect(frameStatus()).toHaveText('Connected');
  const pairing = svc().requests.filter((r) => r.method === 'POST' && r.url === '/pair');
  expect(pairing).toHaveLength(1);
  expect(pairing[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  expect(pairing[0]?.headers.origin).toBe(ORIGIN);
});

test('2. Ready: the stage in words, the packs, the suggested depth chosen; Review starts it', async () => {
  await expect(panel.getByRole('heading', { name: pr.title })).toBeVisible();
  await expect(panel.getByText("Your pull request, first stage: your branch into the team's branch.")).toBeVisible();
  await expect(panel.getByRole('switch', { name: 'Orbit' })).toBeChecked();
  await expect(panel.getByRole('switch', { name: 'Generic' })).toBeChecked();
  await expect(panel.getByRole('radio', { name: /^Standard/ })).toBeChecked();
  await expect(panel.getByRole('radio', { name: /^Quick/ })).not.toBeChecked();

  await panel.getByRole('button', { name: 'Review', exact: true }).click();
  await expect.poll(() => bodiesOf('POST', '/reviews')).toHaveLength(1);
  const body = StartReviewBodySchema.parse(bodiesOf('POST', '/reviews')[0]);
  // All packs on, so the service chooses them.
  expect(body).toEqual({ repo: REPO, number: NUMBER, depth: 'standard' });
});

test('3. Running: stage lines arrive, and the brief and map are shown while a later stage still works', async () => {
  await expect(panel.getByRole('heading', { name: 'Reviewing' })).toBeVisible();
  const stages = panel.getByRole('list', { name: 'Stages' });
  await expect(stages.locator('li').filter({ hasText: 'Reading the pull request' })).toHaveAttribute('data-status', 'done');
  await expect(stages.locator('li').filter({ hasText: 'Looking through each lens' })).toHaveAttribute('data-status', 'working');
  await expect(stages.locator('li').filter({ hasText: 'Looking through each lens' })).toContainText('Working');
  await expect(panel.getByText('Lets a person pause a subscription from the account page.')).toBeVisible();
  await expect(panel.getByText('Paused accounts are never billed')).toBeVisible();
  await expect(panel.getByText('billing.ts still bills a paused account.')).toBeVisible();
  // A verified claim is not one to check.
  await expect(panel.getByText('Adds a Pause button')).toHaveCount(0);
  await expect(panel.getByRole('heading', { name: 'Pausing' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Guarding' })).toBeVisible();

  // All of that is on screen before the fake has written `done`; the keep-alive went past without harm.
  const run = svc().runs[0];
  expect(run?.written.some((item) => 'type' in item && item.type === 'done')).toBe(false);
  expect(run?.written).toContainEqual({ comment: 'keep-alive' });

  // The service's status, seen from Packs, lists the running review; Back returns to it.
  await panel.getByRole('button', { name: 'Packs' }).click();
  await expect(panel.getByText('Running, version test')).toBeVisible();
  await expect(panel.getByText(`${REPO} #${NUMBER}`)).toBeVisible();
  await panel.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Reviewing' })).toBeVisible();

  briefSeen.open();
});

test('4. the verdict: its words and sentence, three top findings in rank order, Also found collapsed with two', async () => {
  const words = verdictWords(document.verdict.label, document.pr.stage);
  await expect(panel.getByRole('heading', { name: words })).toBeVisible();
  await expect(panel.getByText(document.verdict.sentence)).toBeVisible();
  await expect(frameStatus()).toHaveText('Connected');
  await expect(cardTitles()).toHaveText(top.map((f) => f.title));
  await expect(cards().locator('.sev')).toHaveText(['Block', 'Fix', 'Ask']);
  await expect(cards().first()).toContainText('Also raised by 1 more');
  await expect(panel.getByRole('button', { name: 'Not shown to the reviewer' })).toHaveAttribute('aria-expanded', 'false');
  const notes = panel.getByRole('button', { name: 'Notes (1)' });
  await expect(notes).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.getByText(NOTE, { exact: true })).toHaveCount(0);
  await notes.click();
  await expect(panel.getByText(NOTE, { exact: true })).toBeVisible();
  await notes.click();
  await expect(notes).toHaveAttribute('aria-expanded', 'false');

  const fold = panel.getByRole('button', { name: 'Also found' });
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.getByText(alsoFound[0]!.title)).toHaveCount(0);
  await fold.click();
  await expect(panel.locator('button.line .title')).toHaveText(alsoFound.map((f) => f.title));
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
});

test('5. the first finding: its fields, and Copy fix prompt puts exactly its prompt on the clipboard', async () => {
  const first = top[0]!;
  await cards().first().getByRole('button').click();
  await expect(panel.getByRole('heading', { name: first.title })).toBeVisible();
  await expect(panel.locator('.sev')).toHaveText('Block');
  await expect(panel.getByText('src/pause.ts:11', { exact: true })).toBeVisible();
  for (const text of [first.happens, first.why, first.suggestedChange, first.checked, first.wouldBeWrongIf, 'Orbit · R-12']) {
    await expect(panel.getByText(text, { exact: true })).toBeVisible();
  }
  await expect(panel.locator('pre.quote code')).toHaveText(first.quote);
  await expect(panel.getByRole('button', { name: /src\/guard\.ts:4/ })).toBeVisible();

  await panel.getByRole('button', { name: 'Copy fix prompt' }).click();
  await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible();
  const copied = await panel.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(fixPrompt(document, [first]));
});

test('6. dismissed as Not now it leaves the list and Dismissed: 1 appears; Restore brings it back', async () => {
  const first = top[0]!;
  await panel.getByRole('button', { name: 'Dismiss' }).click();
  const sheet = panel.getByRole('dialog');
  await sheet.getByRole('radio', { name: 'Not now' }).check();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet.getByText('Hidden on this pull request.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toHaveCount(0);

  await expect(cardTitles()).toHaveText([top[1]!.title, top[2]!.title]);
  const dismissed = panel.getByRole('button', { name: 'Dismissed: 1' });
  await expect(dismissed).toBeVisible();
  expect(bodiesOf('POST', '/dismissals').map((b) => DismissBodySchema.parse(b))).toEqual([
    { repo: REPO, number: NUMBER, reviewId: document.id, findingId: first.id, reason: 'not-now', text: '' },
  ]);

  await dismissed.click();
  await panel.getByRole('button', { name: `Restore ${first.title}` }).click();
  await expect(cardTitles()).toHaveText(top.map((f) => f.title));
  await expect(panel.getByRole('button', { name: /^Dismissed/ })).toHaveCount(0);
  expect(bodiesOf('POST', '/dismissals/restore').map((b) => RestoreBodySchema.parse(b))).toEqual([
    { repo: REPO, number: NUMBER, fingerprint: first.fingerprint },
  ]);
  expect(svc().dismissals(REPO, NUMBER)).toEqual([]);
});

test('7. dismissed as Wrong: Save waits for a valid line, the service gets exactly that line, the sheet says where it went', async () => {
  const second = top[1]!;
  await cards().nth(1).getByRole('button').click();
  await expect(panel.getByRole('heading', { name: second.title })).toBeVisible();
  await panel.getByRole('button', { name: 'Dismiss' }).click();
  const sheet = panel.getByRole('dialog');
  await sheet.getByRole('radio', { name: 'Wrong' }).check();
  const field = sheet.getByRole('textbox', { name: 'The line that will be saved to your pack' });
  const save = sheet.getByRole('button', { name: 'Save' });
  // The draft ends with a space, so it cannot be saved as it is.
  await expect(field).toHaveValue(`Flagged "${second.title}" in ${second.path}. Wrong because: `);
  await expect(save).toBeDisabled();
  await field.fill('Too short');
  await expect(save).toBeDisabled();
  await field.fill(WRONG_LINE);
  await expect(save).toBeEnabled();
  const sent = await field.inputValue();
  await save.click();
  await expect(sheet.getByText('Saved to Orbit.')).toBeVisible();

  const bodies = bodiesOf('POST', '/dismissals').map((b) => DismissBodySchema.parse(b));
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual({ repo: REPO, number: NUMBER, reviewId: document.id, findingId: second.id, reason: 'wrong', text: sent });
  expect(sent).toBe(WRONG_LINE);

  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(cardTitles()).toHaveText([top[0]!.title, top[2]!.title]);
  await expect(panel.getByRole('button', { name: 'Dismissed: 1' })).toBeVisible();
});

test('8. the service stops: the frame says Not running, the offline message shows, the review stays readable', async () => {
  await svc().stop();
  await expect(frameStatus()).toHaveText('Not running', RETRY_WAIT);
  await expect(panel.getByRole('heading', { name: "Airlock's service on this Mac is not running." })).toBeVisible();
  await expect(panel.getByText('npm run service', { exact: true })).toBeVisible();
  await expect(panel.getByText('Shown from before the service stopped.')).toBeVisible();
  await expect(panel.getByRole('heading', { name: verdictWords(document.verdict.label, document.pr.stage) })).toBeVisible();
  await expect(cardTitles()).toHaveText([top[0]!.title, top[2]!.title]);
  await expect(panel.getByRole('button', { name: 'Review again' })).toBeDisabled();
});

test('9. the service starts again: the panel returns to the review by itself, the Wrong dismissal still there', async () => {
  await svc().start();
  await expect(frameStatus()).toHaveText('Connected', RETRY_WAIT);
  await expect(panel.getByText('Shown from before the service stopped.')).toHaveCount(0);
  await expect(panel.getByRole('heading', { name: verdictWords(document.verdict.label, document.pr.stage) })).toBeVisible();
  await expect(cardTitles()).toHaveText([top[0]!.title, top[2]!.title]);
  // The Dismissed fold was left open in step 6, and the review is the same one on screen, so it is still open.
  await expect(panel.getByRole('button', { name: 'Dismissed: 1' })).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByText(top[1]!.title, { exact: true })).toBeVisible();
  await expect(panel.getByText('Wrong', { exact: true })).toBeVisible();
  await expect(panel.getByText(WRONG_LINE, { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: `Restore ${top[1]!.title}` })).toBeEnabled();
  // The review came back from the service: the last thing the panel read was the stored review.
  const latest = svc().requests.filter((r) => r.url.startsWith('/reviews/latest'));
  expect(latest.length).toBeGreaterThan(0);
  expect(LatestReplySchema.shape.dismissals.parse(svc().dismissals(REPO, NUMBER))).toHaveLength(1);
});
