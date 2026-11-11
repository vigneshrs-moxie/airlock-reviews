import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeRunner } from '@airlock/engine';
import type { AgentRequest, ReviewRequest } from '@airlock/engine';
import { ReviewDocumentSchema } from '@airlock/shared';
import type { ReviewDocument } from '@airlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRun, renderReport, runReplay } from '../src/index.js';
import type { CaseEvent, ReplayCase, ReplayDeps, ReplayOptions } from '../src/index.js';
import { doc, finding, problem, replayCase } from './fixtures.js';

const MODEL = 'claude-opus-5-5';
const KIT_SHA = 'c'.repeat(40);
const NOW = new Date('2026-11-10T09:30:05.000Z');

/** Two positive cases and a clean one; the known problems use words that appear nowhere else. */
function cases(): ReplayCase[] {
  return [
    replayCase({
      id: 'pr1', pr: 1, reviewedAt: '2026-10-01T10:00:00Z', baseSha: '1'.repeat(40), headSha: '2'.repeat(40),
      known: [
        problem({ id: 'K1', summary: 'Zebra counters overflow, so the invoice total wraps negative.', comment: 'aardvark: please clamp this' }),
        problem({ id: 'K2', summary: 'The quokka cache is never cleared, so stale prices show.', comment: 'what clears the quokka cache?' }),
      ],
    }),
    replayCase({
      id: 'pr2', pr: 2, reviewedAt: '2026-10-02T10:00:00Z', baseSha: '3'.repeat(40), headSha: '4'.repeat(40),
      known: [problem({ id: 'K3', summary: 'The narwhal job runs twice, so customers get two emails.', comment: 'narwhal double send' })],
    }),
    replayCase({
      id: 'pr3', pr: 3, kind: 'negative', reviewedAt: '2026-10-03T10:00:00Z', baseSha: '5'.repeat(40), headSha: '6'.repeat(40), known: [],
    }),
  ];
}

/** The review a fake pipeline returns for a request: one top finding, f1. */
function reviewFor(req: ReviewRequest): ReviewDocument {
  const base = doc();
  return doc({
    pr: { ...base.pr, repo: req.repo, number: req.number, baseSha: req.explicit!.baseSha, headSha: req.explicit!.headSha },
    findings: [finding('f1', 'top', { severity: 'note' })],
    timings: [{ stage: 'lenses', ms: 1000, agentRuns: 2, inputTokens: 300, outputTokens: 40, costUsd: null }],
  });
}

type FakeReview = NonNullable<ReplayDeps['review']> & { requests: ReviewRequest[] };

function fakeReview(behaviour: (req: ReviewRequest) => Promise<ReviewDocument> | ReviewDocument = reviewFor): FakeReview {
  const requests: ReviewRequest[] = [];
  const review = async (req: ReviewRequest): Promise<ReviewDocument> => {
    requests.push(req);
    return behaviour(req);
  };
  return Object.assign(review, { requests });
}

/** The judge puts K1 in the top list (as f1) and finds nothing for the others. */
const judgeAnswer = () => ({
  matches: [
    { knownId: 'K1', itemId: 'f1', partial: false, reason: 'Same cause.' },
    { knownId: 'K2', itemId: null, partial: false, reason: 'Nothing like it.' },
    { knownId: 'K3', itemId: null, partial: false, reason: 'Nothing like it.' },
  ],
});

const isFor = (req: AgentRequest<unknown>, knownId: string): boolean => req.material.includes(`${knownId} |`);

let outDir: string;
beforeEach(async () => { outDir = await mkdtemp(join(tmpdir(), 'airlock-replay-run-')); });
afterEach(async () => { await rm(outDir, { recursive: true, force: true }); });

function options(over: Partial<ReplayOptions> = {}): ReplayOptions {
  return {
    cases: cases(), model: MODEL, depth: 'standard', outDir, runId: 'run-a',
    packsDir: '/packs/here', kitDir: '/kit/here', kitSha: KIT_SHA, ...over,
  };
}

function deps(review: FakeReview, runner = createFakeRunner(judgeAnswer)): ReplayDeps {
  return { exec: async () => ({ stdout: '', stderr: 'no commands in tests', code: 1 }), runner, now: () => NOW, review };
}

const caseDir = (caseId: string, runId = 'run-a'): string => join(outDir, runId, caseId);
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
const exists = async (path: string): Promise<boolean> => readFile(path).then(() => true, () => false);

function recorder(): { events: CaseEvent[]; onCase: (e: CaseEvent) => void } {
  const events: CaseEvent[] = [];
  return { events, onCase: (e) => events.push(e) };
}

