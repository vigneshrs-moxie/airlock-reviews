import { readFileSync } from 'node:fs';
import type { FileDiff } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import { lineInDiff, loadDiff, parseDiff } from '../../src/diff/parse.js';
import type { Exec } from '../../src/util/exec.js';

const fx = (name: string): string => readFileSync(new URL(`../fixtures/diffs/${name}.diff`, import.meta.url), 'utf8');

const one = (name: string): FileDiff => {
  const f = parseDiff(fx(name))[0];
  if (!f) throw new Error(`no file in fixture ${name}`);
  return f;
};

describe('parseDiff', () => {
  it('numbers added and context lines from the hunk header', () => {
    const file = one('modified-two-hunks');
    expect(file.path).toBe('src/app.ts');
    expect(file.status).toBe('modified');
    expect(file.hunks).toHaveLength(2);
    const h = file.hunks[0];
    expect(h).toMatchObject({ oldStart: 10, oldLines: 3, newStart: 12, newLines: 4, header: '@@ -10,3 +12,4 @@ function main() {' });
    expect(h?.lines[0]).toEqual({ kind: 'ctx', oldNo: 10, newNo: 12, text: 'const a = 1;' });
    expect(h?.lines[1]).toEqual({ kind: 'add', oldNo: null, newNo: 13, text: 'const b = 2;' });
    expect(h?.lines[2]).toMatchObject({ kind: 'ctx', oldNo: 11, newNo: 14 });
    const del = file.hunks[1]?.lines.find((l) => l.kind === 'del');
    expect(del).toEqual({ kind: 'del', oldNo: 41, newNo: null, text: 'gone();' });
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(2);
  });

  it('parses an added file', () => {
    const file = one('added');
    expect(file).toMatchObject({ path: 'src/new.ts', oldPath: null, status: 'added', additions: 2, deletions: 0 });
    expect(file.hunks[0]?.lines.map((l) => l.newNo)).toEqual([1, 2]);
  });

  it('keeps a deleted file with status deleted and no new line numbers', () => {
    const file = one('deleted');
    expect(file).toMatchObject({ path: 'src/old.ts', status: 'deleted', additions: 0, deletions: 2 });
    expect(file.hunks[0]?.lines.every((l) => l.newNo === null)).toBe(true);
  });

  it('records oldPath for a rename', () => {
    const file = one('renamed');
    expect(file).toMatchObject({ path: 'src/after.ts', oldPath: 'src/before.ts', status: 'renamed', additions: 1, deletions: 1 });
  });

  it('keeps a pure rename with no hunks', () => {
    const file = one('renamed-pure');
    expect(file).toMatchObject({ path: 'b.txt', oldPath: 'a.txt', status: 'renamed', hunks: [] });
  });

  it('marks a binary file and gives it no hunks', () => {
    const file = one('binary');
    expect(file).toMatchObject({ path: 'img/logo.png', binary: true, hunks: [], status: 'modified' });
  });

  it('ignores the no-newline marker line', () => {
    const file = one('no-newline');
    expect(file.hunks[0]?.lines).toEqual([
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'first' },
      { kind: 'del', oldNo: 2, newNo: null, text: 'last' },
      { kind: 'add', oldNo: null, newNo: 2, text: 'last!' },
    ]);
  });

  it('handles quoted and unquoted paths with spaces', () => {
    const files = parseDiff(fx('spaces'));
    expect(files.map((f) => f.path)).toEqual(['dir with space/file.ts', 'plain dir/x.ts']);
    expect(files[0]?.oldPath).toBeNull();
    expect(files[0]?.hunks[0]?.lines[1]).toMatchObject({ kind: 'add', newNo: 2, text: 'world' });
  });

  it('splits several files and returns [] for empty input', () => {
    expect(parseDiff(fx('added') + fx('deleted')).map((f) => f.path)).toEqual(['src/new.ts', 'src/old.ts']);
    expect(parseDiff('')).toEqual([]);
  });

  it('does not treat a removed line starting with dashes as a header', () => {
    const text = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,1 @@\n--- not a header\n keep\n';
    const [file] = parseDiff(text) as [FileDiff];
    expect(file.hunks[0]?.lines[0]).toEqual({ kind: 'del', oldNo: 1, newNo: null, text: '-- not a header' });
    expect(file.deletions).toBe(1);
  });
});

describe('lineInDiff', () => {
  it('is true for an added line and false two lines past a hunk', () => {
    const file = one('modified-two-hunks');
    expect(lineInDiff(file, 13)).toBe(true);
    expect(lineInDiff(file, 12)).toBe(true);
    expect(lineInDiff(file, 15)).toBe(true);
    expect(lineInDiff(file, 17)).toBe(false);
    expect(lineInDiff(file, 1)).toBe(false);
  });

  it('is false for a deleted file', () => {
    const file = one('deleted');
    expect(lineInDiff(file, 1)).toBe(false);
  });
});

describe('loadDiff', () => {
  const range = { baseSha: 'aaa', headSha: 'bbb', kind: 'full' as const };

  it('runs git diff with the exact arguments and parses stdout', async () => {
    const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const exec: Exec = async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts?.cwd });
      return { stdout: fx('added'), stderr: '', code: 0 };
    };
    const files = await loadDiff(exec, '/repo', range);
    expect(calls).toEqual([{ cmd: 'git', args: ['diff', '--no-color', '-M', '--unified=3', 'aaa', 'bbb'], cwd: '/repo' }]);
    expect(files[0]?.path).toBe('src/new.ts');
  });

  it('throws with stderr when git fails', async () => {
    const exec: Exec = async () => ({ stdout: '', stderr: 'fatal: bad object', code: 128 });
    await expect(loadDiff(exec, '/repo', range)).rejects.toThrow(/fatal: bad object/);
  });
});
