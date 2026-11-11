import type { Anchor, Finding, PrInfo, Question, Severity, StageError } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import { createFakeRunner } from '../../src/agent/fake-runner.js';
import { fingerprint } from '../../src/anchor/fingerprint.js';
import type { KeptCandidate } from '../../src/challenge/challenge.js';
import { MAX_TOP, decideVerdict, mergeDuplicates, select } from '../../src/select/select.js';
import { block, ctx, labels, lens, pack, pr } from '../helpers/lens-context.js';

const anchor: Anchor = { status: 'in-diff', startLine: 2, endLine: 2 };

function item(id: string, severity: Severity, over: Partial<KeptCandidate> = {}): KeptCandidate {
  return {
    id, source: { pack: 'core', lens: 'boundary', ruleId: null }, cohortId: 'k1', severity,
    title: `Finding ${id}`, path: `src/${id}.ts`, quote: `const ${id} = load();`, lineHint: 2,
    happens: `A member is hurt by ${id}.`, why: 'Because.', suggestedChange: 'Change it.',
    connected: [], wouldBeWrongIf: 'Something guards it.', confidence: 'high', anchor, checked: `Checked ${id}.`, ...over,
  };
}

const answer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  top: [], also: [], sameAs: [], questionSameAs: [], whoseCall: [], checksAfterMerge: [], splitSuggested: false, ...over,
});

const ask = (text: string): Question => ({ text, cohortId: 'k1', source: { pack: 'core', lens: 'boundary', ruleId: null } });
const texts = (qs: Question[]): string[] => qs.map((q) => q.text);

function finding(id: string, severity: Severity, bucket: 'top' | 'also' = 'top', rank: number | null = 1): Finding {
  const k = item(id, severity);
  return { ...k, fingerprint: fingerprint(k), bucket, rank, status: null };
}

const own: PrInfo = { ...pr, author: 'vignesh', viewer: 'vignesh' };
const theirs: PrInfo = { ...pr, author: 'alice', viewer: 'vignesh' };
const stageError = (stage: string): StageError => ({ stage, cohortId: null, message: `${stage} failed` });

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
};

const ids = (fs: { id: string }[]): string[] => fs.map((f) => f.id);
const topIds = (fs: Finding[]): string[] => ids(fs.filter((f) => f.bucket === 'top'));
const alsoIds = (fs: Finding[]): string[] => ids(fs.filter((f) => f.bucket === 'also'));

