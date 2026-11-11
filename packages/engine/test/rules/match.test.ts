import type { ChangeMap } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import { planSweep, rulesForFile } from '../../src/rules/match.js';
import { cohort, diff, layer, pack, rule, tier } from '../helpers/lens-context.js';

const mapOf = (...cohorts: ReturnType<typeof cohort>[]): ChangeMap => ({ cohorts, standalone: [], links: [] });
const one = (files: string[]) => mapOf(cohort('k1', 'One', [layer('k1.l1', 'rules', files)]));

describe('rulesForFile', () => {
  it('matches a rule by glob and not a rule for another folder', () => {
    const packs = [pack('core', [], { rules: [rule('a', ['src/billing/**']), rule('b', ['src/members/**'])] })];
    expect(rulesForFile('src/billing/charge.ts', packs).map((r) => r.id)).toEqual(['a']);
    expect(rulesForFile('docs/readme.md', packs)).toEqual([]);
  });

  it('matches dot files and keeps pack order, then rule order', () => {
    const packs = [
      pack('one', [], { rules: [rule('z', ['**/*.ts'], { packId: 'one' }), rule('y', ['src/.hidden/*'], { packId: 'one' })] }),
      pack('two', [], { rules: [rule('x', ['src/**'], { packId: 'two' })] }),
    ];
    expect(rulesForFile('src/.hidden/a.ts', packs).map((r) => r.id)).toEqual(['z', 'y', 'x']);
  });

  it('matches when any one of the rule globs matches', () => {
    const packs = [pack('core', [], { rules: [rule('a', ['nope/**', 'src/*.ts'])] })];
    expect(rulesForFile('src/a.ts', packs)).toHaveLength(1);
  });
});

