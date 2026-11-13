import {
  LatestReplySchema, PrSummarySchema, ReviewDocumentSchema, candidate, minimalDocument, type Brief, type ChangeMap, type Finding,
  type LatestReply, type LearnedLine, type PrSummary, type ReviewDocument, type ServiceEvent,
} from '@airlock/shared';
import { chromium, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signal, startFakeService, type FakeService, type RunStep } from './fake-service';

// Every screen of the panel against one fake service, for sizes.spec.ts (every screen at every size) and shots.pics.ts (a
// picture of each). Four pull requests: one not reviewed yet (the start screen), one whose review is running and held
// (the progress screen), one with a stored re-review (the review, a finding, the sheets, the tour), and one the service
// does not know (a problem). Pair and offline are reached by taking the token away and by stopping the service.

export const EXTENSION_ID = 'nbcmjckbkploiemllhkmhegjimgeimoa';
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const BUILT = fileURLToPath(new URL('../.output-e2e/chrome-mv3', import.meta.url));
export const TOKEN = '5'.repeat(64);
const REPO = 'acme/widgets';
const HEAD = '7c0ffee'.padEnd(40, '0');
const EARLIER_HEAD = '1abcdef'.padEnd(40, '0');
export const START = 41;
export const RUNNING = 42;
export const REVIEWED = 43;
export const UNKNOWN = 44;
/** More pull requests like RUNNING, so a picture can show a review this panel started (its number of steps known). */
export const RUNNING_TOO = [45, 46] as const;
const address = (n: number): string => `https://github.com/${REPO}/pull/${n}/files`;
const PAGE = '<!doctype html><title>files</title><p>Files changed.</p>';

/** 141 characters: longer than any line the panel has room for. */
export const LONG_TITLE =
  'Let a person pause a subscription from the account page, keep the plan and the seat while paused, and resume it later without paying again';
/** A place too long for any row. */
export const LONG_PATH = `packages/billing/src/${'subscriptions-and-accounts/'.repeat(3)}pause/limit-of-pauses-per-year.ts`;

const prOf = (number: number, title: string, over: Partial<PrSummary> = {}): PrSummary => PrSummarySchema.parse({
  repo: REPO, number, title, author: 'alice', viewer: 'bob', isOwn: false, stage: 'pr1', baseRef: 'main', headRef: 'feature/pause',
  headSha: HEAD, additions: 612, deletions: 38, changedFiles: 14,
  packs: [{ id: 'orbit', title: 'Orbit' }, { id: 'generic', title: 'Generic' }], suggestedDepth: 'standard', ...over,
});

function finding(n: number, over: Partial<Finding>): Finding {
  const hex = n.toString(16).padStart(2, '0');
  return {
    ...candidate(), id: `c_000000${hex}`, path: `src/billing/pause${n}.ts`, lineHint: 10 + n,
    quote: `if (account.paused) {\n  return guard.allow(account, order);\n}`,
    title: `Finding number ${n}`, anchor: { status: 'in-diff', startLine: 10 + n, endLine: 12 + n, comment: { line: 12 + n, startLine: 10 + n } },
    fingerprint: hex.repeat(8), checked: 'Read the handler and the guard it calls.', bucket: 'top', rank: n, status: 'new',
    source: { pack: 'generic', lens: 'correctness', ruleId: null },
    happens: 'A paused account can still place an order, because the guard is asked only after the account state is written.',
    why: 'A customer who paused expects not to be charged; an order placed while paused bills them anyway.',
    suggestedChange: 'Ask the guard before writing the paused state, and stop the order when it says no.',
    connected: [{ path: 'src/billing/guard.ts', line: 4, role: 'caller', quote: 'export function allow(account, order) {' }],
    wouldBeWrongIf: 'The order page already refuses paused accounts before it reaches this handler.',
    confidence: 'high', ...over,
  };
}

