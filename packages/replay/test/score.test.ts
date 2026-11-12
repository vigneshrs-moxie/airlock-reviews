import { describe, expect, it } from 'vitest';
import { scoreCase, summarise } from '../src/index.js';
import type { CaseScore, Match } from '../src/index.js';
import { doc, dropped, finding, problem, raw, replayCase } from './fixtures.js';

const match = (knownId: string, where: Match['where'], itemId: string | null, partial = false): Match =>
  ({ knownId, where, itemId, partial, reason: 'r' });

const ZERO_LOST = { lenses: 0, schema: 0, anchor: 0, merge: 0, challenge: 0, select: 0 };

describe('scoreCase', () => {
  it('counts a known problem matched in the top list as inTop, shown and raised', () => {
    const s = scoreCase(replayCase(), doc({ findings: [finding('f1', 'top')] }), [match('K1', 'top', 'f1')]);
    expect(s).toMatchObject({ caseId: 'pr1', kind: 'positive', known: 1, knownDefects: 1, inTop: 1, shown: 1, raised: 1,
      defectsInTop: 1, defectsShown: 1, partialInTop: 0, asQuestion: 0, lostAt: ZERO_LOST });
  });

  it('counts an also-found match as shown and raised but not in top', () => {
    const s = scoreCase(replayCase(), doc({ findings: [finding('f2', 'also')] }), [match('K1', 'also', 'f2')]);
    expect(s).toMatchObject({ inTop: 0, shown: 1, raised: 1, lostAt: ZERO_LOST });
  });

  it('a problem matched only by a candidate dropped at challenge counts under lostAt.challenge', () => {
    const s = scoreCase(replayCase(), doc({ dropped: [dropped('d1', 'challenge')] }), [match('K1', 'dropped', 'd1')]);
    expect(s).toMatchObject({ inTop: 0, shown: 0, raised: 1, lostAt: { ...ZERO_LOST, challenge: 1 } });
  });

  it('a dropped match counts under its own stage, including schema', () => {
    const c = replayCase({ known: ['A', 'B', 'C'].map((id) => problem({ id })) });
    const d = doc({ dropped: [dropped('d1', 'schema'), dropped('d2', 'anchor'), dropped('d3', 'select')] });
    const s = scoreCase(c, d, [match('A', 'dropped', 'd1'), match('B', 'dropped', 'd2'), match('C', 'dropped', 'd3')]);
    expect(s.lostAt).toEqual({ ...ZERO_LOST, schema: 1, anchor: 1, select: 1 });
  });

  it('a raw candidate match counts under lostAt.select', () => {
    const s = scoreCase(replayCase(), doc({ candidates: [raw('c1')] }), [match('K1', 'candidate', 'c1')]);
    expect(s).toMatchObject({ raised: 1, lostAt: { ...ZERO_LOST, select: 1 } });
  });

  it('a problem with no match counts under lostAt.lenses', () => {
    const s = scoreCase(replayCase(), doc(), [match('K1', 'none', null)]);
    expect(s).toMatchObject({ inTop: 0, shown: 0, raised: 0, lostAt: { ...ZERO_LOST, lenses: 1 } });
  });

  it('a problem with no match entry at all counts under lostAt.lenses', () => {
    const s = scoreCase(replayCase(), doc(), []);
    expect(s).toMatchObject({ raised: 0, lostAt: { ...ZERO_LOST, lenses: 1 } });
  });

  it('a question match counts in asQuestion and not in lostAt', () => {
    const d = doc({ questions: [{ text: 'Why?', cohortId: null, source: { pack: 'core', lens: null, ruleId: null } }] });
    const s = scoreCase(replayCase(), d, [match('K1', 'question', 'q1')]);
    expect(s).toMatchObject({ raised: 1, shown: 0, asQuestion: 1, lostAt: ZERO_LOST });
  });

  it('counts partial top matches', () => {
    const c = replayCase({ known: ['A', 'B', 'C'].map((id) => problem({ id })) });
    const d = doc({ findings: [finding('f1', 'top'), finding('f2', 'also')] });
    const s = scoreCase(c, d, [match('A', 'top', 'f1', true), match('B', 'top', 'f1'), match('C', 'also', 'f2', true)]);
    expect(s.partialInTop).toBe(1);
  });

  it('counts defects and cross-file problems separately', () => {
    const c = replayCase({ known: [
      problem({ id: 'A', crossFile: true }),
      problem({ id: 'B', defect: false }),
      problem({ id: 'C', crossFile: true }),
      problem({ id: 'D' }),
    ] });
    const d = doc({ findings: [finding('f1', 'top'), finding('f2', 'also')] });
    const s = scoreCase(c, d, [match('A', 'top', 'f1'), match('B', 'top', 'f1'), match('C', 'also', 'f2'), match('D', 'none', null)]);
    expect(s).toMatchObject({ known: 4, knownDefects: 3, inTop: 2, defectsInTop: 1, shown: 3, defectsShown: 2, crossFileKnown: 2, crossFileInTop: 1 });
  });

  it('counts known problems whose matched item is also another known problem\'s match', () => {
    const c = replayCase({ known: ['A', 'B', 'C', 'D', 'E'].map((id) => problem({ id })) });
    const d = doc({ findings: [finding('f1', 'top'), finding('f2', 'also')] });
    const s = scoreCase(c, d, [match('A', 'top', 'f1'), match('B', 'top', 'f1', true), match('C', 'also', 'f2'), match('D', 'none', null), match('E', 'none', null)]);
    expect(s.sharedMatches).toBe(2);
  });

  it('counts shown findings, block or fix among them, time, tokens and the verdict', () => {
    const d = doc({
      findings: [finding('f1', 'top', { severity: 'block' }), finding('f2', 'top', { severity: 'ask' }), finding('f3', 'also', { severity: 'fix' })],
      verdict: { label: 'request-changes', sentence: 's', counts: { block: 1, fix: 1, ask: 1, note: 0 } },
      timings: [
        { stage: 'map', ms: 1000, agentRuns: 1, inputTokens: 100, outputTokens: 10, costUsd: null },
        { stage: 'lenses', ms: 2500, agentRuns: 4, inputTokens: 900, outputTokens: 90, costUsd: 0.5 },
      ],
    });
    const s = scoreCase(replayCase({ kind: 'negative', known: [] }), d, []);
    expect(s).toMatchObject({ kind: 'negative', known: 0, findingsShown: 3, blockOrFixShown: 2, ms: 3500, msSummed: true,
      inputTokens: 1000, outputTokens: 100, agentRuns: 5, verdict: 'request-changes' });
  });

  it('a review that records its start takes its time as it passed, not the sum of stages that overlap', () => {
    const timings = [
      { stage: 'lenses', ms: 600_000, agentRuns: 6, inputTokens: 1, outputTokens: 1, costUsd: null },
      { stage: 'sweep', ms: 500_000, agentRuns: 3, inputTokens: 1, outputTokens: 1, costUsd: null },
    ];
    const elapsed = scoreCase(replayCase({ known: [] }), doc({ startedAt: '2026-11-10T09:00:00.000Z', createdAt: '2026-11-10T09:12:30.000Z', timings }), []);
    expect(elapsed).toMatchObject({ ms: 750_000, msSummed: false });
    // Without a start, or with times that cannot be read, the sum of stages is all there is.
    expect(scoreCase(replayCase({ known: [] }), doc({ timings }), [])).toMatchObject({ ms: 1_100_000, msSummed: true });
    expect(scoreCase(replayCase({ known: [] }), doc({ startedAt: 'not a time', timings }), [])).toMatchObject({ ms: 1_100_000, msSummed: true });
  });
});

