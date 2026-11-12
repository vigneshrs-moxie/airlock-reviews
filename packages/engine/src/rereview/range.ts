import type { PrInfo, ReviewDocument } from '@airlock/shared';
import { checkBranchName, FULL_COMMIT_ID, inMirror } from '../intake/git-ids.js';
import { must, type Exec } from '../util/exec.js';

/**
 * What a re-review covers: only what was pushed since the earlier review; or, when the push is exactly one merge of the
 * base branch onto the earlier head (`headSha`, whose first parent is `baseSha`), what was changed by hand in that merge;
 * or the whole pull request again, and why.
 */
export type RereviewPlan =
  | { kind: 'push'; baseSha: string; headSha: string }
  | { kind: 'base-merge'; baseSha: string; headSha: string }
  | { kind: 'everything'; reason: EverythingReason };

/**
 * Why everything is reviewed again: the branch was rewritten; a pushed merge brought the base in (with other commits);
 * the earlier review did not finish; the pull request now targets another base branch than the earlier review's
 * (`retargeted`); the earlier review covered a range given by hand, so not the whole pull request (`earlier-partial`);
 * or the base commit is not in the mirror, so a merge of it cannot be ruled out.
 */
export type EverythingReason = 'rewritten' | 'base-merged-in' | 'earlier-incomplete' | 'retargeted' | 'earlier-partial' | 'base-missing';

/** A full commit id, so git cannot read it as an option or as an abbreviation of another object. */
function checkedId(what: string, id: string): string {
  if (!FULL_COMMIT_ID.test(id)) throw new Error(`The ${what} ${JSON.stringify(id)} is not a full commit id.`);
  return id;
}

