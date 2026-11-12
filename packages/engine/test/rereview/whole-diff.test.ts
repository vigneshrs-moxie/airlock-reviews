import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { minimalDocument } from '@airlock/shared';
import type { FileDiff, ReviewDocument } from '@airlock/shared';
import type { AgentRequest } from '../../src/agent/runner.js';
import { anchorQuote } from '../../src/anchor/anchor.js';
import { carryOver } from '../../src/rereview/carry.js';
import type { Exec } from '../../src/util/exec.js';
import { commitFiles, diffOf } from '../helpers/change-repo.js';
import { earlierFinding } from '../helpers/earlier-finding.js';
import { diff, rawCandidate } from '../helpers/lens-context.js';
import { makeTempRepo, type TempRepo } from '../helpers/temp-repo.js';
import { BASE_FILES, fakeGh, HEAD_FILES, RULED, scenarioScript, useReviewHarness, type Scenario } from '../helpers/review-scenario.js';

const SLOW = 30_000;
const { scenario, review } = useReviewHarness();

/** The sentence a push re-review's challenge is told about its base side. */
const BASE_SIDE = 'The base side in the extra directory is this pull request as it was at that review, not the branch it will merge into';

/** A file whose hunk covers new lines `from` to `to` (all added). */
const covering = (path: string, from: number, to: number): FileDiff => diff(path, 0, {
  hunks: [{
    oldStart: 0, oldLines: 0, newStart: from, newLines: to - from + 1, header: `@@ -0,0 +${from},${to - from + 1} @@`,
    lines: Array.from({ length: to - from + 1 }, (_, i) => ({ kind: 'add' as const, oldNo: null, newNo: from + i, text: 'x' })),
  }],
});

describe('anchoring against the whole pull request\'s diff', () => {
  const text = ['a();', 'twice();', 'b();', 'c();', 'd();', 'twice();', 'e();', 'twice();'].join('\n');

  it('prefers a match in the push, then one in the whole diff, then the nearest, and judges status by the whole diff', () => {
    // twice() is on lines 2, 6 and 8. The push covers 8, the whole diff covers 6 and 8.
    expect(anchorQuote(text, 'twice();', 1, covering('f.ts', 8, 8), { file: covering('f.ts', 6, 8) }))
      .toEqual({ status: 'in-diff', startLine: 8, endLine: 8 });
    expect(anchorQuote(text, 'twice();', 1, covering('f.ts', 1, 1), { file: covering('f.ts', 6, 6) }))
      .toEqual({ status: 'in-diff', startLine: 6, endLine: 6 });
    expect(anchorQuote(text, 'twice();', 1, undefined, { file: undefined })).toEqual({ status: 'outside-diff', startLine: 2, endLine: 2 });
    // A match in the push that the whole diff does not show (a line the push restored) is outside the diff.
    expect(anchorQuote(text, 'b();', null, covering('f.ts', 3, 3), { file: covering('f.ts', 1, 1) }))
      .toEqual({ status: 'outside-diff', startLine: 3, endLine: 3 });
    // Without the whole diff nothing changes.
    expect(anchorQuote(text, 'twice();', 1, covering('f.ts', 6, 6))).toEqual({ status: 'in-diff', startLine: 6, endLine: 6 });
  });
});

describe('carryOver with the whole diff', () => {
  const made: TempRepo[] = [];
  afterEach(async () => {
    for (const r of made.splice(0)) await rm(r.dir, { recursive: true, force: true });
  });

  it('a still-open finding is judged again against the whole diff; without it, it keeps its earlier place', async () => {
    const r = await makeTempRepo();
    made.push(r);
    const A = 'export function total(price: number, qty: number) {\n  const total = price * qty;\n  return total;\n}\n';
    const base = await commitFiles(r, { 'src/a.ts': 'export const x = 1;\n' }, 'base');
    const earlierHead = await commitFiles(r, { 'src/a.ts': A }, 'the pull request adds a.ts');
    const head = await commitFiles(r, { 'src/other.ts': 'export const y = 2;\n' }, 'the push');
    const push = await diffOf(r, earlierHead, head);
    const whole = await diffOf(r, base, head);
    const read = (path: string) => readFile(join(r.dir, path), 'utf8').catch(() => null);
    // Stored as outside the diff with no comment line, as a push re-review before this change would have left it.
    const f = earlierFinding({ anchor: { status: 'outside-diff', startLine: 2, endLine: 2, comment: null } });
    const prev: ReviewDocument = { ...minimalDocument(), findings: [f] };

    const judged = await carryOver(prev, push, read, whole);
    expect(judged.open.map((o) => [o.status, o.anchor])).toEqual([
      ['still-open', { status: 'in-diff', startLine: 2, endLine: 2, comment: { line: 2, startLine: null } }],
    ]);
    const kept = await carryOver(prev, push, read);
    expect(kept.open[0]!.anchor).toEqual(f.anchor);
  });
});

