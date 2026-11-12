import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeRunner, withRetry } from '@airlock/engine';
import type { AgentRequest, EngineDeps, ReviewRequest } from '@airlock/engine';
import { ReviewDocumentSchema } from '@airlock/shared';
import type { ReviewDocument } from '@airlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadRun, renderReport, runReplay } from '../src/index.js';
import type { CaseEvent, ReplayCase, ReplayDeps, ReplayOptions, RunSummary } from '../src/index.js';
import { doc, finding, problem, replayCase } from './fixtures.js';

const MODEL = 'claude-opus-5-5';
const KIT_SHA = 'c'.repeat(40);
const NOW = new Date('2026-11-10T09:30:05.000Z');

/** Two positive cases and a clean one; the known problems use words that appear nowhere else. */
function cases(): ReplayCase[] {
  return [
    replayCase({
      id: 'pr1', pr: 1, reviewedAt: '2026-10-01T10:00:00Z', baseSha: '1'.repeat(40), headSha: '2'.repeat(40),
      titleAtReview: 'Totals, first title', bodyAtReview: 'The description of pr1 at review time.',
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
    range: { baseSha: req.explicit!.baseSha, headSha: req.explicit!.headSha, kind: 'explicit' },
    findings: [finding('f1', 'top', { severity: 'note' })],
    timings: [{ stage: 'lenses', ms: 1000, agentRuns: 2, inputTokens: 300, outputTokens: 40, costUsd: null }],
  });
}

type FakeReview = NonNullable<ReplayDeps['review']> & { requests: ReviewRequest[] };

function fakeReview(behaviour: (req: ReviewRequest, engine: EngineDeps) => Promise<ReviewDocument> | ReviewDocument = reviewFor): FakeReview {
  const requests: ReviewRequest[] = [];
  const review = async (req: ReviewRequest, engine: EngineDeps): Promise<ReviewDocument> => {
    requests.push(req);
    return behaviour(req, engine);
  };
  return Object.assign(review, { requests });
}

/** The judge names f1 (in the top list) for K1 and nothing for the others. */
const judgeAnswer = () => ({
  matches: [
    { knownId: 'K1', items: [{ itemId: 'f1', partial: false, reason: 'Same cause.' }], reason: 'Same cause.' },
    { knownId: 'K2', items: [], reason: 'Nothing like it.' },
    { knownId: 'K3', items: [], reason: 'Nothing like it.' },
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

function deps(review: FakeReview, runner: ReplayDeps['runner'] = createFakeRunner(judgeAnswer)): ReplayDeps {
  return { exec: async () => ({ stdout: '', stderr: 'no commands in tests', code: 1 }), runner, now: () => NOW, review };
}

const caseDir = (caseId: string, runId = 'run-a'): string => join(outDir, runId, caseId);
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
const exists = async (path: string): Promise<boolean> => readFile(path).then(() => true, () => false);

/** Every file under `dir` with its bytes, and every folder, by path relative to `dir`. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const path of (await readdir(dir, { recursive: true })).sort()) {
    const full = join(dir, path);
    out[path] = (await stat(full)).isDirectory() ? '(folder)' : (await readFile(full)).toString('base64');
  }
  return out;
}

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
        repo: c.repo, number: c.pr, depth: 'deep', combine: 'never',
        models: { main: 'claude-fable-5-2', challenger: 'claude-fable-5-2', sweep: 'claude-fable-5-2', effort: 'high' },
        explicit: { baseSha: c.baseSha, headSha: c.headSha },
        prText: { title: c.titleAtReview, body: c.bodyAtReview },
        holdout: { pr: c.pr, reviewedAt: c.reviewedAt },
        packsDir: '/packs/here', kitDir: '/kit/here', kitSha: KIT_SHA,
      });
      expect('packIds' in req).toBe(false);
    });
  });

  it('passes the effort, the sweep model and the combine setting to every review and records them in run.json', async () => {
    const review = fakeReview();
    await runReplay(options({ effort: 'medium', sweepModel: 'claude-sonnet-5-5', combine: 'no-read-tier' }), deps(review));
    for (const req of review.requests) {
      expect(req.models).toEqual({ main: MODEL, challenger: MODEL, sweep: 'claude-sonnet-5-5', effort: 'medium' });
      expect(req.combine).toBe('no-read-tier');
    }
    expect(JSON.parse(await readFile(join(outDir, 'run-a', 'run.json'), 'utf8'))).toMatchObject({
      model: MODEL, effort: 'medium', sweepModel: 'claude-sonnet-5-5', combine: 'no-read-tier',
    });
  });

  describe('a run folder made by an earlier version of the replay', () => {
    const REFUSED = 'The run folder run-a was made by an earlier version of the replay: its reviews read today\'s descriptions ' +
      'and its judge saw where each finding was placed. Start a new run with another --run id.';

    /** A run folder as an earlier version left it: run.json without `format` (or with `format`), effort, sweep model or combine. */
    async function earlierFolder(format?: number): Promise<void> {
      await runReplay(options(), deps(fakeReview()));
      const path = join(outDir, 'run-a', 'run.json');
      const { format: _f, effort: _e, sweepModel: _s, combine: _c, ...older } = await readJson(path) as Record<string, unknown>;
      await writeFile(path, JSON.stringify(format === undefined ? older : { ...older, format }));
      // A case with work left to do, so a resume would have touched it.
      await rm(join(caseDir('pr2'), 'matches.json'));
    }

    it('a new run writes format 2 in run.json and is resumed', async () => {
      await runReplay(options(), deps(fakeReview()));
      expect(await readJson(join(outDir, 'run-a', 'run.json'))).toMatchObject({ format: 2 });
      await rm(join(caseDir('pr2'), 'matches.json'));
      const runner = createFakeRunner(judgeAnswer);
      const resumed = await runReplay(options(), deps(fakeReview(), runner));
      expect(runner.calls).toHaveLength(1);
      expect(resumed.incompleteCases).toEqual([]);
      expect(await readJson(join(outDir, 'run-a', 'run.json'))).toMatchObject({ format: 2 });
    });

    for (const format of [undefined, 1]) {
      it(`is refused for a run when run.json has ${format === undefined ? 'no format' : `format ${format}`}, and nothing in it changes`, async () => {
        await earlierFolder(format);
        const before = await snapshot(join(outDir, 'run-a'));
        const review = fakeReview();
        const runner = createFakeRunner(judgeAnswer);
        const { events, onCase } = recorder();
        await expect(runReplay(options(), deps(review, runner), onCase)).rejects.toThrow(REFUSED);
        expect(review.requests).toHaveLength(0);
        expect(runner.calls).toHaveLength(0);
        expect(events).toEqual([]);
        expect(await snapshot(join(outDir, 'run-a'))).toEqual(before);
      });
    }

    it('is read by loadRun with the old defaults, and its report says it is not comparable', async () => {
      await earlierFolder();
      const { summary, details } = await loadRun(join(outDir, 'run-a'), cases());
      expect(summary.madeByEarlierVersion).toBe(true);
      expect(summary.meets.halfInTop).toBe('not comparable');
      expect(details.pr1!.doc.verdict.label).toBe('approve');
      const report = renderReport(summary, cases(), details);
      const first = report.split('\n').find((l) => l.startsWith('1. '))!;
      expect(first).toContain(' were (33%). Not comparable: see How to read this. ');
      expect(report).toContain('The run folder run-a was made by an earlier version of the replay');
    });
  });

  it('every request carries the pull request\'s title and description as they stood at review time', async () => {
    const review = fakeReview();
    await runReplay(options(), deps(review));
    expect(review.requests.find((r) => r.number === 1)!.prText).toEqual({ title: 'Totals, first title', body: 'The description of pr1 at review time.' });
    for (const req of review.requests) {
      const c = cases().find((x) => x.pr === req.number)!;
      expect(req.prText).toEqual({ title: c.titleAtReview, body: c.bodyAtReview });
    }
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
      expect((await readdir(join(runDir, c.id))).sort()).toEqual(['matches.json', 'review.json', 'spent.json']);
    }
    expect(await readJson(join(runDir, 'pr1', 'matches.json'))).toEqual([
      { knownId: 'K1', where: 'top', itemId: 'f1', partial: false, reason: 'Same cause.', others: [] },
      { knownId: 'K2', where: 'none', itemId: null, partial: false, reason: 'Nothing like it.', others: [] },
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
      format: 2, runId, model: MODEL, depth: 'standard', judgeModel: 'claude-opus-5-5', kitSha: KIT_SHA,
      effort: 'high', sweepModel: MODEL, combine: 'never',
      caseIds: ['pr1', 'pr2', 'pr3'], startedAt: NOW.toISOString(),
      spans: [{ startedAt: NOW.toISOString(), finishedAt: NOW.toISOString() }],
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
    // Not judged, so not lost anywhere: the problem still counts as known and as not found.
    expect(Object.values(failed.lostAt).every((n) => n === 0)).toBe(true);
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

    expect(failing.calls.filter((r) => isFor(r, 'K1'))).toHaveLength(1); // deps.runner is used as it is: no second retry
    expect(summary.cases[0]).toMatchObject({ caseId: 'pr1', inTop: 0, raised: 0, findingsShown: 1, verdict: 'incomplete' });
    expect(Object.values(summary.cases[0]!.lostAt).every((n) => n === 0)).toBe(true);
    expect(summary.incompleteCases).toEqual(['pr1']);
    expect((await readdir(caseDir('pr1'))).sort()).toEqual(['error.txt', 'review.json', 'spent.json']);
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
    expect((await readdir(caseDir('pr1'))).sort()).toEqual(['matches.json', 'review.json', 'spent.json']);
  });

  it('refuses a run folder made with another model, depth or kit version', async () => {
    await runReplay(options(), deps(fakeReview()));
    const review = fakeReview();
    await expect(runReplay(options({ model: 'claude-fable-5-2' }), deps(review))).rejects.toThrow(/model/);
    await expect(runReplay(options({ depth: 'quick' }), deps(review))).rejects.toThrow(/depth/);
    await expect(runReplay(options({ kitSha: 'd'.repeat(40) }), deps(review))).rejects.toThrow(/kit/);
    await expect(runReplay(options({ judgeModel: 'claude-fable-5-2' }), deps(review))).rejects.toThrow(/judge model/);
    await expect(runReplay(options({ effort: 'medium' }), deps(review))).rejects.toThrow(/effort high, not medium/);
    await expect(runReplay(options({ sweepModel: 'claude-sonnet-5-5' }), deps(review))).rejects.toThrow(/sweep model/);
    await expect(runReplay(options({ combine: 'no-read-tier' }), deps(review))).rejects.toThrow(/combine never, not no-read-tier/);
    expect(review.requests).toHaveLength(0);

    // A folder with case folders but no run.json is refused too.
    await mkdir(join(outDir, 'run-b', 'pr1'), { recursive: true });
    await expect(runReplay(options({ runId: 'run-b' }), deps(review))).rejects.toThrow(/run\.json/);
    // So are run ids and case ids that are not plain folder names.
    await expect(runReplay(options({ runId: 'home' }), deps(review))).rejects.toThrow(/home.*Airlock's own data/);
    await expect(runReplay(options({ runId: 'Home' }), deps(review))).rejects.toThrow(/Airlock's own data/);
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

  it('loadRun gives a listed case with no folder as unfinished', async () => {
    await runReplay(options(), deps(fakeReview()));
    await rm(caseDir('pr2'), { recursive: true });
    const loaded = await loadRun(join(outDir, 'run-a'), cases());
    expect(loaded.summary.cases.map((s) => [s.caseId, s.verdict])).toEqual([['pr1', 'approve'], ['pr2', 'incomplete'], ['pr3', 'approve']]);
    expect(loaded.summary.incompleteCases).toEqual(['pr2']);
    expect(loaded.details.pr2!.doc.stageErrors).toEqual([{ stage: 'intake', cohortId: null, message: 'This case has not been run.' }]);
  });

  it('nothing from the known problems appears in any review request or in the environment a review runs in', async () => {
    const environments: string[] = [];
    const review = fakeReview((req) => { environments.push(JSON.stringify(process.env)); return reviewFor(req); });
    await runReplay(options(), deps(review));
    expect(review.requests).toHaveLength(3);
    expect(review.requests.every((r) => r.prText !== undefined)).toBe(true);
    const secrets = cases().flatMap((c) => c.known.flatMap((k) => [k.summary, k.comment]));
    expect(secrets).toHaveLength(6);
    for (const text of [...review.requests.map((r) => JSON.stringify(r)), ...environments]) {
      for (const secret of secrets) expect(text).not.toContain(secret);
      for (const word of ['Zebra', 'aardvark', 'quokka', 'narwhal']) expect(text).not.toContain(word);
    }
    const ids = cases().flatMap((c) => c.known.map((k) => k.id));
    for (const req of review.requests) for (const id of ids) expect(JSON.stringify(req)).not.toContain(`"${id}"`);
  });

  it('the judge runs through a retry: one failed attempt followed by a success is a success', async () => {
    let attempts = 0;
    const runner = createFakeRunner(() => (++attempts === 1 ? new Error('not the expected form') : judgeAnswer()));
    const retrying = withRetry(runner, 1);
    const summary = await runReplay(options({ cases: [cases()[0]!] }), { ...deps(fakeReview()), runner: retrying });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]!.material).toContain('not the expected form');
    expect(summary.cases[0]).toMatchObject({ caseId: 'pr1', inTop: 1, verdict: 'approve' });
    expect(await exists(join(caseDir('pr1'), 'error.txt'))).toBe(false);
  });
  it('a resume with a narrower selection keeps the whole run: the other cases are scored from their folders', async () => {
    const first = await runReplay(options(), deps(fakeReview()));
    await rm(join(caseDir('pr2'), 'matches.json'));

    const review = fakeReview(() => { throw new Error('must not review again'); });
    const runner = createFakeRunner(judgeAnswer);
    const { events, onCase } = recorder();
    const second = await runReplay(options({ cases: [cases()[1]!], dataset: cases() }), deps(review, runner), onCase);

    expect(review.requests).toHaveLength(0);
    expect(runner.calls).toHaveLength(1); // pr2 is judged again, and only that
    expect(new Set(events.map((e) => e.caseId))).toEqual(new Set(['pr2']));
    // The same summary, apart from the second call's own span and its judge request, which pr2 spent.
    expect(second.spans).toHaveLength(2);
    expect(second.cases[1]!.judgeTokens).toBe(first.cases[1]!.judgeTokens + 15);
    const withoutSpending = (s: RunSummary) => ({
      ...s, spans: [], totals: { ...s.totals, inputTokens: 0, outputTokens: 0, agentRuns: 0, judgeTokens: 0 },
      cases: s.cases.map((x) => ({ ...x, inputTokens: 0, outputTokens: 0, agentRuns: 0, judgeTokens: 0 })),
    });
    expect(withoutSpending(second)).toEqual(withoutSpending(first));
    expect(await readJson(join(outDir, 'run-a', 'summary.json'))).toEqual(second);
    expect(await readJson(join(outDir, 'run-a', 'run.json'))).toMatchObject({ caseIds: ['pr1', 'pr2', 'pr3'] });
    const loaded = await loadRun(join(outDir, 'run-a'), cases());
    expect(await readFile(join(outDir, 'run-a', 'report.md'), 'utf8')).toBe(renderReport(loaded.summary, cases(), loaded.details));
    expect(loaded.summary).toEqual(second);
  });

  it('a resume that adds a case runs it and keeps the earlier ones, in dataset order', async () => {
    await runReplay(options({ cases: [cases()[0]!, cases()[2]!] }), deps(fakeReview()));
    const review = fakeReview();
    const summary = await runReplay(options({ cases: [cases()[1]!], dataset: cases() }), deps(review));
    expect(review.requests.map((r) => r.number)).toEqual([2]);
    expect(summary.cases.map((s) => [s.caseId, s.verdict])).toEqual([['pr1', 'approve'], ['pr2', 'approve'], ['pr3', 'approve']]);
    expect(await readJson(join(outDir, 'run-a', 'run.json'))).toMatchObject({ caseIds: ['pr1', 'pr2', 'pr3'] });

    // An earlier case that a given dataset no longer has cannot be scored, so the run folder is refused.
    await expect(runReplay(options({ cases: [cases()[1]!], dataset: [cases()[1]!] }), deps(fakeReview()))).rejects.toThrow(/pr1.*not in the dataset/);
  });

  it('a case whose folder cannot be written is unfinished, and the other cases still finish', async () => {
    await mkdir(join(outDir, 'run-a'), { recursive: true });
    await writeFile(join(outDir, 'run-a', 'pr2'), 'a file where the case folder should be');
    const { events, onCase } = recorder();
    const summary = await runReplay(options(), deps(fakeReview()), onCase);
    expect(summary.cases.map((s) => [s.caseId, s.verdict])).toEqual([['pr1', 'approve'], ['pr2', 'incomplete'], ['pr3', 'approve']]);
    expect(summary.incompleteCases).toEqual(['pr2']);
    expect(events.filter((e) => e.caseId === 'pr2').map((e) => e.status)).toEqual(['start', 'failed']);
    // The review never started, so this is a problem with the case's folder, not a failed review.
    expect(events.find((e) => e.caseId === 'pr2' && e.status === 'failed')!.message).toMatch(/^The case folder could not be prepared: /);
    expect(await exists(join(outDir, 'run-a', 'report.md'))).toBe(true);
  });

  it('rejects for a problem with the run folder itself only after every case has settled', async () => {
    await runReplay(options(), deps(fakeReview()));
    await rm(join(outDir, 'run-a', 'report.md'));
    await mkdir(join(outDir, 'run-a', 'report.md')); // the report cannot be written
    await rm(join(caseDir('pr1'), 'matches.json'));
    const runner = createFakeRunner(judgeAnswer);
    await expect(runReplay(options(), deps(fakeReview(), runner))).rejects.toThrow();
    expect(runner.calls).toHaveLength(1);
    expect(await readJson(join(caseDir('pr1'), 'matches.json'))).toHaveLength(2);
  });

  it('a saved review for another pull request or other commits is reviewed again', async () => {
    await runReplay(options(), deps(fakeReview()));
    await writeFile(join(caseDir('pr2'), 'review.json'), await readFile(join(caseDir('pr1'), 'review.json')));
    const pr3 = ReviewDocumentSchema.parse(await readJson(join(caseDir('pr3'), 'review.json')));
    await writeFile(join(caseDir('pr3'), 'review.json'), JSON.stringify({ ...pr3, range: { ...pr3.range, headSha: 'f'.repeat(40) } }));
    const review = fakeReview();
    await runReplay(options(), deps(review));
    expect(review.requests.map((r) => r.number)).toEqual([2, 3]);
  });

  it('a corrupt or schema-invalid review.json is reviewed again', async () => {
    await runReplay(options(), deps(fakeReview()));
    await writeFile(join(caseDir('pr1'), 'review.json'), '{ not json');
    await writeFile(join(caseDir('pr2'), 'review.json'), JSON.stringify({ schemaVersion: 1, id: 'r_0123456789' }));
    const review = fakeReview();
    const summary = await runReplay(options(), deps(review));
    expect(review.requests.map((r) => r.number)).toEqual([1, 2]);
    expect(summary.incompleteCases).toEqual([]);
  });

  it('a document from review that does not match the schema counts as a failed review', async () => {
    const review = fakeReview((req) =>
      req.number === 2 ? ({ ...reviewFor(req), verdict: { label: 'great' } } as unknown as ReviewDocument) : reviewFor(req));
    const summary = await runReplay(options(), deps(review));
    expect(summary.incompleteCases).toEqual(['pr2']);
    expect(await readdir(caseDir('pr2'))).toEqual(['error.txt']);
    expect(await readFile(join(caseDir('pr2'), 'error.txt'), 'utf8')).toMatch(/^The review failed: /);
  });

  it('a matches.json whose known ids do not match the case is judged again', async () => {
    await runReplay(options(), deps(fakeReview()));
    await writeFile(join(caseDir('pr1'), 'matches.json'), JSON.stringify([
      { knownId: 'K9', where: 'none', itemId: null, partial: false, reason: 'x' },
      { knownId: 'K2', where: 'none', itemId: null, partial: false, reason: 'x' },
    ]));
    const review = fakeReview();
    const runner = createFakeRunner(judgeAnswer);
    const summary = await runReplay(options(), deps(review, runner));
    expect(review.requests).toHaveLength(0);
    expect(runner.calls).toHaveLength(1);
    expect(summary.cases[0]).toMatchObject({ caseId: 'pr1', inTop: 1 });
  });

  describe('a case is done only when it really finished', () => {
    const incomplete = (req: ReviewRequest): ReviewDocument => ({
      ...reviewFor(req),
      verdict: { label: 'incomplete', sentence: 'The review did not finish.', counts: { block: 0, fix: 0, ask: 0, note: 1 } },
      stageErrors: [
        { stage: 'lenses', cohortId: 'c1', message: 'The lens failed.' },
        { stage: 'sweep', cohortId: null, message: 'The sweep failed.' },
        { stage: 'lenses', cohortId: 'c2', message: 'The lens failed.' },
      ],
    });

    it('a review that comes back incomplete is saved but not judged, and the case is unfinished', async () => {
      const runner = createFakeRunner(judgeAnswer);
      const { events, onCase } = recorder();
      const summary = await runReplay(options(), deps(fakeReview((req) => (req.number === 1 ? incomplete(req) : reviewFor(req))), runner), onCase);
      expect(runner.calls.filter((r) => isFor(r, 'K1'))).toHaveLength(0);
      expect((await readdir(caseDir('pr1'))).sort()).toEqual(['review.json', 'spent.json']);
      expect(summary.incompleteCases).toEqual(['pr1']);
      expect(summary.cases[0]).toMatchObject({ caseId: 'pr1', inTop: 0, raised: 0, findingsShown: 1, verdict: 'incomplete' });
      expect(events.filter((e) => e.caseId === 'pr1').map((e) => [e.status, e.message])).toEqual([
        ['start', undefined], ['reviewed', undefined], ['failed', 'The review did not finish (lenses, sweep).'],
      ]);
      expect((await loadRun(join(outDir, 'run-a'), cases())).summary).toEqual(summary);
    });

    it('a saved incomplete review is reviewed again, and the old file is replaced only when the new review is saved', async () => {
      await runReplay(options(), deps(fakeReview((req) => (req.number === 1 ? incomplete(req) : reviewFor(req)))));
      // An older run judged its incomplete review: that still does not make the case done.
      await writeFile(join(caseDir('pr1'), 'matches.json'), JSON.stringify(['K1', 'K2'].map((knownId) => ({ knownId, where: 'none', itemId: null, partial: false, reason: 'x' }))));
      const before = await readFile(join(caseDir('pr1'), 'review.json'), 'utf8');

      const failing = fakeReview((req) => { if (req.number === 1) throw new Error('clone failed'); return reviewFor(req); });
      const second = await runReplay(options(), deps(failing));
      expect(failing.requests.map((r) => r.number)).toEqual([1]);
      expect(await readFile(join(caseDir('pr1'), 'review.json'), 'utf8')).toBe(before);
      expect(second.incompleteCases).toEqual(['pr1']);

      const healthy = fakeReview();
      const third = await runReplay(options(), deps(healthy));
      expect(healthy.requests.map((r) => r.number)).toEqual([1]);
      expect(ReviewDocumentSchema.parse(await readJson(join(caseDir('pr1'), 'review.json'))).verdict.label).toBe('approve');
      expect(third.incompleteCases).toEqual([]);
      expect(third.cases[0]).toMatchObject({ caseId: 'pr1', inTop: 1 });
    });

    it('saved matches that cannot be scored are judged again without reviewing again', async () => {
      await runReplay(options(), deps(fakeReview()));
      // Valid in form and for the right known problems, but naming a dropped item the review does not have.
      await writeFile(join(caseDir('pr1'), 'matches.json'), JSON.stringify([
        { knownId: 'K1', where: 'dropped', itemId: 'd9', partial: false, reason: 'x' },
        { knownId: 'K2', where: 'none', itemId: null, partial: false, reason: 'x' },
      ]));
      const loaded = await loadRun(join(outDir, 'run-a'), cases());
      expect(loaded.summary.incompleteCases).toEqual(['pr1']);
      expect(loaded.details.pr1!.doc.stageErrors.at(-1)).toMatchObject({ stage: 'judge', message: 'The review finished but was not judged.' });

      const review = fakeReview(() => { throw new Error('must not review again'); });
      const runner = createFakeRunner(judgeAnswer);
      const summary = await runReplay(options(), deps(review, runner));
      expect(review.requests).toHaveLength(0);
      expect(runner.calls).toHaveLength(1);
      expect(summary.cases[0]).toMatchObject({ caseId: 'pr1', inTop: 1, verdict: 'approve' });
    });

    it('an error.txt that cannot be read does not discard a valid saved review', async () => {
      await runReplay(options(), deps(fakeReview()));
      await rm(join(caseDir('pr1'), 'matches.json'));
      await mkdir(join(caseDir('pr1'), 'error.txt')); // reading it fails with EISDIR
      const loaded = await loadRun(join(outDir, 'run-a'), cases());
      expect(loaded.details.pr1!.doc.findings).toHaveLength(1);
      expect(loaded.details.pr1!.doc.stageErrors.at(-1)).toMatchObject({ stage: 'judge', message: 'The review finished but was not judged.' });

      const review = fakeReview(() => { throw new Error('must not review again'); });
      const runner = createFakeRunner(judgeAnswer);
      const summary = await runReplay(options({ cases: [cases()[0]!], dataset: cases() }), deps(review, runner));
      expect(review.requests).toHaveLength(0);
      expect(runner.calls).toHaveLength(1);
      expect(summary.cases[0]).toMatchObject({ caseId: 'pr1', inTop: 1, verdict: 'approve' });
    });

    it('a case that is not done and not selected is unfinished, with a reason true for its state', async () => {
      const many = [1, 2, 3, 4, 5, 6].map((n) => replayCase({
        id: `pr${n}`, pr: n, baseSha: String(n).repeat(40), headSha: 'e'.repeat(40), known: [problem({ id: `K${n}` })],
      }));
      const answer = (req: AgentRequest<unknown>) => ({
        matches: many.map((c) => c.known[0]!.id).filter((id) => isFor(req, id)).map((knownId) => ({ knownId, items: [{ itemId: 'f1', partial: false, reason: 'Same.' }], reason: 'Same.' })),
      });
      const opts = { cases: many, dataset: many };
      await runReplay(options(opts), deps(fakeReview((req) => (req.number === 4 ? incomplete(req) : reviewFor(req))), createFakeRunner(answer)));
      await rm(caseDir('pr1'), { recursive: true });
      // pr1 was never run. pr2's saved review is for other commits. pr3 finished but its matches are gone. pr4 did not
      // finish. pr5's review failed. pr6 is done.
      const pr2 = ReviewDocumentSchema.parse(await readJson(join(caseDir('pr2'), 'review.json')));
      await writeFile(join(caseDir('pr2'), 'review.json'), JSON.stringify({ ...pr2, range: { ...pr2.range, headSha: 'f'.repeat(40) } }));
      await rm(join(caseDir('pr3'), 'matches.json'));
      await rm(join(caseDir('pr5'), 'matches.json'));
      await rm(join(caseDir('pr5'), 'review.json'));
      await writeFile(join(caseDir('pr5'), 'error.txt'), 'The review failed: no such commit\n');

      const review = fakeReview();
      const runner = createFakeRunner(answer);
      const summary = await runReplay(options({ ...opts, cases: [many[5]!] }), deps(review, runner));
      expect(review.requests).toHaveLength(0);
      expect(runner.calls).toHaveLength(0);
      expect(summary.incompleteCases).toEqual(['pr1', 'pr2', 'pr3', 'pr4', 'pr5']);
      const { details } = await loadRun(join(outDir, 'run-a'), many);
      const why = (id: string): string => details[id]!.doc.stageErrors.at(-1)!.message;
      expect(why('pr1')).toBe('This case has not been run.');
      expect(why('pr2')).toBe('The saved review is for other commits.');
      expect(why('pr3')).toBe('The review finished but was not judged.');
      expect(details.pr4!.doc.stageErrors.map((e) => e.stage)).toEqual(['lenses', 'sweep', 'lenses']);
      expect(why('pr5')).toBe('The review failed: no such commit');
      for (const id of ['pr1', 'pr2', 'pr5']) expect(details[id]!.doc.findings).toEqual([]);
      expect(details.pr3!.doc.findings).toHaveLength(1);
      expect(summary.cases.find((s) => s.caseId === 'pr6')).toMatchObject({ inTop: 1, verdict: 'approve' });
    });

    it('a saved review.json that cannot be read is reviewed again, and is unfinished until then', async () => {
      await runReplay(options(), deps(fakeReview()));
      await writeFile(join(caseDir('pr1'), 'review.json'), '{ not json');
      const loaded = await loadRun(join(outDir, 'run-a'), cases());
      expect(loaded.details.pr1!.doc.stageErrors).toEqual([{ stage: 'intake', cohortId: null, message: 'The saved review cannot be read.' }]);
    });

    it('a resume that passes no dataset and narrows the selection is not refused, and run.json keeps every case', async () => {
      await runReplay(options(), deps(fakeReview()));
      await rm(join(caseDir('pr2'), 'matches.json'));
      const runner = createFakeRunner(judgeAnswer);
      const summary = await runReplay(options({ cases: [cases()[1]!] }), deps(fakeReview(), runner));
      expect(runner.calls).toHaveLength(1);
      expect(summary.cases.map((s) => [s.caseId, s.verdict])).toEqual([['pr2', 'approve']]);
      expect(await readJson(join(outDir, 'run-a', 'run.json'))).toMatchObject({ caseIds: ['pr2', 'pr1', 'pr3'] });
      // A later call with the whole dataset covers every case again.
      const loaded = await loadRun(join(outDir, 'run-a'), cases());
      expect(loaded.summary.cases.map((s) => s.caseId)).toEqual(['pr1', 'pr2', 'pr3']);
    });
  });

  describe('a usage limit stops the run instead of spoiling it', () => {
    const five = [1, 2, 3, 4, 5].map((n) => replayCase({
      id: `pr${n}`, pr: n, baseSha: String(n).repeat(40), headSha: 'e'.repeat(40), known: [problem({ id: `K${n}` })],
    }));
    const answerAll = (req: AgentRequest<unknown>) => ({
      matches: five.map((c) => c.known[0]!.id).filter((id) => isFor(req, id)).map((knownId) => ({ knownId, items: [{ itemId: 'f1', partial: false, reason: 'Same.' }], reason: 'Same.' })),
    });
    const limited = (req: ReviewRequest, error: { message: string; kind?: 'usage-limit' }): ReviewDocument => ({
      ...reviewFor(req),
      verdict: { label: 'incomplete', sentence: 'The review did not finish.', counts: { block: 0, fix: 0, ask: 0, note: 1 } },
      stageErrors: [{ stage: 'lenses', cohortId: 'c1', ...error }],
    });

    for (const [label, error] of [
      ['a stage error of kind usage-limit', { message: 'The request failed.', kind: 'usage-limit' }],
      ['a stage error without a kind whose message names the usage limit', { message: 'Claude AI usage limit reached|1762963200' }],
    ] as const) {
      it(`${label} during the third of five cases stops the run there, and a second run picks up exactly the unfinished cases`, async () => {
        const review = fakeReview((req) => (req.number === 3 ? limited(req, error) : reviewFor(req)));
        const runner = createFakeRunner(answerAll);
        const { events, onCase } = recorder();
        const summary = await runReplay(options({ cases: five, parallelCases: 1 }), deps(review, runner), onCase);

        expect(review.requests.map((r) => r.number)).toEqual([1, 2, 3]);
        expect(runner.calls).toHaveLength(2);
        expect(await exists(join(caseDir('pr3'), 'review.json'))).toBe(true);
        await expect(stat(caseDir('pr4'))).rejects.toThrow(/ENOENT/);
        await expect(stat(caseDir('pr5'))).rejects.toThrow(/ENOENT/);
        expect(events.some((e) => e.caseId === 'pr4' || e.caseId === 'pr5')).toBe(false);
        expect(summary.incompleteCases).toEqual(['pr3', 'pr4', 'pr5']);
        expect(summary.stopped).toEqual({ reason: 'usage-limit', caseId: 'pr3', notStarted: ['pr4', 'pr5'] });
        expect(await readJson(join(outDir, 'run-a', 'summary.json'))).toEqual(summary);
        expect(await exists(join(outDir, 'run-a', 'report.md'))).toBe(true);
        const { details } = await loadRun(join(outDir, 'run-a'), five);
        expect(details.pr4!.doc.stageErrors.at(-1)!.message).toBe('This case has not been run.');

        const healthy = fakeReview();
        const again = createFakeRunner(answerAll);
        const second = await runReplay(options({ cases: five, parallelCases: 1 }), deps(healthy, again));
        expect(healthy.requests.map((r) => r.number)).toEqual([3, 4, 5]);
        expect(again.calls).toHaveLength(3);
        expect(second.incompleteCases).toEqual([]);
        expect(second.stopped).toBeUndefined();
      });
    }

    it('a judge that fails with a usage limit stops the run too', async () => {
      const runner = createFakeRunner((req) => (isFor(req, 'K2') ? new Error('Claude usage limit reached; resets at 17:00') : answerAll(req)));
      const review = fakeReview();
      const summary = await runReplay(options({ cases: five, parallelCases: 1 }), deps(review, runner));
      expect(review.requests.map((r) => r.number)).toEqual([1, 2]);
      expect(summary.stopped).toEqual({ reason: 'usage-limit', caseId: 'pr2', notStarted: ['pr3', 'pr4', 'pr5'] });
      expect(summary.incompleteCases).toEqual(['pr2', 'pr3', 'pr4', 'pr5']);
      // The saved review is kept; only the judge runs again next time.
      expect((await readdir(caseDir('pr2'))).sort()).toEqual(['error.txt', 'review.json', 'spent.json']);
    });

    it('a judge result marked as a usage limit stops the run', async () => {
      const inner = createFakeRunner(answerAll);
      const runner: ReplayDeps['runner'] = {
        run: async (req) => (isFor(req as AgentRequest<unknown>, 'K1')
          ? ({ ok: false, error: 'The request was refused.', kind: 'usage-limit', usage: { ms: 0, inputTokens: 0, outputTokens: 0, costUsd: null, turns: 0 } } as never)
          : inner.run(req)),
      };
      const summary = await runReplay(options({ cases: five, parallelCases: 1 }), deps(fakeReview(), runner));
      expect(summary.stopped).toEqual({ reason: 'usage-limit', caseId: 'pr1', notStarted: ['pr2', 'pr3', 'pr4', 'pr5'] });
    });

    it('cases already in flight finish, and a done case is still counted as done', async () => {
      await runReplay(options({ cases: [five[4]!], dataset: five }), deps(fakeReview(), createFakeRunner(answerAll)));
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const review = fakeReview(async (req) => {
        if (req.number === 1) return limited(req, { message: 'x', kind: 'usage-limit' });
        if (req.number === 2) { await gate; return reviewFor(req); }
        return reviewFor(req);
      });
      const runner = createFakeRunner(answerAll);
      const running = runReplay(options({ cases: five, parallelCases: 2 }), deps(review, runner));
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      const summary = await running;
      expect(review.requests.map((r) => r.number).sort()).toEqual([1, 2]);
      expect(summary.cases.find((s) => s.caseId === 'pr2')).toMatchObject({ inTop: 1, verdict: 'approve' });
      expect(summary.cases.find((s) => s.caseId === 'pr5')).toMatchObject({ inTop: 1, verdict: 'approve' });
      expect(summary.stopped).toEqual({ reason: 'usage-limit', caseId: 'pr1', notStarted: ['pr3', 'pr4'] });
    });
  });

  describe('an exit signal stops the run', () => {
    const four = [1, 2, 3, 4].map((n) => replayCase({
      id: `pr${n}`, pr: n, baseSha: String(n).repeat(40), headSha: 'e'.repeat(40), known: [problem({ id: `K${n}` })],
    }));
    const answerAll = (req: AgentRequest<unknown>) => ({
      matches: four.map((c) => c.known[0]!.id).filter((id) => isFor(req, id)).map((knownId) => ({ knownId, items: [{ itemId: 'f1', partial: false, reason: 'Same.' }], reason: 'Same.' })),
    });
    /** Waits for the review's signal, then rejects as the engine does when it is stopped. */
    const untilStopped = (engine: EngineDeps): Promise<never> => new Promise((_, reject) => {
      engine.signal!.addEventListener('abort', () => reject(new Error('The review was stopped.')), { once: true });
    });
    /** A review of pr2 that stops the run while it is in flight; the other cases review as usual. */
    const stoppingAtPr2 = (controller: AbortController): FakeReview => fakeReview((req, engine) => {
      if (req.number !== 2) return reviewFor(req);
      setTimeout(() => controller.abort(), 5);
      return untilStopped(engine);
    });

    it('an abort during the second of four cases starts no other case, judges nothing after it, and a second run picks up exactly the unfinished cases', async () => {
      const controller = new AbortController();
      const review = stoppingAtPr2(controller);
      const runner = createFakeRunner(answerAll);
      const { events, onCase } = recorder();
      const summary = await runReplay(options({ cases: four, parallelCases: 1 }), { ...deps(review, runner), signal: controller.signal }, onCase);

      expect(review.requests.map((r) => r.number)).toEqual([1, 2]);
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls.filter((r) => isFor(r, 'K2'))).toHaveLength(0);
      // pr2 had no folder before this call, and has none after it: no error.txt, nothing else.
      for (const id of ['pr2', 'pr3', 'pr4']) await expect(stat(caseDir(id))).rejects.toThrow(/ENOENT/);
      expect(events.filter((e) => e.caseId === 'pr2').map((e) => e.status)).toEqual(['start', 'stopped']);
      expect(events.some((e) => e.caseId === 'pr3' || e.caseId === 'pr4')).toBe(false);
      expect(summary.incompleteCases).toEqual(['pr2', 'pr3', 'pr4']);
      expect(summary.stopped).toEqual({ reason: 'exit-signal' });
      expect(await readJson(join(outDir, 'run-a', 'summary.json'))).toEqual(summary);
      expect(await exists(join(outDir, 'run-a', 'report.md'))).toBe(true);

      const healthy = fakeReview();
      const again = createFakeRunner(answerAll);
      const second = await runReplay(options({ cases: four, parallelCases: 1 }), deps(healthy, again));
      expect(healthy.requests.map((r) => r.number)).toEqual([2, 3, 4]);
      expect(again.calls).toHaveLength(3);
      expect(second.incompleteCases).toEqual([]);
      expect(second.stopped).toBeUndefined();
    });

    it('a stopped case\'s folder is left as it was before the call', async () => {
      await runReplay(options({ cases: four, parallelCases: 1 }), deps(fakeReview((req) => {
        if (req.number === 2) throw new Error('clone failed');
        return reviewFor(req);
      }), createFakeRunner(answerAll)));
      const before = await snapshot(caseDir('pr2'));
      expect(Object.keys(before)).toEqual(['error.txt']);

      const controller = new AbortController();
      await runReplay(options({ cases: four, parallelCases: 1 }), { ...deps(stoppingAtPr2(controller), createFakeRunner(answerAll)), signal: controller.signal });
      expect(await snapshot(caseDir('pr2'))).toEqual(before);
    });

    it('a review that finishes after the stop is saved but not judged, and no error.txt is written', async () => {
      const controller = new AbortController();
      const review = fakeReview((req) => {
        if (req.number === 1) controller.abort();
        return reviewFor(req);
      });
      const runner = createFakeRunner(answerAll);
      const summary = await runReplay(options({ cases: four, parallelCases: 1 }), { ...deps(review, runner), signal: controller.signal });
      expect(review.requests.map((r) => r.number)).toEqual([1]);
      expect(runner.calls).toHaveLength(0);
      expect((await readdir(caseDir('pr1'))).sort()).toEqual(['review.json', 'spent.json']);
      expect(summary.incompleteCases).toEqual(['pr1', 'pr2', 'pr3', 'pr4']);
      expect(summary.stopped).toEqual({ reason: 'exit-signal' });

      const again = createFakeRunner(answerAll);
      const resumed = fakeReview();
      await runReplay(options({ cases: four, parallelCases: 1 }), deps(resumed, again));
      expect(resumed.requests.map((r) => r.number)).toEqual([2, 3, 4]);
      expect(again.calls).toHaveLength(4);
    });

    it('every judge request carries the run\'s stop signal', async () => {
      const controller = new AbortController();
      const runner = createFakeRunner(answerAll);
      const summary = await runReplay(options({ cases: four }), { ...deps(fakeReview(), runner), signal: controller.signal });
      expect(runner.calls).toHaveLength(4);
      expect(runner.calls.every((r) => r.signal === controller.signal)).toBe(true);
      expect(summary.stopped).toBeUndefined();
    });
  });

  describe('everything spent is counted', () => {
    const one = (): ReplayCase[] => [cases()[0]!];
    const incomplete = (req: ReviewRequest): ReviewDocument => ({
      ...reviewFor(req),
      verdict: { label: 'incomplete', sentence: 'The review did not finish.', counts: { block: 0, fix: 0, ask: 0, note: 1 } },
      stageErrors: [{ stage: 'lenses', cohortId: 'c1', message: 'The lens failed.' }],
    });
    // reviewFor's document records 300 tokens in, 40 out and 2 agent runs; a fake runner's request spends 10 in and 5 out.
    const review = { step: 'review', inputTokens: 300, outputTokens: 40, agentRuns: 2 };
    const judge = { step: 'judge', finished: true, inputTokens: 10, outputTokens: 5, agentRuns: 1 };

    it('an incomplete review replaced by a finished one counts both, and the judge\'s request too', async () => {
      await runReplay(options({ cases: one() }), deps(fakeReview(incomplete)));
      expect(await readJson(join(caseDir('pr1'), 'spent.json'))).toEqual([{ ...review, finished: false }]);

      const summary = await runReplay(options({ cases: one() }), deps(fakeReview()));
      expect(await readJson(join(caseDir('pr1'), 'spent.json'))).toEqual([{ ...review, finished: false }, { ...review, finished: true }, judge]);
      expect(summary.cases[0]).toMatchObject({ inputTokens: 610, outputTokens: 85, agentRuns: 5, unfinishedTokens: 340, judgeTokens: 15, usageAbout: false });
      expect(summary.totals).toMatchObject({ inputTokens: 610, outputTokens: 85, agentRuns: 5, unfinishedTokens: 340, judgeTokens: 15, usageAbout: false });
      expect((await loadRun(join(outDir, 'run-a'), one())).summary).toEqual(summary);
      expect(await readFile(join(outDir, 'run-a', 'report.md'), 'utf8')).toContain(
        'Of the 695 tokens spent, 340 (49%) went on reviews that did not finish and 15 (2%) on the judge.',
      );
    });

    it('a review that fails counts what its requests spent before it failed, and one that spent nothing adds no entry', async () => {
      const runner = createFakeRunner((req) => (req.role === 'lens' ? {} : judgeAnswer()));
      const spending = fakeReview(async (req, engine) => {
        await engine.runner.run({ role: 'lens', instructions: 'x', material: 'x', schema: z.object({}), cwd: tmpdir(), model: MODEL, effort: 'high' });
        throw new Error('clone failed');
      });
      const summary = await runReplay(options({ cases: one() }), deps(spending, runner));
      expect(await readJson(join(caseDir('pr1'), 'spent.json'))).toEqual([{ step: 'review', finished: false, inputTokens: 10, outputTokens: 5, agentRuns: 1 }]);
      expect(summary.cases[0]).toMatchObject({ inputTokens: 10, outputTokens: 5, agentRuns: 1, unfinishedTokens: 15, judgeTokens: 0 });

      await runReplay(options({ cases: [cases()[1]!], runId: 'run-b' }), deps(fakeReview(() => { throw new Error('clone failed'); })));
      expect((await readdir(caseDir('pr2', 'run-b'))).sort()).toEqual(['error.txt']);
    });

    it('a spent.json that cannot be read is left as it is, and the case is still reviewed and judged, its counts marked about', async () => {
      await runReplay(options({ cases: one() }), deps(fakeReview(() => { throw new Error('clone failed'); })));
      await writeFile(join(caseDir('pr1'), 'spent.json'), '{ not json');
      const summary = await runReplay(options({ cases: one() }), deps(fakeReview()));
      expect(await readFile(join(caseDir('pr1'), 'spent.json'), 'utf8')).toBe('{ not json');
      expect(summary.incompleteCases).toEqual([]);
      expect(summary.cases[0]).toMatchObject({ inTop: 1, inputTokens: 300, usageAbout: true });
    });

    it('a folder without spent.json counts the kept review\'s own usage, marked about', async () => {
      await runReplay(options(), deps(fakeReview()));
      await rm(join(caseDir('pr1'), 'spent.json'));
      const { summary, details } = await loadRun(join(outDir, 'run-a'), cases());
      expect(summary.cases[0]).toMatchObject({ inputTokens: 300, outputTokens: 40, agentRuns: 2, usageAbout: true });
      expect(summary.cases[1]).toMatchObject({ inputTokens: 310, outputTokens: 45, agentRuns: 3, usageAbout: false });
      expect(summary.totals).toMatchObject({ inputTokens: 910, outputTokens: 125, usageAbout: true });
      const time = renderReport(summary, cases(), details).split('## Time and tokens')[1]!;
      expect(time).toMatch(/\| #1 Add totals \| [^|]+ \| about 300 \| about 40 \| about 2 \|/);
      expect(time).toMatch(/\| #2 Add totals \| [^|]+ \| 310 \| 45 \| 3 \|/);
      expect(time).toMatch(/\| Total \| [^|]+ \| about 910 \| about 125 \| about 7 \|/);
      expect(time).toContain('A token count marked about is only the kept review\'s own: earlier attempts and the judge are not in it.');
    });
  });

  it('the other items the judge named are saved with the matches and read back by loadRun', async () => {
    const runner = createFakeRunner(() => ({
      matches: [{ knownId: 'K1', items: [{ itemId: 'q1', partial: false, reason: 'Asks it.' }, { itemId: 'f1', partial: true, reason: 'Half.' }], reason: 'Both.' }],
    }));
    const review = fakeReview((req) => ({
      ...reviewFor(req), questions: [{ text: 'Is it clamped?', cohortId: null, source: { pack: 'core', lens: null, ruleId: null } }],
    }));
    const one = [replayCase({ id: 'pr1', pr: 1, baseSha: '1'.repeat(40), headSha: '2'.repeat(40), known: [problem({ id: 'K1' })] })];
    const summary = await runReplay(options({ cases: one }), deps(review, runner));
    expect(await readJson(join(caseDir('pr1'), 'matches.json'))).toEqual([
      { knownId: 'K1', where: 'top', itemId: 'f1', partial: true, reason: 'Half.', others: [{ itemId: 'q1', where: 'question', partial: false }] },
    ]);
    const loaded = await loadRun(join(outDir, 'run-a'), one);
    expect(loaded.summary).toEqual(summary);
    expect(loaded.details.pr1!.matches[0]!.others).toEqual([{ itemId: 'q1', where: 'question', partial: false }]);
  });

  it('a stage named merge reads in words when a review does not finish', async () => {
    const review = fakeReview((req) => ({
      ...reviewFor(req),
      verdict: { label: 'incomplete', sentence: 's', counts: { block: 0, fix: 0, ask: 0, note: 1 } },
      stageErrors: [{ stage: 'merge', cohortId: null, message: 'The merge request failed.' }],
    }));
    const { events, onCase } = recorder();
    await runReplay(options({ cases: [cases()[0]!] }), deps(review), onCase);
    expect(events.at(-1)!.message).toBe('The review did not finish (merging duplicates).');
  });

  it('the run\'s total time is the time each call was working on cases, added up across resumes', async () => {
    let t = Date.parse('2026-11-10T09:00:00.000Z');
    const clock = (): Date => new Date(t);
    const review = fakeReview(async (req) => { t += 60_000; return reviewFor(req); });
    const first = await runReplay(options({ parallelCases: 3 }), { ...deps(review), now: clock });
    // The clock moves a minute in each review: one call gives its own duration, from its first case start to its last case end.
    const span1 = { startedAt: '2026-11-10T09:00:00.000Z', finishedAt: '2026-11-10T09:03:00.000Z' };
    expect(first.spans).toEqual([span1]);
    expect(first.totals).toMatchObject({ ms: 180_000, msSummed: false });
    expect(await readJson(join(outDir, 'run-a', 'run.json'))).toMatchObject({ spans: [span1] });

    // A resume an hour later that reviews one case adds its own span: the hour between is not counted.
    await rm(join(caseDir('pr2'), 'matches.json'));
    await rm(join(caseDir('pr2'), 'review.json'));
    t = Date.parse('2026-11-10T10:03:00.000Z');
    const second = await runReplay(options(), { ...deps(fakeReview(async (req) => { t += 60_000; return reviewFor(req); })), now: clock });
    const span2 = { startedAt: '2026-11-10T10:03:00.000Z', finishedAt: '2026-11-10T10:04:00.000Z' };
    expect(second.spans).toEqual([span1, span2]);
    expect(second.totals).toMatchObject({ ms: 240_000, msSummed: false });
    expect(await readFile(join(outDir, 'run-a', 'report.md'), 'utf8')).toContain('Total time is the time the replay was running, over 2 runs of the command.');

    // A call that only skips cases adds nothing.
    t = Date.parse('2026-11-11T10:00:00.000Z');
    const third = await runReplay(options(), { ...deps(fakeReview()), now: clock });
    expect(third.spans).toEqual(second.spans);
    expect((await loadRun(join(outDir, 'run-a'), cases())).summary).toEqual(third);
  });

  it('a run folder without spans gives the summed case times, marked about', async () => {
    await runReplay(options(), deps(fakeReview()));
    const path = join(outDir, 'run-a', 'run.json');
    const { spans: _s, ...without } = await readJson(path) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...without, casesStartedAt: '2026-11-10T09:00:00.000Z', casesFinishedAt: '2026-11-11T09:00:00.000Z' }));
    const { summary, details } = await loadRun(join(outDir, 'run-a'), cases());
    expect(summary.spans).toEqual([]);
    expect(summary.totals).toMatchObject({ ms: 3_000, msSummed: true });
    expect(renderReport(summary, cases(), details)).toMatch(/\| Total \| about 3 s \|/);
  });

  it('the judge runs in a fresh, empty folder made for the run and removed at the end', async () => {
    const seen: { cwd: string; entries: string[] }[] = [];
    const runner = createFakeRunner((req) => {
      seen.push({ cwd: req.cwd, entries: readdirSync(req.cwd) });
      return judgeAnswer();
    });
    await runReplay(options(), deps(fakeReview(), runner));
    expect(seen).toHaveLength(2);
    expect(seen[0]!.cwd).not.toBe(tmpdir());
    expect(seen[1]!.cwd).toBe(seen[0]!.cwd);
    expect(seen.map((s) => s.entries)).toEqual([[], []]);
    await expect(stat(seen[0]!.cwd)).rejects.toThrow(/ENOENT/);
  });
});
