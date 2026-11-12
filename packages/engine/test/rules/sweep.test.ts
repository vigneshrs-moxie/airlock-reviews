import type { ChangeMap } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import { createFakeRunner } from '../../src/agent/fake-runner.js';
import { runSweep } from '../../src/rules/sweep.js';
import {
  block, cohort, ctx, diff, layer, lens, pack, rawCandidate, rule, tier,
} from '../helpers/lens-context.js';

const map: ChangeMap = {
  cohorts: [cohort('k1', 'Billing', [layer('k1.l1', 'writes', ['src/billing/a.ts', 'src/billing/b.ts', 'src/members/m.ts'])])],
  standalone: [], links: [],
};
const files = ['src/billing/a.ts', 'src/billing/b.ts', 'src/members/m.ts'];
const packs = [pack('core', [lens('boundary')], {
  standards: [{ name: 'Money', text: 'STANDARD_MARKER use cents.', dated: false }],
  rules: [
    rule('bill-1', ['src/billing/**'], { severityFloor: 'fix', body: 'Charges must be idempotent.' }),
    rule('mem-1', ['src/members/**'], { body: 'Members are scoped by office.' }),
  ],
})];
const sweepCtx = (over = {}) => ctx({ map, files: files.map((f) => diff(f)), tiers: files.map((f) => tier(f)), packs, ...over });
const sweepCandidate = (over: Record<string, unknown> = {}) =>
  rawCandidate({ path: 'src/billing/a.ts', ruleId: 'bill-1', severity: 'note', ...over });