/** True when `ancestor` is reachable from `descendant`; any answer other than yes (0) or no (1) throws. */
async function isAncestor(exec: Exec, mirror: string, ancestor: string, descendant: string): Promise<boolean> {
  const r = await exec('git', ['--git-dir', mirror, 'merge-base', '--is-ancestor', ancestor, descendant]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new Error(`git merge-base --is-ancestor ${ancestor} ${descendant}: ${r.stderr}`);
}

/**
 * True when the only commit pushed since `earlier` that the base branch does not have is `head` itself, a merge of two
 * parents whose first is `earlier` and whose second the base branch reaches and `earlier` does not.
 */
async function isOneBaseMerge(exec: Exec, mirror: string, earlier: string, head: string, baseTip: string): Promise<boolean> {
  const listed = must(
    await exec('git', ['--git-dir', mirror, 'rev-list', '--parents', '--end-of-options', head, `^${earlier}`, `^${baseTip}`]),
    `git rev-list ${head} ^${earlier} ^${baseTip}`,
  ).split('\n').filter((l) => l.trim() !== '');
  if (listed.length !== 1) return false;
  const [sha, ...parents] = listed[0]!.trim().split(/\s+/).map((id) => checkedId('commit', id));
  if (parents.length !== 2 || !sameCommit(sha!, head)) return false;
  const [first, second] = parents as [string, string];
  return sameCommit(first, earlier) && await isAncestor(exec, mirror, second, baseTip) && !(await isAncestor(exec, mirror, second, earlier));
}

/** True when two full ids name the same commit. */
const sameCommit = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * For an earlier review of a merge (a first review whose range is `sync-merge`): true when its head holds, beyond the base
 * branch, more than the one merge it reviewed. A merge review of the pull request itself covers a range of exactly one
 * merge from where the head meets the base, so anything more is a range given by hand that left commits out. (A pull
 * request of several merges that changes nothing is also counted here: it is then reviewed again in full, never less.)
 */
async function leftCommitsOut(exec: Exec, mirror: string, earlier: string, baseTip: string): Promise<boolean> {
  const count = must(
    await exec('git', ['--git-dir', mirror, 'rev-list', '--count', '--end-of-options', earlier, `^${baseTip}`]),
    `git rev-list --count ${earlier} ^${baseTip}`,
  ).trim();
  return Number(count) > 1;
}

/**
 * Which range a re-review covers. An earlier review that did not finish is no starting point: `earlier-incomplete`.
 * Neither is one made against another base branch than the pull request's now (`retargeted`), nor one that covered a
 * range given by hand (`earlier-partial`: an `explicit` range, or a merge review whose head holds more than its merge
 * beyond the base branch). When the earlier review's head is an ancestor of the new head and no commit pushed
 * since is a merge that brings the base branch in, only the push: the earlier head to the new head. When the earlier
 * head is not in the branch any more (or not in the mirror at all), `rewritten`. When the push is exactly one merge
 * commit, the new head, of two parents, the first the earlier head and the second one the base branch reaches and the
 * earlier head does not, `base-merge`. When any other pushed merge commit has a parent that the base branch reaches and
 * the earlier head does not, `base-merged-in`. The base branch is the pull request's
 * branch in the mirror, or the base GitHub recorded when the pull request is merged or its branch is gone, as the
 * workspace chooses (the workspace fetches GitHub's recorded base first); when that base is not in the mirror, `base-missing`.
 * The stored earlier head must be a full commit id. Throws, before any git call, when an id or the branch name is not
 * one git can be given safely, and throws when git cannot answer.
 */
export async function planRereview(exec: Exec, mirror: string, prev: ReviewDocument, pr: PrInfo): Promise<RereviewPlan> {
  if (!FULL_COMMIT_ID.test(prev.pr.headSha)) {
    throw new Error(`The stored review ${prev.id} records its head as ${JSON.stringify(prev.pr.headSha)}, which is not a full commit id.`);
  }
  const earlier = prev.pr.headSha;
  const head = checkedId('head', pr.headSha);
  checkBranchName(pr.baseRef);
  const branch = `refs/heads/${pr.baseRef}`;
  const useRecorded = pr.merged === true || !(await inMirror(exec, mirror, branch));
  const baseTip = useRecorded ? checkedId('base commit', pr.baseSha) : branch;
  if (prev.verdict.label === 'incomplete') return { kind: 'everything', reason: 'earlier-incomplete' };
  if (prev.pr.baseRef !== pr.baseRef) return { kind: 'everything', reason: 'retargeted' };
  if (prev.range.kind === 'explicit') return { kind: 'everything', reason: 'earlier-partial' };
  if (!(await inMirror(exec, mirror, `${earlier}^{commit}`))) return { kind: 'everything', reason: 'rewritten' };
  if (!(await isAncestor(exec, mirror, earlier, head))) return { kind: 'everything', reason: 'rewritten' };
  if (useRecorded && !(await inMirror(exec, mirror, `${baseTip}^{commit}`))) return { kind: 'everything', reason: 'base-missing' };
  if (prev.range.kind === 'sync-merge' && prev.previous === undefined && await leftCommitsOut(exec, mirror, earlier, baseTip)) {
    return { kind: 'everything', reason: 'earlier-partial' };
  }
  if (await isOneBaseMerge(exec, mirror, earlier, head, baseTip)) return { kind: 'base-merge', baseSha: earlier, headSha: head };
  const listed = must(
    await exec('git', ['--git-dir', mirror, 'rev-list', '--parents', '--end-of-options', head, `^${earlier}`]),
    `git rev-list ${head} ^${earlier}`,
  );
  for (const line of listed.split('\n').filter((l) => l.trim() !== '')) {
    const parents = line.trim().split(/\s+/).slice(1).map((p) => checkedId('parent', p));
    if (parents.length < 2) continue;
    for (const parent of parents) {
      if (await isAncestor(exec, mirror, parent, baseTip) && !(await isAncestor(exec, mirror, parent, earlier))) {
        return { kind: 'everything', reason: 'base-merged-in' };
      }
    }
  }
  return { kind: 'push', baseSha: earlier, headSha: head };
}
