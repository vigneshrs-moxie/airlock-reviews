import { candidate } from '@airlock/shared';
import type { FileDiff } from '@airlock/shared';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anchorCandidates, anchorQuote, findQuote } from '../../src/anchor/anchor.js';
import { MAX_SAFE_READ_BYTES, safeRead } from '../../src/util/safe-read.js';

const file = (over: Partial<FileDiff> & { addedLines?: number[] }): FileDiff => ({
  path: 'a.ts', oldPath: null, status: 'modified', binary: false, additions: 0, deletions: 0,
  hunks: (over.addedLines ?? []).length === 0 ? [] : [{
    oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, header: '@@',
    lines: (over.addedLines ?? []).map((n) => ({ kind: 'add' as const, oldNo: null, newNo: n, text: '' })),
  }],
  ...over,
});

const text = ['one', '  const total = price * qty;', 'two', 'const total = price * qty;', 'three', 'four'].join('\n');

describe('anchorQuote', () => {
  it('finds a quote despite different indentation', () => {
    expect(anchorQuote('function f() {\n    return   a + b;\n}', 'return a + b;', null, file({ addedLines: [2] })))
      .toEqual({ status: 'in-diff', startLine: 2, endLine: 2 });
  });

  it('picks the occurrence inside the diff when the line appears twice', () => {
    expect(anchorQuote(text, 'const total = price * qty;', 2, file({ addedLines: [4] })))
      .toEqual({ status: 'in-diff', startLine: 4, endLine: 4 });
  });

  it('picks the occurrence nearest the hint when both are inside the diff', () => {
    const f = file({ addedLines: [2, 4] });
    expect(anchorQuote(text, 'const total = price * qty;', 5, f).startLine).toBe(4);
    expect(anchorQuote(text, 'const total = price * qty;', 1, f).startLine).toBe(2);
  });

  it('matches a three-line quote on consecutive lines only', () => {
    const t = ['a1;', 'b2;', 'c3;', 'a1;', 'x;', 'c3;', 'a1;', 'b2;', 'c3;'].join('\n');
    expect(anchorQuote(t, 'a1;\nb2;\nc3;', 5, undefined)).toEqual({ status: 'outside-diff', startLine: 7, endLine: 9 });
    expect(anchorQuote('a1;\nx;\nb2;\nc3;', 'a1;\nb2;\nc3;', null, undefined).status).toBe('not-found');
  });

  it('falls back to the longest line of a quote that drifted', () => {
    const t = 'short\nconst result = compute(alpha, beta);\nend';
    expect(anchorQuote(t, 'if (x) {\nconst result = compute(alpha, beta);\n  oops();', null, undefined))
      .toEqual({ status: 'outside-diff', startLine: 2, endLine: 2 });
    expect(anchorQuote('a = 1;', 'x = 1;\ny = 2;', null, undefined).status).toBe('not-found');
  });

  it('reports outside-diff for code the pull request did not touch', () => {
    expect(anchorQuote(text, 'three', null, file({ addedLines: [2] }))).toEqual({ status: 'outside-diff', startLine: 5, endLine: 5 });
  });

  it('is not-found for null text or a blank quote', () => {
    expect(anchorQuote(null, 'x', null, undefined).status).toBe('not-found');
    expect(anchorQuote('x', ' \n\t', null, undefined)).toEqual({ status: 'not-found', startLine: null, endLine: null });
  });
});

describe('findQuote', () => {
  it('needs every line of the quote and never falls back', () => {
    const t = 'short\nconst result = compute(alpha, beta);\nend';
    expect(findQuote(t, 'if (x) {\nconst result = compute(alpha, beta);')).toEqual([]);
    expect(findQuote(t, '\n  const result = compute(alpha, beta);\nend\n')).toEqual([{ startLine: 2, endLine: 3 }]);
  });

  it('returns every place the quote occurs, in file order', () => {
    const t = ['a1;', 'b2;', 'x;', 'a1;', 'b2;'].join('\n');
    expect(findQuote(t, 'a1;\nb2;')).toEqual([{ startLine: 1, endLine: 2 }, { startLine: 4, endLine: 5 }]);
  });

  it('finds nothing in a missing file or for a blank quote', () => {
    expect(findQuote(null, 'a1;')).toEqual([]);
    expect(findQuote('a1;', ' \n\t')).toEqual([]);
  });
});

