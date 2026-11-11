import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { missingHelpers, namedHelpers } from '../../src/packs/helpers-check.js';
import type { Exec } from '../../src/util/exec.js';

const ORBIT = [
  '# Orbit',
  '',
  '## Helpers that must be used',
  '',
  '| Situation | Use | Not |',
  '| --- | --- | --- |',
  '| enforce on write | `assertCanActOn` / `assertInScope` on the server write | filtering only the picker |',
  '| scope a people query | spread `scopeWhere(auth, "people"\\|"act")` | unfiltered `findMany` |',
  '| drop scope on purpose | `withoutScope()` and `scopeWhere` again, also `db` and `id` | `rawQuery` |',
  '',
  '## Other',
  '',
  '| a | b |',
  '| --- | --- |',
  '| x | `ignoredHelper` |',
].join('\n');

describe('namedHelpers', () => {
  it('finds scopeWhere, assertCanActOn and withoutScope in the table, once each, in order', () => {
    expect(namedHelpers(ORBIT)).toEqual(['assertCanActOn', 'assertInScope', 'scopeWhere', 'withoutScope']);
  });
  it('splits cells on unescaped pipes only and ignores the first and third columns', () => {
    const md = '## Helpers that must be used\n| a | b | c |\n|---|---|---|\n| `firstCol` | `useThis("x\\|y")` | `thirdCol` |\n';
    expect(namedHelpers(md)).toEqual(['useThis']);
  });
  it('returns nothing without the heading', () => {
    expect(namedHelpers('| a | b |\n| - | - |\n| x | `fooBar` |')).toEqual([]);
  });
});

describe('missingHelpers', () => {
  it('reports names git grep cannot find, running git grep -l -w -F in baseDir', async () => {
    const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
    const exec: Exec = async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts?.cwd });
      return args[4] === 'gone' ? { stdout: '', stderr: '', code: 1 } : { stdout: 'a.ts\n', stderr: '', code: 0 };
    };
    const dir = await mkdtemp(join(tmpdir(), 'airlock-help-'));
    expect(await missingHelpers(exec, dir, ['scopeWhere', 'gone'])).toEqual(['gone']);
    expect(calls).toContainEqual({ cmd: 'git', args: ['grep', '-l', '-w', '-F', 'gone'], cwd: dir });
  });
  it('throws with stderr on any other exit code', async () => {
    const exec: Exec = async () => ({ stdout: '', stderr: 'fatal: not a git repository', code: 128 });
    await expect(missingHelpers(exec, '/x', ['abcD'])).rejects.toThrow(/not a git repository/);
  });
  it('runs at most 8 at a time', async () => {
    let active = 0; let peak = 0;
    const exec: Exec = async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { stdout: 'x', stderr: '', code: 0 };
    };
    await missingHelpers(exec, '/x', Array.from({ length: 20 }, (_, i) => `nameA${i}`));
    expect(peak).toBe(8);
  });
});