describe('mergeDuplicates', () => {
  it('merges two candidates through an agent group that shares a file, and keeps the block', () => {
    const fix = item('a', 'fix', { path: 'src/pause.ts', quote: 'if (plan.active) charge(plan);' });
    const blk = item('b', 'block', { path: 'src/pause.ts', quote: 'if (plan.active) charge(plan);', title: 'Paused plans are charged' });
    const r = mergeDuplicates([fix, blk], [['a', 'b']]);
    expect(ids(r.merged)).toEqual(['b']);
    expect(r.merged[0]!.severity).toBe('block');
    expect(r.dropped).toEqual([{
      candidate: expect.objectContaining({ id: 'a' }), stage: 'select', reason: 'same problem as b', refutation: null,
    }]);
    expect(r.dropped[0]!.candidate).not.toHaveProperty('anchor');
    expect(r.dropped[0]!.candidate).not.toHaveProperty('checked');
  });

  it('merges identical fingerprints without a group, keeping the first on a tie', () => {
    const a = item('a', 'fix', { path: 'src/x.ts', quote: 'run(a);' });
    const b = item('b', 'fix', { path: 'src/x.ts', quote: '  run(a);  ' });
    const c = item('c', 'note');
    const r = mergeDuplicates([c, a, b]);
    expect(ids(r.merged)).toEqual(['c', 'a']);
    expect(r.dropped.map((d) => [d.candidate.id, d.reason])).toEqual([['b', 'same problem as a']]);
  });

  it('keeps the order of the survivors when the kept one came later', () => {
    const a = item('a', 'note', { path: 'src/x.ts' });
    const b = item('b', 'note');
    const c = item('c', 'block', { path: 'src/x.ts' });
    const r = mergeDuplicates([a, b, c], [['a', 'c']]);
    expect(ids(r.merged)).toEqual(['b', 'c']);
    expect(r.dropped.map((d) => d.reason)).toEqual(['same problem as c']);
  });

  it('merges a group whose items share a file through a connected place', () => {
    const a = item('a', 'fix', { path: 'src/a.ts' });
    const b = item('b', 'fix', { path: 'src/b.ts', connected: [{ path: 'src/a.ts', line: 4, role: 'called here', quote: 'go();' }] });
    expect(ids(mergeDuplicates([a, b], [['a', 'b']]).merged)).toEqual(['a']);
  });

  it('ignores a group whose items share no file', () => {
    const a = item('a', 'fix', { path: 'src/a.ts', connected: [{ path: 'src/c.ts', line: 1, role: 'x', quote: 'x();' }] });
    const b = item('b', 'block', { path: 'src/b.ts', connected: [{ path: 'src/c.ts', line: 1, role: 'x', quote: 'x();' }] });
    const r = mergeDuplicates([a, b], [['a', 'b']]);
    expect(ids(r.merged)).toEqual(['a', 'b']);
    expect(r.dropped).toEqual([]);
  });

  it('ignores the whole group when one pair in it shares no file', () => {
    const a = item('a', 'fix', { path: 'src/a.ts' });
    const b = item('b', 'fix', { path: 'src/a.ts' });
    const c = item('c', 'fix', { path: 'src/c.ts' });
    expect(ids(mergeDuplicates([a, b, c], [['a', 'b', 'c']]).merged)).toEqual(['a', 'b', 'c']);
  });

  it('ignores a group that would join a set whose items share no file with it', () => {
    const a = item('a', 'fix', { path: 'src/a.ts' });
    const b = item('b', 'fix', { path: 'src/b.ts', connected: [
      { path: 'src/a.ts', line: 1, role: 'x', quote: 'x();' }, { path: 'src/c.ts', line: 1, role: 'y', quote: 'y();' },
    ] });
    const c = item('c', 'fix', { path: 'src/c.ts' });
    expect(ids(mergeDuplicates([a, b, c], [['a', 'b'], ['b', 'c']]).merged)).toEqual(['a', 'c']);
    expect(ids(mergeDuplicates([a, b, c], [['b', 'c'], ['a', 'b']]).merged)).toEqual(['a', 'b']);
  });

  it('ignores a group of more than four ids, even on one file', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((id) => item(id, 'fix', { path: 'src/one.ts' }));
    expect(ids(mergeDuplicates(five, [['a', 'b', 'c', 'd', 'e']]).merged)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ids(mergeDuplicates(five, [['a', 'b', 'c', 'd']]).merged)).toEqual(['a', 'e']);
  });

  it('does not merge two different problems on the same line without a group', () => {
    const a = item('a', 'fix', { path: 'src/pause.ts', quote: 'if (plan.active) charge(plan);', source: { pack: 'core', lens: 'money', ruleId: null } });
    const b = item('b', 'block', { path: 'src/pause.ts', quote: 'if (plan.active) charge(plan);', source: { pack: 'core', lens: 'boundary', ruleId: null } });
    const r = mergeDuplicates([a, b]);
    expect(ids(r.merged)).toEqual(['a', 'b']);
  });

  it('ignores ids in a group that are not items', () => {
    const a = item('a', 'fix', { path: 'src/x.ts' });
    const b = item('b', 'note', { path: 'src/x.ts' });
    const r = mergeDuplicates([a, b], [['ghost', 'a', 'b'], ['a', 'nobody']]);
    expect(ids(r.merged)).toEqual(['a']);
    expect(r.dropped.map((d) => d.candidate.id)).toEqual(['b']);
  });

  it('unions connected places and removes duplicates by path and squashed quote', () => {
    const p1 = { path: 'src/charge.ts', line: 4, role: 'charged here', quote: 'charge(plan);' };
    const p1again = { path: 'src/charge.ts', line: 9, role: 'same place', quote: '  charge( plan );' };
    const p2 = { path: 'src/job.ts', line: 2, role: 'job', quote: 'nightly();' };
    const p3 = { path: 'src/other.ts', line: 2, role: 'other', quote: 'charge(plan);' };
    const a = item('a', 'block', { path: 'src/x.ts', connected: [p1] });
    const b = item('b', 'fix', { path: 'src/x.ts', connected: [p1again, p2, p3] });
    const r = mergeDuplicates([a, b], [['a', 'b']]);
    expect(r.merged[0]!.connected).toEqual([p1, p2, p3]);
    expect(r.merged[0]!.checked).toBe('Checked a.');
  });

  it('never mutates its inputs', () => {
    const items = deepFreeze([
      item('a', 'fix', { path: 'src/x.ts', connected: [{ path: 'src/y.ts', line: 1, role: 'y', quote: 'y();' }] }),
      item('b', 'block', { path: 'src/x.ts', connected: [{ path: 'src/z.ts', line: 1, role: 'z', quote: 'z();' }] }),
    ]);
    const groups = deepFreeze([['a', 'b']]);
    const before = structuredClone(items);
    const r = mergeDuplicates(items, groups);
    expect(items).toEqual(before);
    expect(r.merged[0]!.connected).toHaveLength(2);
  });
});