describe('runReplay', () => {
  it('passes the hold-out, the explicit SHAs, the model and the pinned kit for each case, and never packIds', async () => {
    const review = fakeReview();
    await runReplay(options({ model: 'claude-fable-5-2', depth: 'deep' }), deps(review));
    expect(review.requests).toHaveLength(3);
    cases().forEach((c, i) => {
      const req = review.requests[i]!;
      expect(req).toStrictEqual({
        repo: c.repo, number: c.pr, depth: 'deep',
        models: { main: 'claude-fable-5-2', challenger: 'claude-fable-5-2', sweep: 'claude-fable-5-2' },
        explicit: { baseSha: c.baseSha, headSha: c.headSha },
        holdout: { pr: c.pr, reviewedAt: c.reviewedAt },
        packsDir: '/packs/here', kitDir: '/kit/here', kitSha: KIT_SHA,
      });
      expect('packIds' in req).toBe(false);
    });
  });

  it('saves review.json and matches.json per case and summary.json, report.md and run.json for the run', async () => {
    const review = fakeReview();
    const opts = options({ runId: undefined });
    const summary = await runReplay(opts, deps(review));

    const runId = '20261110-093005-claude-opus-5-5-standard';
    expect(summary.runId).toBe(runId);
    const runDir = join(outDir, runId);
    expect((await readdir(runDir)).sort()).toEqual(['pr1', 'pr2', 'pr3', 'report.md', 'run.json', 'summary.json']);

    for (const c of cases()) {
      const saved = ReviewDocumentSchema.parse(await readJson(join(runDir, c.id, 'review.json')));
      expect(saved).toEqual(reviewFor(review.requests.find((r) => r.number === c.pr)!));
      expect((await readdir(join(runDir, c.id))).sort()).toEqual(['matches.json', 'review.json']);
    }
    expect(await readJson(join(runDir, 'pr1', 'matches.json'))).toEqual([
      { knownId: 'K1', where: 'top', itemId: 'f1', partial: false, reason: 'Same cause.' },
      { knownId: 'K2', where: 'none', itemId: null, partial: false, reason: 'Nothing like it.' },
    ]);
    expect(await readJson(join(runDir, 'pr3', 'matches.json'))).toEqual([]);

    expect(await readJson(join(runDir, 'summary.json'))).toEqual(summary);
    expect(summary.cases.map((s) => [s.caseId, s.inTop, s.known, s.verdict])).toEqual([
      ['pr1', 1, 2, 'approve'], ['pr2', 0, 1, 'approve'], ['pr3', 0, 0, 'approve'],
    ]);
    const report = await readFile(join(runDir, 'report.md'), 'utf8');
    expect(report).toBe(renderReport(summary, cases(), Object.fromEntries(await Promise.all(cases().map(async (c) => [
      c.id, { doc: ReviewDocumentSchema.parse(await readJson(join(runDir, c.id, 'review.json'))), matches: await readJson(join(runDir, c.id, 'matches.json')) },
    ])))));
    expect(await readJson(join(runDir, 'run.json'))).toEqual({
      runId, model: MODEL, depth: 'standard', judgeModel: 'claude-opus-5-5', kitSha: KIT_SHA,
      caseIds: ['pr1', 'pr2', 'pr3'], startedAt: NOW.toISOString(),
    });
  });

  it('skips a case that already has a saved review and matches, and scores it from the files', async () => {
    const first = await runReplay(options(), deps(fakeReview()));

    const review = fakeReview(() => { throw new Error('must not review again'); });
    const runner = createFakeRunner(() => new Error('must not judge again'));
    const { events, onCase } = recorder();
    const second = await runReplay(options(), deps(review, runner), onCase);

    expect(review.requests).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
    expect(events.map((e) => [e.caseId, e.status])).toEqual([['pr1', 'skipped'], ['pr2', 'skipped'], ['pr3', 'skipped']]);
    expect(second).toEqual(first);
  });

  it('judges again without reviewing again when only review.json exists', async () => {
    await runReplay(options(), deps(fakeReview()));
    await rm(join(caseDir('pr1'), 'matches.json'));
    await writeFile(join(caseDir('pr2'), 'matches.json'), '{ not json');

    const review = fakeReview(() => { throw new Error('must not review again'); });
    const runner = createFakeRunner(judgeAnswer);
    const { events, onCase } = recorder();
    const summary = await runReplay(options(), deps(review, runner), onCase);

    expect(review.requests).toHaveLength(0);
    expect(runner.calls).toHaveLength(2);
    expect(events.filter((e) => e.caseId !== 'pr3').map((e) => [e.caseId, e.status])).toEqual([
      ['pr1', 'start'], ['pr1', 'judged'], ['pr2', 'start'], ['pr2', 'judged'],
    ]);
    expect(await readJson(join(caseDir('pr1'), 'matches.json'))).toHaveLength(2);
    expect(await readJson(join(caseDir('pr2'), 'matches.json'))).toHaveLength(1);
    expect(summary.cases[0]).toMatchObject({ caseId: 'pr1', inTop: 1, verdict: 'approve' });
  });

  it('a review that throws gives that case an incomplete score with every known problem missed, and the other cases still run', async () => {
    const review = fakeReview((req) => {
      if (req.number === 2) throw new Error('could not fetch pull request 2');
      return reviewFor(req);
    });
    const { events, onCase } = recorder();
    const summary = await runReplay(options(), deps(review), onCase);

    expect(review.requests).toHaveLength(3);
    const failed = summary.cases.find((s) => s.caseId === 'pr2')!;
    expect(failed).toMatchObject({ known: 1, inTop: 0, shown: 0, raised: 0, findingsShown: 0, verdict: 'incomplete' });
    expect(failed.lostAt.lenses).toBe(1);
    expect(summary.incompleteCases).toEqual(['pr2']);
    expect(summary.cases.find((s) => s.caseId === 'pr1')).toMatchObject({ inTop: 1, verdict: 'approve' });

    expect(await readdir(caseDir('pr2'))).toEqual(['error.txt']);
    const error = await readFile(join(caseDir('pr2'), 'error.txt'), 'utf8');
    expect(error).toMatch(/review/i);
    expect(error).toContain('could not fetch pull request 2');
    expect(events.find((e) => e.caseId === 'pr2' && e.status === 'failed')?.message).toContain('could not fetch pull request 2');

    const report = await readFile(join(outDir, 'run-a', 'report.md'), 'utf8');
    expect(report).toContain('## Incomplete reviews');
    expect(report).toContain('could not fetch pull request 2');
  });

  it('a judge that throws gives that case an incomplete score and an error file, and it is judged again on resume', async () => {
    const failing = createFakeRunner((req) => (isFor(req, 'K1') ? new Error('judge overloaded') : judgeAnswer()));
    const { events, onCase } = recorder();
    const summary = await runReplay(options(), deps(fakeReview(), failing), onCase);

    expect(failing.calls.filter((r) => isFor(r, 'K1'))).toHaveLength(2); // the retry ran too
    expect(summary.cases[0]).toMatchObject({ caseId: 'pr1', inTop: 0, raised: 0, findingsShown: 1, verdict: 'incomplete' });
    expect(summary.incompleteCases).toEqual(['pr1']);
    expect((await readdir(caseDir('pr1'))).sort()).toEqual(['error.txt', 'review.json']);
    // The saved review stays the real one.
    expect(ReviewDocumentSchema.parse(await readJson(join(caseDir('pr1'), 'review.json'))).verdict.label).toBe('approve');
    const error = await readFile(join(caseDir('pr1'), 'error.txt'), 'utf8');
    expect(error).toMatch(/judge/i);
    expect(error).toContain('judge overloaded');
    expect(events.filter((e) => e.caseId === 'pr1').map((e) => e.status)).toEqual(['start', 'reviewed', 'failed']);
    expect(await readFile(join(outDir, 'run-a', 'report.md'), 'utf8')).toContain('judge overloaded');

    const review = fakeReview(() => { throw new Error('must not review again'); });
    const working = createFakeRunner(judgeAnswer);
    const resumed = await runReplay(options(), deps(review, working));
    expect(review.requests).toHaveLength(0);
    expect(working.calls).toHaveLength(1);
    expect(resumed.cases[0]).toMatchObject({ caseId: 'pr1', inTop: 1, verdict: 'approve' });
    expect(resumed.incompleteCases).toEqual([]);
    expect((await readdir(caseDir('pr1'))).sort()).toEqual(['matches.json', 'review.json']);
  });

  it('refuses a run folder made with another model, depth or kit version', async () => {
    await runReplay(options(), deps(fakeReview()));
    const review = fakeReview();
    await expect(runReplay(options({ model: 'claude-fable-5-2' }), deps(review))).rejects.toThrow(/model/);
    await expect(runReplay(options({ depth: 'quick' }), deps(review))).rejects.toThrow(/depth/);
    await expect(runReplay(options({ kitSha: 'd'.repeat(40) }), deps(review))).rejects.toThrow(/kit/);
    await expect(runReplay(options({ judgeModel: 'claude-fable-5-2' }), deps(review))).rejects.toThrow(/judge model/);
    expect(review.requests).toHaveLength(0);

    // A folder with case folders but no run.json is refused too.
    await mkdir(join(outDir, 'run-b', 'pr1'), { recursive: true });
    await expect(runReplay(options({ runId: 'run-b' }), deps(review))).rejects.toThrow(/run\.json/);
    // So are run ids and case ids that are not plain folder names.
    for (const runId of ['..', '.', 'a/b', '', 'x'.repeat(101)]) {
      await expect(runReplay(options({ runId }), deps(review))).rejects.toThrow(/run id/);
    }
    await expect(runReplay(options({ runId: 'run-c', cases: [replayCase({ id: '../escape' })] }), deps(review))).rejects.toThrow(/case id/);
    expect(review.requests).toHaveLength(0);
  });

  it('never runs more cases at once than parallelCases', async () => {
    const many = [1, 2, 3, 4, 5].map((n) => replayCase({ id: `pr${n}`, pr: n, known: [] }));
    for (const parallelCases of [undefined, 2]) {
      let active = 0;
      let most = 0;
      const review = fakeReview(async (req) => {
        active++;
        most = Math.max(most, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active--;
        return reviewFor(req);
      });
      const summary = await runReplay(options({ cases: many, runId: `par-${parallelCases ?? 'default'}`, parallelCases }), deps(review));
      expect(most).toBe(parallelCases ?? 1);
      expect(summary.cases.map((s) => s.caseId)).toEqual(['pr1', 'pr2', 'pr3', 'pr4', 'pr5']);
    }
  });

  it('makes no judge request for a case with no known problems', async () => {
    const runner = createFakeRunner(judgeAnswer);
    const summary = await runReplay(options({ cases: [cases()[2]!] }), deps(fakeReview(), runner));
    expect(runner.calls).toHaveLength(0);
    expect(summary.cases).toEqual([expect.objectContaining({ caseId: 'pr3', known: 0, verdict: 'approve' })]);
    expect(await readJson(join(caseDir('pr3'), 'matches.json'))).toEqual([]);
  });

  it('loadRun rebuilds the same summary as the run returned, including a failed case', async () => {
    const review = fakeReview((req) => {
      if (req.number === 2) throw new Error('workspace could not be prepared');
      return reviewFor(req);
    });
    const runner = createFakeRunner((req) => (isFor(req, 'K1') ? new Error('judge overloaded') : judgeAnswer()));
    const summary = await runReplay(options(), deps(review, runner));
    expect(summary.incompleteCases).toEqual(['pr1', 'pr2']);

    const loaded = await loadRun(join(outDir, 'run-a'), cases());
    expect(loaded.summary).toEqual(summary);
    expect(loaded.details.pr2!.doc.verdict.label).toBe('incomplete');
    expect(loaded.details.pr2!.doc.stageErrors).toEqual([{ stage: 'intake', cohortId: null, message: expect.stringContaining('workspace could not be prepared') }]);
    expect(loaded.details.pr2!.matches).toEqual([expect.objectContaining({ knownId: 'K3', where: 'none', itemId: null })]);
    expect(loaded.details.pr1!.matches.map((m) => m.where)).toEqual(['none', 'none']);
    expect(renderReport(loaded.summary, cases(), loaded.details)).toBe(await readFile(join(outDir, 'run-a', 'report.md'), 'utf8'));
  });

  it('nothing from the known problems appears in any review request', async () => {
    const review = fakeReview();
    await runReplay(options(), deps(review));
    expect(review.requests).toHaveLength(3);
    const secrets = cases().flatMap((c) => c.known.flatMap((k) => [k.summary, k.comment]));
    expect(secrets).toHaveLength(6);
    for (const req of review.requests) {
      const text = JSON.stringify(req);
      for (const secret of secrets) expect(text).not.toContain(secret);
      for (const word of ['Zebra', 'aardvark', 'quokka', 'narwhal']) expect(text).not.toContain(word);
    }
  });

  it('the judge runs through a retry: one failed attempt followed by a success is a success', async () => {
    let attempts = 0;
    const runner = createFakeRunner(() => (++attempts === 1 ? new Error('not the expected form') : judgeAnswer()));
    const summary = await runReplay(options({ cases: [cases()[0]!] }), deps(fakeReview(), runner));
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]!.instructions).toContain('not the expected form');
    expect(summary.cases[0]).toMatchObject({ caseId: 'pr1', inTop: 1, verdict: 'approve' });
    expect(await exists(join(caseDir('pr1'), 'error.txt'))).toBe(false);
  });
});
