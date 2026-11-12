import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewDocumentSchema, type ReviewDocument, type ReviewEvent } from '@airlock/shared';
import { failure } from '../../src/agent/fake-runner.js';
import type { AgentRequest } from '../../src/agent/runner.js';
import { latestReview, saveReview } from '../../src/store/store.js';
import { SUMMARY_FAILED_NOTE } from '../../src/summary/summary.js';
import { commitFiles } from '../helpers/change-repo.js';
import { block } from '../helpers/lens-context.js';
import {
  BASE_FILES, fakeGh, GOOD, NUMBER, REPO, RULED, SCENARIO_IN_SHORT, scenarioScript, STANDARD_STAGES, useReviewHarness,
} from '../helpers/review-scenario.js';

const SLOW = 30_000;
const { scenario, review } = useReviewHarness();

/** Makes the select stage itself throw when set, so the review falls back to listing every kept finding. */
const hooks = vi.hoisted(() => ({ selectThrows: false }));
vi.mock('../../src/select/select.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/select/select.js')>();
  return {
    ...m,
    select: async (...args: Parameters<typeof m.select>) => {
      if (hooks.selectThrows) throw new Error('select broke');
      return m.select(...args);
    },
  };
});
afterEach(() => { hooks.selectThrows = false; });

const none = { candidates: [], questions: [] };
/** The ids of the findings the summary request was shown. */
const shownIds = (req: AgentRequest<unknown>): string[] =>
  [...(block(req.material, 'findings') ?? '').matchAll(/^id: (.+)$/gm)].map((m) => m[1]!);
/** A summary answer that writes `<prefix> <id>` and a gist for every finding shown. */
const summaryOf = (prefix: string, inShort = SCENARIO_IN_SHORT) => (req: AgentRequest<unknown>) => ({
  inShort, findings: shownIds(req).map((id) => ({ id, short: `${prefix} ${id}`, gist: `What ${id} does to a member.` })),
});
const roles = (calls: AgentRequest<unknown>[]): string[] => calls.map((c) => c.role);
const stageEvents = (events: ReviewEvent[], stage: string) =>
  events.flatMap((e) => (e.type === 'stage' && e.stage === stage ? [`${e.status}${e.detail === '' ? '' : `: ${e.detail}`}`] : []));
const shorts = (doc: ReviewDocument) => doc.findings.map((f) => [f.id, f.short, f.gist]);