describe('anchorCandidates', () => {
  const head: Record<string, string> = { 'a.ts': text, 'b.ts': 'import { y } from "./y";\nexport const z = 1;' };
  const reads: string[] = [];
  const readHead = async (p: string): Promise<string | null> => { reads.push(p); return head[p] ?? null; };

  it('drops a candidate whose quote is nowhere in the file, with the path in the reason', async () => {
    const good = { ...candidate(), id: 'g', path: 'a.ts', quote: 'three' };
    const bad = { ...candidate(), id: 'b', path: 'a.ts', quote: 'invented();' };
    const res = await anchorCandidates([bad, good], [file({ addedLines: [5] })], readHead);
    expect(res.anchored.map((c) => c.id)).toEqual(['g']);
    expect(res.anchored[0]?.anchor.status).toBe('in-diff');
    expect(res.dropped).toHaveLength(1);
    expect(res.dropped[0]).toMatchObject({ stage: 'anchor', reason: 'quoted code is not in a.ts at the head commit', refutation: null });
    expect(res.dropped[0]?.candidate.id).toBe('b');
  });

  it('a candidate on a deleted file is dropped as not found', async () => {
    const c = { ...candidate(), path: 'gone.ts', quote: 'anything' };
    const res = await anchorCandidates([c], [file({ path: 'gone.ts', status: 'deleted' })], async () => 'anything');
    expect(res.anchored).toEqual([]);
    expect(res.dropped[0]?.reason).toBe('quoted code is not in gone.ts at the head commit');
  });

  it('fills connected lines, reads each file once and does not mutate inputs', async () => {
    reads.length = 0;
    const c = {
      ...candidate(), path: 'a.ts', quote: 'three',
      connected: [
        { path: 'b.ts', line: null, role: 'caller', quote: 'export const z = 1;' },
        { path: 'b.ts', line: null, role: 'x', quote: 'missing' },
        { path: 'c.ts', line: 3, role: 'x', quote: 'q' },
        { path: 'a.ts', line: 9, role: 'x', quote: '' },
      ],
    };
    const before = structuredClone(c);
    const res = await anchorCandidates([c], [], readHead);
    expect(res.anchored[0]?.connected.map((p) => p.line)).toEqual([2, null, null, null]);
    expect(res.anchored[0]?.connected.map((p) => p.role)).toEqual([
      'caller', 'x (not found in the file)', 'x (not found in the file)', 'x',
    ]);
    expect(c).toEqual(before);
    expect(reads.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('replaces the quote with the file\'s own lines at the anchored range', async () => {
    const t = 'short\n    const result = compute(alpha, beta);\nend';
    const c = {
      ...candidate(), path: 'r.ts', quote: 'if (x) {\nconst result = compute(alpha, beta);\n  oops();',
      connected: [{ path: 'r.ts', line: null, role: 'the end', quote: 'end' }],
    };
    const res = await anchorCandidates([c], [], async () => t);
    expect(res.anchored[0]?.anchor).toEqual({ status: 'outside-diff', startLine: 2, endLine: 2, comment: null });
    expect(res.anchored[0]?.quote).toBe('    const result = compute(alpha, beta);');
    expect(res.anchored[0]?.connected[0]).toEqual({ path: 'r.ts', line: 3, role: 'the end', quote: 'end' });
    const whole = await anchorCandidates([{ ...c, quote: 'const   result = compute(alpha, beta);\nend' }], [], async () => t);
    expect(whole.anchored[0]?.quote).toBe('    const result = compute(alpha, beta);\nend');
  });

  it('says the file could not be read when it cannot, rather than that the quote is not in it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airlock-anchor-'));
    try {
      await writeFile(join(dir, 'a%20b.ts'), 'three\n');
      await writeFile(join(dir, 'big.ts'), `three\n${'x'.repeat(MAX_SAFE_READ_BYTES)}`);
      const read = (p: string) => safeRead(dir, p);
      const res = await anchorCandidates([
        { ...candidate(), id: 'pct', path: 'a%20b.ts', quote: 'three' },
        { ...candidate(), id: 'big', path: 'big.ts', quote: 'three' },
      ], [], read);
      expect(res.anchored).toEqual([]);
      expect(res.dropped.map((d) => [d.candidate.id, d.reason])).toEqual([
        ['pct', 'the file a%20b.ts could not be read'], ['big', 'the file big.ts could not be read'],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
