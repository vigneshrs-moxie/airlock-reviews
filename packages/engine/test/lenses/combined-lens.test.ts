import { readFileSync } from 'node:fs';
import type { ChangeMap } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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

  it('keeps each candidate\'s lens in its source, and drops one with a missing lens id with a reason', async () => {
    const runner = createFakeRunner(() => ({
      candidates: [
        rawCandidate({ lens: 'extra/jobs', title: 'Jobs one' }),
        rawCandidate({ lens: ' core/boundary ', title: 'Boundary one' }),
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
      ['No lens', 'schema', 'names no lens'],
    ]);
    expect(r.questions.map((q) => q.text)).toEqual(['Who decided the limit?']);
    expect(new Set(r.candidates.map((c) => c.cohortId))).toEqual(new Set(['k1']));
  });

  it('sends a schema whose lens field lists exactly the ids of the lenses the request carries', async () => {
    const runner = createFakeRunner(empty);
    const one = [pack('solo', [lens('only')])];
    await runCohortLenses(runner, ctx({ packs, combine: 'all', map: { ...ctx().map, cohorts: [ctx().map.cohorts[0]!] } }));
    await runCohortLenses(runner, ctx({ packs: one, combine: 'all', map: { ...ctx().map, cohorts: [ctx().map.cohorts[0]!] } }));
    const lensField = (req: AgentRequest<unknown>) => {
      const json = z.toJSONSchema(req.schema, { target: 'draft-7' }) as unknown as {
        properties: { candidates: { items: { properties: { lens: { enum?: string[] } } } } };
      };
      return json.properties.candidates.items.properties.lens.enum;
    };
    expect(runner.calls.map(lensField)).toEqual([['core/boundary', 'core/money', 'extra/jobs'], ['solo/only']]);
  });

  it('refuses an answer naming a lens it was not given, so the runner asks for it again', async () => {
    const runner = createFakeRunner(() => ({ candidates: [rawCandidate({ lens: 'correctness' })], questions: [] }));
    const r = await runCohortLenses(runner, ctx({ packs, combine: 'all', map: { ...ctx().map, cohorts: [ctx().map.cohorts[0]!] } }));
    expect(r.candidates).toEqual([]);
    expect(r.errors).toEqual([expect.objectContaining({ stage: 'lenses', cohortId: 'k1', kind: 'invalid-output' })]);
  });

  it('the template\'s worked example passes the schema the request is sent with', async () => {
    const template = readFileSync(new URL('../../prompts/lens-combined.md', import.meta.url), 'utf8');
    const example = JSON.parse(/## Example[\s\S]*?```json\n([\s\S]*?)\n```/.exec(template)![1]!) as { lens: string };
    const [packId, lensId] = example.lens.split('/');
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ packs: [pack(packId!, [lens(lensId!)])], combine: 'all', map: { ...ctx().map, cohorts: [ctx().map.cohorts[0]!] } }));
    const parsed = runner.calls[0]!.schema.safeParse({ candidates: [example], questions: [] });
    expect(parsed.success).toBe(true);
    expect(runner.calls[0]!.instructions).toContain(`### ${example.lens}:`);
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
