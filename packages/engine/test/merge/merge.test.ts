import type { Anchor, Candidate, Severity, Source } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import type { AgentRequest } from '../../src/agent/runner.js';
import { createFakeRunner, failure } from '../../src/agent/fake-runner.js';
import { fingerprint } from '../../src/anchor/fingerprint.js';
import { mergeSameProblems, proposeClusters, MAX_CLUSTER, type AnchoredCandidate } from '../../src/merge/merge.js';
import { block, ctx, labels } from '../helpers/lens-context.js';

const source = (lens: string, pack = 'core'): Source => ({ pack, lens, ruleId: null });

function item(
  id: string, startLine: number | null, over: Partial<Candidate & { anchor: Anchor }> & { endLine?: number } = {},
): AnchoredCandidate {
  const { endLine, ...rest } = over;
  return {
    id, source: source('boundary'), cohortId: 'k1', severity: 'fix', title: `Finding ${id}`, path: 'src/pause.ts',
    quote: `line ${startLine ?? 0} of ${id}`, lineHint: startLine, happens: `What happens for ${id}.`, why: `Why ${id}.`,
    suggestedChange: `Change ${id}.`, connected: [], wouldBeWrongIf: '', confidence: 'medium',
    anchor: startLine === null ? { status: 'not-found', startLine: null, endLine: null }
      : { status: 'in-diff', startLine, endLine: endLine ?? startLine },
    ...rest,
  };
}

const ids = (clusters: { members: AnchoredCandidate[] }[]): string[][] => clusters.map((c) => c.members.map((m) => m.id));

describe('proposeClusters', () => {
  it('links two candidates in one file whose lines overlap', () => {
    const clusters = proposeClusters([item('a', 10, { endLine: 14 }), item('b', 12, { endLine: 13 })]);
    expect(ids(clusters)).toEqual([['a', 'b']]);
    expect(clusters[0]!.id).toBe('d1');
  });

  it('links candidates two lines apart, and not three lines apart', () => {
    expect(ids(proposeClusters([item('a', 10), item('b', 12)]))).toEqual([['a', 'b']]);
    expect(ids(proposeClusters([item('a', 10), item('b', 13)]))).toEqual([]);
    expect(ids(proposeClusters([item('a', 10, { endLine: 11 }), item('b', 14)]))).toEqual([]);
  });

  it('never links candidates in different files by their lines', () => {
    expect(ids(proposeClusters([item('a', 10), item('b', 10, { path: 'src/other.ts' })]))).toEqual([]);
  });

  it('links a candidate whose primary place is a connected place of another, ignoring whitespace', () => {
    const a = item('a', 40, { path: 'src/charge.ts', quote: 'charge(plan);' });
    const b = item('b', 3, { connected: [{ path: 'src/charge.ts', line: 40, role: 'charged here', quote: '  charge( plan );' }] });
    expect(ids(proposeClusters([a, b]))).toEqual([['a', 'b']]);
  });

  it('does not link through a connected place in another file with the same quote', () => {
    const a = item('a', 40, { path: 'src/charge.ts', quote: 'charge(plan);' });
    const b = item('b', 3, { connected: [{ path: 'src/bill.ts', line: 40, role: 'x', quote: 'charge(plan);' }] });
    expect(ids(proposeClusters([a, b]))).toEqual([]);
  });

  it('joins chains into one connected cluster, in line order, and leaves a lone candidate alone', () => {
    const clusters = proposeClusters([item('c', 14), item('a', 10), item('far', 40), item('b', 12)]);
    expect(ids(clusters)).toEqual([['a', 'b', 'c']]);
  });

  it('a candidate with no anchored line joins no cluster', () => {
    expect(ids(proposeClusters([item('a', 10), item('b', null)]))).toEqual([]);
  });

  it('cuts a cluster of thirteen into runs of at most twelve in line order', () => {
    const many = Array.from({ length: 13 }, (_, i) => item(`m${String(i).padStart(2, '0')}`, 100 + i));
    const clusters = proposeClusters([...many].reverse());
    expect(clusters.length).toBe(2);
    for (const c of clusters) {
      expect(c.members.length).toBeGreaterThan(1);
      expect(c.members.length).toBeLessThanOrEqual(MAX_CLUSTER);
    }
    expect(ids(clusters).flat()).toEqual(many.map((m) => m.id));
    expect(clusters.map((c) => c.id)).toEqual(['d1', 'd2']);
  });
});