describe('planSweep', () => {
  const packs = [pack('core', [], { rules: [rule('a', ['src/a/**']), rule('b', ['src/b/**']), rule('all', ['src/**'])] })];

  it('puts the files of one group in one batch with the union of their rules, each file with the ids of its own', () => {
    const files = ['src/a/1.ts', 'src/a/2.ts', 'src/b/3.ts'];
    const batches = planSweep(one(files), files.map((f) => tier(f)), files.map((f) => diff(f)), packs);
    expect(batches.map((b) => b.files)).toEqual([['src/a/1.ts', 'src/a/2.ts', 'src/b/3.ts']]);
    expect(batches[0]!.rules.map((r) => r.id)).toEqual(['a', 'b', 'all']);
    expect(batches[0]!.rulesOf).toEqual({ 'src/a/1.ts': ['a', 'all'], 'src/a/2.ts': ['a', 'all'], 'src/b/3.ts': ['b', 'all'] });
    expect(batches[0]!.cohortId).toBe('k1');
  });

  it('makes one batch per group for a change with three groups whose files match different rules', () => {
    const map: ChangeMap = {
      ...mapOf(cohort('k1', 'One', [layer('k1.l1', 'rules', ['src/a/1.ts', 'src/b/2.ts'])]), cohort('k2', 'Two', [layer('k2.l1', 'data', ['src/b/3.ts', 'src/c/4.ts'])])),
      standalone: ['src/a/5.ts', 'src/b/6.ts'],
    };
    const files = ['src/a/1.ts', 'src/b/2.ts', 'src/b/3.ts', 'src/c/4.ts', 'src/a/5.ts', 'src/b/6.ts'];
    const batches = planSweep(map, files.map((f) => tier(f)), files.map((f) => diff(f)), packs);
    expect(batches.map((b) => [b.cohortId, b.files])).toEqual([
      ['k1', ['src/a/1.ts', 'src/b/2.ts']], ['k2', ['src/b/3.ts', 'src/c/4.ts']], ['standalone', ['src/a/5.ts', 'src/b/6.ts']],
    ]);
  });

  it('closes a batch before the union of its rules would pass 25, in the group\'s file order', () => {
    const tens = [0, 1, 2].map((f) => Array.from({ length: 10 }, (_, i) => rule(`f${f}r${i}`, [`src/${f}.ts`])));
    const many = [pack('core', [], { rules: tens.flat() })];
    const files = ['src/0.ts', 'src/1.ts', 'src/2.ts'];
    const batches = planSweep(one(files), files.map((f) => tier(f)), files.map((f) => diff(f)), many);
    expect(batches.map((b) => b.files)).toEqual([['src/0.ts', 'src/1.ts'], ['src/2.ts']]);
    expect(batches.map((b) => b.rules.length)).toEqual([20, 10]);
  });

  it('gives a file matching more than 25 rules batches of at most 25 of its rules', () => {
    const many = [pack('core', [], { rules: Array.from({ length: 30 }, (_, i) => rule(`r${i}`, ['src/**'])) })];
    const files = ['src/x.ts', 'src/y.ts'];
    const batches = planSweep(one(files), files.map((f) => tier(f)), files.map((f) => diff(f)), many);
    expect(batches.map((b) => [b.files, b.rules.length])).toEqual([[['src/x.ts'], 25], [['src/x.ts'], 5], [['src/y.ts'], 25], [['src/y.ts'], 5]]);
  });

  it('sends every file-and-rule pair that matches in exactly one batch, never over a cap, never a rule to a file it does not match', () => {
    let seed = 11;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 30; round += 1) {
      const rules = Array.from({ length: 5 + next(40) }, (_, i) => rule(`r${i}`, [`src/d${next(6)}/**`, ...(next(3) === 0 ? ['src/**/*.ts'] : [])]));
      const packsHere = [pack('core', [], { rules })];
      const files = Array.from({ length: 1 + next(30) }, (_, i) => `src/d${next(6)}/f${i}.${next(2) === 0 ? 'ts' : 'sql'}`);
      const map: ChangeMap = { ...mapOf(cohort('k1', 'One', [layer('k1.l1', 'rules', files.slice(0, files.length / 2))])), standalone: files.slice(files.length / 2) };
      const batches = planSweep(map, files.map((f) => tier(f)), files.map((f) => diff(f, 1 + next(400))), packsHere);
      const expected = files.flatMap((f) => rulesForFile(f, packsHere).map((r) => `${f} ${r.id}`)).sort();
      const sent = batches.flatMap((b) => b.files.flatMap((f) => b.rulesOf[f]!.map((id) => `${f} ${id}`))).sort();
      expect(sent).toEqual(expected);
      for (const b of batches) {
        expect(b.files.length).toBeLessThanOrEqual(8);
        expect(b.rules.length).toBeLessThanOrEqual(25);
        const given = new Set(b.rules.map((r) => r.id));
        for (const f of b.files) {
          const own = new Set(rulesForFile(f, packsHere).map((r) => r.id));
          for (const id of b.rulesOf[f]!) expect(own.has(id) && given.has(id)).toBe(true);
        }
      }
    }
  });

  it('splits a batch at 8 files', () => {
    const files = Array.from({ length: 10 }, (_, i) => `src/a/${i}.ts`);
    const batches = planSweep(one(files), files.map((f) => tier(f)), files.map((f) => diff(f)), packs);
    expect(batches.map((b) => b.files.length)).toEqual([8, 2]);
  });

  it('never includes trust or ignored files', () => {
    const files = ['src/a/1.ts', 'src/a/2.ts', 'src/a/3.ts', 'src/a/4.ts'];
    const tiers = [tier(files[0]!, 'read'), tier(files[1]!, 'skim'), tier(files[2]!, 'trust'), tier(files[3]!, 'ignored')];
    const batches = planSweep(one(files), tiers, files.map((f) => diff(f)), packs);
    expect(batches.map((b) => b.files)).toEqual([['src/a/1.ts', 'src/a/2.ts']]);
  });

  it('never includes deleted or binary files', () => {
    const files = ['src/a/1.ts', 'src/a/2.ts', 'src/a/3.ts'];
    const diffs = [diff(files[0]!), diff(files[1]!, 3, { status: 'deleted' }), diff(files[2]!, 0, { binary: true })];
    const batches = planSweep(one(files), files.map((f) => tier(f)), diffs, packs);
    expect(batches.map((b) => b.files)).toEqual([['src/a/1.ts']]);
  });

  it('closes a batch when the next file would take it past 1,200 changed lines, and gives a huge file its own batch', () => {
    const files = ['src/a/1.ts', 'src/a/2.ts', 'src/a/3.ts', 'src/a/4.ts'];
    const diffs = [diff(files[0]!, 700), diff(files[1]!, 400, { deletions: 100 }), diff(files[2]!, 1500), diff(files[3]!, 10)];
    const batches = planSweep(one(files), files.map((f) => tier(f)), diffs, packs);
    // 700 + 500 = 1200 fits; the 1500-line file does not; the 10-line file starts after it
    expect(batches.map((b) => b.files)).toEqual([['src/a/1.ts', 'src/a/2.ts'], ['src/a/3.ts'], ['src/a/4.ts']]);
  });

  it('counts additions and deletions together against the limit', () => {
    const files = ['src/a/1.ts', 'src/a/2.ts'];
    const diffs = [diff(files[0]!, 600, { deletions: 1 }), diff(files[1]!, 600)];
    const batches = planSweep(one(files), files.map((f) => tier(f)), diffs, packs);
    expect(batches.map((b) => b.files)).toEqual([['src/a/1.ts'], ['src/a/2.ts']]);
  });

  it('sweeps standalone files as cohort standalone, after the cohorts', () => {
    const map: ChangeMap = { ...one(['src/a/1.ts']), standalone: ['src/a/s.ts'] };
    const files = ['src/a/1.ts', 'src/a/s.ts'];
    const batches = planSweep(map, files.map((f) => tier(f)), files.map((f) => diff(f)), packs);
    expect(batches.map((b) => [b.cohortId, b.files])).toEqual([['k1', ['src/a/1.ts']], ['standalone', ['src/a/s.ts']]]);
  });

  it('orders batches by cohort, and files by layer order', () => {
    const map = mapOf(
      cohort('k1', 'One', [layer('k1.l1', 'data', ['src/b/1.ts']), layer('k1.l2', 'rules', ['src/a/2.ts'])]),
      cohort('k2', 'Two', [layer('k2.l1', 'rules', ['src/a/3.ts'])]),
    );
    const files = ['src/b/1.ts', 'src/a/2.ts', 'src/a/3.ts'];
    const batches = planSweep(map, files.map((f) => tier(f)), files.map((f) => diff(f)), packs);
    expect(batches.map((b) => b.files)).toEqual([['src/b/1.ts', 'src/a/2.ts'], ['src/a/3.ts']]);
  });

  it('gives no batches when no rule matches', () => {
    expect(planSweep(one(['docs/x.md']), [tier('docs/x.md')], [diff('docs/x.md')], packs)).toEqual([]);
    expect(planSweep(one(['src/a/1.ts']), [tier('src/a/1.ts')], [diff('src/a/1.ts')], [pack('core', [])])).toEqual([]);
  });
});