describe('the summary stage in a review', () => {
  it('runs after select and before store, on the sweep model, and puts each value on its own finding', async () => {
    const { doc, calls, events } = await review({
      req: { models: { sweep: 'claude-haiku-5-5' } }, script: scenarioScript({ summary: summaryOf('Short') }),
    });
    expect(doc.findings).toHaveLength(2);
    expect(shorts(doc)).toEqual(doc.findings.map((f) => [f.id, `Short ${f.id}`, `What ${f.id} does to a member.`]));
    expect(doc.brief.inShort).toBe(SCENARIO_IN_SHORT);
    expect(doc.brief.whatItDoes).toEqual(['Adds refunds and a pause job.']);
    expect(doc.notes).not.toContain(SUMMARY_FAILED_NOTE);
    expect(doc.stageErrors).toEqual([]);
    // one request, the last, after select's
    expect(roles(calls).filter((r) => r === 'summary')).toHaveLength(1);
    expect(roles(calls).at(-1)).toBe('summary');
    const summary = calls.at(-1)!;
    expect(summary.model).toBe('claude-haiku-5-5');
    expect(new Set(shownIds(summary))).toEqual(new Set(doc.findings.map((f) => f.id)));
    // the pull request's own title and description are not sent
    expect(summary.material).not.toContain('Refunds reuse formatMoney');
    // the stage list, its events and its timing
    const starts = events.flatMap((e) => (e.type === 'stage' && e.status === 'start' ? [e.stage] : []));
    expect(starts).toEqual(STANDARD_STAGES);
    expect(STANDARD_STAGES.slice(-3)).toEqual(['select', 'summary', 'store']);
    expect(stageEvents(events, 'summary')).toEqual(['start', 'done']);
    expect(doc.timings.find((t) => t.stage === 'summary')).toMatchObject({ agentRuns: 1, inputTokens: 10, outputTokens: 5 });
    // the document is valid and is what was saved
    expect(ReviewDocumentSchema.parse(doc)).toEqual(doc);
    expect(await latestReview(REPO, NUMBER, doc.pr.headSha)).toEqual(doc);
  }, SLOW);

  it.each([
    ['fails', failure('the model said no', 'other')],
    ['times out', failure('timed out after 180 s', 'timeout')],
    ['hits the usage limit', failure("Claude's usage limit was reached", 'usage-limit')],
    ['returns nothing valid', { inShort: 'two\nlines', findings: [{ id: 'c_nobody', short: 'Short', gist: 'Gist.' }] }],
  ])('when the request %s, the review finishes as without the stage, with one note', async (_why, reply) => {
    const s = await scenario();
    const { doc: summarised } = await review({ s, script: scenarioScript({ summary: summaryOf('Short') }) });
    const { doc, events } = await review({ s, script: scenarioScript({ summary: () => reply }) });
    expect(doc.notes?.filter((n) => n === SUMMARY_FAILED_NOTE)).toHaveLength(1);
    expect(doc.notes?.at(-1)).toBe(SUMMARY_FAILED_NOTE);
    expect(doc.stageErrors).toEqual([]);
    expect(doc.verdict).toEqual(summarised.verdict);
    expect(doc.verdict.label).toBe('approve-after-fixes');
    expect(doc.selfReviewText).toBe(summarised.selfReviewText);
    expect(doc.findings.every((f) => f.short === undefined && f.gist === undefined)).toBe(true);
    expect(doc.brief).toEqual({ whatItDoes: ['Adds refunds and a pause job.'], claims: [] });
    expect(stageEvents(events, 'summary')).toEqual(['start', 'done']);
    expect(ReviewDocumentSchema.parse(doc)).toEqual(doc);
  }, SLOW);

  it('after the usage limit was hit earlier in the review, sends no request and gives the note, not a stage error', async () => {
    const { doc, calls, events } = await review({
      script: scenarioScript({
        select: () => failure("Claude's usage limit was reached", 'usage-limit'), summary: () => { throw new Error('no summary expected'); },
      }),
    });
    expect(roles(calls)).not.toContain('summary');
    expect(doc.stageErrors.map((e) => [e.stage, e.kind])).toEqual([['select', 'usage-limit']]);
    expect(stageEvents(events, 'summary')).toEqual(['start', 'done: skipped: usage limit']);
    expect(doc.timings.find((t) => t.stage === 'summary')).toMatchObject({ agentRuns: 0, costUsd: 0 });
    expect(doc.notes?.at(-1)).toBe(SUMMARY_FAILED_NOTE);
  }, SLOW);

  it('a review whose select request failed is incomplete and still gets summaries', async () => {
    const { doc, calls } = await review({
      script: scenarioScript({ select: () => failure('select timed out', 'timeout'), summary: summaryOf('Short') }),
    });
    expect(doc.verdict.label).toBe('incomplete');
    expect(doc.stageErrors.map((e) => e.stage)).toEqual(['select']);
    expect(roles(calls).at(-1)).toBe('summary');
    expect(doc.findings).toHaveLength(2);
    expect(shorts(doc)).toEqual(doc.findings.map((f) => [f.id, `Short ${f.id}`, `What ${f.id} does to a member.`]));
    expect(doc.notes).not.toContain(SUMMARY_FAILED_NOTE);
  }, SLOW);

  it('a review whose select stage threw still gets summaries for every finding listed', async () => {
    hooks.selectThrows = true;
    const { doc } = await review({ script: scenarioScript({ summary: summaryOf('Short') }) });
    expect(doc.verdict.label).toBe('incomplete');
    expect(doc.stageErrors).toEqual([{ stage: 'select', cohortId: null, message: 'select broke' }]);
    expect(doc.findings.map((f) => f.bucket)).toEqual(['also', 'also']);
    expect(shorts(doc)).toEqual(doc.findings.map((f) => [f.id, `Short ${f.id}`, `What ${f.id} does to a member.`]));
  }, SLOW);

  it('a review with no findings still makes one request, with an empty list, and writes the sentence on the change', async () => {
    const { doc, calls } = await review({
      script: scenarioScript({ 'lens:': () => none, 'sweep:': () => none, summary: summaryOf('Short') }),
    });
    expect(doc.findings).toEqual([]);
    const summary = calls.filter((c) => c.role === 'summary');
    expect(summary).toHaveLength(1);
    expect(block(summary[0]!.material, 'findings')).toBe('(none)');
    expect(doc.brief.inShort).toBe(SCENARIO_IN_SHORT);
    expect(doc.notes).not.toContain(SUMMARY_FAILED_NOTE);
  }, SLOW);

  it('makes no request when there are no findings and nothing is known of the change', async () => {
    const { doc, calls, events } = await review({
      script: scenarioScript({
        brief: () => failure('brief failed', 'other'), 'lens:': () => none, 'sweep:': () => none, summary: () => { throw new Error('no summary expected'); },
      }),
    });
    expect(roles(calls)).not.toContain('summary');
    expect(stageEvents(events, 'summary')).toEqual(['start', 'done: skipped: nothing to summarise']);
    expect(doc.notes).not.toContain(SUMMARY_FAILED_NOTE);
    expect(doc.brief).not.toHaveProperty('inShort');
  }, SLOW);
});

