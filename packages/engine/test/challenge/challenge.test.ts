import type { Anchor, Candidate, Severity } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import type { AgentRequest } from '../../src/agent/runner.js';
import { createFakeRunner } from '../../src/agent/fake-runner.js';
import { challenge } from '../../src/challenge/challenge.js';
import { block, ctx, diff, labels, lens, models, pack } from '../helpers/lens-context.js';

const UNCONFIRMED = ' The refutation it offered could not be confirmed in the code, so the finding stands.';

const anchor: Anchor = { status: 'in-diff', startLine: 2, endLine: 2 };

function item(id: string, severity: Severity, over: Partial<Candidate & { anchor: Anchor }> = {}): Candidate & { anchor: Anchor } {
  return {
    id, source: { pack: 'core', lens: 'boundary', ruleId: null }, cohortId: 'k1', severity,
    title: `Finding ${id}`, path: 'src/pause.ts', quote: 'if (plan.active) charge(plan);', lineHint: 2,
    happens: 'A member who paused is charged.', why: 'The job checks active only.', suggestedChange: 'Skip paused plans.',
    connected: [], wouldBeWrongIf: 'The query already filters paused plans.', confidence: 'high', anchor, ...over,
  };
}

const answer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  outcome: 'keep', ground: 'none', explanation: 'Nothing refutes it.', refutation: null, newSeverity: null,
  checked: 'Read src/pause.ts and its caller src/charge.ts.', ...over,
});

const BASE_PAUSE = ['export function pause(plan) {', '  // already charged before this change', '  if (plan.active) charge(plan);', '}'].join('\n');
const HEAD_CHARGE = ['import { pause } from "./pause";', '', 'export function nightly(plans) {', '  for (const p of plans.filter((x) => !x.paused)) charge(p);', '}'].join('\n');

/** An in-memory `read` that records every call. */
function memoryRead(files: Record<string, string> = { 'base:src/pause.ts': BASE_PAUSE, 'head:src/charge.ts': HEAD_CHARGE }) {
  const calls: string[] = [];
  const read = async (where: 'head' | 'base', path: string): Promise<string | null> => {
    calls.push(`${where}:${path}`);
    return files[`${where}:${path}`] ?? null;
  };
  return { read, calls };
}

const idOf = (req: AgentRequest<unknown>): string => req.role.slice('challenge:'.length);

