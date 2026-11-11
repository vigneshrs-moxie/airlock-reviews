import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewRange } from '@airlock/shared';
import { isSyncMerge } from '../../src/shape/detect.js';
import { realExec } from '../../src/util/exec.js';
import { commitFiles } from '../helpers/change-repo.js';
import { makeTempRepo, type TempRepo } from '../helpers/temp-repo.js';

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await rm(r.dir, { recursive: true, force: true });
});

async function repo(): Promise<TempRepo> {
  const r = await makeTempRepo();
  repos.push(r);
  return r;
}

const range = (baseSha: string, headSha: string): ReviewRange => ({ baseSha, headSha, kind: 'full' });

/** main at `root`, then main moves on; returns the merge-base the review would use and a helper to merge main in. */
async function branchBehindMain(r: TempRepo): Promise<{ mainTip: string }> {
  await commitFiles(r, { 'a.txt': 'root\n' }, 'root');
  await r.git('checkout', '-b', 'feature');
  await r.git('checkout', 'main');
  const mainTip = await commitFiles(r, { 'b.txt': 'main moved on\n' }, 'main advances');
  await r.git('checkout', 'feature');
  return { mainTip };
}

describe('isSyncMerge', () => {
  it('is true for a branch that only merged its target', async () => {
    const r = await repo();
    const { mainTip } = await branchBehindMain(r);
    await r.git('merge', '--no-ff', '-m', 'Merge main into feature', 'main');
    const head = await r.git('rev-parse', 'HEAD');
    const base = await r.git('merge-base', 'main', head);
    expect(base).toBe(mainTip);
    expect(await isSyncMerge(realExec, r.dir, range(base, head), null)).toBe(true);
  });

  it('is false when the branch has a commit of its own besides the merge', async () => {
    const r = await repo();
    await branchBehindMain(r);
    await commitFiles(r, { 'c.txt': 'feature work\n' }, 'feature work');
    await r.git('merge', '--no-ff', '-m', 'Merge main into feature', 'main');
    const head = await r.git('rev-parse', 'HEAD');
    const base = await r.git('merge-base', 'main', head);
    expect(await isSyncMerge(realExec, r.dir, range(base, head), null)).toBe(false);
  });

  it('is false for an empty range', async () => {
    const r = await repo();
    const sha = await commitFiles(r, { 'a.txt': 'root\n' }, 'root');
    expect(await isSyncMerge(realExec, r.dir, range(sha, sha), null)).toBe(false);
  });

  it('counts a commit already in the next stage as synced', async () => {
    const r = await repo();
    const root = await commitFiles(r, { 'a.txt': 'root\n' }, 'root');
    await r.git('checkout', '-b', 'staging');
    await commitFiles(r, { 'b.txt': 'already on staging\n' }, 'staging work');
    await r.git('checkout', '-b', 'feature');
    await r.git('checkout', 'main');
    await commitFiles(r, { 'c.txt': 'main moved on\n' }, 'main advances');
    await r.git('checkout', 'feature');
    await r.git('merge', '--no-ff', '-m', 'Merge main into feature', 'main');
    const head = await r.git('rev-parse', 'HEAD');
    const base = await r.git('merge-base', 'main', head);
    expect(base).not.toBe(root);
    expect(await isSyncMerge(realExec, r.dir, range(base, head), null)).toBe(false);
    expect(await isSyncMerge(realExec, r.dir, range(base, head), 'staging')).toBe(true);
  });

  it('throws when git cannot list the range', async () => {
    const r = await repo();
    await commitFiles(r, { 'a.txt': 'root\n' }, 'root');
    await expect(isSyncMerge(realExec, r.dir, range('0'.repeat(40), '1'.repeat(40)), null)).rejects.toThrow(/git rev-list/);
  });
});