/** The pull request adds refund (billing.ts lines 6-9); the push then puts two lines on top of billing.ts and touches pause.ts. */
const PUSHED_BILLING = `// billing\n// see the guide\n${HEAD_FILES['src/billing.ts']}`;
const PUSHED_PAUSE = 'export function pauseJob(): void { audit(); }\n';
const ON_REFUND = rawCandidate({
  severity: 'fix', title: 'A refund can be negative', path: 'src/billing.ts', quote: 'return formatMoney(-total);', lineHint: 10,
});
const ON_PAUSE = rawCandidate({ severity: 'fix', title: 'A pause is not audited', path: 'src/jobs/pause.ts', quote: 'export function pauseJob(): void { audit(); }', lineHint: 1 });
const ON_EXPIRE = rawCandidate({
  severity: 'fix', title: 'Expiry does nothing', path: 'src/jobs/expire.ts', quote: 'export function expireJob(): void {}', lineHint: 1,
});
const none = { candidates: [], questions: [] };

/** A challenger that answers pre-existing for every finding, quoting the finding's own code on the base side. */
const preExisting = (req: AgentRequest<unknown>) => {
  const quote = /Quoted code:\n {4}(.*)\n/.exec(req.material)?.[1] ?? '';
  const path = /Where: ([^,\n]+)/.exec(req.material)?.[1] ?? '';
  return {
    outcome: 'drop', ground: 'pre-existing', explanation: 'It was already there.', refutation: { path, quote, where: 'base' },
    newSeverity: null, checked: 'Compared both sides.',
  };
};

function pushScript(correctness: Record<string, unknown>[]) {
  return scenarioScript({
    mapper: () => ({ cohorts: [], standalone: ['src/billing.ts', 'src/jobs/pause.ts'] }),
    'lens:core/correctness': () => ({ candidates: correctness, questions: [] }),
    'lens:core/naming': () => none,
    'sweep:': () => none,
    seams: () => none,
    merge: () => ({ clusters: [] }),
    'challenge:': preExisting,
  });
}

async function firstThenPush(s?: Scenario) {
  const sc = s ?? await scenario();
  const first = (await review({ s: sc })).doc;
  const head = await commitFiles(sc.remote, { 'src/billing.ts': PUSHED_BILLING, 'src/jobs/pause.ts': PUSHED_PAUSE }, 'push');
  return { s: sc, first, head };
}

