import type { ChangeMap, Cohort, FileDiff, FileFact, Layer, Tier } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import { checkChangeMap } from '../../src/map/check.js';

const diff = (path: string, status: FileDiff['status'] = 'modified'): FileDiff => ({
  path, oldPath: null, status, binary: false, additions: 1, deletions: 0, hunks: [],
});
const fact = (path: string, tier: Tier = 'read'): FileFact => ({ path, tier, reason: '' });
const layer = (id: string, files: string[], dependsOn: string[] = []): Layer => ({
  id, title: `Layer ${id}`, kind: 'other', files, dependsOn, note: '',
});
const cohort = (id: string, layers: Layer[], title = `Cohort ${id}`): Cohort => ({
  id, title, summary: '', layers, neighbours: [], inferredLinks: [],
});
const map = (cohorts: Cohort[], standalone: string[] = []): ChangeMap => ({ cohorts, standalone, links: [] });

const files = [diff('src/a.ts'), diff('src/b.ts'), diff('src/c.ts')];
const facts = files.map((f) => fact(f.path));

describe('checkChangeMap', () => {
  it('accepts a map that places every non-ignored file once', () => {
    const m = map([cohort('k1', [layer('k1.l1', ['src/a.ts']), layer('k1.l2', ['src/b.ts'], ['k1.l1'])])], ['src/c.ts']);
    expect(checkChangeMap(m, files, facts)).toEqual([]);
  });

  it('reports a file that is missing and one that appears twice', () => {
    const m = map([cohort('k1', [layer('k1.l1', ['src/a.ts']), layer('k1.l2', ['src/b.ts'])])], ['src/b.ts']);
    expect(checkChangeMap(m, files, facts)).toEqual([
      'src/b.ts is placed twice (cohort k1 layer k1.l2, standalone)',
      'src/c.ts is not placed in any cohort or in standalone',
    ]);
  });

  it('reports a dependsOn that names an unknown layer', () => {
    const m = map([
      cohort('k1', [layer('k1.l1', ['src/a.ts']), layer('k1.l2', ['src/b.ts'], ['k1.l9', 'k2.l1'])]),
      cohort('k2', [layer('k2.l1', ['src/c.ts'])]),
    ]);
    expect(checkChangeMap(m, files, facts)).toEqual([
      'layer k1.l2 in cohort k1 depends on "k1.l9", which is not a layer of cohort k1',
      'layer k1.l2 in cohort k1 depends on "k2.l1", which is not a layer of cohort k1',
    ]);
  });

  it('does not require ignored files to be placed', () => {
    const withLock = [...files, diff('package-lock.json')];
    const withLockFacts = [...facts, fact('package-lock.json', 'ignored')];
    const m = map([cohort('k1', [layer('k1.l1', ['src/a.ts', 'src/b.ts'])])], ['src/c.ts']);
    expect(checkChangeMap(m, withLock, withLockFacts)).toEqual([]);
  });

  it('a deleted file must still be placed', () => {
    const withDeleted = [...files, diff('src/old.ts', 'deleted')];
    const withDeletedFacts = [...facts, fact('src/old.ts')];
    const m = map([cohort('k1', [layer('k1.l1', ['src/a.ts', 'src/b.ts'])])], ['src/c.ts']);
    expect(checkChangeMap(m, withDeleted, withDeletedFacts)).toEqual(['src/old.ts is not placed in any cohort or in standalone']);
  });

  it('reports a file that is not in the diff', () => {
    const m = map([cohort('k1', [layer('k1.l1', ['src/a.ts', 'src/b.ts', 'src/z.ts'])])], ['src/c.ts', 'src/z.ts']);
    expect(checkChangeMap(m, files, facts)).toEqual(['src/z.ts is not a changed file']);
  });

  it('a file with no fact counts as one that must be placed', () => {
    const m = map([cohort('k1', [layer('k1.l1', ['src/a.ts', 'src/b.ts'])])]);
    expect(checkChangeMap(m, files, [fact('src/a.ts'), fact('src/b.ts')])).toEqual([
      'src/c.ts is not placed in any cohort or in standalone',
    ]);
  });

  it('reports a cohort with no layers, a blank title, a repeated id and a repeated layer id', () => {
    const m = map([
      cohort('k1', [layer('k1.l1', ['src/a.ts']), layer('k1.l1', ['src/b.ts'])]),
      cohort('k2', [], '  '),
      cohort('k1', [layer('k1.l3', ['src/c.ts'])]),
    ]);
    expect(checkChangeMap(m, files, facts)).toEqual([
      'cohort k1 has the layer id "k1.l1" more than once',
      'cohort k2 has no title',
      'cohort k2 has no layers',
      'cohort id "k1" is used more than once',
    ]);
  });

  it('reports a cohort with a blank id or the reserved id standalone', () => {
    const m = map([cohort('', [layer('l1', ['src/a.ts', 'src/b.ts'])]), cohort('standalone', [layer('l1', ['src/c.ts'])])]);
    expect(checkChangeMap(m, files, facts)).toEqual([
      'a cohort has an empty id',
      'cohort id "standalone" is reserved for the standalone group',
    ]);
  });
});
