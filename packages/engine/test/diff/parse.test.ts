import { readFileSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileDiff } from '@airlock/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { lineInDiff, linkFacts, loadDiff, parseDiff, recheckBinary } from '../../src/diff/parse.js';
import { realExec, type Exec } from '../../src/util/exec.js';
import { safeRead } from '../../src/util/safe-read.js';
import { commitFiles } from '../helpers/change-repo.js';
import { makeTempRepo, type TempRepo } from '../helpers/temp-repo.js';

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
    const files = await loadDiff(exec, '/mirror.git', range);
    expect(calls).toEqual([{
      cmd: 'git',
      args: ['--git-dir', '/mirror.git', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '-M', '--unified=3', 'aaa', 'bbb'],
      cwd: '/mirror.git',
    }]);
    expect(files[0]?.path).toBe('src/new.ts');
  });

  it('throws with stderr when git fails', async () => {
    const exec: Exec = async () => ({ stdout: '', stderr: 'fatal: bad object', code: 128 });
    await expect(loadDiff(exec, '/repo', range)).rejects.toThrow(/fatal: bad object/);
  });
});

describe('loadDiff on a real repository', () => {
  const made: string[] = [];
  afterEach(async () => {
    for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  async function repo(): Promise<TempRepo> {
    const r = await makeTempRepo();
    made.push(r.dir);
    return r;
  }
  async function bareClone(r: TempRepo): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'airlock-mirror-'));
    made.push(dir);
    const mirror = join(dir, 'm.git');
    await realExec('git', ['clone', '--bare', r.dir, mirror]);
    return mirror;
  }

  it('ignores a .gitattributes the pull request adds, so it cannot hide its own files', async () => {
    const r = await repo();
    const baseSha = await commitFiles(r, { 'src/auth.ts': 'export const ok = () => check();\n' }, 'base');
    const headSha = await commitFiles(r, {
      'src/auth.ts': 'export const ok = () => true;\n', 'src/pay.ts': 'export const pay = 1;\n', '.gitattributes': '* -diff\n',
    }, 'head');
    const files = await loadDiff(realExec, await bareClone(r), { baseSha, headSha, kind: 'full' });
    expect(files.map((f) => [f.path, f.binary])).toEqual([['.gitattributes', false], ['src/auth.ts', false], ['src/pay.ts', false]]);
    expect(files[1]!.hunks[0]!.lines.map((l) => `${l.kind} ${l.text}`)).toEqual([
      'del export const ok = () => check();', 'add export const ok = () => true;',
    ]);
  });
});

describe('recheckBinary', () => {
  const made: string[] = [];
  afterEach(async () => {
    for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('turns a text file git calls binary back into text with a fact, and leaves a real binary file alone', async () => {
    const r = await makeTempRepo();
    made.push(r.dir);
    const baseSha = await commitFiles(r, { 'src/a.ts': 'export const a = 1;\n' }, 'base');
    await writeFile(join(r.dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const headSha = await commitFiles(r, { 'src/a.ts': 'export const a = 2;\n' }, 'head');
    // The person's own git settings (here the repository's info/attributes) can still mark a text file as binary.
    await writeFile(join(r.dir, '.git', 'info', 'attributes'), '*.ts -diff\n');
    const files = await loadDiff(realExec, join(r.dir, '.git'), { baseSha, headSha, kind: 'full' });
    expect(files.map((f) => [f.path, f.binary])).toEqual([['logo.png', true], ['src/a.ts', true]]);

    const out = await recheckBinary(files, (path, bytes) => safeRead(r.dir, path, { firstBytes: bytes }));
    expect(out.files.map((f) => [f.path, f.binary])).toEqual([['logo.png', true], ['src/a.ts', false]]);
    expect(out.facts).toEqual([{
      checkId: 'diff-not-available', path: 'src/a.ts', line: null,
      message: 'src/a.ts: the diff is not available (git was told to treat it as binary); read the file itself',
    }]);
  });

  it('keeps a deleted binary file and one that cannot be read as binary', async () => {
    const file = (path: string, status: FileDiff['status']): FileDiff => ({
      path, oldPath: null, status, binary: true, additions: 0, deletions: 0, hunks: [],
    });
    const out = await recheckBinary([file('gone.ts', 'deleted'), file('huge.ts', 'modified')], async () => null);
    expect(out.files.map((f) => f.binary)).toEqual([true, true]);
    expect(out.facts).toEqual([]);
  });
});

describe('symbolic links', () => {
  const made: string[] = [];
  afterEach(async () => {
    for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('keeps each file\'s mode, and says where a link points', async () => {
    const r = await makeTempRepo();
    made.push(r.dir);
    const baseSha = await commitFiles(r, { 'src/a.ts': 'export const a = 1;\n', 'docs/rules.md': 'rules\n' }, 'base');
    await symlink('docs/rules.md', join(r.dir, 'CLAUDE.md'));
    const headSha = await commitFiles(r, { 'src/a.ts': 'export const a = 2;\n' }, 'head');
    const files = await loadDiff(realExec, join(r.dir, '.git'), { baseSha, headSha, kind: 'full' });
    expect(files.map((f) => [f.path, f.mode])).toEqual([['CLAUDE.md', '120000'], ['src/a.ts', '100644']]);
    expect(linkFacts(files)).toEqual([{
      checkId: 'symbolic-link', path: 'CLAUDE.md', line: null, message: 'CLAUDE.md is a symbolic link to docs/rules.md',
    }]);
  });

  it('gives a file that changes type one entry: its path once, both contents in its diff, and the new mode', async () => {
    const r = await makeTempRepo();
    made.push(r.dir);
    const baseSha = await commitFiles(r, { 'src/auth.ts': 'export const ok = check();\n', 'src/mock.ts': 'export const ok = true;\n' }, 'base');
    await rm(join(r.dir, 'src/auth.ts'));
    await symlink('mock.ts', join(r.dir, 'src/auth.ts'));
    const headSha = await commitFiles(r, {}, 'head');
    const files = await loadDiff(realExec, join(r.dir, '.git'), { baseSha, headSha, kind: 'full' });
    expect(files.map((f) => [f.path, f.status, f.mode, f.additions, f.deletions])).toEqual([['src/auth.ts', 'modified', '120000', 1, 1]]);
    const lines = files[0]!.hunks.flatMap((h) => h.lines).map((l) => [l.kind, l.text]);
    expect(lines).toEqual([['del', 'export const ok = check();'], ['add', 'mock.ts']]);
    expect(linkFacts(files)).toEqual([{
      checkId: 'symbolic-link', path: 'src/auth.ts', line: null, message: 'src/auth.ts is a symbolic link to mock.ts',
    }]);

    await rm(join(r.dir, 'src/auth.ts'));
    await writeFile(join(r.dir, 'src/auth.ts'), 'export const ok = check();\n');
    const backSha = await commitFiles(r, {}, 'back');
    const back = await loadDiff(realExec, join(r.dir, '.git'), { baseSha: headSha, headSha: backSha, kind: 'full' });
    expect(back.map((f) => [f.path, f.status, f.mode, f.additions, f.deletions])).toEqual([['src/auth.ts', 'modified', '100644', 1, 1]]);
    expect(linkFacts(back)).toEqual([]);
  });
});
