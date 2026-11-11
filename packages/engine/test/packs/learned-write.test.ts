import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendLearned, removeLearned } from '../../src/packs/learned.js';

/** Records every write, append and rename, so a test can see that the learned file itself is never written in place. */
const seen = vi.hoisted(() => ({ writes: [] as string[], appends: [] as string[], renames: [] as [string, string][] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => { seen.writes.push(String(args[0])); return fs.writeFile(...args); },
    appendFile: async (...args: Parameters<typeof fs.appendFile>) => { seen.appends.push(String(args[0])); return fs.appendFile(...args); },
    rename: async (from: string, to: string) => { seen.renames.push([from, to]); return fs.rename(from, to); },
  };
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  seen.writes.length = 0;
  seen.appends.length = 0;
  seen.renames.length = 0;
});

describe('learned files are replaced whole, never written in place', () => {
  it('appendLearned and removeLearned write a temporary file beside the learned file and rename it over it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airlock-learned-'));
    dirs.push(dir);
    await mkdir(join(dir, 'learned'));
    const file = join(dir, 'learned', 'wrong.md');
    await writeFile(file, '2026-01-01 · r/r · a\n');
    seen.writes.length = 0;
    const entry = { date: '2026-01-02', repo: 'r/r', kind: 'wrong' as const, text: 'b' };

    await appendLearned(dir, entry);
    expect(await readFile(file, 'utf8')).toBe('2026-01-01 · r/r · a\n2026-01-02 · r/r · b\n');
    expect(await removeLearned(dir, entry)).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('2026-01-01 · r/r · a\n');

    expect(seen.appends).toEqual([]);
    expect(seen.writes).not.toContain(file);
    expect(seen.renames.map(([, to]) => to)).toEqual([file, file]);
    expect(seen.renames.every(([from]) => from.startsWith(join(dir, 'learned')) && from !== file)).toBe(true);
    expect(await readdir(join(dir, 'learned'))).toEqual(['wrong.md']);
  });
});
