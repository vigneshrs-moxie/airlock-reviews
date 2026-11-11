import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_SAFE_READ_BYTES, safeRead } from '../../src/util/safe-read.js';

/** Lets a test act right after realpath resolves a path, to swap a file for a link before it is opened. */
const race = vi.hoisted(() => ({ afterRealpath: null as null | ((resolved: string) => Promise<void>) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    realpath: async (...args: Parameters<typeof fs.realpath>) => {
      const resolved = await fs.realpath(...args);
      if (race.afterRealpath) await race.afterRealpath(String(resolved));
      return resolved;
    },
  };
});
afterEach(() => { race.afterRealpath = null; });

let top: string;
let root: string;

beforeAll(async () => {
  top = await mkdtemp(join(tmpdir(), 'airlock-safe-read-'));
  root = join(top, 'repo');
  const outside = join(top, 'outside');
  await mkdir(join(root, 'src', 'deep'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'src', 'deep', 'b.ts'), 'export const b = 2;\n');
  await writeFile(join(outside, 'secret.txt'), 'SECRET');
  await symlink(join(outside, 'secret.txt'), join(root, 'src', 'link.ts'));
  await symlink(outside, join(root, 'out'));
  await symlink(join(root, 'src', 'a.ts'), join(root, 'src', 'alias.ts'));
  await writeFile(join(root, 'exact.bin'), Buffer.alloc(MAX_SAFE_READ_BYTES, 0x61));
  await writeFile(join(root, 'big.bin'), Buffer.alloc(MAX_SAFE_READ_BYTES + 1, 0x61));
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'config'), '[core]\n');
  await mkdir(join(root, 'docs', '.git'), { recursive: true });
  await writeFile(join(root, 'docs', '.git', 'notes.md'), 'nested\n');
  await writeFile(join(root, 'src', 'swapped.ts'), 'export const swapped = 1;\n');
});

afterAll(async () => {
  await rm(top, { recursive: true, force: true });
});

describe('safeRead', () => {
  it('reads a repository-relative file', async () => {
    expect(await safeRead(root, 'src/a.ts')).toBe('export const a = 1;\n');
    expect(await safeRead(root, 'src/deep/b.ts')).toBe('export const b = 2;\n');
  });

  it('refuses .., an absolute path and other unsafe spellings', async () => {
    for (const path of [
      '../outside/secret.txt', 'src/../src/a.ts', join(root, 'src', 'a.ts'), '/etc/hosts', 'src\\a.ts', 'src/%2e%2e/a.ts',
      'C:/a.ts', 'src//a.ts', 'src/a.ts/', './src/a.ts', '', 'src/a.ts\0',
    ]) {
      expect(await safeRead(root, path), path).toBeNull();
    }
  });

  it('refuses a symbolic link pointing out of the root, to a file or through a folder', async () => {
    expect(await safeRead(root, 'src/link.ts')).toBeNull();
    expect(await safeRead(root, 'out/secret.txt')).toBeNull();
  });

  it('refuses a symbolic link inside the root, whose real spelling differs', async () => {
    expect(await safeRead(root, 'src/alias.ts')).toBeNull();
  });

  it('refuses a path that differs only in letter case', async () => {
    expect(await safeRead(root, 'SRC/a.ts')).toBeNull();
    expect(await safeRead(root, 'src/A.ts')).toBeNull();
  });

  it('reads a file of exactly 2 MB and refuses one over it', async () => {
    expect((await safeRead(root, 'exact.bin'))?.length).toBe(MAX_SAFE_READ_BYTES);
    expect(await safeRead(root, 'big.bin')).toBeNull();
  });

  it('refuses anything under .git at the root, whatever the letter case', async () => {
    expect(await safeRead(root, '.git/config')).toBeNull();
    expect(await safeRead(root, '.GIT/config')).toBeNull();
    expect(await safeRead(root, '.Git/config')).toBeNull();
    expect(await safeRead(root, 'docs/.git/notes.md')).toBe('nested\n');
  });

  it('does not follow a link that replaces the file between resolving it and opening it', async () => {
    race.afterRealpath = async (resolved) => {
      if (!resolved.endsWith(join('src', 'swapped.ts'))) return;
      race.afterRealpath = null;
      await rename(resolved, `${resolved}.moved`);
      await symlink(join(top, 'outside', 'secret.txt'), resolved);
    };
    expect(await safeRead(root, 'src/swapped.ts')).toBeNull();
  });

  it('returns null for a folder, a missing file and a missing root, never throwing', async () => {
    expect(await safeRead(root, 'src')).toBeNull();
    expect(await safeRead(root, 'src/missing.ts')).toBeNull();
    expect(await safeRead(join(top, 'no-such-root'), 'src/a.ts')).toBeNull();
    expect(await safeRead(root, 42 as unknown as string)).toBeNull();
  });
});
