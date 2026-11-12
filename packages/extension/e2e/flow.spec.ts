import {
  DismissBodySchema, ForgetPostBodySchema, LatestReplySchema, PostBodySchema, PostPreviewBodySchema, PrSummarySchema, RemoveLearnedBodySchema, RestoreBodySchema,
  ReviewDocumentSchema, StartReviewBodySchema, candidate, commentBody, fixPrompt, minimalDocument, verdictWords,
  type Brief, type ChangeMap, type Finding, type LatestReply, type LearnedLine, type PrSummary, type ReviewDocument, type ServiceEvent,
} from '@airlock/shared';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kitUnavailable, signal, startFakeService, type FakeService, type RecordedRequest, type RunStep } from './fake-service';
import { clickNode, insideNotes, otherPages, type OtherPage } from './note-dom';
import { E2E_PORT } from './port';

// The whole flow a person goes through, in the built extension beside the classic Files changed fixture, against the
// fake service: pair, Ready, a running review whose brief arrives early, the verdict and its notes on the Files changed
// page, a finding, the fix prompt, dismiss and restore, the service stopping and coming back, the notes setting and
// Open in Airlock on a note, and posting: a preview, an edit, the post and its mark, a refusal, a post whose outcome is
// not known and the ways it is settled, a push and its re-review, the learned lines on Packs, merge reviews, a preview
// that expired, and a Chrome extension repository whose review kit cannot be had and whose own pack's lines can be
// removed. Each step is its own test; they share one browser and run in order.
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
    // GitHub can hang a comment on its line, so it is posted inline.
    anchor: { status: 'in-diff', startLine: 11, endLine: 11, comment: { line: 11, startLine: null } },
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

const PUSHED_HEAD = 'd'.repeat(40);
const MOVED_FINDING = finding(1, {
  // The same problem, now in another file: a new fingerprint that still answers to the old one, so its Posted mark stays.
  status: 'moved', path: 'src/pause-rules.ts', fingerprint: '9'.repeat(16), aliases: [top[0]!.fingerprint],
  severity: 'block', title: 'Pause skips the guard', happens: 'A paused account can still place an order.',
  why: 'The guard is never asked when the account is paused.', suggestedChange: 'Call the guard before pausing.',
  anchor: { status: 'in-diff', startLine: 11, endLine: 11 },
});
const NEW_FINDING = finding(6, { status: 'new', severity: 'fix', title: 'Pause limit is not saved', path: 'src/limit.ts', rank: 2 });
const FIXED_FINDING = finding(3, {
  status: 'fixed', bucket: 'also', rank: null, checked: 'The quoted code is gone; not checked further.',
});
const PUSH_NOTE = 'src/copy.ts changed in the push but was only skimmed.';
const rereviewDocument = (): ReviewDocument => ReviewDocumentSchema.parse({
  ...document, id: 'r_0123456790', pr: { ...document.pr, headSha: PUSHED_HEAD },
  range: { ...document.range, headSha: PUSHED_HEAD, kind: 'rereview' },
  previous: { reviewId: document.id, headSha: HEAD, covered: 'push' },
  findings: [MOVED_FINDING, NEW_FINDING], fixed: [FIXED_FINDING],
  verdict: { label: 'request-changes', sentence: 'One thing still blocks this.', counts: { block: 1, fix: 1, ask: 0, note: 0 } },
  questions: [], notes: [PUSH_NOTE], limits: undefined,
});
const rereviewScript: RunStep[] = [stage('intake', 'start'), PAUSE, stage('intake', 'done', '1 file'), PAUSE, { event: { type: 'done', document: rereviewDocument() } }];

const learnedLine = (n: number, over: Partial<LearnedLine> = {}): LearnedLine => ({
  pack: 'generic', packTitle: 'Generic', kind: 'wrong', date: `2026-11-0${n}`, repo: REPO, text: `Learned line ${n}.`,
  key: String(n).padStart(16, '0'), appliesHere: true, removable: true, ...over,
});
const LEARNED: LearnedLine[] = [
  learnedLine(3, { kind: 'product-knowledge', text: 'Orders under a cent are rounded up on purpose.' }),
  learnedLine(2, { text: 'A paused account skips the guard by design.' }),
  learnedLine(1, { pack: 'orbit', packTitle: 'Orbit', text: '<b>not bold</b>' }),
];

let service: FakeService | undefined;
let profile: string | undefined;
let context: BrowserContext | undefined;
let worker: Worker;
let github: Page;
let panel: Page;