const top: Finding[] = [
  // No short title or gist: an older review's finding, cut to fit.
  finding(1, { severity: 'block', status: 'still-open', title: LONG_TITLE }),
  finding(2, {
    severity: 'fix', status: 'new', path: LONG_PATH, title: 'The pause limit is counted per calendar month rather than per year', short: 'The pause limit resets every month',
    gist: 'The limit on pauses is counted per month, so a person can pause twelve times a year instead of three.',
  }),
  finding(3, {
    severity: 'fix', status: 'still-open', title: 'Resume sets the account back to the default plan instead of the plan it had', short: 'Resume forgets the plan',
    gist: 'Resuming puts the account back on the default plan, not the one it had before the pause.',
  }),
  finding(4, { severity: 'ask', status: 'new', title: 'Is a paused account billed for its seat?', confidence: 'medium' }),
  finding(5, { severity: 'note', status: 'new', title: 'The pause limit is the bare number 3 in two files', short: 'Name the pause limit', gist: 'The number 3 appears in two files with no name.' }),
];
const alsoFound: Finding[] = [
  finding(20, { severity: 'note', bucket: 'also', rank: null, title: 'The pause button has no label for screen readers' }),
  finding(21, { severity: 'ask', bucket: 'also', rank: null, title: 'Should a paused account keep its seat?', short: 'Keep the seat while paused?' }),
  finding(22, { severity: 'fix', bucket: 'also', rank: null, title: 'The resume date is shown in the server time zone' }),
];
const fixed: Finding[] = [
  finding(30, { severity: 'fix', status: 'fixed', bucket: 'also', rank: null, title: 'Pause did not check the account owner', checked: 'The quoted code is gone.' }),
  finding(31, { severity: 'block', status: 'fixed', bucket: 'also', rank: null, title: 'A paused account could still place an order', short: 'Orders went through while paused', checked: 'The guard now runs first.' }),
];

const brief: Brief = {
  whatItDoes: ['Adds a Pause button to the account page.', 'Stops billing while an account is paused.', 'Lets a person resume later.'],
  claims: [
    { text: 'Billing stops while paused.', verdict: 'verified', evidence: 'The billing job skips paused accounts.' },
    { text: 'A paused account keeps its plan.', verdict: 'not-supported', evidence: 'Resume sets the default plan.' },
  ],
  inShort: 'Lets a person pause a subscription from the account page and resume it later.',
};
const map: ChangeMap = {
  cohorts: [
    {
      id: 'g1', title: 'Pausing', summary: 'The pause rule and where it is written.', neighbours: [], inferredLinks: [],
      layers: [
        { id: 'l1', title: 'The rule', kind: 'rules', files: ['src/billing/pause1.ts', LONG_PATH], dependsOn: [], note: '' },
        { id: 'l2', title: 'The write', kind: 'writes', files: ['src/billing/pause2.ts'], dependsOn: ['l1'], note: '' },
      ],
    },
    {
      id: 'g2', title: 'Resuming', summary: 'Bringing an account back.', neighbours: [], inferredLinks: [],
      layers: [{ id: 'l3', title: 'The screen', kind: 'screens', files: ['src/account/ResumeButton.tsx'], dependsOn: [], note: '' }],
    },
  ],
  standalone: ['README.md'],
  links: [],
};

