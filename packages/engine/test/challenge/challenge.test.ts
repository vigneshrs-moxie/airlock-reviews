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

const BASE_PAUSE = [
  'export function pause(plan) {', '  // already charged before this change', '  if (plan.active) charge(plan);', '}',
  'function noop() {', '  return;', '}',
  'function guard(plan) {', '  if (plan.paused) return false;', '}',
].join('\n');
const HEAD_PAUSE = ['export function pause(plan) {', '  if (plan.active) charge(plan);', '}'].join('\n');
const HEAD_CHARGE = [
  'import { pause } from "./pause";', '', 'export function nightly(plans) {', '  for (const p of plans.filter((x) => !x.paused)) charge(p);', '}',
  'function noop() {', '  return;', '}',
].join('\n');

/** src/pause.ts changed only at line 20, so the finding's line 2 is outside every hunk and can be pre-existing. */
const PAUSE_LINE_2_UNCHANGED = diff('src/pause.ts', 0, {
  hunks: [{
    oldStart: 20, oldLines: 0, newStart: 20, newLines: 1, header: '@@ -20,0 +20,1 @@',
    lines: [{ kind: 'add', oldNo: null, newNo: 20, text: '  log(plan);' }],
  }],
});
/** src/pause.ts with a guard deleted directly above the finding's unchanged line 2, in the same hunk. */
const PAUSE_GUARD_DELETED_ABOVE = diff('src/pause.ts', 0, {
  hunks: [{
    oldStart: 2, oldLines: 2, newStart: 2, newLines: 1, header: '@@ -2,2 +2,1 @@',
    lines: [
      { kind: 'del', oldNo: 2, newNo: null, text: '  if (plan.paused) return;' },
      { kind: 'ctx', oldNo: 3, newNo: 2, text: '  if (plan.active) charge(plan);' },
    ],
  }],
});
const UNCHANGED_FILES = [PAUSE_LINE_2_UNCHANGED, diff('src/charge.ts')];
const unchangedCtx = () => ctx({ files: UNCHANGED_FILES });

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
    const r = await challenge(runner, unchangedCtx(), [item('c1', 'fix')], read);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual([{
      candidate, stage: 'challenge',
      reason: 'pre-existing: The base branch charges active plans the same way. (proof: src/pause.ts:3 on the base)',
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
    expect(r.dropped[0]!.reason).toBe('guarded-elsewhere: The nightly job skips paused plans. (proof: src/charge.ts:4 on the head)');
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
      outcome: 'drop', ground: 'guarded-elsewhere', explanation: 'Guarded.',
      refutation: { path: 'src/missing.ts', quote: 'for (const p of plans.filter((x) => !x.paused)) charge(p);', where: 'head' },
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

  it.each([
    '/etc/passwd', '../outside/pause.ts', 'src/../../pause.ts', '  ', '', '%2e%2e/x.ts', 'C:\\x\\y.ts', 'src\\pause.ts',
    'src/a:b.ts', 'src/\u0000x.ts', 'src//pause.ts', 'src/',
  ])('does not honour a drop whose refutation path is %j, and never reads it', async (path) => {
    const runner = createFakeRunner(() => answer({
      outcome: 'drop', ground: 'guarded-elsewhere', explanation: 'Guarded.',
      refutation: { path, quote: 'if (plan.active) charge(plan);', where: 'head' },
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
    const r = await challenge(runner, unchangedCtx(), [item('c1', 'note'), item('c2', 'fix'), item('c3', 'block'), item('c4', 'ask'), item('c5', 'fix')], read);
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
      outcome: 'drop', ground: idOf(req) === 'c3' ? 'guarded-elsewhere' : 'pre-existing', explanation: 'Already there.',
      refutation: { ...refute, where: idOf(req) === 'c3' ? 'head' : 'base' },
    }));
    const { read, calls } = memoryRead();
    const r = await challenge(runner, unchangedCtx(), [item('c1', 'fix'), item('c2', 'block'), item('c3', 'fix')], read);
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

  describe('accepts a refutation only on full, relevant proof', () => {
    const GUARD = 'for (const p of plans.filter((x) => !x.paused)) charge(p);';
    const drop = (ground: string, refutation: Record<string, unknown> | null, over: Record<string, unknown> = {}) =>
      answer({ outcome: 'drop', ground, explanation: 'EXPLANATION_MARKER the code shows it.', refutation, ...over });
    const FILES: Record<string, string> = {
      'base:src/pause.ts': BASE_PAUSE, 'head:src/charge.ts': HEAD_CHARGE, 'head:src/pause.ts': HEAD_PAUSE,
      'base:src/util/strings.ts': 'export const trimAll = (s) => s.trim();', 'base:src/old-pause.ts': BASE_PAUSE,
    };
    const run = async (
      reply: Record<string, unknown>,
      over: Partial<Parameters<typeof ctx>[0]> = {},
      severity: Severity = 'fix',
      opts: { item?: Partial<Candidate & { anchor: Anchor }>; files?: Record<string, string> } = {},
    ) => {
      const { read, calls } = memoryRead({ ...FILES, ...opts.files });
      const r = await challenge(createFakeRunner(() => reply), ctx(over), [item('c1', severity, opts.item)], read);
      return { r, calls };
    };
    const OWN = 'if (plan.active) charge(plan);';

    it('does not take base code as proof that the head is guarded', async () => {
      const { r } = await run(drop('guarded-elsewhere', { path: 'src/pause.ts', quote: 'if (plan.paused) return false;', where: 'base' }));
      expect(r.dropped).toEqual([]);
      expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
    });

    it('does not take the finding\'s own line on the base as proof it is unreachable', async () => {
      const { r } = await run(drop('unreachable', { path: 'src/pause.ts', quote: OWN, where: 'base' }));
      expect(r.dropped).toEqual([]);
      expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
    });

    it('treats the finding\'s own code as its own when any copy of the quote overlaps it', async () => {
      const twice = ['function a(plan) {', `  ${OWN}`, '}', 'export function pause(plan) {', `  ${OWN}`, '}'].join('\n');
      const { r } = await run(drop('guarded-elsewhere', { path: 'src/pause.ts', quote: OWN, where: 'head' }), {}, 'fix', {
        item: { anchor: { status: 'in-diff', startLine: 5, endLine: 5 }, lineHint: 5 }, files: { 'head:src/pause.ts': twice },
      });
      expect(r.dropped).toEqual([]);
      expect(r.kept[0]!.checked).toContain('EXPLANATION_MARKER');
      expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
    });

    it('recognises the finding\'s own file when the finding\'s path starts with ./', async () => {
      const { r } = await run(drop('guarded-elsewhere', { path: 'src/pause.ts', quote: OWN, where: 'head' }), {}, 'fix', {
        item: { path: './src/pause.ts' },
      });
      expect(r.dropped).toEqual([]);
      expect(r.kept[0]!.checked).toContain('EXPLANATION_MARKER');
    });

    it('recognises the finding\'s own file when the refutation path differs only in letter case', async () => {
      const { r } = await run(drop('guarded-elsewhere', { path: 'SRC/Pause.ts', quote: OWN, where: 'head' }), {}, 'fix', {
        files: { 'head:SRC/Pause.ts': HEAD_PAUSE },
      });
      expect(r.dropped).toEqual([]);
      expect(r.kept[0]!.checked).toContain('EXPLANATION_MARKER');
    });

    describe('pre-existing', () => {
      const ALREADY = { path: 'src/pause.ts', quote: '// already charged before this change', where: 'base' };

      it('does not count a context line inside a hunk, beside a deleted guard, as pre-existing', async () => {
        const { r } = await run(drop('pre-existing', ALREADY), { files: [PAUSE_GUARD_DELETED_ABOVE] });
        expect(r.dropped).toEqual([]);
        expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
      });

      it('honours the same code when it is outside every hunk of its file', async () => {
        const { r } = await run(drop('pre-existing', ALREADY), { files: [PAUSE_LINE_2_UNCHANGED] });
        expect(r.dropped[0]!.refutation).toEqual({ path: 'src/pause.ts', line: 3, role: 'base', quote: OWN });
      });

      it('honours a file that is not in the diff at all', async () => {
        const { r } = await run(drop('pre-existing', ALREADY), { files: [diff('src/charge.ts')] });
        expect(r.dropped).toHaveLength(1);
      });

      it('matches the finding\'s file when the refutation path differs only in letter case, and records the real path', async () => {
        const { r } = await run(drop('pre-existing', { ...ALREADY, path: 'SRC/Pause.ts' }), { files: UNCHANGED_FILES });
        expect(r.dropped[0]!.refutation).toEqual({ path: 'src/pause.ts', line: 3, role: 'base', quote: OWN });
      });

      it('does not take a quote from another base file as proof', async () => {
        const { r } = await run(drop('pre-existing', { path: 'src/util/strings.ts', quote: 'export const trimAll = (s) => s.trim();', where: 'base' }), { files: UNCHANGED_FILES });
        expect(r.dropped).toEqual([]);
        expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
      });

      it('records the finding\'s own quote where it is found in the base version of its file', async () => {
        const { r } = await run(drop('pre-existing', ALREADY), { files: UNCHANGED_FILES });
        expect(r.kept).toEqual([]);
        expect(r.dropped[0]!.refutation).toEqual({ path: 'src/pause.ts', line: 3, role: 'base', quote: OWN });
      });

      it('does not count a line this pull request added as pre-existing', async () => {
        const { r } = await run(drop('pre-existing', ALREADY));
        expect(r.dropped).toEqual([]);
        expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
      });

      it('keeps the finding when its own quote is not in the base file', async () => {
        const { r } = await run(drop('pre-existing', ALREADY), { files: UNCHANGED_FILES }, 'fix', { files: { 'base:src/pause.ts': 'export function pause(plan) {\n  // already charged before this change\n}' } });
        expect(r.dropped).toEqual([]);
      });

      it('matches a renamed file by its old path', async () => {
        const renamed = { ...PAUSE_LINE_2_UNCHANGED, status: 'renamed' as const, oldPath: 'src/old-pause.ts' };
        const { r } = await run(drop('pre-existing', { ...ALREADY, path: 'src/old-pause.ts' }), { files: [renamed] });
        expect(r.dropped[0]!.refutation).toEqual({ path: 'src/old-pause.ts', line: 3, role: 'base', quote: OWN });
      });
    });

    it('does not confirm a quote with one real line and one invented line', async () => {
      const { r } = await run(drop('guarded-elsewhere', { path: 'src/charge.ts', quote: `if (plan.paused) return;\n${GUARD}`, where: 'head' }));
      expect(r.dropped).toEqual([]);
      expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
    });

    it('does not confirm an invented guard joined to the finding\'s own line', async () => {
      const { r } = await run(drop('guarded-elsewhere', { path: 'src/pause.ts', quote: 'if (plan.paused) return;\nif (plan.active) charge(plan);', where: 'head' }));
      expect(r.dropped).toEqual([]);
      expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
    });

    it('treats a drop on the ground smaller as a downgrade', async () => {
      const lower = await run(drop('smaller', null, { newSeverity: 'fix' }), {}, 'block');
      expect(lower.r.dropped).toEqual([]);
      expect(lower.r.kept[0]).toMatchObject({ severity: 'fix', checked: 'Read src/pause.ts and its caller src/charge.ts.' });
      const confirmable = { path: 'src/charge.ts', quote: GUARD, where: 'head' };
      const same = await run(drop('smaller', confirmable, { newSeverity: 'block' }), {}, 'block');
      expect(same.r.dropped).toEqual([]);
      expect(same.r.kept[0]).toMatchObject({ severity: 'block', checked: 'Read src/pause.ts and its caller src/charge.ts.' });
    });

    it('keeps a drop on the ground none, even with a quote that exists', async () => {
      const { r } = await run(drop('none', { path: 'src/charge.ts', quote: GUARD, where: 'head' }));
      expect(r.dropped).toEqual([]);
      expect(r.kept[0]!.checked).toBe(`Read src/pause.ts and its caller src/charge.ts.${UNCONFIRMED}`);
    });

    it('needs the base side for a pre-existing fault', async () => {
      const { r, calls } = await run(drop('pre-existing', { path: 'src/charge.ts', quote: GUARD, where: 'head' }));
      expect(r.dropped).toEqual([]);
      expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
      expect(calls).toEqual([]);
    });

    it.each(['}', 'return;'])('does not confirm the trivial quote %j', async (quote) => {
      const { r } = await run(drop('guarded-elsewhere', { path: 'src/charge.ts', quote, where: 'head' }));
      expect(r.dropped).toEqual([]);
      expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
    });

    it('does not take the finding\'s own lines on the head as proof', async () => {
      const { r } = await run(drop('unreachable', { path: 'src/pause.ts', quote: 'if (plan.active) charge(plan);', where: 'head' }));
      expect(r.dropped).toEqual([]);
      expect(r.kept[0]!.checked).toContain('EXPLANATION_MARKER');
      expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
    });

    describe('documented intent', () => {
      const SENTENCE = 'Offices may share a single plan when the account owner agrees in writing.';
      const MID_LINE = 'Members keep their original renewal date during any pause.';
      const packs = [pack('core', [lens('boundary')], {
        standards: [{
          name: 'calibration.md',
          text: [
            `Pauses may run 90 days. ${MID_LINE}`,
            SENTENCE,
            'Always use chargeIdempotencyKeyForEveryNightlyBillingRun.',
            '1. It is unsafe to skip the idempotency key on nightly billing runs.',
            'Offices may never share a plan across two regions without written approval.',
          ].join('\n'),
          dated: true,
        }],
        learned: [{ date: '2026-11-01', repo: 'o/r', kind: 'intended', text: 'A paused plan keeps its original renewal date when it resumes.' }],
      })];
      const intent = (quote: string) => drop('documented-intent', { path: 'x', quote, where: 'standard' });

      describe('in a hard-wrapped standard', () => {
        const NO_EVAL = 'No `eval`, `new Function`, `setTimeout("string")`, or scripts fetched from a URL.';
        const LEAD = 'Never do the following in a billing job:';
        const wrapped = [pack('core', [lens('boundary')], {
          standards: [{
            name: 'orbit.md',
            text: [
              '# Extensions',
              '',
              'Code from strings is never allowed in an extension. No',
              '`eval`, `new Function`, `setTimeout("string")`, or scripts fetched from a URL.',
              '',
              'Do not let members pause twice in one year, i.e. a second pause request within twelve months is refused.',
              '',
              LEAD,
              '- retry a failed charge without the original idempotency key',
              '- charge a plan that is paused or cancelled',
              '',
              '## Pauses',
              'Members on a paused plan are never charged by the nightly billing job.',
              '',
              '| Office | Billing day must be the first of the month |',
            ].join('\n'),
            dated: false,
          }],
        })];
        const check = async (quote: string) => (await run(intent(quote), { packs: wrapped })).r;

        it.each([
          ['a wrapped line whose negation is on the line above', NO_EVAL.slice('No '.length)],
          ['the tail after "i.e."', 'a second pause request within twelve months is refused.'],
          ['a list entry without its negating lead-in', 'retry a failed charge without the original idempotency key'],
          ['a heading joined to the sentence under it', '## Pauses\nMembers on a paused plan are never charged by the nightly billing job.'],
          ['one cell of a table row', 'Billing day must be the first of the month'],
        ])('does not take %s as proof', async (_what, quote) => {
          const r = await check(quote);
          expect(r.dropped).toEqual([]);
          expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
        });

        it.each([
          ['the whole sentence joined across the wrap', NO_EVAL],
          ['both sentences as wrapped in the file', `Code from strings is never allowed in an extension. No\n${NO_EVAL.slice('No '.length)}`],
          ['the whole sentence with "i.e." in it', 'Do not let members pause twice in one year, i.e. a second pause request within twelve months is refused.'],
          ['the lead-in with one entry', `${LEAD}\n- retry a failed charge without the original idempotency key`],
          ['the lead-in with both entries', `${LEAD}\n- retry a failed charge without the original idempotency key\n- charge a plan that is paused or cancelled`],
          ['the sentence under a heading, without the heading', 'Members on a paused plan are never charged by the nightly billing job.'],
          ['a whole table row', '| Office | Billing day must be the first of the month |'],
        ])('drops on %s', async (_what, quote) => {
          const r = await check(quote);
          expect(r.kept).toEqual([]);
          expect(r.dropped[0]!.refutation).toMatchObject({ path: 'Pack core: orbit.md', role: 'standard' });
        });
      });

      it.each([
        'safe to skip the idempotency key on nightly billing runs.',
        'share a plan across two regions without written approval.',
      ])('does not take the fragment %j, which drops a negation, as proof', async (quote) => {
        const { r } = await run(intent(quote), { packs });
        expect(r.dropped).toEqual([]);
        expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
      });

      it.each([
        ['a sentence that starts mid-line', MID_LINE],
        ['a sentence after a numbered list marker', 'It is unsafe to skip the idempotency key on nightly billing runs.'],
        ['two whole consecutive sentences across a line break', `${MID_LINE}\n${SENTENCE}`],
        ['a learned entry copied with its list marker', '- A paused plan keeps its original renewal date when it resumes.'],
      ])('drops on %s', async (_what, quote) => {
        const { r } = await run(intent(quote), { packs });
        expect(r.kept).toEqual([]);
        expect(r.dropped).toHaveLength(1);
      });

      it('drops on the whole sentence that states the intent', async () => {
        const { r } = await run(drop('documented-intent', { path: 'x', quote: SENTENCE, where: 'standard' }), { packs });
        expect(r.dropped).toHaveLength(1);
        expect(r.dropped[0]!.refutation).toMatchObject({ path: 'Pack core: calibration.md', role: 'standard', quote: SENTENCE });
      });

      it('does not take a 20-character fragment of a sentence as proof', async () => {
        const quote = 'share a single plan when';
        expect(quote.replace(/\s+/g, '')).toHaveLength(20);
        const { r } = await run(drop('documented-intent', { path: 'x', quote, where: 'standard' }), { packs });
        expect(r.dropped).toEqual([]);
        expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
      });

      it('does not take a long quote of fewer than four words as proof', async () => {
        const quote = 'Always use chargeIdempotencyKeyForEveryNightlyBillingRun.';
        const { r } = await run(drop('documented-intent', { path: 'x', quote, where: 'standard' }), { packs });
        expect(r.dropped).toEqual([]);
      });

      it('drops on a sentence found in a standard', async () => {
        const quote = SENTENCE;
        const { r, calls } = await run(drop('documented-intent', { path: 'anything', quote, where: 'standard' }), { packs });
        expect(r.kept).toEqual([]);
        expect(r.dropped[0]).toMatchObject({
          reason: 'documented-intent: EXPLANATION_MARKER the code shows it. (proof: a sentence in Pack core: calibration.md)',
          refutation: { path: 'Pack core: calibration.md', line: null, role: 'standard', quote },
        });
        expect(calls).toEqual([]);
      });

      it('drops on a sentence found in the learned product facts', async () => {
        const quote = 'A paused plan keeps its original renewal date when it resumes.';
        const { r } = await run(drop('documented-intent', { path: '', quote, where: 'standard' }), { packs });
        expect(r.dropped[0]!.refutation).toEqual({ path: 'Product facts to respect', line: null, role: 'standard', quote });
      });

      it('keeps the finding when the sentence is in no standard', async () => {
        const { r } = await run(drop('documented-intent', { path: 'x', quote: 'Pauses may run for a full year without any charge to the member.', where: 'standard' }), { packs });
        expect(r.dropped).toEqual([]);
        expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
      });

      it('keeps the finding when documented intent quotes code', async () => {
        const { r } = await run(drop('documented-intent', { path: 'src/charge.ts', quote: GUARD, where: 'head' }), { packs });
        expect(r.dropped).toEqual([]);
        expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
      });

      it('keeps the finding when another ground quotes a standard', async () => {
        const quote = SENTENCE;
        const { r } = await run(drop('guarded-elsewhere', { path: 'x', quote, where: 'standard' }), { packs });
        expect(r.dropped).toEqual([]);
      });
    });

    it('reads an empty or unpunctuated checked and the unconfirmed sentence as two sentences', async () => {
      const empty = await run(drop('unreachable', null, { checked: '' }));
      expect(empty.r.kept[0]!.checked).toBe('checked, no refutation found. The refutation it offered could not be confirmed in the code, so the finding stands.');
      const bare = await run(drop('unreachable', null, { checked: 'Read the nightly job' }));
      expect(bare.r.kept[0]!.checked).toBe(`Read the nightly job.${UNCONFIRMED}`);
    });
  });

  describe('one item never stops the batch', () => {
    it('treats a read that throws as a missing file and keeps the item', async () => {
      const runner = createFakeRunner(() => answer({
        outcome: 'drop', ground: 'pre-existing', explanation: 'Already there.',
        refutation: { path: 'src/pause.ts', quote: 'if (plan.active) charge(plan);', where: 'base' },
      }));
      const read = async (): Promise<string | null> => { throw new Error('disk gone'); };
      const r = await challenge(runner, unchangedCtx(), [item('c1', 'fix')], read);
      expect(r.dropped).toEqual([]);
      expect(r.errors).toEqual([]);
      expect(r.kept[0]!.checked.endsWith(UNCONFIRMED)).toBe(true);
    });

    it('keeps an item whose request could not be built, and the others carry on', async () => {
      let thrown = false;
      const base = ctx();
      const broken = Object.defineProperty({ ...base }, 'facts', {
        get: () => {
          if (thrown) return [];
          thrown = true;
          throw new Error('facts unavailable');
        },
      });
      const runner = createFakeRunner(() => answer());
      const { read } = memoryRead();
      const r = await challenge(runner, broken, [item('c1', 'fix'), item('c2', 'block')], read);
      expect(r.kept.map((k) => [k.id, k.checked])).toEqual([
        ['c1', 'challenge did not complete'],
        ['c2', 'Read src/pause.ts and its caller src/charge.ts.'],
      ]);
      expect(r.errors).toEqual([{ stage: 'challenge', cohortId: 'k1', message: 'c1: facts unavailable' }]);
    });

    it('keeps the input order of the survivors with one failure and one confirmed drop', async () => {
      const runner = createFakeRunner((req) => (idOf(req) === 'c1' ? new Error('timed out') : answer({
        outcome: 'drop', ground: 'pre-existing', explanation: 'Already there.',
        refutation: { path: 'src/pause.ts', quote: 'if (plan.active) charge(plan);', where: 'base' },
      })));
      const { read } = memoryRead();
      const r = await challenge(runner, unchangedCtx(), [item('c1', 'fix'), item('c2', 'fix'), item('c3', 'note'), item('c4', 'block')], read);
      expect(r.kept.map((k) => [k.id, k.checked])).toEqual([['c1', 'challenge did not complete'], ['c3', 'not challenged']]);
      expect(r.dropped.map((d) => d.candidate.id)).toEqual(['c2', 'c4']);
      expect(r.errors).toHaveLength(1);
    });
  });
});