test.beforeAll(async () => {
  service = await startFakeService({ token: TOKEN, unpaired: true, pulls: [{ pr, script }], learned: LEARNED });
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
async function activate(address = FILES_URL): Promise<void> {
  await worker.evaluate(async (address) => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    const [tab] = await chrome.tabs.query({ url: address });
    if (tab?.id === undefined) throw new Error(`no tab at ${address}`);
    await chrome.tabs.update(tab.id, { active: true });
  }, address);
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
/** Airlock's notes on the GitHub page, and one note by its finding's id. */
const noteRows = () => github.locator('tr[data-airlock-note]');
const noteRow = (id: string) => github.locator(`tr[data-airlock-note="${id}"]`);
/** The small lines under the verdict. */
const verdictLines = () => panel.locator('.verdict');

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
  // The notes: each open finding under its line on the Files changed page beside the panel. The fixture has no line 15,
  // so the last one waits for its line.
  await expect(noteRows()).toHaveCount(4);
  for (const f of [...top, alsoFound[0]!]) await expect(noteRow(f.id)).toHaveCount(1);
  await expect(noteRow(alsoFound[1]!.id)).toHaveCount(0);
  await expect(verdictLines().getByText('4 shown, 1 waiting for their lines to load')).toBeVisible();
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
  await expect(panel.locator('.ap-tag')).toHaveText('Block');
  await expect(panel.locator('.ap-where').getByText('src/pause.ts:11', { exact: true })).toBeVisible();
  await expect(panel.locator('.ap-do').getByText(first.suggestedChange, { exact: true })).toBeVisible();
  // The detail is folded: each fold opens with its button.
  for (const name of ['What happens', 'Why it matters', 'The code', 'Also involves', 'How sure is this']) {
    await panel.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  }
  for (const text of [first.happens, first.why, first.checked, first.wouldBeWrongIf, 'Orbit · R-12']) {
    await expect(panel.locator('.ap-folds').getByText(text, { exact: true })).toBeVisible();
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
  await sheet.getByRole('radio', { name: 'Hide it on this pull request only' }).check();
  await sheet.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(sheet.getByText('Hidden on this pull request.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toHaveCount(0);

  await expect(cardTitles()).toHaveText([top[1]!.title, top[2]!.title]);
  // Its note is gone from the page; the others stay.
  await expect(noteRow(first.id)).toHaveCount(0);
  await expect(noteRows()).toHaveCount(3);
  const dismissed = panel.getByRole('button', { name: 'Dismissed: 1' });
  await expect(dismissed).toBeVisible();
  expect(bodiesOf('POST', '/dismissals').map((b) => DismissBodySchema.parse(b))).toEqual([
    { repo: REPO, number: NUMBER, reviewId: document.id, findingId: first.id, reason: 'not-now', text: '' },
  ]);

  await dismissed.click();
  await panel.getByRole('button', { name: `Restore ${first.title}` }).click();
  await expect(cardTitles()).toHaveText(top.map((f) => f.title));
  await expect(panel.getByRole('button', { name: /^Dismissed/ })).toHaveCount(0);
  await expect(noteRow(first.id)).toHaveCount(1);
  await expect(noteRows()).toHaveCount(4);
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
  await sheet.getByRole('radio', { name: 'The finding is mistaken' }).check();
  const field = sheet.getByRole('textbox', { name: 'The line Airlock will remember' });
  const save = sheet.getByRole('button', { name: 'Dismiss', exact: true });
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
  await expect(noteRow(second.id)).toHaveCount(0);
  await expect(verdictLines().getByText('3 shown, 1 waiting for their lines to load')).toBeVisible();
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
  // The notes need no service: they stay with the review on screen.
  await expect(noteRows()).toHaveCount(3);
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

test('10. notes: Show notes in the diff turned off removes them all and on brings them back; Open in Airlock on a note opens its finding', async () => {
  if (context === undefined) throw new Error('no browser');
  const stepStart = svc().requests.length;
  await expect(noteRows()).toHaveCount(3);
  await panel.getByRole('button', { name: 'Packs' }).click();
  const toggle = panel.getByRole('switch', { name: 'Show notes in the diff' });
  await expect(toggle).toBeChecked();
  // The Packs screen's own reads are made before the notes are turned off and on.
  const since = (from: number) => svc().requests.slice(from).map((r) => `${r.method} ${r.url.split('?')[0]}`);
  await expect.poll(() => since(stepStart)).toEqual(expect.arrayContaining(['GET /status', 'GET /learned']));
  const before = svc().requests.length;
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(noteRows()).toHaveCount(0);
  await toggle.click();
  await expect(noteRows()).toHaveCount(3);
  // Notes are private: turning them off and on asked the service nothing. Only the panel's own reads may fall in this
  // window: its check that the service still answers (GET /hello, every five seconds), and its read of the commit the
  // GitHub tab shows (GET /pr, when Chrome reports the tab loaded or moved), which carries no body and names only the
  // repository and the number.
  const own = (r: RecordedRequest): boolean => {
    const [path, query = ''] = r.url.split('?');
    if (r.method === 'GET' && path === '/hello') return true;
    const asked = [...new URLSearchParams(query).entries()];
    return r.method === 'GET' && path === '/pr' && r.body === undefined
      && JSON.stringify(asked) === JSON.stringify([['repo', REPO], ['number', String(NUMBER)]]);
  };
  expect(svc().requests.slice(before).filter((r) => !own(r)).map((r) => `${r.method} ${r.url}`)).toEqual([]);
  await panel.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(verdictLines().getByText('3 shown, 1 waiting for their lines to load')).toBeVisible();

  // The person presses Open in Airlock on the third finding's note: the open panel opens that finding.
  const ctx = context;
  const third = top[2]!;
  const pressNote = async (id: string): Promise<void> => {
    const { seen, cdp } = await insideNotes(ctx, github);
    const note = seen.find((n) => n.id === id);
    if (note === undefined) throw new Error(`no note for ${id}`);
    await clickNode(github, cdp, note.buttonNodeId);
  };
  expect((await insideNotes(ctx, github)).seen.find((n) => n.id === third.id)?.text).toBe(`Ask ${third.title} Open in Airlock`);
  // This test's panel is a tab, so for Chrome the tab's side panel is closed: the worker opens it too, inside the click.
  // Playwright does not list a side panel; it is found and read through the DevTools protocol.
  const sidePanels = (except: Page[]): Promise<OtherPage[]> => otherPages(ctx, github, `${ORIGIN}/sidepanel.html`, except);
  const sidePanel = async (except: Page[]): Promise<OtherPage> => {
    await expect.poll(async () => (await sidePanels(except)).length).toBe(1);
    return (await sidePanels(except))[0]!;
  };
  /** The heading of the finding a panel shows in full, and whether it has the focus. */
  const DETAIL = `(() => { const h = document.querySelector('[data-focus="detail"]'); return h === null ? null : [h.textContent, document.activeElement === h]; })()`;
  const sessionIds = () => worker.evaluate(async () => (globalThis as unknown as { chrome: typeof browser }).chrome.storage.session.get(null));
  await activate();
  await pressNote(third.id);
  await expect(panel.getByRole('heading', { name: third.title })).toBeVisible();
  await expect(panel.locator('[data-focus="detail"]')).toBeFocused();
  // The open panel took the id the worker left at once; the side panel that opened beside it is closed again.
  await expect.poll(sessionIds).toEqual({});
  await (await sidePanel([panel])).close();
  await expect.poll(async () => (await sidePanels([panel])).length).toBe(0);
  await panel.getByRole('button', { name: 'Back to the review' }).click();

  // With no panel open: the worker opens the side panel, which opens the finding from the id the worker left.
  await panel.close();
  await activate();
  const first = top[0]!;
  await pressNote(first.id);
  const opened = await sidePanel([]);
  await expect.poll(() => opened.evaluate(DETAIL), { timeout: 15_000 }).toEqual([first.title, true]);
  await expect.poll(sessionIds).toEqual({});
  await opened.close();
  await expect.poll(async () => (await sidePanels([])).length).toBe(0);

  // The test's own panel again, beside the GitHub tab, for the steps that follow; only one panel runs from here on.
  panel = await ctx.newPage();
  await panel.goto(`${ORIGIN}/sidepanel.html`);
  await activate();
  await panel.reload();
  await expect(cardTitles()).toHaveText([top[0]!.title, top[2]!.title]);
  expect(await sidePanels([panel])).toEqual([]);
  // Notes are private: nothing about them reached the service in this whole step, in an address or a body.
  const sentDuringStep = svc().requests.slice(stepStart).map((r) => `${r.url}\n${JSON.stringify(r.body ?? null)}`);
  expect(sentDuringStep.length).toBeGreaterThan(0);
  for (const words of ['airlock:notes', ...document.findings.map((f) => f.title)]) {
    expect(sentDuringStep.filter((r) => r.includes(words)), words).toEqual([]);
  }
});

const ONLY_COMMENTS = 'Airlock never approves, requests changes or merges.';
const UNKNOWN = 'Airlock could not tell whether GitHub accepted the comments. Look at the pull request before posting again.';
const EDITED = 'Please call the guard before pausing; a paused account can still place an order.';
const SUMMARY = 'Notes from my review of the pause change, for @carol.';
const NAMES_CAROL = 'Names @carol: GitHub notifies them unless the name is inside code.';
const postBodies = () => bodiesOf('POST', '/posts').map((b) => PostBodySchema.parse(b));
const previewBodies = () => bodiesOf('POST', '/posts/preview').map((b) => PostPreviewBodySchema.parse(b));

test('11. Post comment: the preview, an edit, Update preview, then the post; the finding is marked Posted', async () => {
  const first = top[0]!;
  await cards().first().getByRole('button').click();
  await expect(panel.getByRole('heading', { name: first.title })).toBeVisible();
  await panel.getByRole('button', { name: 'Comment on GitHub' }).click();
  const sheet = panel.getByRole('dialog');
  await expect(sheet.getByText(`Posts as alice on ${REPO}#${NUMBER}, as a comment. ${ONLY_COMMENTS} Nothing has been sent yet.`)).toBeVisible();
  await expect(sheet.getByText('On the line', { exact: true })).toBeVisible();
  await expect(sheet.getByText('src/pause.ts, line 11. It shows in Files changed, next to the code.')).toBeVisible();
  const comment = sheet.getByRole('textbox', { name: 'Comment 1' });
  await expect(comment).toHaveValue(commentBody(first));
  await expect(sheet.getByRole('textbox', { name: 'Summary' })).toHaveValue('Review notes from Airlock: 1 comment.');

  await comment.fill(EDITED);
  await expect(sheet.getByRole('button', { name: 'Post comment', exact: true })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Update preview' }).click();
  const post = sheet.getByRole('button', { name: 'Post comment', exact: true });
  await expect(post).toBeEnabled();
  expect(previewBodies()).toEqual([
    { repo: REPO, number: NUMBER, reviewId: document.id, items: [{ fingerprint: first.fingerprint }] },
    { repo: REPO, number: NUMBER, reviewId: document.id, items: [{ fingerprint: first.fingerprint, body: EDITED }] },
  ]);

  await post.click();
  await expect(sheet.getByText('Posted 1 comment.')).toBeVisible();
  const [record] = svc().posts(REPO, NUMBER);
  const link = sheet.getByRole('link', { name: 'Open on GitHub' });
  await expect(link).toHaveAttribute('href', record?.url ?? 'missing');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  // The post named the last preview, and what reached GitHub is that preview: the edited text, on its line, as a comment.
  expect(postBodies()).toEqual([{ previewId: svc().previews[1]?.previewId }]);
  expect(svc().sent).toEqual([{
    repo: REPO, number: NUMBER, event: 'COMMENT', body: 'Review notes from Airlock: 1 comment.',
    comments: [{ path: 'src/pause.ts', line: 11, startLine: null, body: EDITED }],
  }]);
  for (const request of svc().requests.filter((r) => r.url.startsWith('/posts'))) expect(request.headers.origin).toBe(ORIGIN);
  // The post routes carry the token, and only after a hello with a nonce: the panel asked the service to prove it first.
  const log = svc().requests;
  const firstPostRoute = log.findIndex((r) => r.url.startsWith('/posts'));
  expect(log.slice(0, firstPostRoute).some((r) => r.method === 'GET' && r.url.startsWith('/hello?nonce='))).toBe(true);
  for (const request of log.filter((r) => r.url.startsWith('/posts'))) expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);

  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(panel.locator('.mark').getByText('Posted', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Comment on GitHub' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Back to the review' }).click();
  await expect(cards().first()).toContainText('Posted');
});

test('12. Post selected skips the posted finding; GitHub refuses, and every text is kept', async () => {
  const third = top[2]!;
  svc().answerNextPost({ refuse: 'Line 13 is not part of the diff' });
  await panel.getByRole('checkbox', { name: `Select: ${top[0]!.title}`, exact: true }).check();
  await panel.getByRole('checkbox', { name: `Select: ${third.title}`, exact: true }).check();
  await panel.getByRole('button', { name: 'Post selected (1)' }).click();
  const sheet = panel.getByRole('dialog');
  const comment = sheet.getByRole('textbox', { name: 'Comment 1' });
  await expect(comment).toHaveValue(commentBody(third));
  await expect(sheet.getByText('The line is not part of the diff GitHub shows. The comment names the file and line.')).toBeVisible();
  expect(previewBodies().at(-1)).toEqual({ repo: REPO, number: NUMBER, reviewId: document.id, items: [{ fingerprint: third.fingerprint }] });
  // Airlock's own texts only: the service names no one in the drafted comment or the review text.
  expect(svc().previews.at(-1)?.items[0]?.mentions).toEqual([]);
  expect(svc().previews.at(-1)?.reviewBodyMentions).toEqual([]);

  await sheet.getByRole('textbox', { name: 'Summary' }).fill(SUMMARY);
  // Unsent: the summary field says the name it holds.
  await expect(sheet.getByText(NAMES_CAROL)).toHaveCount(1);
  await sheet.getByRole('button', { name: 'Update preview' }).click();
  const post = sheet.getByRole('button', { name: 'Post comment', exact: true });
  await expect(post).toBeEnabled();
  // Sent and previewed: the service's list for the review's own text says it now.
  expect(svc().previews.at(-1)?.reviewBodyMentions).toEqual(['@carol']);
  await expect(sheet.locator('[data-review-body] ~ .notice')).toHaveText(NAMES_CAROL);
  await post.click();
  await expect(sheet.getByRole('alert')).toHaveText('GitHub refused the comments: Line 13 is not part of the diff. Nothing was posted.');
  await expect(sheet.getByRole('textbox', { name: 'Summary' })).toHaveValue(SUMMARY);
  await expect(comment).toHaveValue(commentBody(third));
  await expect(sheet.getByRole('button', { name: 'Update preview' })).toBeEnabled();
  expect(svc().posts(REPO, NUMBER)).toHaveLength(1);
  expect(svc().sent).toHaveLength(2);
});

const FORGET_ASK = 'Forget this record? Only do this after looking at the pull request.';
const CANNOT_ASK = 'Airlock could not ask GitHub whether this review exists, so the record was kept.';
const GITHUB_HAS_IT = 'GitHub has this review: it was posted. Nothing was forgotten.';

test('13. a post whose outcome is not known: the sentence and Open the pull request; It was not posted asks first, GitHub cannot be asked, and the card then forgets it', async () => {
  svc().answerNextPost({ unknown: true });
  const sheet = panel.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Update preview' }).click();
  await expect(sheet.getByText("The review's own text, as it will be posted:")).toBeVisible();
  await expect(sheet.locator('[data-review-body]')).toHaveText(svc().previews.at(-1)?.reviewBody ?? 'missing');
  await sheet.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(sheet.getByRole('alert')).toHaveText(UNKNOWN);
  await expect(sheet.getByRole('link', { name: 'Open the pull request' })).toHaveAttribute('href', `https://github.com/${REPO}/pull/${NUMBER}`);
  const [, unknown] = svc().posts(REPO, NUMBER);
  expect(unknown?.outcome).toBe('unknown');
  // One call to GitHub per press, never a second try.
  expect(svc().sent).toHaveLength(3);
  expect(postBodies()).toHaveLength(3);

  // In the sheet, as on the finding, It was not posted asks first; Keep sends nothing.
  await sheet.getByRole('button', { name: 'It was not posted' }).click();
  await expect(sheet.getByText(FORGET_ASK)).toBeVisible();
  await sheet.getByRole('button', { name: 'Keep' }).click();
  await expect(sheet.getByText(FORGET_ASK)).toHaveCount(0);
  expect(bodiesOf('POST', '/posts/forget')).toEqual([]);
  // Asked and answered, the service asks GitHub first; GitHub cannot be asked, so the record is kept and the sheet says so.
  svc().answerNextForget({ cannotAsk: true });
  await sheet.getByRole('button', { name: 'It was not posted' }).click();
  await sheet.getByRole('button', { name: 'It was not posted' }).click();
  await expect(sheet.getByText(CANNOT_ASK)).toBeVisible();
  expect(svc().posts(REPO, NUMBER).map((r) => r.outcome)).toEqual(['posted', 'unknown']);
  await expect(sheet.getByRole('button', { name: 'It was not posted' })).toBeEnabled();
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);

  // The card says it is not known, and the record can still be forgotten from there, after a second question.
  const card = cards().nth(1);
  await expect(card).toContainText('Not known whether this was posted');
  await expect(card.getByRole('link', { name: 'Open the pull request' })).toHaveAttribute('href', `https://github.com/${REPO}/pull/${NUMBER}`);
  await card.getByRole('button', { name: 'It was not posted' }).click();
  await expect(card.getByText(FORGET_ASK)).toBeVisible();
  await card.getByRole('button', { name: 'It was not posted' }).click();
  await expect(card).not.toContainText('Not known whether this was posted');
  await expect(card).not.toContainText('Posted');
  const asked = { repo: REPO, number: NUMBER, id: unknown?.id };
  expect(bodiesOf('POST', '/posts/forget').map((b) => ForgetPostBodySchema.parse(b))).toEqual([asked, asked]);
  expect(svc().posts(REPO, NUMBER).map((r) => r.outcome)).toEqual(['posted']);
});

test('14. GitHub has the review after all: It was not posted finds it, nothing is forgotten, and the finding is marked Posted', async () => {
  const third = top[2]!;
  svc().answerNextPost({ unknown: true });
  await cards().nth(1).getByRole('button').click();
  await expect(panel.getByRole('heading', { name: third.title })).toBeVisible();
  await panel.getByRole('button', { name: 'Comment on GitHub' }).click();
  const sheet = panel.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(sheet.getByRole('alert')).toHaveText(UNKNOWN);
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);
  expect(svc().sent).toHaveLength(4);

  // From the finding: asked, then the service finds the review on GitHub.
  svc().answerNextForget({ githubHas: true });
  await panel.getByRole('button', { name: 'It was not posted' }).click();
  await panel.getByRole('button', { name: 'It was not posted' }).click();
  await expect(panel.locator('.notice', { hasText: GITHUB_HAS_IT })).toBeVisible();
  await expect(panel.getByText('Not known whether this was posted')).toHaveCount(0);
  await expect(panel.locator('.mark').getByText('Posted', { exact: true })).toBeVisible();
  const [, found] = svc().posts(REPO, NUMBER);
  expect(found?.outcome).toBe('posted');
  await expect(panel.locator('.mark').getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute('href', found?.url ?? 'missing');
  expect(svc().sent).toHaveLength(4);
  await panel.getByRole('button', { name: 'Back to the review' }).click();
  await expect(cards().nth(1)).toContainText('Posted');
});

test('15. a post whose proof gets no answer was never sent: it says so, and the same post goes through once the service answers', async () => {
  const fourth = alsoFound[0]!;
  await panel.getByRole('button', { name: 'Also found' }).click();
  await panel.locator('button.line').filter({ hasText: fourth.title }).click();
  await expect(panel.getByRole('heading', { name: fourth.title })).toBeVisible();
  await panel.getByRole('button', { name: 'Comment on GitHub' }).click();
  const sheet = panel.getByRole('dialog');
  const post = sheet.getByRole('button', { name: 'Post comment', exact: true });
  await expect(post).toBeEnabled();
  // The service stops answering /hello, and the proof of a second ago has run out: the post proves first, and gets no answer.
  svc().hellosDown(true);
  await panel.waitForTimeout(1_200);
  const before = postBodies().length;
  await post.click();
  await expect(sheet.getByRole('alert')).toHaveText('Airlock could not reach its service, so nothing was sent.');
  expect(postBodies()).toHaveLength(before);
  expect(svc().sent).toHaveLength(4);
  // Not a post whose outcome is unknown: no Open the pull request, and the same preview is offered again.
  await expect(sheet.getByRole('link', { name: 'Open the pull request' })).toHaveCount(0);
  svc().hellosDown(false);
  await expect(post).toBeEnabled(RETRY_WAIT);
  await post.click();
  await expect(sheet.getByText('Posted 1 comment.')).toBeVisible();
  expect(postBodies()).toHaveLength(before + 1);
  expect(svc().sent).toHaveLength(5);
  await sheet.getByRole('button', { name: 'Done' }).click();
  await panel.getByRole('button', { name: 'Back to the review' }).click();
});

test('16. GitHub refuses a post and the service cannot clear its record: the records are read again, so It was not posted is offered', async () => {
  const fifth = alsoFound[1]!;
  svc().answerNextPost({ refuseKept: 'Validation Failed' });
  await panel.locator('button.line').filter({ hasText: fifth.title }).click();
  await expect(panel.getByRole('heading', { name: fifth.title })).toBeVisible();
  await panel.getByRole('button', { name: 'Comment on GitHub' }).click();
  const sheet = panel.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(sheet.getByRole('alert')).toHaveText(
    'GitHub refused the comments: Validation Failed. Nothing was posted, but Airlock could not clear its own record: press "It was not posted" before trying again.',
  );
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toHaveCount(0);
  // The record the service kept is on screen without a reload, and can be cleared where the finding is.
  await expect(panel.locator('.ap-onhub').getByText('Not known whether this was posted')).toBeVisible();
  await panel.getByRole('button', { name: 'It was not posted' }).click();
  await panel.getByRole('button', { name: 'It was not posted' }).click();
  await expect(panel.getByText('Not known whether this was posted')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Comment on GitHub' })).toBeEnabled();
  expect(svc().posts(REPO, NUMBER).map((r) => r.outcome)).toEqual(['posted', 'posted', 'posted']);
  expect(svc().sent).toHaveLength(6);
  await panel.getByRole('button', { name: 'Back to the review' }).click();
});

test('17. the post routes refuse a request without the extension Origin, and a preview body over 512 KB', async () => {
  for (const path of ['/posts/preview', '/posts', '/posts/forget', '/learned/remove']) {
    const res = await fetch(`http://127.0.0.1:${E2E_PORT}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Airlock does not accept requests from this page.' });
  }
  // With the Origin, a preview body over 512 KB is refused before it is read as a preview.
  const big = await fetch(`http://127.0.0.1:${E2E_PORT}/posts/preview`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ padding: 'x'.repeat(600 * 1024) }),
  });
  expect(big.status).toBe(413);
  expect(await big.json()).toEqual({ error: 'The request body is too large.' });
});

test('18. a push: the banner, Review the push starts with since last, and the re-review shows what is new, still open, moved and fixed', async () => {
  svc().push(REPO, NUMBER, PUSHED_HEAD, rereviewScript);
  // The person reloads the GitHub tab, not the panel: the panel reads the pull request again by itself.
  await github.reload();
  await expect(panel.getByText('New commits since this review.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Review everything again' })).toBeVisible();
  // A review of an older commit: its lines may have moved, so its notes are not put back on the page, and the panel
  // says nothing about notes.
  await expect(verdictLines().getByText(/ shown/)).toHaveCount(0);
  await expect(noteRows()).toHaveCount(0);
  await panel.getByRole('button', { name: 'Review the push' }).click();
  await expect.poll(() => bodiesOf('POST', '/reviews').length).toBe(2);
  expect(StartReviewBodySchema.parse(bodiesOf('POST', '/reviews').at(-1))).toEqual({ repo: REPO, number: NUMBER, depth: 'standard', since: 'last' });

  const line = `Review of the push ${'b'.repeat(7)} to ${'d'.repeat(7)}`;
  await expect(panel.getByText(line)).toBeVisible();
  await expect(panel.getByText(PUSH_NOTE)).toBeVisible();
  await expect(panel.getByText('New commits since this review.')).toHaveCount(0);
  await expect(cards()).toHaveCount(2);
  // Neither finding's file is on the fixture page: both notes wait for their lines.
  await expect(verdictLines().getByText('0 shown, 2 waiting for their lines to load')).toBeVisible();
  await expect(cards().nth(0).getByTestId('status')).toHaveText('Moved');
  await expect(cards().nth(1).getByTestId('status')).toHaveText('New');
  // The moved finding is the one posted earlier, found again by its alias.
  await expect(cards().nth(0)).toContainText('Posted');
  await expect(cards().nth(1)).not.toContainText('Posted');

  const toggle = panel.getByRole('button', { name: 'Fixed since the last review (1)' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  const fixed = toggle.locator('xpath=ancestor::section[1]');
  await expect(fixed).toContainText(FIXED_FINDING.title);
  await expect(fixed).toContainText('src/pause.ts:13');
  await expect(fixed).toContainText('The quoted code is gone; not checked further.');
  await expect(fixed.getByRole('checkbox')).toHaveCount(0);
  await expect(fixed.getByRole('button')).toHaveCount(1);
  expect(svc().sent).toHaveLength(6);
});

test('19. a post whose connection is cut before any answer: the panel waits, reads the records, and shows Posted when the record appears', async () => {
  // First, straight to the service: when it cannot read its records of the pull request it posts nothing (500).
  const asService = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Origin: ORIGIN };
  const asked = await fetch(`http://127.0.0.1:${E2E_PORT}/posts/preview`, {
    method: 'POST', headers: asService,
    body: JSON.stringify({ repo: REPO, number: NUMBER, reviewId: 'r_0123456790', items: [{ fingerprint: NEW_FINDING.fingerprint }] }),
  });
  expect(asked.status).toBe(200);
  const { previewId } = (await asked.json()) as { previewId: string };
  svc().answerNextPost({ brokenRecords: true });
  const broken = await fetch(`http://127.0.0.1:${E2E_PORT}/posts`, { method: 'POST', headers: asService, body: JSON.stringify({ previewId }) });
  expect(broken.status).toBe(500);
  expect(await broken.json()).toEqual({
    error: 'Airlock could not read its record of what was posted on this pull request, so it will not post. Fix or move that file in the posts folder of the Airlock home.',
  });
  expect(svc().sent).toHaveLength(6);

  svc().answerNextPost({ cut: true, recordAfterMs: 2_000 });
  await cards().nth(1).getByRole('button').click();
  await expect(panel.getByRole('heading', { name: NEW_FINDING.title })).toBeVisible();
  await panel.getByRole('button', { name: 'Comment on GitHub' }).click();
  const sheet = panel.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Post comment', exact: true }).click();
  // Chromium may send the cut post again by itself; that copy finds the preview taken (404), and the panel then checks
  // whether the post already went through instead of waiting to hear. Either way it reads the records.
  await expect(sheet.getByRole('status').filter({
    hasText: /^(Waiting to hear whether GitHub accepted the comments…|Checking whether this post already went through…)$/,
  })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await expect(sheet.getByText('Posted 1 comment.')).toBeVisible(RETRY_WAIT);
  // One press, one review: the panel read the records and sent nothing again.
  expect(svc().sent).toHaveLength(7);
  await sheet.getByRole('button', { name: 'Done' }).click();
  await panel.getByRole('button', { name: 'Back to the review' }).click();
  await expect(cards().nth(1)).toContainText('Posted');
});

test('20. Packs shows the learned lines under their packs; Remove asks, removes and shows the note; a line already gone says so', async () => {
  await panel.getByRole('button', { name: 'Packs' }).click();
  const generic = panel.locator('.packs-screen li').filter({ hasText: 'Generic' });
  const orbit = panel.locator('.packs-screen li').filter({ hasText: 'Orbit' });
  await expect(generic.locator('.learned-line')).toHaveCount(2);
  await expect(generic.locator('.learned-line').nth(0)).toContainText('Product fact');
  await expect(generic.locator('.learned-line').nth(0)).toContainText('Applies to this repository');
  await expect(orbit.locator('.learned-line')).toHaveText(/<b>not bold<\/b>/);
  await expect(panel.locator('.packs-screen b')).toHaveCount(0);

  // A pack the service will not change: the refusal is said under the line, which stays.
  svc().lockPack('orbit');
  await orbit.getByRole('button', { name: 'Remove' }).click();
  await orbit.getByRole('button', { name: 'Remove' }).click();
  await expect(orbit.getByRole('alert')).toHaveText('Airlock will not change the pack "orbit".');
  await expect(orbit.locator('.learned-line')).toHaveCount(1);

  const second = generic.locator('.learned-line').nth(1);
  await second.getByRole('button', { name: 'Remove' }).click();
  await expect(second.getByText('Remove this line? The reviewer stops following it from the next review.')).toBeVisible();
  await second.getByRole('button', { name: 'Remove' }).click();
  await expect(panel.locator('.packs-screen .notice').first()).toHaveText('Removed.');
  await expect(generic.locator('.learned-line')).toHaveCount(1);
  expect(RemoveLearnedBodySchema.parse(bodiesOf('POST', '/learned/remove').at(-1))).toEqual({ repo: REPO, pack: 'generic', kind: 'wrong', key: '0000000000000002' });

  // A line whose file changed by hand between two reads cannot be matched exactly: the note says so, and the line stays.
  svc().unmatchLine('0000000000000003');
  const kept = generic.locator('.learned-line');
  await kept.getByRole('button', { name: 'Remove' }).click();
  await kept.getByRole('button', { name: 'Remove' }).click();
  await expect(panel.locator('.packs-screen .notice').first()).toHaveText('This line could not be matched exactly in the file; edit the file by hand.');
  await expect(generic.locator('.learned-line')).toHaveCount(1);

  // A line edited by hand since the list was read is already gone: the service says so, and the empty state follows.
  svc().learned.splice(svc().learned.findIndex((l) => l.key === '0000000000000003'), 1);
  const last = generic.locator('.learned-line');
  await expect(last.getByRole('button', { name: 'Remove' })).toBeEnabled();
  await last.getByRole('button', { name: 'Remove' }).click();
  await last.getByRole('button', { name: 'Remove' }).click();
  await expect(panel.locator('.packs-screen .notice').first()).toHaveText("That line was no longer in Generic's product-knowledge.md; nothing was removed.");
  await expect(generic.getByText('Nothing learned yet.')).toBeVisible();
  await panel.getByRole('button', { name: 'Back', exact: true }).click();
});

/**
 * A merge pull request, reviewed first or again since an earlier review (`covered`: as a pushed merge, or everything again,
 * with the engine's note), with what the document says was reviewed of the merge.
 */
const EVERYTHING_NOTE = 'The last review did not finish, so everything was reviewed again.';
const MERGE_PULLS: Array<{ number: number; kind: ReviewDocument['mergeReview']; covered?: 'merge' | 'everything' }> = [
  { number: 8, kind: 'by-hand' },
  { number: 9, kind: 'nothing-by-hand' },
  { number: 10, kind: 'not-reviewed' },
  { number: 11, kind: undefined },
  { number: 12, kind: 'by-hand', covered: 'merge' },
  { number: 13, kind: 'nothing-by-hand', covered: 'merge' },
  { number: 14, kind: 'by-hand', covered: 'everything' },
];

function mergePull({ number, kind, covered }: (typeof MERGE_PULLS)[number]): { pr: PrSummary; latest: LatestReply } {
  const merge = PrSummarySchema.parse({ ...pr, number, title: `Merge main into the branch (${number})` });
  const base = minimalDocument();
  const doc = ReviewDocumentSchema.parse({
    ...base, id: `r_00000000${String(number).padStart(2, '0')}`,
    pr: { ...base.pr, repo: REPO, number, title: merge.title, headSha: HEAD, url: `https://github.com/${REPO}/pull/${number}` },
    range: { baseSha: 'e'.repeat(40), headSha: HEAD, kind: 'sync-merge' },
    brief: { whatItDoes: ['This branch only merges its target branch into itself.'], claims: [] },
    ...(kind === undefined ? {} : { mergeReview: kind }),
    ...(covered === undefined ? {} : { previous: { reviewId: 'r_0000000001', headSha: 'f'.repeat(40), covered } }),
    ...(covered === 'everything' ? { notes: [EVERYTHING_NOTE] } : {}),
    ...(kind === 'not-reviewed' ? {
      verdict: { label: 'incomplete', sentence: 'The review did not finish.', counts: { block: 0, fix: 0, ask: 0, note: 0 } },
      stageErrors: [{ stage: 'shape', cohortId: null, message: 'This pull request only merges another branch in. Airlock did not review it: 2 changed files were not looked at.' }],
    } : {}),
  });
  return { pr: merge, latest: { document: doc, dismissals: [], posts: [] } };
}

test('21. a merge review says it reviewed what was changed by hand only when its document says so, and nothing of it when everything was reviewed again', async () => {
  if (context === undefined) throw new Error('no browser');
  const classic = await readFile(join(FIXTURES, 'files-classic.html'), 'utf8');
  for (const one of MERGE_PULLS) {
    svc().addPull(mergePull(one));
    await context.route(`https://github.com/${REPO}/pull/${one.number}/files`, (route) => route.fulfill({ contentType: 'text/html', body: classic }));
  }
  const expected: Record<number, { heading: string; line: string | null }> = {
    8: { heading: 'A merge of main: only what was changed by hand was reviewed', line: null },
    9: { heading: 'A merge of main: git merged it without conflicts and nothing was changed by hand.', line: null },
    10: { heading: 'What this does', line: null },
    11: { heading: 'What this does', line: null },
    12: { heading: 'What this does', line: `Review of the merge pushed since ${'f'.repeat(7)}: only what was changed by hand was reviewed.` },
    13: { heading: 'What this does', line: 'The push only merged another branch in; git merged it without conflicts and nothing was changed by hand.' },
    // A pull request of only a merge reviewed again in full: its note is the only line, and no merge sentence.
    14: { heading: 'What this does', line: EVERYTHING_NOTE },
  };
  for (const { number } of MERGE_PULLS) {
    await github.goto(`https://github.com/${REPO}/pull/${number}/files`);
    await activate(`https://github.com/${REPO}/pull/${number}/files`);
    const want = expected[number]!;
    await expect(panel.getByRole('heading', { name: want.heading })).toBeVisible();
    const sentences = panel.locator('main').getByText(/changed by hand/);
    if (want.line !== null) await expect(panel.getByText(want.line, { exact: true })).toBeVisible();
    const count = (want.heading.includes('by hand') ? 1 : 0) + (want.line?.includes('by hand') === true ? 1 : 0);
    await expect(sentences).toHaveCount(count);
  }
});

test('22. a post the browser sent twice: the copy the panel hears is told the preview expired, so the panel waits and shows Posted when the first copy\'s record appears', async () => {
  if (context === undefined) throw new Error('no browser');
  const number = 15;
  const address = `https://github.com/${REPO}/pull/${number}/files`;
  const twice = PrSummarySchema.parse({ ...pr, number, title: 'Let a person resume a subscription' });
  const doc = ReviewDocumentSchema.parse({
    ...document, id: 'r_0000000015', pr: { ...document.pr, number, title: twice.title, url: `https://github.com/${REPO}/pull/${number}` },
    verdict: { label: 'request-changes', sentence: 'One thing blocks this.', counts: { block: 1, fix: 0, ask: 0, note: 0 } },
    findings: [top[0], top[1]],
  });
  svc().addPull({ pr: twice, latest: { document: doc, dismissals: [], posts: [] } });
  const classic = await readFile(join(FIXTURES, 'files-classic.html'), 'utf8');
  await context.route(address, (route) => route.fulfill({ contentType: 'text/html', body: classic }));
  await github.goto(address);
  await activate(address);
  await expect(cards()).toHaveCount(2);

  svc().answerNextPost({ sentTwice: true, recordAfterMs: 2_000 });
  const before = svc().sent.length;
  await cards().first().getByRole('button').click();
  await expect(panel.getByRole('heading', { name: top[0]!.title })).toBeVisible();
  await panel.getByRole('button', { name: 'Comment on GitHub' }).click();
  const sheet = panel.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(sheet.getByText('Checking whether this post already went through…')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await expect(sheet.getByText('Posted 1 comment.')).toBeVisible(RETRY_WAIT);
  // The 404 the panel heard was never shown: one press, one review, sent by the first copy.
  await expect(sheet.getByText('This preview has expired. Open the preview again.')).toHaveCount(0);
  expect(svc().sent).toHaveLength(before + 1);
  expect(svc().posts(REPO, number)).toHaveLength(1);
  await sheet.getByRole('button', { name: 'Done' }).click();
  await panel.getByRole('button', { name: 'Back to the review' }).click();
  await expect(cards().first()).toContainText('Posted');
});

test('23. a preview that really expired: the panel checks for 20 seconds, finds no record, and says the preview expired', async () => {
  test.setTimeout(90_000);
  const number = 15;
  svc().answerNextPost({ expired: true });
  const before = svc().sent.length;
  await cards().nth(1).getByRole('button').click();
  await expect(panel.getByRole('heading', { name: top[1]!.title })).toBeVisible();
  await panel.getByRole('button', { name: 'Comment on GitHub' }).click();
  const sheet = panel.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(sheet.getByText('Checking whether this post already went through…')).toBeVisible();
  // A first read, then four more five seconds apart: the answer comes after about twenty seconds, not ninety.
  const started = Date.now();
  await expect(sheet.getByText('This preview has expired. Open the preview again.')).toBeVisible({ timeout: 40_000 });
  expect(Date.now() - started).toBeLessThan(40_000);
  await expect(sheet.getByText('Checking whether this post already went through…')).toHaveCount(0);
  expect(svc().sent).toHaveLength(before);
  expect(svc().posts(REPO, number)).toHaveLength(1);
});

const EXT_REPO = 'Moxie-Pest-Control-Phoenix/scheduling-tool-suite';
const EXT_KIT = 'Moxie-Pest-Control-Phoenix/moxie-ext-review-kit';
const EXT_NUMBER = 3;
const EXT_FILES = `https://github.com/${EXT_REPO}/pull/${EXT_NUMBER}/files`;
const NO_KIT = `Airlock could not review this pull request: The review kit could not be fetched from ${EXT_KIT} and none is cached: gh: Not Found (HTTP 404)`;

test('24. an extension repository whose review kit cannot be had: Extensions and Generic are chosen, and the review stops with the sentence that names the kit', async () => {
  if (context === undefined) throw new Error('no browser');
  const ext = PrSummarySchema.parse({
    ...pr, repo: EXT_REPO, number: EXT_NUMBER, title: 'Ask for the tabs permission', stage: 'other',
    packs: [{ id: 'extensions', title: 'Extensions' }, { id: 'generic', title: 'Generic' }],
  });
  svc().addPull({ pr: ext, script: kitUnavailable(EXT_KIT, 'gh: Not Found (HTTP 404)') });
  const classic = await readFile(join(FIXTURES, 'files-classic.html'), 'utf8');
  await context.route(EXT_FILES, (route) => route.fulfill({ contentType: 'text/html', body: classic }));
  await github.goto(EXT_FILES);
  await activate(EXT_FILES);
  await expect(panel.getByRole('heading', { name: ext.title })).toBeVisible();
  await expect(panel.getByRole('switch', { name: 'Extensions' })).toBeChecked();
  await expect(panel.getByRole('switch', { name: 'Generic' })).toBeChecked();
  await expect(panel.getByRole('switch')).toHaveCount(2);

  await panel.getByRole('button', { name: 'Review', exact: true }).click();
  await expect.poll(() => bodiesOf('POST', '/reviews').length).toBe(3);
  expect(StartReviewBodySchema.parse(bodiesOf('POST', '/reviews').at(-1))).toMatchObject({ repo: EXT_REPO, number: EXT_NUMBER });
  // The person reads the service's sentence, naming the kit, with Retry; nothing else stands in for it.
  await expect(panel.getByRole('alert')).toHaveText(NO_KIT);
  await expect(frameStatus()).toHaveText('Problem');
  await expect(panel.getByRole('button', { name: 'Retry' })).toBeVisible();
  expect(svc().runs.at(-1)?.written.at(-1)).toEqual({ type: 'failed', message: NO_KIT });
  // No review came of it, so no note was placed.
  await expect(noteRows()).toHaveCount(0);
});

test('25. Packs on that repository: the Extensions pack\'s learned line has Remove, no pack there is managed by the team, and Remove takes it out', async () => {
  const line = learnedLine(4, { pack: 'extensions', packTitle: 'Extensions', repo: EXT_REPO, text: 'The popup reads the active tab on purpose.' });
  svc().learned.push(line);
  await panel.getByRole('button', { name: 'Packs' }).click();
  const extensions = panel.locator('.packs-screen li').filter({ hasText: 'Extensions' });
  await expect(extensions.locator('.learned-line')).toHaveCount(1);
  await expect(extensions.locator('.learned-line')).toContainText(line.text);
  await expect(panel.getByText('Managed by the team; not edited here.')).toHaveCount(0);
  // The line of Orbit's pack held for another repository is not listed here.
  await expect(panel.getByText('<b>not bold</b>')).toHaveCount(0);
  await extensions.getByRole('button', { name: 'Remove' }).click();
  await extensions.getByRole('button', { name: 'Remove' }).click();
  await expect(panel.locator('.packs-screen .notice').first()).toHaveText('Removed.');
  await expect(extensions.getByText('Nothing learned yet.')).toBeVisible();
  expect(RemoveLearnedBodySchema.parse(bodiesOf('POST', '/learned/remove').at(-1))).toEqual({ repo: EXT_REPO, pack: 'extensions', kind: 'wrong', key: line.key });
  await panel.getByRole('button', { name: 'Back', exact: true }).click();
});
