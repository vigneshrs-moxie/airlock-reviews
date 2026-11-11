import type { ChangeMap } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import { createFakeRunner } from '../../src/agent/fake-runner.js';
import type { AgentRequest } from '../../src/agent/runner.js';
import { MAX_CANDIDATES_COMBINED, runCohortLenses } from '../../src/lenses/cohort-lens.js';
import { block, ctx, lens, pack, rawCandidate, tier } from '../helpers/lens-context.js';

const empty = () => ({ candidates: [], questions: [] });
const packs = [
  pack('core', [lens('boundary', { instructions: 'BOUNDARY_BRIEF look at who can see what.' }), lens('money')]),
  pack('extra', [lens('jobs', { instructions: 'JOBS_BRIEF look at scheduled work.' })]),
];
const cohortOf = (req: AgentRequest<unknown>): string => block(req.material, 'cohort')!.split('\n')[0]!;

/** twoCohorts plus a standalone read file: k1 has read files, k2 only a skim file. */
const withStandalone = (): Partial<Parameters<typeof ctx>[0]> => {
  const base = ctx();
  const map: ChangeMap = { ...base.map, standalone: ['src/alone.ts'] };
  return { map, files: [...base.files, ...[base.files[0]!].map((f) => ({ ...f, path: 'src/alone.ts' }))], tiers: [...base.tiers, tier('src/alone.ts')] };
};

describe('combined lens requests', () => {
  it('quick depth makes one combined request per group, carrying every lens brief under its id', async () => {
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ packs, combine: 'all', ...withStandalone() }));
    expect(runner.calls.map((c) => c.role)).toEqual(['lens:combined', 'lens:combined', 'lens:combined']);
    expect(runner.calls.map(cohortOf)).toEqual(['Cohort: Pausing a plan', 'Cohort: Invoice totals', 'Cohort: Standalone changes']);
    const { instructions } = runner.calls[0]!;
    for (const id of ['core/boundary', 'core/money', 'extra/jobs']) expect(instructions).toContain(`### ${id}:`);
    expect(instructions).toContain('BOUNDARY_BRIEF');
    expect(instructions).toContain('JOBS_BRIEF');
    expect(instructions).toContain(`at most ${MAX_CANDIDATES_COMBINED}`);
  });

  it('standard depth with the default makes the separate lens requests as before', async () => {
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ packs }));
    expect(runner.calls.map((c) => c.role)).toEqual([
      'lens:core/boundary', 'lens:core/money', 'lens:extra/jobs', 'lens:core/boundary', 'lens:core/money', 'lens:extra/jobs',
    ]);
  });

  it('with no-read-tier, a group with a read-tier file gets separate requests, and a group without one and the standalone group one each', async () => {
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ packs, combine: 'no-read-tier', ...withStandalone() }));
    expect(runner.calls.map((c) => [cohortOf(c), c.role])).toEqual([
      ['Cohort: Pausing a plan', 'lens:core/boundary'], ['Cohort: Pausing a plan', 'lens:core/money'], ['Cohort: Pausing a plan', 'lens:extra/jobs'],
      ['Cohort: Invoice totals', 'lens:combined'],
      ['Cohort: Standalone changes', 'lens:combined'],
    ]);
  });

  it('keeps each candidate\'s lens in its source, and drops one with an unknown or missing lens id with a reason', async () => {
    const runner = createFakeRunner(() => ({
      candidates: [
        rawCandidate({ lens: 'extra/jobs', title: 'Jobs one' }),
        rawCandidate({ lens: ' core/boundary ', title: 'Boundary one' }),
        rawCandidate({ lens: 'core/made-up', title: 'Made up' }),
        rawCandidate({ title: 'No lens' }),
      ],
      questions: ['Who decided the limit?'],
    }));
    const r = await runCohortLenses(runner, ctx({ packs, combine: 'all', map: { ...ctx().map, cohorts: [ctx().map.cohorts[0]!] } }));
    expect(r.candidates.map((c) => [c.title, c.source])).toEqual([
      ['Jobs one', { pack: 'extra', lens: 'jobs', ruleId: null }],
      ['Boundary one', { pack: 'core', lens: 'boundary', ruleId: null }],
    ]);
    expect(r.dropped.map((d) => [d.candidate.title, d.stage, d.reason])).toEqual([
      ['Made up', 'schema', 'names a lens that was not given: core/made-up'],
      ['No lens', 'schema', 'names no lens'],
    ]);
    expect(r.questions.map((q) => q.text)).toEqual(['Who decided the limit?']);
    expect(new Set(r.candidates.map((c) => c.cohortId))).toEqual(new Set(['k1']));
  });

  it('keeps at most ten candidates from one combined request', async () => {
    const runner = createFakeRunner(() => ({
      candidates: Array.from({ length: 12 }, (_, i) => rawCandidate({ lens: i % 2 === 0 ? 'core/boundary' : 'core/money', title: `C${i}` })),
      questions: [],
    }));
    const r = await runCohortLenses(runner, ctx({ packs, combine: 'all', map: { ...ctx().map, cohorts: [ctx().map.cohorts[0]!] } }));
    expect(r.candidates).toHaveLength(MAX_CANDIDATES_COMBINED);
    expect(r.dropped.map((d) => d.reason)).toEqual(Array(2).fill(`more than ${MAX_CANDIDATES_COMBINED} candidates from one combined request`));
  });

  it('a failed combined request is a stage error naming the group', async () => {
    const runner = createFakeRunner(() => new Error('bad answer'));
    const r = await runCohortLenses(runner, ctx({ packs, combine: 'all', map: { ...ctx().map, cohorts: [ctx().map.cohorts[0]!] } }));
    expect(r.errors).toEqual([{ stage: 'lenses', cohortId: 'k1', message: 'airlock/combined: bad answer', kind: 'invalid-output' }]);
  });
});
