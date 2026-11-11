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
  it('sends one request per batch with its role, model and directories', async () => {
    const runner = createFakeRunner(() => ({ candidates: [], questions: [] }));
    const r = await runSweep(runner, sweepCtx());
    expect(runner.calls.map((c) => c.role)).toEqual(['sweep:k1#1', 'sweep:k1#2']);
    expect(runner.calls[0]).toMatchObject({ cwd: '/tmp/head', extraDirs: ['/tmp/base'], model: 'claude-haiku-5-5', effort: 'high' });
    expect(r.usage).toHaveLength(2);
  });

  it('a request carries only the rules that matched its files, and the description in material', async () => {
    const runner = createFakeRunner(() => ({ candidates: [], questions: [] }));
    await runSweep(runner, sweepCtx());
    const [first, second] = runner.calls;
    expect(first!.instructions).toContain('### bill-1: Rule bill-1');
    expect(first!.instructions).toContain('Charges must be idempotent.');
    expect(first!.instructions).toContain('Applies to: src/billing/**');
    expect(first!.instructions).not.toContain('mem-1');
    expect(second!.instructions).toContain('### mem-1: Rule mem-1');
    expect(second!.instructions).not.toContain('bill-1');
    expect(first!.material).toContain('PR_BODY_MARKER');
    expect(first!.instructions).not.toContain('PR_BODY_MARKER');
    expect(block(first!.material, 'diff')).toContain('src/billing/a.ts');
    expect(block(first!.material, 'diff')).not.toContain('src/members/m.ts');
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

  it('drops a candidate that names a rule that was not given', async () => {
    const runner = createFakeRunner((req) => (req.role.endsWith('#1')
      ? { candidates: [sweepCandidate({ ruleId: 'mem-1' }), sweepCandidate()], questions: [] } : { candidates: [], questions: [] }));
    const r = await runSweep(runner, sweepCtx());
    expect(r.candidates).toHaveLength(1);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]).toMatchObject({ stage: 'schema', reason: 'names a rule that was not given: mem-1', refutation: null });
  });

  it('turns an invalid candidate into a question, and keeps at most 6 candidates per batch', async () => {
    const many = Array.from({ length: 8 }, () => sweepCandidate());
    const runner = createFakeRunner((req) => (req.role.endsWith('#1')
      ? { candidates: [...many, { ruleId: 'bill-1', title: 'Half a thought' }], questions: ['Is this intended?'] } : { candidates: [], questions: [] }));
    const r = await runSweep(runner, sweepCtx());
    expect(r.candidates).toHaveLength(6);
    expect(r.dropped.map((d) => d.reason)).toEqual(Array(2).fill('more than 6 candidates from one lens'));
    expect(r.questions.map((q) => q.text).sort()).toEqual(['Half a thought', 'Is this intended?']);
    expect(new Set(r.candidates.map((c) => c.id)).size).toBe(6);
  });

  it('a failed batch becomes a stage error naming the batch and the others carry on', async () => {
    const runner = createFakeRunner((req) => (req.role.endsWith('#1') ? new Error('boom') : { candidates: [sweepCandidate({ ruleId: 'mem-1', path: 'src/members/m.ts' })], questions: [] }));
    const r = await runSweep(runner, sweepCtx());
    expect(r.errors).toEqual([{ stage: 'sweep', cohortId: 'k1', message: 'batch 1: boom' }]);
    expect(r.candidates).toHaveLength(1);
    expect(r.usage).toHaveLength(2);
  });

  it('numbers batches within each cohort, standalone included', async () => {
    const m: ChangeMap = { ...map, standalone: ['src/billing/s.ts'] };
    const fs = [...files, 'src/billing/s.ts'];
    const runner = createFakeRunner(() => ({ candidates: [], questions: [] }));
    await runSweep(runner, sweepCtx({ map: m, files: fs.map((f) => diff(f)), tiers: fs.map((f) => tier(f)) }));
    expect(runner.calls.map((c) => c.role)).toEqual(['sweep:k1#1', 'sweep:k1#2', 'sweep:standalone#1']);
  });

  it('makes no request when there are no batches', async () => {
    const runner = createFakeRunner(() => ({ candidates: [], questions: [] }));
    const r = await runSweep(runner, sweepCtx({ packs: [pack('core', [lens('boundary')])] }));
    expect(runner.calls).toEqual([]);
    expect(r).toEqual({ candidates: [], questions: [], dropped: [], errors: [], usage: [] });
  });
});
