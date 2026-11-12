import { describe, expect, it } from 'vitest';
import type { ReviewDocument } from '@airlock/shared';
import type { AgentRequest } from '../../src/agent/runner.js';
import { fingerprint } from '../../src/anchor/fingerprint.js';
import { renderReview } from '../../src/render/terminal.js';
import { saveReview } from '../../src/store/store.js';
import type { Exec } from '../../src/util/exec.js';
import { commitFiles } from '../helpers/change-repo.js';
import { rawCandidate } from '../helpers/lens-context.js';
import {
  BASE_FILES, fakeGh, GOOD, HEAD_FILES, RULED, scenarioScript, useReviewHarness, type Scenario,
} from '../helpers/review-scenario.js';

const SLOW = 30_000;
const { scenario, review } = useReviewHarness();

const none = { candidates: [], questions: [] };
const NEW_ONE = rawCandidate({
  severity: 'fix', title: 'A pause is never logged', path: 'src/jobs/pause.ts', quote: 'export function pauseJob(): void { audit(); }', lineHint: 1,
});
/** GOOD's quote, raised by another lens of the same pack. */
const GOOD_AGAIN_BY_NAMING = { ...GOOD, title: 'Same line, another lens' };
const goodPrint = fingerprint({ source: { pack: 'core', lens: 'correctness', ruleId: null }, path: 'src/money.ts', quote: GOOD.quote as string });
const namingPrint = fingerprint({ source: { pack: 'core', lens: 'naming', ruleId: null }, path: 'src/money.ts', quote: GOOD.quote as string });

interface PushScript {
  /** The paths the push changed; the mapper puts them all in the standalone group. */
  paths: string[];
  correctness?: Record<string, unknown>[];
  /** The correctness lens's questions. */
  questions?: string[];
  naming?: Record<string, unknown>[];
  fixedCheck?: (req: AgentRequest<unknown>) => unknown;
}

/** The second review's answers: a map of the push, the given lens candidates, and the given fixed-check answer. */
function pushScript(p: PushScript) {
  return scenarioScript({
    mapper: () => ({ cohorts: [], standalone: p.paths }),
    'lens:core/correctness': () => ({ candidates: p.correctness ?? [], questions: p.questions ?? [] }),
    'lens:core/naming': () => ({ candidates: p.naming ?? [], questions: [] }),
    'sweep:': () => none,
    seams: () => none,
    'challenge:fixed:': p.fixedCheck ?? (() => { throw new Error('no fixed check was expected'); }),
  });
}

/** The first review of the default scenario: GOOD (a fix in src/money.ts) and RULED (a note in src/billing.ts). */
async function firstReview(s?: Scenario) {
  const scenarioUsed = s ?? await scenario();
  const first = await review({ s: scenarioUsed });
  return { s: scenarioUsed, first: first.doc };
}

/** Pushes `files` to the feature branch of the scenario's remote and returns the new head. */
const push = (s: Scenario, files: Record<string, string | null>, msg = 'push'): Promise<string> => commitFiles(s.remote, files, msg);

async function rereview(s: Scenario, since: string, headSha: string, script: ReturnType<typeof pushScript>, depth?: 'quick' | 'standard') {
  return review({
    s, req: { since: { reviewId: since }, ...(depth ? { depth } : {}) }, exec: fakeGh({ baseSha: s.baseSha, headSha }), script,
  });
}

const statuses = (doc: ReviewDocument) => doc.findings.map((f) => [f.title, f.status]);

