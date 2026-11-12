import type { FileDiff } from '@airlock/shared';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commentLine } from '../../src/anchor/comment-line.js';
import { rawCandidate } from '../helpers/lens-context.js';
import { scenarioScript, useReviewHarness } from '../helpers/review-scenario.js';

const SIX_LENSES_DIR = fileURLToPath(new URL('../fixtures/pipeline/six-lenses/', import.meta.url));

type Row = ['add' | 'ctx', number] | ['del'];

/** A file whose hunks hold the given rows; a deleted line has no new number. */
const diff = (hunks: Row[][], over: Partial<FileDiff> = {}): FileDiff => ({
  path: 'a.ts', oldPath: null, status: 'modified', binary: false, additions: 0, deletions: 0,
  hunks: hunks.map((rows) => ({
    oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, header: '@@',
    lines: rows.map((r) => (r[0] === 'del'
      ? { kind: 'del' as const, oldNo: 1, newNo: null, text: '' }
      : { kind: r[0], oldNo: null, newNo: r[1], text: '' })),
  })),
  ...over,
});
const range = (from: number, to: number): Row[] => Array.from({ length: to - from + 1 }, (_, i) => ['add', from + i] as Row);

describe('commentLine', () => {
  it('a range inside one hunk gives its last line and its first line', () => {
    expect(commentLine(diff([range(10, 20)]), 12, 15)).toEqual({ line: 15, startLine: 12 });
  });

  it('a single line gives that line and no start line', () => {
    expect(commentLine(diff([range(10, 20)]), 12, 12)).toEqual({ line: 12, startLine: null });
  });

  it('a range that runs past the end of a hunk gives the last line inside it and no start line', () => {
    // the range begins before the hunk, so the first line is not one a comment can start on
    expect(commentLine(diff([range(10, 14)]), 8, 18)).toEqual({ line: 14, startLine: null });
    // the range begins inside the hunk and ends past it: the last in-hunk line, with the first line kept
    expect(commentLine(diff([range(10, 14)]), 12, 18)).toEqual({ line: 14, startLine: 12 });
  });

  it('a range spanning two hunks gives the last in-hunk line and no start line', () => {
    expect(commentLine(diff([range(10, 14), range(30, 34)]), 12, 32)).toEqual({ line: 32, startLine: null });
  });

  it('a context line counts, a deleted line does not', () => {
    const f = diff([[['ctx', 10], ['del'], ['add', 11], ['ctx', 12]]]);
    expect(commentLine(f, 10, 10)).toEqual({ line: 10, startLine: null });
    expect(commentLine(f, 10, 12)).toEqual({ line: 12, startLine: 10 });
    expect(commentLine(diff([[['del'], ['del']]]), 1, 2)).toBeNull();
  });

  it('a file that changed type counts its new side only', () => {
    const f = diff([[['del'], ['del']], [['add', 1]]], { mode: '120000' });
    expect(commentLine(f, 1, 1)).toEqual({ line: 1, startLine: null });
    expect(commentLine(f, 2, 2)).toBeNull();
  });

  it('outside every hunk, a binary file, a deleted file and an unanchored finding give null', () => {
    const f = diff([range(10, 14)]);
    expect(commentLine(f, 1, 5)).toBeNull();
    expect(commentLine(f, 15, 20)).toBeNull();
    expect(commentLine(undefined, 10, 12)).toBeNull();
    expect(commentLine({ ...f, binary: true }, 10, 12)).toBeNull();
    expect(commentLine({ ...f, status: 'deleted' }, 10, 12)).toBeNull();
    expect(commentLine(diff([]), 10, 12)).toBeNull();
    expect(commentLine(f, null, null)).toBeNull();
    expect(commentLine(f, 10, null)).toBeNull();
    expect(commentLine(f, null, 12)).toBeNull();
  });
});

describe('the pipeline document', () => {
  const h = useReviewHarness();

  it('the pipeline document carries anchor.comment on every finding', async () => {
    const { doc } = await h.review();
    expect(doc.findings.length).toBeGreaterThan(0);
    for (const f of doc.findings) {
      expect(f.anchor.comment, f.title).toBeDefined();
      if (f.anchor.status === 'in-diff') expect(f.anchor.comment, f.title).not.toBeNull();
      if (f.anchor.comment) expect(f.anchor.comment.line).toBeLessThanOrEqual(f.anchor.endLine!);
    }
  }, 20_000);

  it('a merged finding keeps the comment line it was anchored with', async () => {
    const same = (req: { role: string; material: string }) => (req.material.includes('Cohort: Money') ? {
      candidates: [rawCandidate({ title: `${req.role}: the total is not rounded`, path: 'src/money.ts', quote: 'return n.toFixed(2);', lineHint: 3 })],
      questions: [],
    } : { candidates: [], questions: [] });
    const oneSet = (req: { material: string }) => ({
      clusters: [...req.material.matchAll(/<material label="cluster (d\d+)">\n([\s\S]*?)\n<\/material>/g)].map(([, id, body]) => ({
        id, sets: [body!.split('\n').filter((l) => l.startsWith('- id: ')).map((l) => l.slice(6))], reason: 'Same line.',
      })),
    });
    const { doc } = await h.review({ req: { packsDir: SIX_LENSES_DIR }, script: scenarioScript({ 'lens:': same, merge: oneSet }) });
    expect(doc.findings).toHaveLength(1);
    const f = doc.findings[0]!;
    expect(f.aliases!.length).toBeGreaterThan(0);
    expect(f.anchor.comment).toEqual({ line: f.anchor.endLine, startLine: null });
  }, 20_000);
});