function reviewDocument(): ReviewDocument {
  const base = minimalDocument();
  return ReviewDocumentSchema.parse({
    ...base, id: 'r_0000000043', createdAt: '2026-11-12T10:06:00.000Z', startedAt: '2026-11-12T10:00:35.000Z',
    pr: {
      ...base.pr, repo: REPO, number: REVIEWED, title: LONG_TITLE, author: 'alice', viewer: 'bob', headSha: HEAD,
      url: `https://github.com/${REPO}/pull/${REVIEWED}`, additions: 612, deletions: 38, changedFiles: 14,
    },
    range: { baseSha: EARLIER_HEAD, headSha: HEAD, kind: 'rereview' },
    previous: { reviewId: 'r_00000000aa', headSha: EARLIER_HEAD, covered: 'push' },
    packs: [{ id: 'orbit', version: 'v3', title: 'Orbit' }, { id: 'generic', version: 'v1', title: 'Generic' }],
    files: [
      { path: 'src/billing/pause1.ts', tier: 'read', reason: '' }, { path: LONG_PATH, tier: 'read', reason: '' },
      { path: 'src/billing/pause2.ts', tier: 'read', reason: '' }, { path: 'src/account/ResumeButton.tsx', tier: 'skim', reason: 'A screen.' },
    ],
    map, brief,
    verdict: { label: 'request-changes', sentence: 'One thing still blocks this: a paused account can still order.', counts: { block: 1, fix: 3, ask: 2, note: 2 } },
    findings: [...top, ...alsoFound],
    fixed,
    questions: [{ text: 'Should a paused account keep its seat?', cohortId: 'g1', source: { pack: 'generic', lens: 'product', ruleId: null } }],
    whoseCall: ['Billing decides what a pause costs.', 'Support decides how many pauses a year are allowed.'],
    dropped: [
      { candidate: { ...candidate(), id: 'c_000000d1', title: 'The guard runs after the write', path: 'src/billing/pause1.ts' }, stage: 'merge', reason: 'Same place and cause.', refutation: null, mergedInto: top[0]!.id },
      { candidate: { ...candidate(), id: 'c_000000d2', title: 'Pause is not awaited', path: 'src/billing/pause2.ts' }, stage: 'challenge', reason: 'Every caller awaits it.', refutation: { path: 'src/billing/guard.ts', line: 3, role: 'head', quote: 'await pause(account);' } },
    ],
    notes: ['src/account/copy.ts changed in the push but was only skimmed.'],
    limits: ['The rule file docs/rules.md was left out because it is too long.'],
    timings: [
      { stage: 'intake', ms: 4000, agentRuns: 0, inputTokens: 0, outputTokens: 0, costUsd: null, startedAt: '2026-11-12T10:00:35.000Z', finishedAt: '2026-11-12T10:00:39.000Z' },
      { stage: 'lenses', ms: 280000, agentRuns: 6, inputTokens: 210000, outputTokens: 18000, costUsd: 1.92, startedAt: '2026-11-12T10:00:40.000Z', finishedAt: '2026-11-12T10:05:20.000Z' },
      { stage: 'challenge', ms: 38000, agentRuns: 2, inputTokens: 40000, outputTokens: 3000, costUsd: 0.31, startedAt: '2026-11-12T10:05:20.000Z', finishedAt: '2026-11-12T10:05:58.000Z' },
    ],
  });
}

function reviewed(): LatestReply {
  const document = reviewDocument();
  const posted = top[2]!;
  return LatestReplySchema.parse({
    document,
    dismissals: [{
      fingerprint: alsoFound[0]!.fingerprint, findingId: alsoFound[0]!.id, reviewId: document.id, reason: 'not-now', text: '',
      at: '2026-11-12T10:20:00.000Z', learned: null,
    }],
    posts: [{
      id: 'post_00000000abcd', repo: REPO, number: REVIEWED, reviewId: document.id, headSha: HEAD, postedAt: '2026-11-12T10:30:00.000Z',
      outcome: 'posted', githubReviewId: 9001, url: `https://github.com/${REPO}/pull/${REVIEWED}#pullrequestreview-9001`,
      items: [{ fingerprint: posted.fingerprint, aliases: [], placement: 'inline' }],
    }],
  });
}

const stage = (name: string, status: 'start' | 'done', detail = ''): RunStep => ({ event: { type: 'stage', stage: name, status, detail } satisfies ServiceEvent });

