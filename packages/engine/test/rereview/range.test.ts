import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { minimalDocument } from '@airlock/shared';
import type { PrInfo, ReviewDocument } from '@airlock/shared';
import { planRereview } from '../../src/rereview/range.js';
import { realExec } from '../../src/util/exec.js';
import { commitFiles } from '../helpers/change-repo.js';
import { makeTempRepo, type TempRepo } from '../helpers/temp-repo.js';

const made: TempRepo[] = [];
afterEach(async () => {
  for (const r of made.splice(0)) await rm(r.dir, { recursive: true, force: true });
});

async function repo(): Promise<TempRepo> {
  const r = await makeTempRepo();
  made.push(r);
  return r;
}

const previous = (headSha: string): ReviewDocument => {
  const doc = minimalDocument();
  return { ...doc, id: 'r_0123456789', pr: { ...doc.pr, headSha } };
};
const prAt = (headSha: string, baseSha: string, over: Partial<PrInfo> = {}): PrInfo =>
  ({ ...minimalDocument().pr, baseRef: 'main', baseSha, headSha, ...over });
const mirrorOf = (r: TempRepo): string => join(r.dir, '.git');

describe('planRereview', () => {
  it('plans a push range when the earlier head is an ancestor', async () => {
    const r = await repo();
    const base = await commitFiles(r, { 'a.ts': 'one\n' }, 'base');
    await r.git('checkout', '-b', 'feature');
    const earlier = await commitFiles(r, { 'a.ts': 'two\n' }, 'first');
    const head = await commitFiles(r, { 'a.ts': 'three\n' }, 'second');
    expect(await planRereview(realExec, mirrorOf(r), previous(earlier), prAt(head, base)))
      .toEqual({ kind: 'push', baseSha: earlier, headSha: head });
  });

  it('plans a push range when a pushed merge brings in a branch other than the base', async () => {
    const r = await repo();
    const base = await commitFiles(r, { 'a.ts': 'one\n' }, 'base');
    await r.git('checkout', '-b', 'side');
    await commitFiles(r, { 'side.ts': 'side\n' }, 'side');
    await r.git('checkout', 'main');
    await r.git('checkout', '-b', 'feature');
    const earlier = await commitFiles(r, { 'a.ts': 'two\n' }, 'first');
    await r.git('merge', '--no-ff', '--no-edit', 'side');
    const head = await r.git('rev-parse', 'HEAD');
    expect(await planRereview(realExec, mirrorOf(r), previous(earlier), prAt(head, base)))
      .toEqual({ kind: 'push', baseSha: earlier, headSha: head });
  });

  it('plans everything, rewritten, when the earlier head is no longer in the branch', async () => {
    const r = await repo();
    const base = await commitFiles(r, { 'a.ts': 'one\n' }, 'base');
    await r.git('checkout', '-b', 'feature');
    const earlier = await commitFiles(r, { 'a.ts': 'two\n' }, 'first');
    await r.git('reset', '--hard', base);
    const head = await commitFiles(r, { 'a.ts': 'two again\n' }, 'rewritten');
    expect(await planRereview(realExec, mirrorOf(r), previous(earlier), prAt(head, base)))
      .toEqual({ kind: 'everything', reason: 'rewritten' });
  });

  it('plans everything, rewritten, when the earlier head is not in the mirror at all', async () => {
    const r = await repo();
    const base = await commitFiles(r, { 'a.ts': 'one\n' }, 'base');
    await r.git('checkout', '-b', 'feature');
    const head = await commitFiles(r, { 'a.ts': 'two\n' }, 'first');
    expect(await planRereview(realExec, mirrorOf(r), previous('c'.repeat(40)), prAt(head, base)))
      .toEqual({ kind: 'everything', reason: 'rewritten' });
  });

  it('plans everything, base-merged-in, when a pushed commit merges the base branch', async () => {
    const r = await repo();
    const base = await commitFiles(r, { 'a.ts': 'one\n' }, 'base');
    await r.git('checkout', '-b', 'feature');
    const earlier = await commitFiles(r, { 'b.ts': 'two\n' }, 'first');
    await r.git('checkout', 'main');
    await commitFiles(r, { 'c.ts': 'main moved on\n' }, 'main');
    await r.git('checkout', 'feature');
    await r.git('merge', '--no-ff', '--no-edit', 'main');
    const head = await commitFiles(r, { 'b.ts': 'three\n' }, 'after the merge');
    expect(await planRereview(realExec, mirrorOf(r), previous(earlier), prAt(head, base)))
      .toEqual({ kind: 'everything', reason: 'base-merged-in' });
  });

  it('uses the recorded base when the base branch no longer exists', async () => {
    const r = await repo();
    const base = await commitFiles(r, { 'a.ts': 'one\n' }, 'base');
    await r.git('checkout', '-b', 'feature');
    const earlier = await commitFiles(r, { 'b.ts': 'two\n' }, 'first');
    await r.git('checkout', 'main');
    const moved = await commitFiles(r, { 'c.ts': 'main moved on\n' }, 'main');
    await r.git('checkout', 'feature');
    await r.git('merge', '--no-ff', '--no-edit', 'main');
    const head = await r.git('rev-parse', 'HEAD');
    await r.git('branch', '-D', 'main');
    // The earlier review was against the same base branch, by name, before it was deleted.
    const earlierGone: ReviewDocument = { ...previous(earlier), pr: { ...previous(earlier).pr, baseRef: 'gone' } };
    expect(await planRereview(realExec, mirrorOf(r), earlierGone, prAt(head, moved, { baseRef: 'gone' })))
      .toEqual({ kind: 'base-merge', baseSha: earlier, headSha: head });
    const after = await commitFiles(r, { 'b.ts': 'three\n' }, 'after the merge');
    expect(await planRereview(realExec, mirrorOf(r), earlierGone, prAt(after, moved, { baseRef: 'gone' })))
      .toEqual({ kind: 'everything', reason: 'base-merged-in' });
  });

  it('plans a base merge when the push is exactly one merge of the base branch onto the earlier head', async () => {
    const r = await repo();
    const base = await commitFiles(r, { 'a.ts': 'one\n' }, 'base');
    await r.git('checkout', '-b', 'feature');
    const earlier = await commitFiles(r, { 'b.ts': 'two\n' }, 'first');
    await r.git('checkout', 'main');
    await commitFiles(r, { 'c.ts': 'main moved on\n' }, 'main');
    await commitFiles(r, { 'd.ts': 'and again\n' }, 'main again');
    await r.git('checkout', 'feature');
    await r.git('merge', '--no-ff', '--no-edit', 'main');
    const head = await r.git('rev-parse', 'HEAD');
    expect(await planRereview(realExec, mirrorOf(r), previous(earlier), prAt(head, base)))
      .toEqual({ kind: 'base-merge', baseSha: earlier, headSha: head });
  });

  it('plans everything when the one pushed merge brings the base in on top of a commit not reviewed', async () => {
    const r = await repo();
    const base = await commitFiles(r, { 'a.ts': 'one\n' }, 'base');
    await r.git('checkout', '-b', 'feature');
    const earlier = await commitFiles(r, { 'b.ts': 'two\n' }, 'first');
    await r.git('checkout', 'main');
    await commitFiles(r, { 'c.ts': 'main moved on\n' }, 'main');
    // The merge is made on main, with the earlier head as its second parent: its first parent is not the earlier head.
    await r.git('merge', '--no-ff', '--no-edit', 'feature');
    const head = await r.git('rev-parse', 'HEAD');
    await r.git('checkout', '--detach');
    await r.git('branch', '-f', 'main', 'HEAD~1');
    expect(await planRereview(realExec, mirrorOf(r), previous(earlier), prAt(head, base)))
      .toEqual({ kind: 'everything', reason: 'base-merged-in' });
  });

  it('refuses a stored earlier head that is not a full commit id before asking git, naming the stored review', async () => {
    for (const stored of ['--upload-pack=x', 'abcdef1', 'a'.repeat(39)]) {
      const calls: string[][] = [];
      const exec = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { stdout: '', stderr: '', code: 0 }; };
      await expect(planRereview(exec, '/nowhere', previous(stored), prAt('d'.repeat(40), 'a'.repeat(40))))
        .rejects.toThrow(`The stored review r_0123456789 records its head as ${JSON.stringify(stored)}, which is not a full commit id.`);
      expect(calls).toEqual([]);
    }
  });

  it('plans everything, earlier-incomplete, when the earlier review did not finish', async () => {
    const r = await repo();
    const base = await commitFiles(r, { 'a.ts': 'one\n' }, 'base');
    await r.git('checkout', '-b', 'feature');
    const earlier = await commitFiles(r, { 'a.ts': 'two\n' }, 'first');
    const head = await commitFiles(r, { 'a.ts': 'three\n' }, 'second');
    const unfinished: ReviewDocument = {
      ...previous(earlier), verdict: { label: 'incomplete', sentence: 'The review did not finish (lenses).', counts: { block: 0, fix: 0, ask: 0, note: 0 } },
    };
    expect(await planRereview(realExec, mirrorOf(r), unfinished, prAt(head, base)))
      .toEqual({ kind: 'everything', reason: 'earlier-incomplete' });
  });

  it('plans everything, retargeted, when the pull request now targets another base branch', async () => {
    const r = await repo();
    const base = await commitFiles(r, { 'a.ts': 'one\n' }, 'base');
    await r.git('branch', 'develop');
    await r.git('checkout', '-b', 'feature');
    const earlier = await commitFiles(r, { 'a.ts': 'two\n' }, 'first');
    const head = await commitFiles(r, { 'a.ts': 'three\n' }, 'second');
    const againstDevelop: ReviewDocument = { ...previous(earlier), pr: { ...previous(earlier).pr, baseRef: 'develop' } };
    expect(await planRereview(realExec, mirrorOf(r), againstDevelop, prAt(head, base)))
      .toEqual({ kind: 'everything', reason: 'retargeted' });
    // The same base branch as before is still a push.
    expect(await planRereview(realExec, mirrorOf(r), previous(earlier), prAt(head, base)))
      .toEqual({ kind: 'push', baseSha: earlier, headSha: head });
  });

  it('plans everything, earlier-partial, when the earlier review covered a range given by hand', async () => {
    const r = await repo();
    const base = await commitFiles(r, { 'a.ts': 'one\n' }, 'base');
    await r.git('checkout', '-b', 'feature');
    const one = await commitFiles(r, { 'a.ts': 'two\n' }, 'first');
    const earlier = await commitFiles(r, { 'a.ts': 'three\n' }, 'second');
    const head = await commitFiles(r, { 'a.ts': 'four\n' }, 'third');
    const given: ReviewDocument = { ...previous(earlier), range: { baseSha: one, headSha: earlier, kind: 'explicit' } };
    expect(await planRereview(realExec, mirrorOf(r), given, prAt(head, base)))
      .toEqual({ kind: 'everything', reason: 'earlier-partial' });
  });

  it('plans everything, earlier-partial, when the earlier merge review covered a given range that left commits out', async () => {
    const r = await repo();
    const base = await commitFiles(r, { 'a.ts': 'one\n' }, 'base');
    await r.git('checkout', '-b', 'feature');
    const own = await commitFiles(r, { 'b.ts': 'feature\n' }, 'a commit of the pull request');
    await r.git('checkout', 'main');
    await commitFiles(r, { 'c.ts': 'main moved on\n' }, 'main');
    await r.git('checkout', 'feature');
    await r.git('merge', '--no-ff', '--no-edit', 'main');
    const merge = await r.git('rev-parse', 'HEAD');
    const head = await commitFiles(r, { 'b.ts': 'pushed\n' }, 'push');
    // A given range from the pull request's own commit to the merge is a merge review, stored as sync-merge.
    const given: ReviewDocument = { ...previous(merge), range: { baseSha: own, headSha: merge, kind: 'sync-merge' } };
    expect(await planRereview(realExec, mirrorOf(r), given, prAt(head, base)))
      .toEqual({ kind: 'everything', reason: 'earlier-partial' });
  });

  it('plans a push after a merge review of a pull request that was only that merge', async () => {
    const r = await repo();
    await commitFiles(r, { 'a.ts': 'one\n' }, 'base');
    await r.git('checkout', '-b', 'feature');
    await r.git('checkout', 'main');
    const moved = await commitFiles(r, { 'c.ts': 'main moved on\n' }, 'main');
    await r.git('checkout', 'feature');
    await r.git('merge', '--no-ff', '--no-edit', 'main');
    const merge = await r.git('rev-parse', 'HEAD');
    const head = await commitFiles(r, { 'b.ts': 'pushed\n' }, 'push');
    const whole: ReviewDocument = { ...previous(merge), range: { baseSha: moved, headSha: merge, kind: 'sync-merge' } };
    expect(await planRereview(realExec, mirrorOf(r), whole, prAt(head, moved)))
      .toEqual({ kind: 'push', baseSha: merge, headSha: head });
  });

  it('plans everything, base-missing, when the base commit is not in the mirror, instead of failing', async () => {
    const r = await repo();
    await commitFiles(r, { 'a.ts': 'one\n' }, 'base');
    await r.git('checkout', '-b', 'side');
    await commitFiles(r, { 'side.ts': 'side\n' }, 'side');
    await r.git('checkout', 'main');
    await r.git('checkout', '-b', 'feature');
    const earlier = await commitFiles(r, { 'a.ts': 'two\n' }, 'first');
    await r.git('merge', '--no-ff', '--no-edit', 'side');
    const head = await r.git('rev-parse', 'HEAD');
    // The base branch is gone and GitHub's recorded base is a commit this mirror never had.
    const earlierGone: ReviewDocument = { ...previous(earlier), pr: { ...previous(earlier).pr, baseRef: 'gone' } };
    expect(await planRereview(realExec, mirrorOf(r), earlierGone, prAt(head, 'e'.repeat(40), { baseRef: 'gone' })))
      .toEqual({ kind: 'everything', reason: 'base-missing' });
  });
});