describe('re-review after a push', () => {
  it('a review without since is unchanged: no previous, no fixed, every status null', async () => {
    const { first } = await firstReview();
    expect(first.previous).toBeUndefined();
    expect(first.fixed).toBeUndefined();
    expect(first.range.kind).toBe('full');
    expect(first.findings.length).toBeGreaterThan(0);
    expect(first.findings.every((f) => f.status === null)).toBe(true);
    expect(first.selfReviewText).not.toMatch(/last review/);
  }, SLOW);

  it('fails before any model call for an unknown review id and for an unchanged head', async () => {
    const { s, first } = await firstReview();
    const unknown = review({ s, req: { since: { reviewId: 'r_00000000ff' } }, script: () => { throw new Error('no call expected'); } });
    await expect(unknown).rejects.toThrow('There is no stored review r_00000000ff of this pull request.');
    const malformed = review({ s, req: { since: { reviewId: '../../etc' } }, script: () => { throw new Error('no call expected'); } });
    await expect(malformed).rejects.toThrow('There is no stored review ../../etc of this pull request.');
    const unchanged = review({ s, req: { since: { reviewId: first.id } }, script: () => { throw new Error('no call expected'); } });
    await expect(unchanged).rejects.toThrow('Nothing was pushed since the last review.');
  }, SLOW);

  it('reviews only the push and says what became of each earlier finding', async () => {
    const { s, first } = await firstReview();
    expect(first.findings.map((f) => f.title).sort()).toEqual([GOOD.title, RULED.title].sort());
    const head = await push(s, {
      'src/money.ts': `// money helpers\n${HEAD_FILES['src/money.ts']}`,
      'src/jobs/pause.ts': 'export function pauseJob(): void { audit(); }\n',
    });
    const { doc, calls } = await rereview(s, first.id, head, pushScript({ paths: ['src/jobs/pause.ts', 'src/money.ts'], correctness: [NEW_ONE] }));

    expect(doc.range).toEqual({ baseSha: s.headSha, headSha: head, kind: 'rereview' });
    expect(doc.previous).toEqual({ reviewId: first.id, headSha: s.headSha, covered: 'push' });
    expect(doc.files.map((f) => f.path).sort()).toEqual(['src/jobs/pause.ts', 'src/money.ts']);
    expect(Object.fromEntries(statuses(doc))).toEqual({
      [GOOD.title as string]: 'moved', [RULED.title as string]: 'still-open', [NEW_ONE.title as string]: 'new',
    });
    const moved = doc.findings.find((f) => f.title === GOOD.title)!;
    expect(moved.anchor).toMatchObject({ startLine: 4, endLine: 4 });
    expect(moved.anchor.comment).toEqual({ line: 4, startLine: null });
    expect(doc.fixed).toEqual([]);
    // Only the new finding was challenged; the carried ones were challenged by the earlier review.
    expect(calls.filter((c) => c.role.startsWith('challenge:')).length).toBe(1);
    expect(doc.stageErrors).toEqual([]);
    expect(doc.selfReviewText).toContain(`Since the last review (${s.headSha.slice(0, 7)}): 1 new, 1 still open, 1 moved, 0 fixed.`);
    for (const word of ['New:', 'Still open:', 'Moved:']) expect(doc.selfReviewText).toContain(word);
  }, SLOW);

  it('a new finding with a carried fingerprint or alias is merged into the carried one', async () => {
    const { s, first } = await firstReview();
    // The earlier review's GOOD already went by the naming lens's fingerprint too, as if the two had been merged then.
    const withAlias: ReviewDocument = {
      ...first, id: 'r_aaaaaaaaaa',
      findings: first.findings.map((f) => (f.title === GOOD.title ? { ...f, aliases: [namingPrint] } : f)),
    };
    await saveReview(withAlias);
    const head = await push(s, { 'src/money.ts': `// money helpers\n${HEAD_FILES['src/money.ts']}` });
    const { doc } = await rereview(s, withAlias.id, head, pushScript({
      paths: ['src/money.ts'], correctness: [GOOD], naming: [GOOD_AGAIN_BY_NAMING],
    }));

    const carried = doc.findings.find((f) => f.title === GOOD.title)!;
    expect(carried.status).toBe('moved');
    expect(doc.findings.filter((f) => f.path === 'src/money.ts')).toHaveLength(1);
    const merged = doc.dropped.filter((d) => d.stage === 'merge');
    expect(merged.map((d) => [d.candidate.title, d.mergedInto])).toEqual([
      [GOOD.title, carried.id], [GOOD_AGAIN_BY_NAMING.title, carried.id],
    ]);
    expect(carried.fingerprint).toBe(goodPrint);
    expect(carried.aliases).toEqual([namingPrint]);
  }, SLOW);

  it('the verdict counts carried open findings and ignores fixed ones', async () => {
    const { s, first } = await firstReview();
    // The earlier review as stored, with RULED a note, so its vanishing needs no request.
    const earlier: ReviewDocument = {
      ...first, id: 'r_bbbbbbbbbb',
      findings: first.findings.map((f) => (f.title === RULED.title ? { ...f, severity: 'note' as const } : f)),
    };
    await saveReview(earlier);
    const head = await push(s, { 'src/billing.ts': BASE_FILES['src/billing.ts']! });
    const { doc, calls } = await rereview(s, earlier.id, head, pushScript({ paths: ['src/billing.ts'] }));

    expect(doc.stageErrors).toEqual([]);
    expect(statuses(doc)).toEqual([[GOOD.title, 'still-open']]);
    expect(doc.fixed!.map((f) => [f.title, f.status, f.checked])).toEqual([
      [RULED.title, 'fixed', 'The quoted code is gone; not checked further.'],
    ]);
    // The vanished note needed no request.
    expect(calls.some((c) => c.role.startsWith('challenge:fixed:'))).toBe(false);
    expect(doc.verdict.counts).toEqual({ block: 0, fix: 1, ask: 0, note: 0 });
    expect(doc.verdict.label).toBe('approve-after-fixes');
    expect(doc.selfReviewText).toContain('Fixed since the last review:');
    const printed = renderReview(doc);
    expect(printed).toContain('Fixed since the last review');
    expect(printed).toContain(RULED.title as string);
    expect(printed).toContain('(Still open)');
  }, SLOW);

  it('the fixed check runs at quick depth', async () => {
    const { s, first } = await firstReview();
    const fixedLine = 'return Math.round(n * 100 + Number.EPSILON).toFixed(2);';
    const head = await push(s, { 'src/money.ts': `export function formatMoney(n: number): string {\n  ${fixedLine}\n}\n` });
    const { doc, calls, events } = await rereview(s, first.id, head, pushScript({
      paths: ['src/money.ts'],
      fixedCheck: () => ({
        outcome: 'fixed', evidence: { path: 'src/money.ts', quote: fixedLine }, explanation: 'It now rounds before formatting.', checked: 'Read both sides.',
      }),
    }), 'quick');

    const fixedCalls = calls.filter((c) => c.role.startsWith('challenge:fixed:'));
    expect(fixedCalls).toHaveLength(1);
    expect(fixedCalls[0]!.model).toBe('claude-opus-5-5');
    expect(doc.fixed!.map((f) => f.title).sort()).toEqual([GOOD.title]);
    expect(doc.fixed![0]!.checked).toBe('It now rounds before formatting. Proof: src/money.ts:2 on the head.');
    expect(doc.findings.find((f) => f.title === GOOD.title)).toBeUndefined();
    expect(events.some((e) => e.type === 'stage' && e.stage === 'challenge' && e.status === 'done' && e.detail === '')).toBe(true);
    expect(doc.stageErrors).toEqual([]);
  }, SLOW);

  it('a failed fixed check leaves the finding open and the review incomplete', async () => {
    const { s, first } = await firstReview();
    const head = await push(s, { 'src/money.ts': 'export function formatMoney(n: number): string {\n  return format(n);\n}\n' });
    const { doc } = await rereview(s, first.id, head, pushScript({
      paths: ['src/money.ts'], fixedCheck: () => ({ outcome: 'fixed', evidence: null, explanation: '', checked: '' }),
    }));
    expect(doc.fixed).toEqual([]);
    const open = doc.findings.find((f) => f.title === GOOD.title)!;
    expect(open.status).toBe('still-open');
    expect(open.anchor.status).toBe('not-found');
    expect(doc.verdict.label).toBe('incomplete');
    expect(doc.stageErrors.map((e) => e.stage)).toEqual(['challenge']);
  }, SLOW);

  it('reviews everything again when the branch was rewritten, says why, and still recognises the earlier findings', async () => {
    const { s, first } = await firstReview();
    await s.remote.git('reset', '--hard', s.baseSha);
    const head = await commitFiles(s.remote, { ...HEAD_FILES, 'src/jobs/pause.ts': 'export function pauseJob(): void { audit(); }\n' }, 'rewritten');
    const { doc } = await rereview(s, first.id, head, pushScript({
      paths: ['CLAUDE.md', 'src/billing.ts', 'src/jobs/pause.ts', 'src/money.ts', 'test/money.test.ts'],
    }));
    expect(doc.range).toEqual({ baseSha: s.baseSha, headSha: head, kind: 'full' });
    expect(doc.previous).toEqual({ reviewId: first.id, headSha: s.headSha, covered: 'everything' });
    expect(doc.notes).toContain(
      `The branch was rewritten since the last review (its earlier head ${s.headSha.slice(0, 7)} is no longer part of it), so the whole pull request was reviewed again.`,
    );
    expect(Object.fromEntries(statuses(doc))).toEqual({ [GOOD.title as string]: 'still-open', [RULED.title as string]: 'still-open' });
  }, SLOW);

  it('reviews everything again when a pushed commit merges the base branch in', async () => {
    const { s, first } = await firstReview();
    await s.remote.git('checkout', 'main');
    await commitFiles(s.remote, { 'README.md': 'main moved on\n' }, 'main');
    await s.remote.git('checkout', 'feature');
    await s.remote.git('merge', '--no-ff', '--no-edit', 'main');
    // A commit after the merge: the push is not only a merge of the base, whose hand-made changes would be reviewed alone.
    const head = await commitFiles(s.remote, { 'src/jobs/pause.ts': 'export function pauseJob(): void { audit(); }\n' }, 'after the merge');
    const { doc } = await rereview(s, first.id, head, pushScript({
      paths: ['CLAUDE.md', 'src/billing.ts', 'src/jobs/pause.ts', 'src/money.ts', 'test/money.test.ts'],
    }));
    expect(doc.range.kind).toBe('full');
    expect(doc.notes).toContain('A commit pushed since the last review merges the base branch main in, so the whole pull request was reviewed again.');
    expect(doc.previous).toEqual({ reviewId: first.id, headSha: s.headSha, covered: 'everything' });
  }, SLOW);

  it('reviews everything again when the last review did not finish, and still carries its findings', async () => {
    const { s, first } = await firstReview();
    const unfinished: ReviewDocument = {
      ...first, id: 'r_cccccccccc',
      verdict: { ...first.verdict, label: 'incomplete', sentence: 'The review did not finish (lenses).' },
      stageErrors: [{ stage: 'lenses', cohortId: null, message: 'the usage limit was reached' }],
    };
    await saveReview(unfinished);
    const head = await push(s, { 'src/jobs/pause.ts': 'export function pauseJob(): void { audit(); }\n' });
    const { doc } = await rereview(s, unfinished.id, head, pushScript({
      paths: ['CLAUDE.md', 'src/billing.ts', 'src/jobs/pause.ts', 'src/money.ts', 'test/money.test.ts'],
    }));
    expect(doc.range).toEqual({ baseSha: s.baseSha, headSha: head, kind: 'full' });
    expect(doc.previous).toEqual({ reviewId: unfinished.id, headSha: s.headSha, covered: 'everything' });
    expect(doc.notes).toContain('The last review did not finish, so everything was reviewed again.');
    expect(Object.fromEntries(statuses(doc))).toEqual({ [GOOD.title as string]: 'still-open', [RULED.title as string]: 'still-open' });
  }, SLOW);

  it('reviews everything again when the pull request was retargeted to another base branch, and still carries its findings', async () => {
    const { s, first } = await firstReview();
    // The earlier review was made when the pull request targeted develop; GitHub now says main.
    const againstDevelop: ReviewDocument = { ...first, id: 'r_dddddddddd', pr: { ...first.pr, baseRef: 'develop' } };
    await saveReview(againstDevelop);
    const head = await push(s, { 'src/jobs/pause.ts': 'export function pauseJob(): void { audit(); }\n' });
    const { doc } = await rereview(s, againstDevelop.id, head, pushScript({
      paths: ['CLAUDE.md', 'src/billing.ts', 'src/jobs/pause.ts', 'src/money.ts', 'test/money.test.ts'],
    }));
    expect(doc.range).toEqual({ baseSha: s.baseSha, headSha: head, kind: 'full' });
    expect(doc.previous).toEqual({ reviewId: againstDevelop.id, headSha: s.headSha, covered: 'everything' });
    expect(doc.notes).toContain('The pull request now targets main; the last review was against develop, so everything was reviewed again.');
    // Reviewed again in full, the pull request's questions and checks are its own, not repeated from the last review.
    expect(doc.notes).not.toContain('Questions and checks from the last review are repeated here.');
    expect(Object.fromEntries(statuses(doc))).toEqual({ [GOOD.title as string]: 'still-open', [RULED.title as string]: 'still-open' });
  }, SLOW);

  it('reviews everything again when the last review covered a range given by hand', async () => {
    const { s, first } = await firstReview();
    const given: ReviewDocument = { ...first, id: 'r_eeeeeeeeee', range: { ...first.range, kind: 'explicit' } };
    await saveReview(given);
    const head = await push(s, { 'src/jobs/pause.ts': 'export function pauseJob(): void { audit(); }\n' });
    const { doc } = await rereview(s, given.id, head, pushScript({
      paths: ['CLAUDE.md', 'src/billing.ts', 'src/jobs/pause.ts', 'src/money.ts', 'test/money.test.ts'],
    }));
    expect(doc.range).toEqual({ baseSha: s.baseSha, headSha: head, kind: 'full' });
    expect(doc.notes).toContain('The last review covered a range given by hand, so everything was reviewed again.');
    expect(doc.previous?.covered).toBe('everything');
    expect(Object.fromEntries(statuses(doc))).toEqual({ [GOOD.title as string]: 'still-open', [RULED.title as string]: 'still-open' });
  }, SLOW);

  it('a push re-review gives the requests the base branch\'s rule files, never the ones the pull request\'s own earlier commit wrote', async () => {
    // The pull request's first commit changed CLAUDE.md (HEAD_RULES_MARKER); the base branch has BASE_RULES_MARKER.
    const { s, first } = await firstReview();
    const head = await push(s, { 'src/jobs/pause.ts': 'export function pauseJob(): void { audit(); }\n' });
    const { doc, calls } = await rereview(s, first.id, head, pushScript({ paths: ['src/jobs/pause.ts'], correctness: [NEW_ONE] }));
    expect(doc.range.kind).toBe('rereview');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(`${c.instructions}\n${c.material}`).not.toContain('HEAD_RULES_MARKER');
    const ruled = calls.filter((c) => c.material.includes('<material label="repository rule file CLAUDE.md"'));
    expect(ruled.map((c) => c.role)).toEqual(expect.arrayContaining(['lens:core/correctness', `challenge:${doc.findings.find((f) => f.title === NEW_ONE.title)!.id}`]));
    for (const c of ruled) expect(c.material).toContain('Base rules BASE_RULES_MARKER');
  }, SLOW);

  it('a push re-review whose pull request base cannot be found shows no rule files and says so', async () => {
    const { s, first } = await firstReview();
    const head = await push(s, { 'src/jobs/pause.ts': 'export function pauseJob(): void { audit(); }\n' });
    const gh = fakeGh({ baseSha: s.baseSha, headSha: head });
    // The merge base of the pull request cannot be found; ancestry questions still get answers.
    const exec: Exec = async (cmd, args, opts) => (cmd === 'git' && args.includes('merge-base') && !args.includes('--is-ancestor')
      ? { stdout: '', stderr: 'fatal: no merge base', code: 1 }
      : gh(cmd, args, opts));
    const { doc, calls } = await review({
      s, req: { since: { reviewId: first.id } }, exec, script: pushScript({ paths: ['src/jobs/pause.ts'], correctness: [NEW_ONE] }),
    });
    expect(doc.range.kind).toBe('rereview');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.material).not.toContain('<material label="repository rule file');
    expect(doc.limits).toContain('The repository\'s rule files were not shown: Airlock could not find the base of this pull request.');
  }, SLOW);

  it('a push re-review repeats the last review\'s questions, whose-call lines and checks after merge before its own, once each', async () => {
    const { s, first } = await firstReview();
    const earlierQuestions = first.questions.map((q) => q.text);
    expect(earlierQuestions).toEqual(['Is rounding half up intended?', 'Does a refund need a ledger entry?']);
    const stored: ReviewDocument = { ...first, id: 'r_1111111111', checksAfterMerge: ['Run the backfill for plans created before the migration.'] };
    await saveReview(stored);
    const head = await push(s, { 'src/jobs/pause.ts': 'export function pauseJob(): void { audit(); }\n' });
    const { doc } = await rereview(s, stored.id, head, pushScript({
      paths: ['src/jobs/pause.ts'], correctness: [NEW_ONE], questions: ['Is the pause audited?', 'Is rounding half up intended?'],
    }));
    expect(doc.questions.map((q) => q.text)).toEqual([...earlierQuestions, 'Is the pause audited?']);
    // The earlier ones name no group: groups belong to the earlier review's change map.
    expect(doc.questions.slice(0, 2).map((q) => q.cohortId)).toEqual([null, null]);
    // The push's selection says the same whose-call line again: it is listed once.
    expect(doc.whoseCall).toEqual(['Whether refunds may be negative is a product call.']);
    expect(doc.checksAfterMerge).toEqual(['Run the backfill for plans created before the migration.']);
    expect(doc.notes).toContain('Questions and checks from the last review are repeated here.');
  }, SLOW);

  it('continues a stored review whose head was written in upper case, and writes its head in lower case', async () => {
    const { s, first } = await firstReview();
    const upper: ReviewDocument = { ...first, id: 'r_2222222222', pr: { ...first.pr, headSha: first.pr.headSha.toUpperCase() } };
    await saveReview(upper);
    const head = await push(s, { 'src/jobs/pause.ts': 'export function pauseJob(): void { audit(); }\n' });
    const { doc } = await rereview(s, upper.id, head, pushScript({ paths: ['src/jobs/pause.ts'] }));
    expect(doc.previous).toEqual({ reviewId: upper.id, headSha: s.headSha, covered: 'push' });
    expect(doc.range).toEqual({ baseSha: s.headSha, headSha: head, kind: 'rereview' });
  }, SLOW);

  it('a push that changes no files carries the earlier findings and says so, without an empty-diff error', async () => {
    const { s, first } = await firstReview();
    await s.remote.git('commit', '--allow-empty', '-m', 'empty');
    const head = await s.remote.git('rev-parse', 'HEAD');
    const { doc } = await rereview(s, first.id, head, pushScript({ paths: [] }));
    expect(doc.range.kind).toBe('rereview');
    expect(doc.files).toEqual([]);
    expect(doc.stageErrors).toEqual([]);
    expect(doc.notes).toContain('The push changed no files.');
    expect(Object.fromEntries(statuses(doc))).toEqual({ [GOOD.title as string]: 'still-open', [RULED.title as string]: 'still-open' });
    expect(doc.verdict.label).toBe('approve-after-fixes');
  }, SLOW);
});