describe('select', () => {
  it('keeps at most five in the top list and moves the rest to also found', async () => {
    const kept = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => item(id, 'fix'));
    const runner = createFakeRunner(() => answer({ top: ['g', 'f', 'e', 'd', 'c', 'b', 'a'] }));
    const r = await select(runner, ctx(), kept, [], []);
    expect(MAX_TOP).toBe(5);
    expect(topIds(r.findings)).toEqual(['g', 'f', 'e', 'd', 'c']);
    expect(r.findings.filter((f) => f.bucket === 'top').map((f) => f.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(alsoIds(r.findings)).toEqual(['a', 'b']);
    expect(r.findings.filter((f) => f.bucket === 'also').map((f) => f.rank)).toEqual([null, null]);
    expect(r.findings[0]).toEqual({ ...kept[6], fingerprint: fingerprint(kept[6]!), bucket: 'top', rank: 1, status: null });
  });

  it('never removes a kept candidate that the agent left out', async () => {
    const kept = [item('a', 'fix'), item('b', 'note'), item('c', 'ask')];
    const runner = createFakeRunner(() => answer({ top: ['a'], also: [] }));
    const r = await select(runner, ctx(), kept, [], []);
    expect(topIds(r.findings)).toEqual(['a']);
    expect(alsoIds(r.findings)).toEqual(['c', 'b']);
    expect(r.dropped).toEqual([]);
  });

  it('ignores unknown, repeated and merged-away ids in top', async () => {
    const kept = [item('a', 'fix', { path: 'src/x.ts' }), item('b', 'note', { path: 'src/x.ts' }), item('c', 'ask')];
    const runner = createFakeRunner(() => answer({ top: ['ghost', 'c', 'b', 'c', 'a'], sameAs: [['a', 'b']] }));
    const r = await select(runner, ctx(), kept, [], []);
    expect(topIds(r.findings)).toEqual(['c', 'a']);
    expect(alsoIds(r.findings)).toEqual([]);
    expect(r.dropped.map((d) => [d.candidate.id, d.stage, d.reason])).toEqual([['b', 'select', 'same problem as a']]);
  });

  it('puts a block the agent left out into the top list when there is room', async () => {
    const kept = [item('a', 'fix'), item('b', 'block'), item('c', 'note')];
    const runner = createFakeRunner(() => answer({ top: ['a'], also: ['b', 'c'] }));
    const r = await select(runner, ctx(), kept, [], []);
    expect(topIds(r.findings)).toEqual(['a', 'b']);
    expect(alsoIds(r.findings)).toEqual(['c']);
  });

  it('puts a left-out block in place of the last non-block when the top list is full', async () => {
    const kept = [item('f1', 'fix'), item('b1', 'block'), item('f2', 'fix'), item('n1', 'note'), item('b2', 'block'), item('f3', 'fix'), item('b3', 'block')];
    const runner = createFakeRunner(() => answer({ top: ['f1', 'b1', 'f2', 'n1', 'b2'], also: ['f3', 'b3'] }));
    const r = await select(runner, ctx(), kept, [], []);
    expect(topIds(r.findings)).toEqual(['f1', 'b1', 'f2', 'b3', 'b2']);
    expect(alsoIds(r.findings)).toEqual(['n1', 'f3']);
  });

  it('keeps left-out blocks in input order when they replace non-blocks', async () => {
    const kept = [item('n1', 'fix'), item('b1', 'block'), item('n2', 'fix'), item('n3', 'note'), item('b2', 'block'), item('n4', 'ask'), item('n5', 'note')];
    const runner = createFakeRunner(() => answer({ top: ['n1', 'n2', 'n3', 'n4', 'n5'] }));
    const r = await select(runner, ctx(), kept, [], []);
    expect(topIds(r.findings)).toEqual(['n1', 'n2', 'n3', 'b1', 'b2']);
    expect(alsoIds(r.findings)).toEqual(['n4', 'n5']);
  });

  it('puts blocks that cannot fit first under also found', async () => {
    const kept = [...['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((id) => item(id, 'block')), item('f1', 'fix'), item('f2', 'fix')];
    const runner = createFakeRunner(() => answer({ top: ['b1', 'b2', 'b3', 'b4', 'f1'], also: ['f2', 'b6', 'b5'] }));
    const r = await select(runner, ctx(), kept, [], []);
    expect(topIds(r.findings)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5']);
    expect(alsoIds(r.findings)).toEqual(['b6', 'f1', 'f2']);
  });

  it('places every item once even when two share an id', async () => {
    const kept = [item('a', 'fix', { path: 'src/x.ts' }), item('a', 'note', { path: 'src/y.ts' })];
    const runner = createFakeRunner(() => answer({ top: ['a'], also: ['a'] }));
    const r = await select(runner, ctx(), kept, [], []);
    expect(r.findings.map((f) => [f.id, f.path, f.bucket])).toEqual([['a', 'src/x.ts', 'top'], ['a', 'src/y.ts', 'also']]);
    expect(r.dropped).toEqual([]);
  });

  it('ignores a group listing every id of a one-file pull request', async () => {
    const kept = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => item(id, 'fix', { path: 'src/one.ts' }));
    const runner = createFakeRunner(() => answer({ top: ['a'], sameAs: [['a', 'b', 'c', 'd', 'e', 'f']] }));
    const r = await select(runner, ctx(), kept, [], []);
    expect(r.findings).toHaveLength(6);
    expect(r.dropped).toEqual([]);
  });

  it('never loses an item, whatever the answer', async () => {
    let seed = 7;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const severities: Severity[] = ['block', 'fix', 'ask', 'note'];
    for (let round = 0; round < 60; round += 1) {
      const count = 1 + next(12);
      const kept = Array.from({ length: count }, (_, i) => item(`i${next(3) === 0 ? next(count) : i}`, severities[next(4)]!, {
        path: `src/f${next(3)}.ts`, quote: `q${next(4)}();`,
        connected: next(2) === 0 ? [] : [{ path: `src/f${next(3)}.ts`, line: 1, role: 'r', quote: 'c();' }],
      }));
      const every = kept.map((k) => k.id);
      const hostile = [
        answer({ top: [...every, ...every, 'ghost'], also: [...every, 'nobody', ...every], sameAs: [every, [...every].reverse()] }),
        answer({ top: [], also: [], sameAs: [every.slice(0, 2), every.slice(1, 3), every.slice(0, 4)] }),
        new Error('down'),
      ][round % 3]!;
      const r = await select(createFakeRunner(() => hostile), ctx(), kept, [], []);
      const droppedHere = r.dropped.filter((d) => d.stage === 'select');
      expect(r.findings.length + droppedHere.length).toBe(kept.length);
      expect(r.findings.filter((f) => f.bucket === 'top').length).toBeLessThanOrEqual(MAX_TOP);
    }
  });

  it('fills the top list by severity when the agent gives no usable top ids', async () => {
    const kept = [item('n', 'note'), item('a', 'ask'), item('f', 'fix'), item('b', 'block'), item('f2', 'fix'), item('n2', 'note')];
    const runner = createFakeRunner(() => answer({ top: ['ghost'] }));
    const r = await select(runner, ctx(), kept, [], []);
    expect(topIds(r.findings)).toEqual(['b', 'f', 'f2', 'a', 'n']);
    expect(alsoIds(r.findings)).toEqual(['n2']);
  });

  it('orders also found by the agent first, then by severity and original order', async () => {
    const kept = [item('t', 'fix'), item('n1', 'note'), item('a1', 'ask'), item('f1', 'fix'), item('n2', 'note'), item('f2', 'fix')];
    const runner = createFakeRunner(() => answer({ top: ['t'], also: ['n2', 'ghost', 'n2', 't'] }));
    const r = await select(runner, ctx(), kept, [], []);
    expect(alsoIds(r.findings)).toEqual(['n2', 'f1', 'f2', 'a1', 'n1']);
  });

  it('makes its request when nothing was kept and returns whoseCall and checksAfterMerge', async () => {
    const runner = createFakeRunner(() => answer({ whoseCall: ['The 60-day limit'], checksAfterMerge: ['Pause a plan as a manager'] }));
    const r = await select(runner, ctx({ pr: own }), [], [], []);
    expect(runner.calls).toHaveLength(1);
    expect(block(runner.calls[0]!.material, 'findings')).toBe('(none)');
    expect(r.findings).toEqual([]);
    expect(r.usage).toHaveLength(1);
    expect(r.errors).toEqual([]);
    expect(r.verdict.label).toBe('ready-for-pr2');
    expect(r.whoseCall).toEqual(['The 60-day limit']);
    expect(r.checksAfterMerge).toEqual(['Pause a plan as a manager']);
  });

  it('makes no request when nothing was kept and there are no questions on a sync merge', async () => {
    const runner = createFakeRunner(() => answer({ checksAfterMerge: ['never asked'] }));
    const r = await select(runner, ctx({ pr: own }), [], [], [stageError('shape')], 'standard', true);
    expect(runner.calls).toHaveLength(0);
    expect(r.findings).toEqual([]);
    expect(r.questions).toEqual([]);
    expect(r.usage).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.verdict.label).toBe('incomplete');
    expect(r.whoseCall).toEqual([]);
    expect(r.checksAfterMerge).toEqual([]);
  });

  it('the model sees the brief and the change map when nothing was kept', async () => {
    const runner = createFakeRunner(() => answer());
    await select(runner, ctx(), [], [ask('Who decided the 60-day limit?')], []);
    const { material } = runner.calls[0]!;
    expect(labels(material)).toEqual(['pull request', 'brief', 'change map', 'findings', 'questions']);
    expect(block(material, 'brief')).toContain('Pauses are limited to 60 days');
    expect(block(material, 'change map')).toContain('Cohort: Pausing a plan');
    expect(block(material, 'change map')).toContain('src/pause.ts');
    expect(block(material, 'findings')).toBe('(none)');
    expect(block(material, 'questions')).toBe('q1 | Who decided the 60-day limit?');
  });

  it('removes a question the model says is the same as an earlier question', async () => {
    const questions = [ask('Is 60 days the limit?'), ask('Can a pause last longer than 60 days?'), ask('Who signs off pauses?')];
    const runner = createFakeRunner(() => answer({ questionSameAs: [{ question: 2, sameAs: 'q1' }] }));
    const r = await select(runner, ctx({ pr: theirs }), [], questions, []);
    expect(block(runner.calls[0]!.material, 'questions')!.split('\n')).toEqual([
      'q1 | Is 60 days the limit?', 'q2 | Can a pause last longer than 60 days?', 'q3 | Who signs off pauses?',
    ]);
    expect(r.questions).toEqual([questions[0], questions[2]]);
    expect(r.verdict.sentence).toBe('Nothing that needs fixing was found. 2 questions to settle.');
  });

  it('removes a question the model says is the same as a finding in the result', async () => {
    const kept = [item('a', 'fix', { path: 'src/x.ts' }), item('b', 'ask', { path: 'src/x.ts' }), item('c', 'note')];
    const questions = [ask('Is c intended?'), ask('Is b intended?'), ask('Who owns the report?')];
    const runner = createFakeRunner(() => answer({
      top: ['a'], sameAs: [['a', 'b']], questionSameAs: [{ question: 1, sameAs: 'c' }, { question: 2, sameAs: 'b' }],
    }));
    const r = await select(runner, ctx(), kept, questions, []);
    expect(ids(r.findings)).toEqual(['a', 'c']); // b was merged into a, so q2 counts as the same as a
    expect(r.questions).toEqual([questions[2]]);
  });

  it('keeps a question whose target does not exist, is itself, or was dropped', async () => {
    const questions = ['one', 'two', 'three', 'four', 'five'].map((t) => ask(`Question ${t}?`));
    const runner = createFakeRunner(() => answer({
      top: ['a'],
      questionSameAs: [
        { question: 1, sameAs: 'ghost' }, // no such finding
        { question: 2, sameAs: 'q2' }, // itself
        { question: 3, sameAs: 'q9' }, // no such question
        { question: 4, sameAs: 'gone' }, // a finding dropped before selection
        { question: 5, sameAs: 'Q1' }, // not written as shown
        { question: 0, sameAs: 'q1' }, { question: 6, sameAs: 'q1' }, { question: 1.5, sameAs: 'q2' }, // no such position
      ],
    }));
    const r = await select(runner, ctx(), [item('a', 'fix')], questions, []);
    expect(r.questions).toEqual(questions);
  });

  it('follows a chain and keeps the lowest position of a cycle', async () => {
    const questions = ['1', '2', '3', '4', '5', '6', '7'].map((t) => ask(`Question ${t}?`));
    const runner = createFakeRunner(() => answer({
      top: ['a'],
      questionSameAs: [
        { question: 3, sameAs: 'q2' }, { question: 2, sameAs: 'q1' }, // chain: 3 and 2 go
        { question: 4, sameAs: 'q6' }, { question: 6, sameAs: 'q5' }, { question: 5, sameAs: 'q4' }, // cycle: 4 stays
        { question: 7, sameAs: 'q5' }, // into the cycle: 7 goes
      ],
    }));
    const r = await select(runner, ctx(), [item('a', 'fix')], questions, []);
    expect(texts(r.questions)).toEqual(['Question 1?', 'Question 4?']);
  });

  it('reduces questions with the same text to one without asking, also when the request fails', async () => {
    const questions = [ask('Is 60 the limit?'), ask('Who decides?'), { ...ask('  is 60\n the   LIMIT? '), cohortId: 'k2' }];
    const ok = createFakeRunner(() => answer());
    const asked = await select(ok, ctx(), [], questions, []);
    expect(block(ok.calls[0]!.material, 'questions')!.split('\n')).toEqual(['q1 | Is 60 the limit?', 'q2 | Who decides?']);
    expect(asked.questions).toEqual([questions[0], questions[1]]);

    const failed = await select(createFakeRunner(() => new Error('down')), ctx(), [item('a', 'fix')], questions, []);
    expect(failed.errors).toEqual([{ stage: 'select', cohortId: null, message: 'down' }]);
    expect(failed.questions).toEqual([questions[0], questions[1]]);
  });

  it('sends one select request with the standards in the instructions and the pull request and findings in the material', async () => {
    const packs = [pack('core', [lens('boundary')], {
      title: 'Core', standards: [{ name: 'Harm first', text: 'STANDARD_MARKER rank by harm.', dated: false }],
      learned: [{ date: '2026-11-01', repo: 'acme/widgets', kind: 'intended', text: 'LEARNED_MARKER pauses last 60 days.' }],
    })];
    const kept = [
      item('a', 'block', { title: 'Totals | taxes are wrong', happens: 'The invoice\nshows the wrong total.' }),
      item('b', 'note', { source: { pack: 'orbit', lens: null, ruleId: 'R7' }, anchor: { status: 'not-found', startLine: null, endLine: null } }),
    ];
    const questions = [{ text: 'Is 60 the\nright | limit?', cohortId: 'k1', source: { pack: 'core', lens: 'boundary', ruleId: null } }];
    const runner = createFakeRunner(() => answer({ top: ['a'] }));
    const r = await select(runner, ctx({ packs }), kept, questions, []);

    expect(runner.calls).toHaveLength(1);
    const req = runner.calls[0]!;
    expect(req).toMatchObject({ role: 'select', model: 'claude-opus-5-5', effort: 'high', cwd: '/tmp/head', extraDirs: ['/tmp/base'] });
    expect(req.instructions).toContain('STANDARD_MARKER');
    expect(req.instructions).toContain('LEARNED_MARKER');
    expect(req.instructions).toContain('The reader is a reviewer');
    expect(req.instructions).not.toMatch(/\{\{/);
    expect(labels(req.material)).toEqual(['pull request', 'brief', 'change map', 'findings', 'questions']);
    expect(block(req.material, 'pull request')).toContain('PR_BODY_MARKER');
    expect(block(req.material, 'brief')).toContain('Pauses are limited to 60 days');
    expect(block(req.material, 'findings')!.split('\n')).toEqual([
      'a | block | core/boundary | src/a.ts:2 | Totals \\| taxes are wrong | happens: The invoice shows the wrong total.',
      'b | note | orbit/R7 | src/b.ts:- | Finding b | happens: A member is hurt by b.',
    ]);
    expect(block(req.material, 'questions')!.split('\n')).toEqual(['q1 | Is 60 the right \\| limit?']);
    expect(r.usage).toHaveLength(1);
  });

  it('sends the findings with identical fingerprints once', async () => {
    const kept = [item('a', 'fix', { path: 'src/x.ts', quote: 'go();' }), item('b', 'fix', { path: 'src/x.ts', quote: 'go();' })];
    const runner = createFakeRunner(() => answer({ top: ['a', 'b'] }));
    const r = await select(runner, ctx(), kept, [], []);
    expect(block(runner.calls[0]!.material, 'findings')!.split('\n')).toHaveLength(1);
    expect(ids(r.findings)).toEqual(['a']);
    expect(ids(r.dropped.map((d) => d.candidate))).toEqual(['b']);
  });

  it('says (none) when there are no questions', async () => {
    const runner = createFakeRunner(() => answer({ top: ['a'] }));
    await select(runner, ctx(), [item('a', 'fix')], [], []);
    expect(block(runner.calls[0]!.material, 'questions')).toBe('(none)');
  });

  it('trims whoseCall and checksAfterMerge, removes empties and keeps at most five', async () => {
    const runner = createFakeRunner(() => answer({
      top: ['a'],
      whoseCall: ['  The 60-day limit  ', '', '   ', 'w2', 'w3', 'w4', 'w5', 'w6'],
      checksAfterMerge: [' Pause a plan as a manager ', '', 'c2', 'c3', 'c4', 'c5', 'c6'],
    }));
    const r = await select(runner, ctx(), [item('a', 'fix')], [], []);
    expect(r.whoseCall).toEqual(['The 60-day limit', 'w2', 'w3', 'w4', 'w5']);
    expect(r.checksAfterMerge).toEqual(['Pause a plan as a manager', 'c2', 'c3', 'c4', 'c5']);
  });

  it('ranks by severity when the agent fails, and records the error', async () => {
    const kept = [item('n', 'note'), item('a', 'ask'), item('f', 'fix'), item('b', 'block'), item('f2', 'fix'), item('n2', 'note')];
    const runner = createFakeRunner(() => new Error('model unavailable'));
    const r = await select(runner, ctx({ pr: own }), kept, [], []);
    expect(topIds(r.findings)).toEqual(['b', 'f', 'f2', 'a', 'n']);
    expect(alsoIds(r.findings)).toEqual(['n2']);
    expect(r.errors).toEqual([{ stage: 'select', cohortId: null, message: 'model unavailable' }]);
    expect(r.whoseCall).toEqual([]);
    expect(r.checksAfterMerge).toEqual([]);
    expect(r.verdict.label).toBe('incomplete');
    expect(r.verdict.sentence).toContain('(select)');
    expect(r.selfReviewText.endsWith(' The review did not finish.')).toBe(true);
    expect(r.usage).toHaveLength(1);
  });

  it('passes the split suggestion and earlier stage errors to the verdict', async () => {
    const runner = createFakeRunner(() => answer({ top: ['a'], splitSuggested: true }));
    const split = await select(runner, ctx({ pr: own }), [item('a', 'fix')], [], []);
    expect(split.verdict.label).toBe('split-first');
    const failed = await select(runner, ctx({ pr: own }), [item('a', 'fix')], [], [stageError('lenses')]);
    expect(failed.verdict.label).toBe('incomplete');
    expect(failed.verdict.sentence).toContain('(lenses)');
    expect(failed.errors).toEqual([]);
  });

  it('the self-review text states the short sha, the depth and the counts', async () => {
    const packs = [pack('core', [lens('boundary')], { title: 'Core' }), pack('orbit', [], { title: 'Orbit' })];
    const kept = [item('b', 'block'), item('f1', 'fix'), item('f2', 'fix'), item('q', 'ask'), item('n', 'note')];
    const runner = createFakeRunner(() => answer({ top: ['b', 'f1', 'f2', 'q', 'n'] }));
    const r = await select(runner, ctx({ packs, pr: { ...own, headSha: '0123456789abcdef', stage: 'pr1' } }), kept, [], [], 'deep');
    expect(r.selfReviewText).toBe(
      'Reviewed with Airlock at 0123456 (deep, Core, Orbit). 5 findings: 1 block, 2 fixes, 1 question, 1 note. No checks ran at PR #1.',
    );
  });

  it('leaves out the PR #1 sentence after PR #1 and zero counts', async () => {
    const runner = createFakeRunner(() => answer({ top: ['f'] }));
    const r = await select(runner, ctx({ pr: { ...own, headSha: 'abcdef0123', stage: 'pr2' } }), [item('f', 'fix')], [], []);
    expect(r.selfReviewText).toBe('Reviewed with Airlock at abcdef0 (standard, Pack core). 1 finding: 1 fix.');
  });

  it('says no findings in the self-review text when there are none', async () => {
    const runner = createFakeRunner(() => answer());
    const r = await select(runner, ctx({ pr: { ...own, headSha: 'abcdef0123', stage: 'pr1' } }), [], [], []);
    expect(r.selfReviewText).toBe('Reviewed with Airlock at abcdef0 (standard, Pack core). No findings. No checks ran at PR #1.');
  });

  it('never says no findings for a review that did not finish', async () => {
    const runner = createFakeRunner(() => answer());
    const r = await select(runner, ctx({ pr: { ...own, headSha: 'abcdef0123', stage: 'pr2' } }), [], [], [stageError('facts')]);
    expect(r.verdict.label).toBe('incomplete');
    expect(r.selfReviewText).toBe('Reviewed with Airlock at abcdef0 (standard, Pack core). Airlock could not finish reviewing this pull request.');
  });
});

describe('decideVerdict', () => {
  it('own pull request with a fix is not-ready', () => {
    const v = decideVerdict(own, [finding('f', 'fix', 'top', 1), finding('n', 'note', 'also', null)], [], false, 0);
    expect(v).toEqual({
      label: 'not-ready', sentence: '1 thing to fix before this merges. The first: Finding f.',
      counts: { block: 0, fix: 1, ask: 0, note: 1 },
    });
  });

  it('own pull request with only notes is ready-for-pr2', () => {
    const v = decideVerdict(own, [finding('n', 'note')], [], false, 0);
    expect(v.label).toBe('ready-for-pr2');
    expect(v.sentence).toBe('Nothing that needs fixing was found.');
  });

  it('own pull request that should be split is split-first', () => {
    const v = decideVerdict(own, [finding('b', 'block')], [], true, 0);
    expect(v.label).toBe('split-first');
    expect(v.sentence).toBe('This pull request is too large or mixed to review well in one go. Split it, then review the parts.');
  });

  it('someone else\'s pull request with a block is request-changes', () => {
    const findings = [finding('f', 'fix', 'top', 1), finding('b', 'block', 'top', 2), finding('f2', 'fix', 'also', null)];
    const v = decideVerdict(theirs, findings, [], true, 0);
    expect(v.label).toBe('request-changes');
    expect(v.sentence).toBe('3 things to fix before this merges. The first: Finding f.');
    expect(v.counts).toEqual({ block: 1, fix: 2, ask: 0, note: 0 });
  });

  it('names the highest-ranked block or fix, whatever the order of the list', () => {
    const findings = [finding('n', 'note', 'also', null), finding('f2', 'fix', 'top', 3), finding('f1', 'fix', 'top', 2), finding('q', 'ask', 'top', 1)];
    expect(decideVerdict(own, findings, [], false, 0).sentence).toBe('2 things to fix before this merges. The first: Finding f1.');
  });

  it('someone else\'s pull request with a fix is approve-after-fixes', () => {
    const one = decideVerdict(theirs, [finding('f', 'fix')], [], false, 0);
    expect(one.label).toBe('approve-after-fixes');
    expect(one.sentence).toBe('1 thing to fix, none of them blocking. The first: Finding f.');
    const two = decideVerdict(theirs, [finding('f', 'fix', 'top', 1), finding('g', 'fix', 'top', 2)], [], false, 0);
    expect(two.sentence).toBe('2 things to fix, none of them blocking. The first: Finding f.');
  });

  it('someone else\'s pull request with only questions and notes is approve and counts the questions', () => {
    const one = decideVerdict(theirs, [finding('q', 'ask'), finding('n', 'note', 'also', null)], [], false, 0);
    expect(one.label).toBe('approve');
    expect(one.sentence).toBe('Nothing that needs fixing was found. 1 question to settle.');
    const two = decideVerdict(theirs, [finding('q', 'ask', 'top', 1), finding('r', 'ask', 'top', 2)], [], false, 0);
    expect(two.sentence).toBe('Nothing that needs fixing was found. 2 questions to settle.');
    expect(decideVerdict(theirs, [], [], false, 0)).toEqual({
      label: 'approve', sentence: 'Nothing that needs fixing was found.', counts: { block: 0, fix: 0, ask: 0, note: 0 },
    });
  });

  it('the sentence counts ask findings and surviving questions together', () => {
    const v = decideVerdict(theirs, [finding('q', 'ask'), finding('n', 'note', 'also', null)], [], false, 2);
    expect(v).toEqual({
      label: 'approve', sentence: 'Nothing that needs fixing was found. 3 questions to settle.', counts: { block: 0, fix: 0, ask: 1, note: 1 },
    });
    const one = decideVerdict(own, [], [], false, 1);
    expect(one.label).toBe('ready-for-pr2');
    expect(one.sentence).toBe('Nothing that needs fixing was found. 1 question to settle.');
    expect(one.counts).toEqual({ block: 0, fix: 0, ask: 0, note: 0 });
    expect(decideVerdict(own, [finding('f', 'fix')], [], false, 4).sentence).toBe('1 thing to fix before this merges. The first: Finding f.');
  });

  it('does not add a second full stop after a title that has one', () => {
    const f = { ...finding('f', 'fix'), title: 'The total is wrong.' };
    expect(decideVerdict(own, [f], [], false, 0).sentence).toBe('1 thing to fix before this merges. The first: The total is wrong.');
  });

  it('strips trailing punctuation and ellipses from the title before the full stop', () => {
    const sentence = (title: string): string => decideVerdict(own, [{ ...finding('f', 'fix'), title }], [], false, 0).sentence;
    const expected = '1 thing to fix before this merges. The first: Totals are wrong.';
    expect(sentence('Totals are wrong:')).toBe(expected);
    expect(sentence('Totals are wrong;')).toBe(expected);
    expect(sentence('Totals are wrong,')).toBe(expected);
    expect(sentence('Totals are wrong…')).toBe(expected);
    expect(sentence('Totals are wrong...')).toBe(expected);
    expect(sentence('Totals are wrong ; , …')).toBe(expected);
  });

  it('cuts a long title at a word boundary, within 120 characters, ending with an ellipsis', () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const { sentence } = decideVerdict(own, [{ ...finding('f', 'fix'), title: words }], [], false, 0);
    const quoted = sentence.slice(sentence.indexOf('The first: ') + 'The first: '.length);
    expect(quoted.length).toBeLessThanOrEqual(120);
    expect(quoted.endsWith('…')).toBe(true);
    expect(words.startsWith(quoted.slice(0, -1))).toBe(true);
    expect(words[quoted.length - 1]).toBe(' ');
    const exact = 'x'.repeat(120);
    expect(decideVerdict(own, [{ ...finding('f', 'fix'), title: exact }], [], false, 0).sentence.endsWith(`${exact}.`)).toBe(true);
  });

  it('any stage error makes the verdict incomplete and names the stage', () => {
    const errors = [stageError('lenses'), stageError('challenge'), stageError('lenses')];
    const v = decideVerdict(own, [finding('n', 'note')], errors, true, 0);
    expect(v.label).toBe('incomplete');
    expect(v.sentence).toBe(
      'The review did not finish (lenses, challenge). What was found is listed below, but this is not a complete review.',
    );
    expect(decideVerdict(theirs, [], [stageError('select')], false, 0).label).toBe('incomplete');
  });
});