describe('a push re-review judges its findings against the whole pull request\'s diff', () => {
  it('a carried finding on a line the pull request added earlier is in the diff, with its comment line', async () => {
    const { s, first, head } = await firstThenPush();
    const { doc } = await review({
      s, req: { since: { reviewId: first.id } }, exec: fakeGh({ baseSha: s.baseSha, headSha: head }), script: pushScript([]),
    });
    expect(doc.range.kind).toBe('rereview');
    const ruled = doc.findings.find((f) => f.title === RULED.title)!;
    expect(ruled.status).toBe('moved');
    expect(ruled.anchor).toEqual({ status: 'in-diff', startLine: 10, endLine: 10, comment: { line: 10, startLine: null } });
    expect(doc.notes ?? []).not.toContainEqual(expect.stringMatching(/whole diff/));
  }, SLOW);

  it('a new finding on such a line survives a pre-existing answer from the earlier head; one in neither diff is still dropped', async () => {
    const { s, first, head } = await firstThenPush();
    const { doc, calls } = await review({
      s, req: { since: { reviewId: first.id } }, exec: fakeGh({ baseSha: s.baseSha, headSha: head }),
      script: pushScript([ON_REFUND, ON_PAUSE, ON_EXPIRE]),
    });
    const refund = doc.findings.find((f) => f.title === ON_REFUND.title)!;
    expect(refund).toMatchObject({ status: 'new', anchor: { status: 'in-diff', startLine: 10, endLine: 10, comment: { line: 10, startLine: null } } });
    expect(refund.checked).toMatch(/could not be confirmed in the code/);
    // A new finding on a pushed line is in the diff as before.
    expect(doc.findings.find((f) => f.title === ON_PAUSE.title)!.anchor).toMatchObject({ status: 'in-diff', startLine: 1, comment: { line: 1, startLine: null } });
    // A line in neither diff is already on the base: dropped.
    expect(doc.findings.find((f) => f.title === ON_EXPIRE.title)).toBeUndefined();
    expect(doc.dropped.find((d) => d.candidate.title === ON_EXPIRE.title)).toMatchObject({ stage: 'challenge' });
    // The challenger is told what its base side is on a push re-review.
    const challenges = calls.filter((c) => c.role.startsWith('challenge:'));
    expect(challenges.length).toBeGreaterThan(0);
    for (const c of challenges) expect(c.instructions).toContain(BASE_SIDE);
  }, SLOW);

  it('falls back to the push\'s diff when the whole diff cannot be computed, and says so', async () => {
    const { s, first, head } = await firstThenPush();
    const gh = fakeGh({ baseSha: s.baseSha, headSha: head });
    // The merge base of the pull request cannot be found; ancestry questions still get answers.
    const exec: Exec = async (cmd, args, opts) => (cmd === 'git' && args.includes('merge-base') && !args.includes('--is-ancestor')
      ? { stdout: '', stderr: 'fatal: no merge base', code: 1 }
      : gh(cmd, args, opts));
    const { doc } = await review({ s, req: { since: { reviewId: first.id } }, exec, script: pushScript([]) });
    expect(doc.range.kind).toBe('rereview');
    expect(doc.notes).toContain(
      'Airlock could not work out the pull request\'s whole diff, so which lines GitHub shows was judged from the push alone.',
    );
    const ruled = doc.findings.find((f) => f.title === RULED.title)!;
    expect(ruled.anchor).toEqual({ status: 'outside-diff', startLine: 10, endLine: 10, comment: null });
  }, SLOW);

  it('without the whole diff, no finding is dropped as pre-existing: the refutation is refused and the finding kept', async () => {
    const { s, first, head } = await firstThenPush();
    const gh = fakeGh({ baseSha: s.baseSha, headSha: head });
    const exec: Exec = async (cmd, args, opts) => (cmd === 'git' && args.includes('merge-base') && !args.includes('--is-ancestor')
      ? { stdout: '', stderr: 'fatal: no merge base', code: 1 }
      : gh(cmd, args, opts));
    // The refund lines were added by the pull request before the last review; the push only put two lines above them.
    const { doc } = await review({ s, req: { since: { reviewId: first.id } }, exec, script: pushScript([ON_REFUND, ON_EXPIRE]) });
    expect(doc.notes).toContain(
      'Airlock could not work out the pull request\'s whole diff, so which lines GitHub shows was judged from the push alone.',
    );
    for (const title of [ON_REFUND.title, ON_EXPIRE.title]) {
      const kept = doc.findings.find((f) => f.title === title)!;
      expect(kept).toMatchObject({ status: 'new' });
      expect(kept.checked).toMatch(/could not be confirmed in the code/);
    }
    expect(doc.dropped.filter((d) => d.stage === 'challenge')).toEqual([]);
  }, SLOW);

  it('a first review is unchanged: no base-side sentence, and findings judged by its own diff', async () => {
    const s = await scenario(BASE_FILES, HEAD_FILES);
    const { doc, calls } = await review({ s });
    expect(doc.previous).toBeUndefined();
    for (const c of calls.filter((x) => x.role.startsWith('challenge:'))) expect(c.instructions).not.toContain(BASE_SIDE);
    expect(doc.findings.find((f) => f.title === RULED.title)!.anchor).toMatchObject({ status: 'in-diff', startLine: 8, comment: { line: 8, startLine: null } });
  }, SLOW);
});
