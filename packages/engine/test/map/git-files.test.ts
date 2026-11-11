import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { gitGrep } from '../../src/map/git-files.js';
import { type Exec, realExec } from '../../src/util/exec.js';
import { makeTempRepo, type TempRepo } from '../helpers/temp-repo.js';

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await rm(r.dir, { recursive: true, force: true });
});

describe('gitGrep', () => {
  it('returns one hit per matching line, in path then line order', async () => {
    const r = await makeTempRepo();
    repos.push(r);
    await r.write('b.ts', 'needle needle\nhay\nneedle\n');
    await r.write('a.md', 'a needle here\nneedles\n');
    await r.commit('init');
    expect(await gitGrep(realExec, r.dir, 'needle')).toEqual([
      { path: 'a.md', line: 1 }, { path: 'b.ts', line: 1 }, { path: 'b.ts', line: 3 },
    ]);
    expect(await gitGrep(realExec, r.dir, 'absent')).toEqual([]);
  });

  it('throws naming the pattern when the output overflows the buffer instead of reporting no match', async () => {
    const r = await makeTempRepo();
    repos.push(r);
    await r.write('big.txt', 'needle\n'.repeat(2000));
    await r.commit('init');
    await expect(gitGrep(realExec, r.dir, 'needle', [], 1024)).rejects.toThrow(/"needle".*(overflow|too large)/);
  });

  it('treats exit 1 with a buffer message and no output as an overflow too', async () => {
    const exec: Exec = async () => ({ stdout: '', stderr: 'stdout maxBuffer length exceeded', code: 1 });
    await expect(gitGrep(exec, '/x', 'needle')).rejects.toThrow(/"needle"/);
  });
});