function score(over: Partial<CaseScore>): CaseScore {
  return {
    caseId: 'pr1', kind: 'positive', known: 0, knownDefects: 0, inTop: 0, shown: 0, raised: 0, defectsInTop: 0,
    defectsShown: 0, partialInTop: 0, asQuestion: 0, sharedMatches: 0, lostAt: { ...ZERO_LOST }, crossFileKnown: 0, crossFileInTop: 0,
    findingsShown: 0, blockOrFixShown: 0, ms: 0, msSummed: false, inputTokens: 0, outputTokens: 0, agentRuns: 0,
    unfinishedTokens: 0, judgeTokens: 0, usageAbout: false, verdict: 'approve',
    ...over,
  };
}

describe('summarise', () => {
  it('recallTop is 13/26 when half are in the top list, and halfInTop is true', () => {
    const scores = [
      score({ caseId: 'a', known: 10, inTop: 5, shown: 7 }),
      score({ caseId: 'b', known: 16, inTop: 8, shown: 9 }),
    ];
    const cases = [replayCase({ id: 'a' }), replayCase({ id: 'b' })];
    const s = summarise('run-1', 'claude-opus-5-5', 'standard', scores, cases);
    expect(s).toMatchObject({ runId: 'run-1', model: 'claude-opus-5-5', depth: 'standard', knownTotal: 26, inTopTotal: 13 });
    expect(s.recallTop).toBe(0.5);
    expect(s.recallShown).toBeCloseTo(16 / 26);
    expect(s.meets.halfInTop).toBe(true);
    expect(s.cases).toEqual(scores);
  });

  it('halfInTop is false just under half', () => {
    const s = summarise('r', 'm', 'standard', [score({ known: 26, inTop: 12 })], [replayCase()]);
    expect(s.meets.halfInTop).toBe(false);
  });

  it('recalls count positive cases only', () => {
    const scores = [
      score({ caseId: 'p', known: 4, inTop: 2 }),
      score({ caseId: 's', kind: 'secondary', known: 4, inTop: 0 }),
    ];
    const s = summarise('r', 'm', 'standard', scores, [replayCase({ id: 'p' }), replayCase({ id: 's', kind: 'secondary' })]);
    expect(s).toMatchObject({ knownTotal: 4, inTopTotal: 2, recallTop: 0.5 });
  });

  it('defect-only recall leaves out a question problem', () => {
    // 4 known, one of them a pure question that was missed; the 3 defects are all in the top list.
    const s = summarise('r', 'm', 'standard', [score({ known: 4, knownDefects: 3, inTop: 3, defectsInTop: 3 })], [replayCase()]);
    expect(s.recallTop).toBe(0.75);
    expect(s.recallTopDefects).toBe(1);
  });

  it('cross-file recall is computed over cross-file problems only', () => {
    const scores = [
      score({ caseId: 'a', known: 10, inTop: 9, crossFileKnown: 4, crossFileInTop: 1 }),
      score({ caseId: 'b', known: 10, inTop: 1, crossFileKnown: 0, crossFileInTop: 0 }),
    ];
    const s = summarise('r', 'm', 'standard', scores, [replayCase({ id: 'a' }), replayCase({ id: 'b' })]);
    expect(s.crossFileRecallTop).toBe(0.25);
  });

  it('recalls are 0 with no positive cases', () => {
    const s = summarise('r', 'm', 'quick', [score({ caseId: 'n', kind: 'negative' })], [replayCase({ id: 'n', kind: 'negative', known: [] })]);
    expect(s).toMatchObject({ knownTotal: 0, recallTop: 0, recallShown: 0, recallTopDefects: 0, crossFileRecallTop: 0 });
    expect(s.meets.halfInTop).toBe('not tested');
  });

  it('cleanControls is not tested with no negative cases', () => {
    const s = summarise('r', 'm', 'standard', [score({ known: 2, inTop: 2 })], [replayCase()]);
    expect(s.meets.cleanControls).toBe('not tested');
    expect(s.meets.halfInTop).toBe(true);
  });

  it('an incomplete negative case with nothing shown makes cleanControls incomplete', () => {
    const scores = [
      score({ caseId: 'n1', kind: 'negative' }),
      score({ caseId: 'n2', kind: 'negative', verdict: 'incomplete' }),
    ];
    const s = summarise('r', 'm', 'standard', scores, [replayCase({ id: 'n1', kind: 'negative' }), replayCase({ id: 'n2', kind: 'negative' })]);
    expect(s.meets.cleanControls).toBe('incomplete');
    expect(s.negativesIncomplete).toBe(1);
  });

  it('a block on a negative case outranks an incomplete one', () => {
    const scores = [
      score({ caseId: 'n1', kind: 'negative', blockOrFixShown: 1 }),
      score({ caseId: 'n2', kind: 'negative', verdict: 'incomplete' }),
    ];
    const s = summarise('r', 'm', 'standard', scores, [replayCase({ id: 'n1', kind: 'negative' }), replayCase({ id: 'n2', kind: 'negative' })]);
    expect(s.meets.cleanControls).toBe('needs a human look');
    expect(s.negativesIncomplete).toBe(1);
  });

  it('an incomplete positive case keeps its known problems in the recall denominator', () => {
    const scores = [
      score({ caseId: 'a', known: 2, inTop: 2 }),
      score({ caseId: 'b', known: 2, inTop: 0, verdict: 'incomplete' }),
    ];
    const s = summarise('r', 'm', 'standard', scores, [replayCase({ id: 'a' }), replayCase({ id: 'b' })]);
    expect(s).toMatchObject({ knownTotal: 4, inTopTotal: 2, recallTop: 0.5, positivesIncomplete: 1 });
  });

  it('totals shared matches over positive cases', () => {
    const scores = [
      score({ caseId: 'a', sharedMatches: 2 }),
      score({ caseId: 'b', sharedMatches: 3 }),
      score({ caseId: 's', kind: 'secondary', sharedMatches: 4 }),
    ];
    const s = summarise('r', 'm', 'standard', scores, [replayCase({ id: 'a' }), replayCase({ id: 'b' }), replayCase({ id: 's', kind: 'secondary' })]);
    expect(s.sharedMatches).toBe(5);
  });

  it('a block on a negative case makes cleanControls need a human look', () => {
    const scores = [
      score({ caseId: 'n1', kind: 'negative', blockOrFixShown: 1 }),
      score({ caseId: 'n2', kind: 'negative', blockOrFixShown: 0, findingsShown: 2 }),
      score({ caseId: 'p', blockOrFixShown: 3 }),
    ];
    const cases = [replayCase({ id: 'n1', kind: 'negative' }), replayCase({ id: 'n2', kind: 'negative' }), replayCase({ id: 'p' })];
    const s = summarise('r', 'm', 'standard', scores, cases);
    expect(s.negativesWithBlockOrFix).toBe(1);
    expect(s.meets.cleanControls).toBe('needs a human look');
  });

  it('cleanControls is true when no negative case shows a block or fix', () => {
    const s = summarise('r', 'm', 'standard', [score({ caseId: 'n', kind: 'negative', findingsShown: 2 })], [replayCase({ id: 'n', kind: 'negative' })]);
    expect(s.meets.cleanControls).toBe(true);
  });

  it('lists incomplete cases and totals time and tokens over every case', () => {
    const scores = [
      score({ caseId: 'a', verdict: 'incomplete', ms: 100, inputTokens: 10, outputTokens: 1, agentRuns: 2 }),
      score({ caseId: 'b', kind: 'negative', ms: 50, inputTokens: 5, outputTokens: 2, agentRuns: 1 }),
      score({ caseId: 'c', kind: 'negative', verdict: 'incomplete' }),
    ];
    const cases = [replayCase({ id: 'a' }), replayCase({ id: 'b', kind: 'negative' }), replayCase({ id: 'c', kind: 'negative' })];
    const s = summarise('r', 'm', 'standard', scores, cases);
    expect(s.incompleteCases).toEqual(['a', 'c']);
    // With no spans recorded for the run, the total time is the sum of cases, and says so.
    expect(s.totals).toEqual({
      ms: 150, msSummed: true, inputTokens: 15, outputTokens: 3, agentRuns: 3, unfinishedTokens: 0, judgeTokens: 0, usageAbout: false,
    });
    expect(s.spans).toEqual([]);
  });

  it('the total time is the time the replay was running: one call gives its own duration', () => {
    const scores = [score({ caseId: 'a', ms: 600_000 }), score({ caseId: 'b', ms: 600_000 })];
    const cases = [replayCase({ id: 'a' }), replayCase({ id: 'b' })];
    const spans = [{ startedAt: '2026-11-10T09:00:00.000Z', finishedAt: '2026-11-10T09:15:00.000Z' }];
    const s = summarise('r', 'm', 'standard', scores, cases, cases, { spans });
    expect(s.totals).toMatchObject({ ms: 900_000, msSummed: false });
    expect(s.spans).toEqual(spans);
  });

  it('two calls an hour apart give the sum of their own durations, not the wait between them', () => {
    const scores = [score({ caseId: 'a', ms: 600_000 }), score({ caseId: 'b', ms: 600_000 })];
    const cases = [replayCase({ id: 'a' }), replayCase({ id: 'b' })];
    const spans = [
      { startedAt: '2026-11-10T09:00:00.000Z', finishedAt: '2026-11-10T09:15:00.000Z' },
      { startedAt: '2026-11-10T10:15:00.000Z', finishedAt: '2026-11-10T10:20:00.000Z' },
    ];
    expect(summarise('r', 'm', 'standard', scores, cases, cases, { spans }).totals).toMatchObject({ ms: 1_200_000, msSummed: false });
  });

  describe('how much of the dataset the run covers', () => {
    const dataset = [
      replayCase({ id: 'a', known: ['A1', 'A2'].map((id) => problem({ id })) }),
      replayCase({ id: 'b', known: ['B1', 'B2', 'B3'].map((id) => problem({ id })) }),
      replayCase({ id: 'c', known: ['C1'].map((id) => problem({ id })) }),
      replayCase({ id: 's', kind: 'secondary', known: ['S1', 'S2'].map((id) => problem({ id })) }),
      replayCase({ id: 'n', kind: 'negative', known: [] }),
    ];
    const pick = (...ids: string[]) => dataset.filter((c) => ids.includes(c.id));

    it('a run with every positive case, all finished, answers yes or no', () => {
      const yes = summarise('r', 'm', 'standard', [score({ caseId: 'a', known: 2, inTop: 2 }), score({ caseId: 'b', known: 3, inTop: 1 }), score({ caseId: 'c', known: 1 })], pick('a', 'b', 'c'), dataset);
      expect(yes).toMatchObject({ datasetKnownTotal: 6, datasetPositives: 3, positivesNotRun: [], knownTotal: 6, inTopTotal: 3 });
      expect(yes.meets.halfInTop).toBe(true);
      const no = summarise('r', 'm', 'standard', [score({ caseId: 'a', known: 2, inTop: 1 }), score({ caseId: 'b', known: 3, inTop: 1 }), score({ caseId: 'c', known: 1 })], pick('a', 'b', 'c'), dataset);
      expect(no.meets.halfInTop).toBe(false);
    });

    it('a partial run says so far and names the positive cases it did not run', () => {
      const s = summarise('r', 'm', 'standard', [score({ caseId: 'a', known: 2, inTop: 2 }), score({ caseId: 'n', kind: 'negative' })], pick('a', 'n'), dataset);
      expect(s).toMatchObject({ datasetKnownTotal: 6, datasetPositives: 3, positivesNotRun: ['b', 'c'], knownTotal: 2 });
      expect(s.meets.halfInTop).toBe('yes so far');
      const low = summarise('r', 'm', 'standard', [score({ caseId: 'b', known: 3, inTop: 1 })], pick('b'), dataset);
      expect(low.meets.halfInTop).toBe('no so far');
    });

    it('a run with every positive case, one of which did not finish, still says so far', () => {
      const s = summarise('r', 'm', 'standard', [
        score({ caseId: 'a', known: 2, inTop: 2 }), score({ caseId: 'b', known: 3, inTop: 3 }), score({ caseId: 'c', known: 1, verdict: 'incomplete' }),
      ], pick('a', 'b', 'c'), dataset);
      expect(s.positivesNotRun).toEqual([]);
      expect(s.meets.halfInTop).toBe('yes so far');
    });

    it('secondary cases are kept apart and change no headline number', () => {
      const positives = [score({ caseId: 'a', known: 2, inTop: 1, shown: 1, sharedMatches: 0 })];
      const secondary = score({ caseId: 's', kind: 'secondary', known: 2, knownDefects: 2, inTop: 2, shown: 2, defectsInTop: 2, crossFileKnown: 1, crossFileInTop: 1, sharedMatches: 2 });
      const without = summarise('r', 'm', 'standard', positives, pick('a'), dataset);
      const withSecondary = summarise('r', 'm', 'standard', [...positives, secondary], pick('a', 's'), dataset);
      expect(withSecondary.secondary).toEqual([secondary]);
      expect(without.secondary).toEqual([]);
      for (const key of ['knownTotal', 'inTopTotal', 'recallTop', 'recallShown', 'recallTopDefects', 'crossFileRecallTop', 'sharedMatches',
        'negativesWithBlockOrFix', 'positivesIncomplete', 'negativesIncomplete', 'datasetKnownTotal', 'datasetPositives', 'positivesNotRun', 'meets'] as const) {
        expect(withSecondary[key], key).toEqual(without[key]);
      }
    });

    it('without a dataset the cases in the run are the dataset', () => {
      const s = summarise('r', 'm', 'standard', [score({ caseId: 'a', known: 2, inTop: 1 })], pick('a'));
      expect(s).toMatchObject({ datasetKnownTotal: 2, datasetPositives: 1, positivesNotRun: [] });
      expect(s.meets.halfInTop).toBe(true);
    });
  });

  it('takes the kind of each case from the dataset and refuses a score with no case', () => {
    expect(() => summarise('r', 'm', 'standard', [score({ caseId: 'ghost' })], [replayCase()])).toThrow(/ghost/);
  });
});