describe('runSweep', () => {
  it('sends one request per group of changes with its role, model and directories', async () => {
    const runner = createFakeRunner(() => ({ candidates: [], questions: [] }));
    const r = await runSweep(runner, sweepCtx());
    expect(runner.calls.map((c) => c.role)).toEqual(['sweep:k1#1']);
    expect(runner.calls[0]).toMatchObject({ cwd: '/tmp/head', extraDirs: ['/tmp/base'], model: 'claude-haiku-5-5', effort: 'high' });
    expect(r.usage).toHaveLength(1);
  });

  it('a request carries the rules that matched its files, lists each file with its own rule ids, and the description in material', async () => {
    const unmatched = [pack('core', [lens('boundary')], { rules: [...packs[0]!.rules, rule('docs-1', ['docs/**'])] })];
    const runner = createFakeRunner(() => ({ candidates: [], questions: [] }));
    await runSweep(runner, sweepCtx({ packs: unmatched }));
    const [first] = runner.calls;
    expect(first!.instructions).toContain('### bill-1: Rule bill-1');
    expect(first!.instructions).toContain('Charges must be idempotent.');
    expect(first!.instructions).toContain('Applies to: src/billing/**');
    expect(first!.instructions).toContain('### mem-1: Rule mem-1');
    expect(first!.instructions).not.toContain('docs-1');
    expect(block(first!.material, 'files and their rules')!.split('\n')).toEqual([
      'src/billing/a.ts: bill-1', 'src/billing/b.ts: bill-1', 'src/members/m.ts: mem-1',
    ]);
    expect(first!.instructions).not.toContain('src/billing/a.ts');
    expect(first!.material).toContain('PR_BODY_MARKER');
    expect(first!.instructions).not.toContain('PR_BODY_MARKER');
    expect(block(first!.material, 'diff')).toContain('src/billing/a.ts');
    expect(block(first!.material, 'diff')).toContain('src/members/m.ts');
  });

  it('puts no pack standards in a sweep request', async () => {
    const runner = createFakeRunner(() => ({ candidates: [], questions: [] }));
    await runSweep(runner, sweepCtx());
    for (const c of runner.calls) {
      expect(c.instructions).not.toContain('STANDARD_MARKER');
      expect(c.material).not.toContain('STANDARD_MARKER');
    }
  });

  it('raises a note to the rule floor of fix and sets the source', async () => {
    const runner = createFakeRunner((req) => (req.role.endsWith('#1') ? { candidates: [sweepCandidate()], questions: [] } : { candidates: [], questions: [] }));
    const r = await runSweep(runner, sweepCtx());
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ severity: 'fix', cohortId: 'k1', source: { pack: 'core', lens: null, ruleId: 'bill-1' } });
  });

  it('does not lower a block to a fix floor', async () => {
    const runner = createFakeRunner((req) => (req.role.endsWith('#1') ? { candidates: [sweepCandidate({ severity: 'block' })], questions: [] } : { candidates: [], questions: [] }));
    const r = await runSweep(runner, sweepCtx());
    expect(r.candidates[0]!.severity).toBe('block');
  });

  it.each([
    ['fix', 'block', 'block'], ['fix', 'fix', 'fix'], ['fix', 'ask', 'ask'], ['fix', 'note', 'fix'],
    ['block', 'block', 'block'], ['block', 'fix', 'block'], ['block', 'ask', 'ask'], ['block', 'note', 'block'],
  ] as const)('against a %s floor, a %s candidate becomes %s: a doubt stays a doubt', async (floor, given, expected) => {
    const floored = [pack('core', [lens('boundary')], { rules: [rule('bill-1', ['src/billing/**'], { severityFloor: floor })] })];
    const runner = createFakeRunner((req) => (req.role.endsWith('#1') ? { candidates: [sweepCandidate({ severity: given })], questions: [] } : { candidates: [], questions: [] }));
    const r = await runSweep(runner, sweepCtx({ packs: floored }));
    expect(r.candidates.map((c) => c.severity)).toEqual([expected]);
  });

  it('prints each rule\'s floor beside it', async () => {
    const runner = createFakeRunner(() => ({ candidates: [], questions: [] }));
    await runSweep(runner, sweepCtx());
    expect(runner.calls[0]!.instructions).toContain('### bill-1: Rule bill-1\n\nCharges must be idempotent.');
    expect(runner.calls[0]!.instructions).toContain('Applies to: src/billing/**\nFloor: fix');
    expect(runner.calls[0]!.instructions).toContain('Applies to: src/members/**\nFloor: note');
  });

  it('drops a candidate that names a rule that was not given', async () => {
    const runner = createFakeRunner((req) => (req.role.endsWith('#1')
      ? { candidates: [sweepCandidate({ ruleId: 'other-9' }), sweepCandidate()], questions: [] } : { candidates: [], questions: [] }));
    const r = await runSweep(runner, sweepCtx());
    expect(r.candidates).toHaveLength(1);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]).toMatchObject({ stage: 'schema', reason: 'names a rule that was not given: other-9', refutation: null });
  });

  it('drops a candidate that applies a rule to a file the rule does not match', async () => {
    const runner = createFakeRunner(() => ({
      candidates: [sweepCandidate({ ruleId: 'mem-1' }), sweepCandidate({ ruleId: 'mem-1', path: 'src/members/m.ts' })], questions: [],
    }));
    const r = await runSweep(runner, sweepCtx());
    expect(r.candidates.map((c) => [c.source.ruleId, c.path])).toEqual([['mem-1', 'src/members/m.ts']]);
    expect(r.dropped.map((d) => [d.stage, d.reason])).toEqual([['schema', 'the rule mem-1 does not apply to src/billing/a.ts']]);
  });

  it('turns an invalid candidate into a question, and keeps at most 12 candidates per batch, as the prompt says', async () => {
    const many = Array.from({ length: 14 }, () => sweepCandidate());
    const runner = createFakeRunner((req) => (req.role.endsWith('#1')
      ? { candidates: [...many, { ruleId: 'bill-1', title: 'Half a thought' }], questions: ['Is this intended?'] } : { candidates: [], questions: [] }));
    const r = await runSweep(runner, sweepCtx());
    expect(r.candidates).toHaveLength(12);
    expect(r.dropped.map((d) => d.reason)).toEqual(Array(2).fill('more than 12 candidates from one sweep request'));
    expect(r.questions.map((q) => q.text).sort()).toEqual(['Half a thought', 'Is this intended?']);
    expect(new Set(r.candidates.map((c) => c.id)).size).toBe(12);
    expect(runner.calls[0]!.instructions).toContain('Return at most 12 candidates.');
  });

  it('keeps a sweep candidate that fails the schema as a dropped entry with its reason', async () => {
    const runner = createFakeRunner((req) => (req.role.endsWith('#1')
      ? { candidates: [sweepCandidate({ why: ' ' })], questions: [] } : { candidates: [], questions: [] }));
    const r = await runSweep(runner, sweepCtx());
    expect(r.candidates).toEqual([]);
    expect(r.questions).toEqual([]);
    expect(r.dropped.map((d) => [d.stage, d.reason])).toEqual([['schema', 'it does not say why']]);
  });

  it('a failed batch names at most its own eight files', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `src/billing/f${i}.ts`);
    const m: ChangeMap = { cohorts: [cohort('k1', 'Billing', [layer('k1.l1', 'writes', ten)])], standalone: [], links: [] };
    const runner = createFakeRunner((req) => (req.role === 'sweep:k1#2' ? new Error('boom') : { candidates: [], questions: [] }));
    const r = await runSweep(runner, sweepCtx({ map: m, files: ten.map((f) => diff(f)), tiers: ten.map((f) => tier(f)) }));
    expect(r.errors.map((e) => e.message)).toEqual(['batch 2 (src/billing/f8.ts, src/billing/f9.ts): boom']);
    const all = createFakeRunner(() => new Error('boom'));
    const first = (await runSweep(all, sweepCtx({ map: m, files: ten.map((f) => diff(f)), tiers: ten.map((f) => tier(f)) }))).errors[0]!;
    expect(first.message).toBe(`batch 1 (${ten.slice(0, 8).join(', ')}): boom`);
  });

  it('a failed batch becomes a stage error naming the batch and the others carry on', async () => {
    const m: ChangeMap = { ...map, standalone: ['src/members/s.ts'] };
    const fs = [...files, 'src/members/s.ts'];
    const runner = createFakeRunner((req) => (req.role === 'sweep:k1#1' ? new Error('boom') : { candidates: [sweepCandidate({ ruleId: 'mem-1', path: 'src/members/s.ts' })], questions: [] }));
    const r = await runSweep(runner, sweepCtx({ map: m, files: fs.map((f) => diff(f)), tiers: fs.map((f) => tier(f)) }));
    expect(r.errors).toEqual([{
      stage: 'sweep', cohortId: 'k1', message: 'batch 1 (src/billing/a.ts, src/billing/b.ts, src/members/m.ts): boom', kind: 'invalid-output',
    }]);
    expect(r.candidates).toHaveLength(1);
    expect(r.usage).toHaveLength(2);
  });

  it('numbers batches within each cohort, standalone included', async () => {
    const more = Array.from({ length: 6 }, (_, i) => `src/billing/n${i}.ts`);
    const m: ChangeMap = { cohorts: [cohort('k1', 'Billing', [layer('k1.l1', 'writes', [...files, ...more])])], standalone: ['src/billing/s.ts'], links: [] };
    const fs = [...files, ...more, 'src/billing/s.ts'];
    const runner = createFakeRunner(() => ({ candidates: [], questions: [] }));
    await runSweep(runner, sweepCtx({ map: m, files: fs.map((f) => diff(f)), tiers: fs.map((f) => tier(f)) }));
    expect(runner.calls.map((c) => c.role)).toEqual(['sweep:k1#1', 'sweep:k1#2', 'sweep:standalone#1']);
  });

  it('makes no request when there are no batches', async () => {
    const runner = createFakeRunner(() => ({ candidates: [], questions: [] }));
    const r = await runSweep(runner, sweepCtx({ packs: [pack('core', [lens('boundary')])] }));
    expect(runner.calls).toEqual([]);
    expect(r).toEqual({ candidates: [], questions: [], dropped: [], errors: [], usage: [], limits: [] });
  });

  it('says how much of a batch diff was shown when the sweep budget cut it', async () => {
    const big = files.map((f) => diff(f, f === 'src/billing/a.ts' ? 1500 : 3));
    const runner = createFakeRunner(() => ({ candidates: [], questions: [] }));
    const r = await runSweep(runner, sweepCtx({ files: big }));
    const shown = block(runner.calls[0]!.material, 'diff')!.split('\n').filter((l) => /^\s*\d* [+-] /.test(l)).length;
    expect(shown).toBeLessThan(1500);
    expect(r.limits).toEqual([`sweep: Billing, batch 1: ${shown.toLocaleString('en-US')} of 1,500 changed lines were shown (1 file cut)`]);
  });
});