const LEARNED: LearnedLine[] = [
  { pack: 'generic', packTitle: 'Generic', kind: 'wrong', date: '2026-11-03', repo: REPO, text: 'A paused account skips the guard by design.', key: '0000000000000003', appliesHere: true, removable: true },
  { pack: 'orbit', packTitle: 'Orbit', kind: 'product-knowledge', date: '2026-11-02', repo: null, text: 'Orders under a cent are rounded up on purpose.', key: '0000000000000002', appliesHere: true, removable: true },
];

export const SIZES = ['Small', 'Default', 'Large', 'Largest'] as const;
export type SizeName = typeof SIZES[number];
const ZOOM: Record<SizeName, string> = { Small: '0.9', Default: '1', Large: '1.15', Largest: '1.3' };

/** One browser with the built extension, a GitHub tab and the side panel as a page of its own, against the fake service. */
export class Screens {
  service!: FakeService;
  context!: BrowserContext;
  worker!: Worker;
  github!: Page;
  panel!: Page;
  private profile: string | undefined;
  /** Holds the running review at its lenses for as long as the browser lives. */
  private readonly held = signal();

  async open(width: number, height: number): Promise<void> {
    const script: RunStep[] = [
      stage('intake', 'start'), stage('intake', 'done'), stage('packs', 'start'), stage('packs', 'done'),
      stage('shape', 'start'), stage('shape', 'done', 'skipped: not a sync merge'), stage('facts', 'start'), stage('facts', 'done'),
      stage('map', 'start'), { event: { type: 'map', map } }, stage('map', 'done'),
      stage('brief', 'start'), { event: { type: 'brief', brief } }, stage('brief', 'done'),
      stage('lenses', 'start'),
      { until: this.held.promise },
    ];
    this.service = await startFakeService({
      token: TOKEN, learned: LEARNED,
      pulls: [
        { pr: prOf(START, LONG_TITLE) },
        ...[RUNNING, ...RUNNING_TOO].map((n) => ({ pr: prOf(n, 'Let a person pause a subscription', { additions: 120, deletions: 4, changedFiles: 3 }), script })),
        { pr: prOf(REVIEWED, LONG_TITLE), latest: reviewed() },
      ],
    });
    this.profile = await mkdtemp(join(tmpdir(), 'airlock-e2e-'));
    this.context = await chromium.launchPersistentContext(this.profile, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${BUILT}`, `--load-extension=${BUILT}`],
    });
    this.worker = this.context.serviceWorkers()[0] ?? await this.context.waitForEvent('serviceworker');
    await this.context.route(/^https:\/\/github\.com\/acme\/widgets\/pull\/\d+\/files$/, (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
    this.github = await this.context.newPage();
    await this.github.goto(address(START));
    this.panel = await this.context.newPage();
    await this.panel.setViewportSize({ width, height });
    await this.panel.goto(`${ORIGIN}/sidepanel.html`);
    await this.panel.evaluate(async (token) => {
      const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
      // Paired, and the tour seen: the tour is shown on purpose, from Settings.
      await chrome.storage.local.set({ 'airlock.token': token, 'airlock.tourSeen': true });
    }, TOKEN);
    await this.activate(START);
    await this.panel.reload();
    await expect(this.button('Review this pull request')).toBeVisible();
  }

  async close(): Promise<void> {
    this.held.open();
    await this.context?.close();
    await this.service?.close();
    if (this.profile !== undefined) await rm(this.profile, { recursive: true, force: true });
  }

  button(name: string) {
    return this.panel.getByRole('button', { name, exact: true });
  }

  private async activate(n: number): Promise<void> {
    await this.github.bringToFront();
    await this.worker.evaluate(async (at) => {
      const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
      const [tab] = await chrome.tabs.query({ url: at });
      if (tab?.id === undefined) throw new Error(`no tab at ${at}`);
      await chrome.tabs.update(tab.id, { active: true });
    }, address(n));
  }

  /** The GitHub tab goes to this pull request, and the panel follows it. */
  async goTo(n: number): Promise<void> {
    await this.github.goto(address(n));
    await this.activate(n);
  }

  async start(): Promise<void> {
    await this.goTo(START);
    await expect(this.panel.getByRole('heading', { name: LONG_TITLE })).toBeVisible();
  }

  /**
   * The progress screen: the review of RUNNING (or another like it) is started the first time, and stays held at its
   * lenses. Started here, the panel knows its depth and so its number of steps; come back to, it counts only the steps seen.
   */
  async progress(n: number = RUNNING): Promise<void> {
    await this.goTo(n);
    const reviewing = this.panel.getByRole('heading', { name: 'Reviewing' });
    const go = this.button('Review this pull request');
    await expect(reviewing.or(go)).toBeVisible();
    if (await go.isVisible()) await go.click();
    await expect(reviewing).toBeVisible();
    await expect(this.panel.getByRole('progressbar', { name: 'Progress' })).toHaveAttribute('aria-valuetext', /^Step 7( of 15)?$/);
  }

  async review(): Promise<void> {
    await this.goTo(REVIEWED);
    await expect(this.panel.getByRole('heading', { name: 'Request changes' })).toBeVisible();
  }

  async problem(): Promise<void> {
    await this.goTo(UNKNOWN);
    await expect(this.button('Retry')).toBeVisible();
  }

  /** The Pair screen: the token taken out of the panel's storage. */
  async unpair(): Promise<void> {
    await this.panel.evaluate(async () => {
      const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
      await chrome.storage.local.remove('airlock.token');
    });
    await this.panel.reload();
    await expect(this.panel.getByRole('heading', { name: 'Pair this panel with Airlock' })).toBeVisible();
  }

  /** Paired again, by typing the token in the Pair screen. */
  async pair(): Promise<void> {
    await this.panel.getByLabel('Pairing token').fill(TOKEN);
    await this.button('Pair').click();
    await expect(this.panel.getByRole('heading', { name: 'Pair this panel with Airlock' })).toHaveCount(0);
  }

  async offline(): Promise<void> {
    await this.service.stop();
    await expect(this.panel.getByRole('heading', { name: "Airlock's service on this Mac is not running." })).toBeVisible({ timeout: 25_000 });
  }

  async online(): Promise<void> {
    await this.service.start();
    await expect(this.panel.getByRole('heading', { name: "Airlock's service on this Mac is not running." })).toHaveCount(0, { timeout: 25_000 });
  }

  /** The text and button size, chosen in Settings as a person would; back to the screen it was opened from. */
  async size(size: SizeName): Promise<void> {
    await this.button('Settings').click();
    const choice = this.panel.getByRole('radiogroup', { name: 'Text and button size' }).getByRole('radio', { name: size, exact: true });
    await choice.check();
    await expect.poll(() => this.panel.evaluate(() => document.documentElement.style.zoom)).toBe(ZOOM[size]);
    await this.button('Back').click();
    await expect(this.panel.getByRole('heading', { name: 'Settings', level: 2 })).toHaveCount(0);
  }

  tab(name: 'Findings' | 'The change' | 'More') {
    return this.panel.getByRole('tab', { name: name === 'Findings' ? /^Findings · / : name });
  }

  /** Opens every closed fold on screen (outside a sheet), in order, until none is left closed. */
  async openFolds(): Promise<void> {
    for (let i = 0; i < 30; i += 1) {
      const closed = this.panel.locator('button[aria-expanded="false"]:is(.ap-fold, .ap-set)').first();
      if (await closed.count() === 0) return;
      await closed.click();
    }
  }

  /** A finding opened from its row on the Findings tab. */
  async finding(index = 0): Promise<void> {
    await this.tab('Findings').click();
    await this.panel.locator('.finding-card button.ap-row').nth(index).click();
    await expect(this.button('Back to the review')).toBeVisible();
  }
}