const partition = (sets: string[][], id = 'd1', reason = 'They are the same fault.') => ({ id, sets, reason });

describe('mergeSameProblems', () => {
  it('makes no request when there is no cluster', async () => {
    const runner = createFakeRunner(() => { throw new Error('no request expected'); });
    const r = await mergeSameProblems(runner, ctx(), [item('a', 10), item('b', 30)]);
    expect(runner.calls).toHaveLength(0);
    expect(r.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(r.dropped).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.notes).toEqual([]);
  });

  it('sends one low-effort merge request with every cluster as material and nothing of the findings in the instructions', async () => {
    const runner = createFakeRunner(() => ({ clusters: [partition([['a'], ['b']]), partition([['c'], ['d']], 'd2')] }));
    const a = item('a', 10, { title: 'TITLE_MARKER a', quote: 'QUOTE_MARKER();' });
    await mergeSameProblems(runner, ctx(), [a, item('b', 11), item('c', 50), item('d', 51)]);
    expect(runner.calls).toHaveLength(1);
    const req = runner.calls[0]!;
    expect(req.role).toBe('merge');
    expect(req.effort).toBe('low');
    expect(req.model).toBe(ctx().models.main);
    expect(labels(req.material)).toEqual(['cluster d1', 'cluster d2']);
    const d1 = block(req.material, 'cluster d1')!;
    for (const text of ['a', 'core/boundary', 'TITLE_MARKER a', 'What happens for a.', 'Why a.', 'Change a.', 'QUOTE_MARKER();', 'src/pause.ts:10']) {
      expect(d1).toContain(text);
    }
    expect(d1).not.toContain('Finding c');
    expect(req.instructions).not.toContain('TITLE_MARKER');
    expect(req.instructions).not.toContain('QUOTE_MARKER');
  });

  it('merges a set into its most serious member, which gains the others\' places, sources and fingerprints', async () => {
    const a = item('a', 10, { severity: 'fix', confidence: 'high', source: source('correctness') });
    const b = item('b', 10, {
      severity: 'block', confidence: 'low', source: source('boundary'), title: 'Keeper title',
      connected: [{ path: 'src/charge.ts', line: 4, role: 'called here', quote: 'pause(plan);' }],
    });
    const c = item('c', 11, {
      severity: 'block', confidence: 'medium', source: source('rules-x', 'orbit'),
      connected: [{ path: 'src/charge.ts', line: 4, role: 'also here', quote: ' pause(plan); ' }, { path: 'src/job.ts', line: 9, role: 'run', quote: 'run();' }],
    });
    const runner = createFakeRunner(() => ({ clusters: [partition([['a', 'b', 'c']], 'd1', 'All three say the paused plan is charged.')] }));
    const r = await mergeSameProblems(runner, ctx(), [a, b, c]);
    expect(r.items.map((i) => i.id)).toEqual(['c']);
    const keeper = r.items[0]!;
    expect(keeper.connected).toEqual([
      { path: 'src/charge.ts', line: 4, role: 'also here', quote: ' pause(plan); ' },
      { path: 'src/job.ts', line: 9, role: 'run', quote: 'run();' },
      { path: 'src/pause.ts', line: 10, role: 'also raised here', quote: 'line 10 of a' },
      { path: 'src/pause.ts', line: 10, role: 'also raised here', quote: 'line 10 of b' },
    ]);
    expect(keeper.alsoRaisedBy).toEqual([source('correctness'), source('boundary')]);
    expect(keeper.aliases).toEqual([fingerprint(a), fingerprint(b)]);
    expect(r.dropped.map((d) => [d.candidate.id, d.stage, d.mergedInto])).toEqual([['a', 'merge', 'c'], ['b', 'merge', 'c']]);
    expect(r.dropped[0]!.reason).toBe(`the same problem as "Finding c": All three say the paused plan is charged.`);
    expect(r.dropped[0]!.refutation).toBeNull();
    expect('anchor' in r.dropped[0]!.candidate).toBe(false);
    expect(r.errors).toEqual([]);
  });

  it('adds a duplicate\'s own place to the keeper\'s places, unless it is the keeper\'s own place or already there', async () => {
    const keeper = item('k', 10, { severity: 'block', quote: 'charge(plan);', connected: [{ path: 'src/pay.ts', line: 3, role: 'calls it', quote: 'pay();' }] });
    const samePlace = item('s', 10, { quote: '  charge( plan );' });
    const listed = item('l', 3, { path: 'src/pay.ts', quote: 'pay();' });
    const elsewhere = item('e', 11, { path: 'src/pause.ts', quote: 'other();', anchor: { status: 'outside-diff', startLine: 11, endLine: 12 } });
    const runner = createFakeRunner(() => ({ clusters: [partition([['k', 's', 'l', 'e']])] }));
    const r = await mergeSameProblems(runner, ctx(), [keeper, samePlace, listed, elsewhere]);
    expect(r.items.map((i) => i.id)).toEqual(['k']);
    expect(r.items[0]!.connected).toEqual([
      { path: 'src/pay.ts', line: 3, role: 'calls it', quote: 'pay();' },
      { path: 'src/pause.ts', line: 11, role: 'also raised here', quote: 'other();' },
    ]);
  });

  it('on a tie of severity and confidence keeps the earliest in the list', async () => {
    const runner = createFakeRunner(() => ({ clusters: [partition([['b', 'a']])] }));
    const r = await mergeSameProblems(runner, ctx(), [item('a', 10), item('b', 10)]);
    expect(r.items.map((i) => i.id)).toEqual(['a']);
  });

  it('keeps two different problems on one line as two findings when the model says so', async () => {
    const runner = createFakeRunner(() => ({ clusters: [partition([['a'], ['b']], 'd1', 'One is about rounding, the other about the currency.')] }));
    const r = await mergeSameProblems(runner, ctx(), [item('a', 10, { quote: 'x' }), item('b', 10, { quote: 'x' })]);
    expect(r.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(r.items.every((i) => i.alsoRaisedBy === undefined && i.aliases === undefined)).toBe(true);
    expect(r.dropped).toEqual([]);
  });

  it.each([
    ['drops an id', [['a']]],
    ['repeats an id', [['a', 'b'], ['b']]],
    ['names an outsider', [['a', 'b', 'z']]],
    ['names a member of another cluster', [['a', 'b', 'c']]],
    ['has an empty set', [['a', 'b'], []]],
  ])('refuses an answer that %s and asks about that cluster again once, alone', async (_name, bad) => {
    let n = 0;
    const runner = createFakeRunner(() => {
      n += 1;
      if (n === 1) return { clusters: [partition(bad), partition([['c', 'd']], 'd2')] };
      return { clusters: [partition([['a', 'b']])] };
    });
    const r = await mergeSameProblems(runner, ctx(), [item('a', 10), item('b', 11), item('c', 50), item('d', 51)]);
    expect(runner.calls).toHaveLength(2);
    expect(labels(runner.calls[1]!.material)).toEqual(['cluster d1']);
    expect(r.items.map((i) => i.id)).toEqual(['a', 'c']);
    expect(r.errors).toEqual([]);
  });

  it('asks again about a cluster the answer left out', async () => {
    let n = 0;
    const runner = createFakeRunner(() => (++n === 1 ? { clusters: [partition([['c', 'd']], 'd2')] } : { clusters: [partition([['a'], ['b']])] }));
    const r = await mergeSameProblems(runner, ctx(), [item('a', 10), item('b', 11), item('c', 50), item('d', 51)]);
    expect(labels(runner.calls[1]!.material)).toEqual(['cluster d1']);
    expect(r.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves a cluster unmerged and says so in a note, not a stage error, when the second answer is unusable too', async () => {
    const runner = createFakeRunner(() => ({ clusters: [partition([['a', 'b', 'z']]), partition([['c', 'd']], 'd2')] }));
    const r = await mergeSameProblems(runner, ctx(), [item('a', 10), item('b', 11), item('c', 50), item('d', 51)]);
    expect(runner.calls).toHaveLength(2);
    expect(r.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(r.errors).toEqual([]);
    expect(r.notes).toEqual([
      'Airlock could not confirm whether 2 findings at the same place are the same problem ("Finding a", "Finding b"), so they are listed separately.',
    ]);
  });

  it('names at most five titles in the note, then how many more', async () => {
    const seven = Array.from({ length: 7 }, (_, i) => item(`m${i}`, 10 + i));
    const r = await mergeSameProblems(createFakeRunner(() => ({ clusters: [] })), ctx(), seven);
    expect(r.notes).toEqual([
      'Airlock could not confirm whether 7 findings at the same place are the same problem '
        + '("Finding m0", "Finding m1", "Finding m2", "Finding m3", "Finding m4" and 2 more), so they are listed separately.',
    ]);
  });

  it('asks again after an unusable reply; a turn limit or timeout is not asked again and becomes a note', async () => {
    let n = 0;
    const flaky = createFakeRunner(() => (++n === 1 ? new Error('bad json') : { clusters: [partition([['a', 'b']])] }));
    const ok = await mergeSameProblems(flaky, ctx(), [item('a', 10), item('b', 11)]);
    expect(flaky.calls).toHaveLength(2);
    expect(ok.items.map((i) => i.id)).toEqual(['a']);
    expect(ok.notes).toEqual([]);

    for (const kind of ['timeout', 'turn-limit', 'other'] as const) {
      const failed = createFakeRunner(() => failure('it stopped', kind));
      const r = await mergeSameProblems(failed, ctx(), [item('a', 10), item('b', 11)]);
      expect(failed.calls).toHaveLength(1);
      expect(r.items.map((i) => i.id)).toEqual(['a', 'b']);
      expect(r.errors).toEqual([]);
      expect(r.notes).toHaveLength(1);
      expect(r.usage).toHaveLength(1);
    }
  });

  it('keeps a usage-limit failure as a stage error of that kind, with no note', async () => {
    const limited = createFakeRunner(() => failure("Claude's usage limit was reached", 'usage-limit'));
    const r = await mergeSameProblems(limited, ctx(), [item('a', 10), item('b', 11)]);
    expect(r.errors).toEqual([{
      stage: 'merge', cohortId: null, kind: 'usage-limit', message: "Claude's usage limit was reached; cluster d1 (a, b) was not merged",
    }]);
    expect(r.notes).toEqual([]);
  });

  it('merges the review\'s six lenses on one line into one item with five dropped entries pointing at it', async () => {
    const lenses = ['boundary', 'numbers', 'scale', 'release', 'sibling', 'correctness'];
    const severities: Severity[] = ['fix', 'fix', 'block', 'fix', 'ask', 'fix'];
    const six = lenses.map((l, i) => item(`c${i}`, 33, { source: source(l), severity: severities[i]!, quote: 'void run();' }));
    const runner = createFakeRunner((req: AgentRequest<unknown>) => {
      const members = block(req.material, 'cluster d1')!.split('\n').filter((l) => l.startsWith('- id: ')).map((l) => l.slice(6));
      return { clusters: [partition([members], 'd1', 'Each says the background run is not awaited.')] };
    });
    const r = await mergeSameProblems(runner, ctx(), six);
    expect(r.items.map((i) => i.id)).toEqual(['c2']);
    expect(r.items[0]!.alsoRaisedBy!.map((s) => s.lens)).toEqual(['boundary', 'numbers', 'release', 'sibling', 'correctness']);
    expect(r.dropped).toHaveLength(5);
    expect(r.dropped.every((d) => d.mergedInto === 'c2' && d.stage === 'merge')).toBe(true);
  });
});