describe('challenge', () => {
  it('challenges block and fix and lets ask and note through', async () => {
    const runner = createFakeRunner(() => answer());
    const { read } = memoryRead();
    const r = await challenge(runner, ctx(), [item('c1', 'block'), item('c2', 'fix'), item('c3', 'ask'), item('c4', 'note')], read);
    expect(runner.calls.map((c) => c.role)).toEqual(['challenge:c1', 'challenge:c2']);
    expect(r.kept.map((k) => [k.id, k.severity, k.checked])).toEqual([
      ['c1', 'block', 'Read src/pause.ts and its caller src/charge.ts.'],
      ['c2', 'fix', 'Read src/pause.ts and its caller src/charge.ts.'],
      ['c3', 'ask', 'not challenged'],
      ['c4', 'note', 'not challenged'],
    ]);
    expect(r.dropped).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.usage).toHaveLength(2);
  });

  it('drops a candidate when the refutation quote is found on the base side', async () => {
    const runner = createFakeRunner(() => answer({
      outcome: 'drop', ground: 'pre-existing', explanation: 'The base branch charges active plans the same way.',
      refutation: { path: 'src/pause.ts', quote: 'if (plan.active) charge(plan);', where: 'base' },
    }));
    const { read } = memoryRead();
    const { anchor: _anchor, ...candidate } = item('c1', 'fix');
    const r = await challenge(runner, ctx(), [item('c1', 'fix')], read);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual([{
      candidate, stage: 'challenge', reason: 'pre-existing: The base branch charges active plans the same way.',
      refutation: { path: 'src/pause.ts', line: 3, role: 'base', quote: 'if (plan.active) charge(plan);' },
    }]);
  });

  it('records the found line and the head side for a confirmed drop', async () => {
    const runner = createFakeRunner(() => answer({
      outcome: 'drop', ground: 'guarded-elsewhere', explanation: 'The nightly job skips paused plans.',
      refutation: { path: 'src/charge.ts', quote: 'for (const p of plans.filter((x) => !x.paused)) charge(p);', where: 'head' },
    }));
    const { read } = memoryRead();
    const r = await challenge(runner, ctx(), [item('c1', 'block')], read);
    expect(r.dropped[0]!.refutation).toEqual({
      path: 'src/charge.ts', line: 4, role: 'head', quote: 'for (const p of plans.filter((x) => !x.paused)) charge(p);',
    });
    expect(r.dropped[0]!.reason).toBe('guarded-elsewhere: The nightly job skips paused plans.');
  });

  it('keeps a candidate when the refutation quote cannot be found', async () => {
    const runner = createFakeRunner(() => answer({
      outcome: 'drop', ground: 'guarded-elsewhere', explanation: 'A guard exists.',
      refutation: { path: 'src/charge.ts', quote: 'if (plan.paused) return;', where: 'head' },
    }));
    const { read } = memoryRead();
    const r = await challenge(runner, ctx(), [item('c1', 'fix')], read);
    expect(r.dropped).toEqual([]);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]!.severity).toBe('fix');
    expect(r.kept[0]!.checked).toBe(`Read src/pause.ts and its caller src/charge.ts.${UNCONFIRMED}`);
  });

  it('keeps a candidate when the refutation names a file that does not exist on that side', async () => {
    const runner = createFakeRunner(() => answer({
      outcome: 'drop', ground: 'pre-existing', explanation: 'Already there.',
      refutation: { path: 'src/charge.ts', quote: 'for (const p of plans.filter((x) => !x.paused)) charge(p);', where: 'base' },
    }));
    const { read } = memoryRead();
    const r = await challenge(runner, ctx(), [item('c1', 'fix')], read);
    expect(r.dropped).toEqual([]);
    expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
  });

  it('keeps a candidate when the agent says drop without a refutation', async () => {
    const runner = createFakeRunner(() => answer({ outcome: 'drop', ground: 'unreachable', explanation: 'Probably never called.' }));
    const { read, calls } = memoryRead();
    const r = await challenge(runner, ctx(), [item('c1', 'block')], read);
    expect(r.dropped).toEqual([]);
    expect(r.kept[0]!.severity).toBe('block');
    expect(r.kept[0]!.checked).toBe(`Read src/pause.ts and its caller src/charge.ts.${UNCONFIRMED}`);
    expect(calls).toEqual([]);
  });

  it.each(['/etc/passwd', '../outside/pause.ts', 'src/../../pause.ts', '  '])('does not honour a drop whose refutation path is %j', async (path) => {
    const runner = createFakeRunner(() => answer({
      outcome: 'drop', ground: 'pre-existing', explanation: 'Already there.',
      refutation: { path, quote: 'if (plan.active) charge(plan);', where: 'base' },
    }));
    const { read, calls } = memoryRead(new Proxy({}, { get: () => BASE_PAUSE }) as Record<string, string>);
    const r = await challenge(runner, ctx(), [item('c1', 'fix')], read);
    expect(r.dropped).toEqual([]);
    expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
    expect(calls).toEqual([]);
  });

  it('downgrades block to fix but ignores an attempt to raise note to block', async () => {
    const runner = createFakeRunner((req) => (idOf(req) === 'c1'
      ? answer({ outcome: 'downgrade', ground: 'smaller', explanation: 'Only one office uses it.', newSeverity: 'fix' })
      : answer({ outcome: 'downgrade', ground: 'smaller', explanation: 'Worse than rated.', newSeverity: 'block' })));
    const { read } = memoryRead();
    const r = await challenge(runner, ctx(), [item('c1', 'block'), item('c2', 'fix'), item('c3', 'note')], read);
    expect(runner.calls.map(idOf)).toEqual(['c1', 'c2']);
    expect(r.kept.map((k) => [k.id, k.severity])).toEqual([['c1', 'fix'], ['c2', 'fix'], ['c3', 'note']]);
    expect(r.kept[0]!.checked).toBe('Read src/pause.ts and its caller src/charge.ts.');
  });

  it('keeps the severity when a downgrade names no new severity', async () => {
    const runner = createFakeRunner(() => answer({ outcome: 'downgrade', ground: 'smaller', explanation: 'Smaller.' }));
    const { read } = memoryRead();
    const r = await challenge(runner, ctx(), [item('c1', 'block')], read);
    expect(r.kept[0]!.severity).toBe('block');
  });

  it('turns a finding that depends on a decision into an ask', async () => {
    const runner = createFakeRunner(() => answer({ outcome: 'ask', ground: 'documented-intent', explanation: 'Only the business knows.' }));
    const { read } = memoryRead();
    const r = await challenge(runner, ctx(), [item('c1', 'block')], read);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]!.severity).toBe('ask');
    expect(r.kept[0]!.checked).toBe('Read src/pause.ts and its caller src/charge.ts.');
  });

  it('keeps the candidate and records a stage error when the agent fails', async () => {
    const runner = createFakeRunner((req) => (idOf(req) === 'c1' ? new Error('timed out') : answer()));
    const { read } = memoryRead();
    const r = await challenge(runner, ctx(), [item('c1', 'block', { cohortId: 'k2' }), item('c2', 'fix')], read);
    expect(r.kept.map((k) => [k.id, k.severity, k.checked])).toEqual([
      ['c1', 'block', 'challenge did not complete'],
      ['c2', 'fix', 'Read src/pause.ts and its caller src/charge.ts.'],
    ]);
    expect(r.errors).toEqual([{ stage: 'challenge', cohortId: 'k2', message: 'c1: timed out' }]);
    expect(r.usage).toHaveLength(2);
  });

  it('keeps the input order and removes dropped items', async () => {
    const runner = createFakeRunner((req) => (idOf(req) === 'c2'
      ? answer({
        outcome: 'drop', ground: 'pre-existing', explanation: 'Already there.',
        refutation: { path: 'src/pause.ts', quote: 'if (plan.active) charge(plan);', where: 'base' },
      })
      : answer()));
    const { read } = memoryRead();
    const r = await challenge(runner, ctx(), [item('c1', 'note'), item('c2', 'fix'), item('c3', 'block'), item('c4', 'ask'), item('c5', 'fix')], read);
    expect(r.kept.map((k) => k.id)).toEqual(['c1', 'c3', 'c4', 'c5']);
    expect(r.dropped.map((d) => d.candidate.id)).toEqual(['c2']);
  });

  it('sends each request with its role, the challenger model, effort and directories', async () => {
    const runner = createFakeRunner(() => answer());
    const { read } = memoryRead();
    await challenge(runner, ctx({ models: { ...models, main: 'main-model', challenger: 'challenger-model' } }), [item('c1', 'fix')], read);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      role: 'challenge:c1', model: 'challenger-model', effort: 'high', cwd: '/tmp/head', extraDirs: ['/tmp/base'],
    });
  });

  it('sends each request through ctx.run', async () => {
    let wrapped = 0;
    const runner = createFakeRunner(() => answer());
    const { read } = memoryRead();
    await challenge(runner, ctx({ run: (fn) => { wrapped++; return fn(); } }), [item('c1', 'fix'), item('c2', 'block')], read);
    expect(wrapped).toBe(2);
  });

  it('puts the standards and learned entries in the instructions and the finding and description in the material', async () => {
    const runner = createFakeRunner(() => answer());
    const { read } = memoryRead();
    const packs = [pack('core', [lens('boundary')], {
      standards: [{ name: 'calibration.md', text: 'STANDARD_MARKER pauses may run 90 days.', dated: true }],
      learned: [{ date: '2026-11-01', repo: 'o/r', kind: 'intended', text: 'LEARNED_MARKER offices share plans.' }],
    })];
    await challenge(runner, ctx({ packs }), [item('c1', 'fix', {
      connected: [{ path: 'src/charge.ts', line: 4, role: 'the nightly charge runs here', quote: 'charge(p);' }],
    })], read);
    const req = runner.calls[0]!;
    expect(req.instructions).toMatch(/^Your job is to try to refute one finding about a pull request/);
    expect(req.instructions).toContain('Doubt, unfamiliarity or a sense that it is probably fine are not reasons to remove a finding.');
    expect(req.instructions).toContain('STANDARD_MARKER');
    expect(req.instructions).toContain('LEARNED_MARKER');
    expect(req.instructions).not.toContain('PR_BODY_MARKER');
    expect(req.material).not.toContain('STANDARD_MARKER');

    const finding = block(req.material, 'finding')!;
    for (const part of [
      'fix', 'Finding c1', 'src/pause.ts', 'src/pause.ts, line 2', 'if (plan.active) charge(plan);', 'A member who paused is charged.',
      'The job checks active only.', 'Skip paused plans.', 'src/charge.ts:4', 'the nightly charge runs here', 'charge(p);',
      'The query already filters paused plans.',
    ]) expect(finding).toContain(part);
    expect(block(req.material, 'pull request')).toContain('PR_BODY_MARKER');
    expect(block(req.material, 'pull request')).toContain('Let members pause a plan');
  });

  it('orders the material: finding, pull request, cohort, diff, facts, rule files', async () => {
    const runner = createFakeRunner(() => answer());
    const { read } = memoryRead();
    const files = [diff('src/pause.ts'), diff('src/charge.ts'), diff('src/totals.ts')];
    const facts = [
      { checkId: 'raw-sql', path: 'src/charge.ts', line: 3, message: 'FACT_CHARGE' },
      { checkId: 'raw-sql', path: 'src/totals.ts', line: 1, message: 'FACT_TOTALS' },
    ];
    await challenge(runner, ctx({ files, facts, repoRules: [{ path: 'CLAUDE.md', text: 'RULE_MARKER' }] }), [item('c1', 'fix', {
      connected: [{ path: 'src/charge.ts', line: 4, role: 'charges here', quote: 'charge(p);' }],
    })], read);
    const m = runner.calls[0]!.material;
    expect(labels(m)).toEqual(['finding', 'pull request', 'cohort', 'diff', 'facts', 'repository rule file CLAUDE.md']);
    expect(block(m, 'cohort')).toContain('Cohort: Pausing a plan');
    expect(block(m, 'diff')).toContain('src/pause.ts');
    expect(block(m, 'diff')).toContain('src/charge.ts');
    expect(block(m, 'diff')).not.toContain('src/totals.ts');
    expect(block(m, 'facts')).toContain('FACT_CHARGE');
    expect(block(m, 'facts')).not.toContain('FACT_TOTALS');
    expect(block(m, 'repository rule file CLAUDE.md')).toContain('RULE_MARKER');
  });

  it('says outside the diff for a finding anchored outside it, and leaves out the cohort when there is none', async () => {
    const runner = createFakeRunner(() => answer());
    const { read } = memoryRead();
    await challenge(runner, ctx(), [item('c1', 'fix', { cohortId: null, anchor: { status: 'outside-diff', startLine: 40, endLine: 41 } })], read);
    const m = runner.calls[0]!.material;
    expect(block(m, 'finding')).toContain('outside the diff');
    expect(labels(m)).not.toContain('cohort');
  });

  it('gives the standalone outline to a standalone finding', async () => {
    const runner = createFakeRunner(() => answer());
    const { read } = memoryRead();
    const map = { cohorts: [], standalone: ['src/pause.ts'], links: [] };
    await challenge(runner, ctx({ map }), [item('c1', 'fix', { cohortId: 'standalone' })], read);
    expect(block(runner.calls[0]!.material, 'cohort')).toContain('Standalone changes');
  });

  it('reads each side and path once in a run', async () => {
    const refute = { path: 'src/pause.ts', quote: 'if (plan.active) charge(plan);' };
    const runner = createFakeRunner((req) => answer({
      outcome: 'drop', ground: 'pre-existing', explanation: 'Already there.',
      refutation: { ...refute, where: idOf(req) === 'c3' ? 'head' : 'base' },
    }));
    const { read, calls } = memoryRead();
    const r = await challenge(runner, ctx(), [item('c1', 'fix'), item('c2', 'block'), item('c3', 'fix')], read);
    expect(calls.sort()).toEqual(['base:src/pause.ts', 'head:src/pause.ts']);
    expect(r.dropped.map((d) => d.candidate.id)).toEqual(['c1', 'c2']);
  });

  it('makes no runner call when nothing is challenged', async () => {
    const runner = createFakeRunner(() => answer());
    const { read, calls } = memoryRead();
    const r = await challenge(runner, ctx(), [item('c1', 'ask'), item('c2', 'note')], read);
    expect(runner.calls).toEqual([]);
    expect(calls).toEqual([]);
    expect(r.kept.map((k) => k.checked)).toEqual(['not challenged', 'not challenged']);
    expect(r.usage).toEqual([]);
    const empty = await challenge(runner, ctx(), [], read);
    expect(empty).toEqual({ kept: [], dropped: [], errors: [], usage: [] });
  });

  it('writes a default when the agent leaves checked empty', async () => {
    const runner = createFakeRunner(() => answer({ checked: '   ' }));
    const { read } = memoryRead();
    const r = await challenge(runner, ctx(), [item('c1', 'fix')], read);
    expect(r.kept[0]!.checked).toBe('checked, no refutation found');
  });

  it('trims the agent checked text', async () => {
    const runner = createFakeRunner(() => answer({ checked: '  Read the base branch.\n' }));
    const { read } = memoryRead();
    const r = await challenge(runner, ctx(), [item('c1', 'fix')], read);
    expect(r.kept[0]!.checked).toBe('Read the base branch.');
  });
});