describe('the summary stage in a re-review', () => {
  it('summarises the carried findings again, and the fixed ones keep what they had', async () => {
    const s = await scenario();
    const first = (await review({ s, script: scenarioScript({ summary: summaryOf('First') }) })).doc;
    expect(first.findings.every((f) => f.short === `First ${f.id}`)).toBe(true);
    // RULED as a note, so its vanishing is settled by code with no request
    const earlier: ReviewDocument = {
      ...first, id: 'r_cccccccccc',
      findings: first.findings.map((f) => (f.title === RULED.title ? { ...f, severity: 'note' as const } : f)),
    };
    await saveReview(earlier);
    const head = await commitFiles(s.remote, { 'src/billing.ts': BASE_FILES['src/billing.ts']! }, 'push');
    const again = (summary: (req: AgentRequest<unknown>) => unknown) => review({
      s, req: { since: { reviewId: earlier.id } }, exec: fakeGh({ baseSha: s.baseSha, headSha: head }),
      script: scenarioScript({
        mapper: () => ({ cohorts: [], standalone: ['src/billing.ts'] }), 'lens:': () => none, 'sweep:': () => none, seams: () => none, summary,
      }),
    });

    const { doc, calls } = await again(summaryOf('Again'));
    const good = doc.findings.find((f) => f.title === GOOD.title)!;
    expect(good.status).toBe('still-open');
    expect([good.short, good.gist]).toEqual([`Again ${good.id}`, `What ${good.id} does to a member.`]);
    const summary = calls.find((c) => c.role === 'summary')!;
    expect(shownIds(summary)).toEqual([good.id]); // the fixed one is not sent
    expect(doc.fixed!.map((f) => [f.title, f.short])).toEqual([[RULED.title, `First ${doc.fixed![0]!.id}`]]);

    // When the stage fails, the carried finding keeps what the earlier review gave it, as it would without the stage.
    const failed = (await again(() => failure('the model said no', 'other'))).doc;
    expect(failed.findings.find((f) => f.title === GOOD.title)!.short).toBe(`First ${good.id}`);
    expect(failed.notes).toContain(SUMMARY_FAILED_NOTE);
    expect(failed.stageErrors).toEqual([]);
  }, SLOW);
});
