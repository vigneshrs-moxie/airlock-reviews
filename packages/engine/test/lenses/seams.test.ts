import { candidate } from '@airlock/shared';
import type { ChangeMap } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import { createFakeRunner } from '../../src/agent/fake-runner.js';
import { runSeams } from '../../src/lenses/seams.js';
import { block, ctx, diff, labels, lens, pack, pr, rawCandidate, tier, twoCohorts } from '../helpers/lens-context.js';

const empty = () => ({ candidates: [], questions: [] });
const soFar = [
  { ...candidate(), id: 'c_1', severity: 'block' as const, title: 'Paused plans are charged', path: 'src/pause.ts' },
  { ...candidate(), id: 'c_2', severity: 'note' as const, title: 'Totals round late', path: 'src/totals.ts' },
];

describe('runSeams', () => {
  it('the seams request contains every cohort title and no diff text', async () => {
    const map: ChangeMap = { ...twoCohorts, standalone: ['README.md'] };
    const runner = createFakeRunner(empty);
    await runSeams(runner, ctx({ map, files: [...ctx().files, diff('README.md')], tiers: [...ctx().tiers, tier('README.md')] }), soFar);
    expect(runner.calls).toHaveLength(1);
    const { material, role } = runner.calls[0]!;
    expect(role).toBe('seams');
    const outline = block(material, 'change map')!;
    expect(outline).toContain('Cohort: Pausing a plan');
    expect(outline).toContain('Cohort: Invoice totals');
    expect(outline).toContain('Layer k1.l2 (writes)');
    expect(outline).toContain('test/pause.test.ts');
    expect(outline).toContain('README.md');
    expect(material).not.toContain('## File:');
    expect(material).not.toMatch(/ line \d/);
    expect(material).not.toContain('@@');
  });

  it('sends the pull request, the brief, the change map, the facts and the candidates so far', async () => {
    const facts = [{ checkId: 'no-raw-sql', path: 'src/pause.ts', line: 4, message: 'Raw SQL in an action' }];
    const runner = createFakeRunner(empty);
    await runSeams(runner, ctx({ facts }), soFar);
    const { material } = runner.calls[0]!;
    expect(labels(material)).toEqual(['pull request', 'brief', 'change map', 'facts', 'candidates so far']);
    expect(block(material, 'pull request')).toContain('PR_BODY_MARKER');
    expect(block(material, 'brief')).toContain('[not-supported] Pauses are limited to 60 days');
    expect(block(material, 'facts')).toBe('src/pause.ts:4 no-raw-sql: Raw SQL in an action');
    expect(block(material, 'candidates so far')).toBe('block | Paused plans are charged | src/pause.ts\nnote | Totals round late | src/totals.ts');
  });

  it('carries the seams template, the standards and the learned entries in the instructions', async () => {
    const packs = [pack('core', [lens('boundary')], {
      standards: [{ name: 'Conventions', dated: false, text: 'STANDARD_CORE text' }],
      learned: [{ date: '2026-10-03', repo: 'acme/web', kind: 'intended', text: 'LEARNED_FACT entry' }],
    })];
    const runner = createFakeRunner(empty);
    await runSeams(runner, ctx({ packs }), []);
    const { instructions, material } = runner.calls[0]!;
    expect(instructions).toMatch(/release order/i);
    expect(instructions).toContain('STANDARD_CORE');
    expect(instructions).toContain('LEARNED_FACT');
    expect(material).not.toContain('STANDARD_CORE');
    expect(instructions).not.toContain('PR_BODY_MARKER');
    expect(runner.calls[0]).toMatchObject({ cwd: '/tmp/head', extraDirs: ['/tmp/base'], model: 'claude-opus-5-5', effort: 'high' });
  });

  it('gives its candidates the seams source and no cohort', async () => {
    const runner = createFakeRunner(() => ({ candidates: [rawCandidate()], questions: ['Which ships first?'] }));
    const r = await runSeams(runner, ctx(), []);
    const source = { pack: 'airlock', lens: 'seams', ruleId: null };
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ source, cohortId: null });
    expect(r.candidates[0]!.id).toMatch(/^c_[0-9a-f]{8}$/);
    expect(r.questions).toEqual([{ text: 'Which ships first?', cohortId: null, source }]);
    expect(r.usage).toHaveLength(1);
  });

  it('never reuses the id of a candidate found so far', async () => {
    const runner = createFakeRunner(() => ({ candidates: [rawCandidate()], questions: [] }));
    const r = await runSeams(runner, ctx(), soFar);
    expect(soFar.map((c) => c.id)).not.toContain(r.candidates[0]!.id);
  });

  it('makes no request for a single cohort', async () => {
    const map: ChangeMap = { ...twoCohorts, cohorts: [twoCohorts.cohorts[0]!] };
    const runner = createFakeRunner(empty);
    const r = await runSeams(runner, ctx({ map }), soFar);
    expect(runner.calls).toEqual([]);
    expect(r).toEqual({ candidates: [], questions: [], dropped: [], errors: [], usage: [], limits: [] });
  });

  it('counts the standalone group as a cohort when it has files to read', async () => {
    const one: ChangeMap = { ...twoCohorts, cohorts: [twoCohorts.cohorts[0]!], standalone: ['README.md'] };
    const files = [...ctx().files, diff('README.md')];
    const read = createFakeRunner(empty);
    await runSeams(read, ctx({ map: one, files, tiers: [...ctx().tiers, tier('README.md', 'skim')] }), []);
    expect(read.calls).toHaveLength(1);
    const trusted = createFakeRunner(empty);
    await runSeams(trusted, ctx({ map: one, files, tiers: [...ctx().tiers, tier('README.md', 'trust')] }), []);
    expect(trusted.calls).toEqual([]);
  });

  it('a failed seams pass becomes a stage error', async () => {
    const runner = createFakeRunner(() => new Error('model timed out'));
    const r = await runSeams(runner, ctx(), []);
    expect(r.errors).toEqual([{ stage: 'seams', cohortId: null, message: 'airlock/seams: model timed out' }]);
    expect(r.candidates).toEqual([]);
    expect(r.usage).toHaveLength(1);
  });

  it('names the reader from who opened the pull request and who is reviewing it', async () => {
    const own = createFakeRunner(empty);
    await runSeams(own, ctx({ pr: { ...pr, author: 'alice', viewer: 'alice' } }), []);
    expect(own.calls[0]!.instructions).toContain('The reader is the author, who will fix what you find before a senior reviewer sees the pull request.');
    const other = createFakeRunner(empty);
    await runSeams(other, ctx({ pr: { ...pr, author: 'alice', viewer: 'bob' } }), []);
    expect(other.calls[0]!.instructions).toContain('The reader is a reviewer deciding whether to ask the author for changes, who will pass on what you find in their own words.');
    expect(other.calls[0]!.instructions).toMatch(/Write so the reader can act/);
  });

  it('cuts a long description at 20,000 characters and says so', async () => {
    const runner = createFakeRunner(empty);
    await runSeams(runner, ctx({ pr: { ...pr, body: 'a'.repeat(20_500) } }), []);
    const text = block(runner.calls[0]!.material, 'pull request')!;
    expect(text).toContain('a'.repeat(20_000));
    expect(text).not.toContain('a'.repeat(20_001));
    expect(text).toContain('(description cut at 20000 characters)');
  });

  it('goes through the parallel cap', async () => {
    let wrapped = 0;
    const runner = createFakeRunner(empty);
    await runSeams(runner, ctx({ run: (fn) => { wrapped++; return fn(); } }), []);
    expect(wrapped).toBe(1);
  });
});
