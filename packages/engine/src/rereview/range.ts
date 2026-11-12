import type { PrInfo, ReviewDocument } from '@airlock/shared';
import { must, TIMED_OUT, type Exec } from '../util/exec.js';

/** What a re-review covers: only what was pushed since the earlier review, or the whole pull request again, and why. */
export type RereviewPlan =
  | { kind: 'push'; baseSha: string; headSha: string }
  | { kind: 'everything'; reason: 'rewritten' | 'base-merged-in' };

/** A commit id as GitHub and the store write it: 7 to 64 hexadecimal characters, so git cannot read it as an option. */
const COMMIT_ID = /^[0-9a-f]{7,64}$/i;
/** A branch name git cannot read as an option or as anything but a branch. */
const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

function checkedId(what: string, id: string): string {
  if (!COMMIT_ID.test(id)) throw new Error(`The ${what} ${JSON.stringify(id)} is not a commit id.`);
  return id;
}

/** True when the mirror has `spec`; a lookup that timed out throws, since it says nothing. */
async function has(exec: Exec, mirror: string, spec: string): Promise<boolean> {
  const r = await exec('git', ['--git-dir', mirror, 'rev-parse', '--verify', '--quiet', '--end-of-options', spec]);
  if (r.code === TIMED_OUT) throw new Error(`git rev-parse ${spec}: ${r.stderr}`);
  return r.code === 0;
}

/** True when `ancestor` is reachable from `descendant`; any answer other than yes (0) or no (1) throws. */
async function isAncestor(exec: Exec, mirror: string, ancestor: string, descendant: string): Promise<boolean> {
  const r = await exec('git', ['--git-dir', mirror, 'merge-base', '--is-ancestor', ancestor, descendant]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new Error(`git merge-base --is-ancestor ${ancestor} ${descendant}: ${r.stderr}`);
}

/**
 * Which range a re-review covers. When the earlier review's head is an ancestor of the new head and no commit pushed
 * since is a merge that brings the base branch in, only the push: the earlier head to the new head. When the earlier
 * head is not in the branch any more (or not in the mirror at all), `rewritten`. When a pushed merge commit has a parent
 * that the base branch reaches and the earlier head does not, `base-merged-in`. The base branch is the pull request's
 * branch in the mirror, or the base GitHub recorded when the pull request is merged or its branch is gone, as the
 * workspace chooses. Throws when an id or the branch name is not one git can be given safely, or when git cannot answer.
 */
export async function planRereview(exec: Exec, mirror: string, prev: ReviewDocument, pr: PrInfo): Promise<RereviewPlan> {
  const earlier = checkedId('earlier head', prev.pr.headSha);
  const head = checkedId('head', pr.headSha);
  if (!BRANCH_NAME.test(pr.baseRef) || pr.baseRef.startsWith('-')) {
    throw new Error(`The base branch ${JSON.stringify(pr.baseRef)} is not a branch name Airlock can use.`);
  }
  if (!(await has(exec, mirror, `${earlier}^{commit}`))) return { kind: 'everything', reason: 'rewritten' };
  if (!(await isAncestor(exec, mirror, earlier, head))) return { kind: 'everything', reason: 'rewritten' };

  const branch = `refs/heads/${pr.baseRef}`;
  const baseTip = pr.merged === true || !(await has(exec, mirror, branch)) ? checkedId('base commit', pr.baseSha) : branch;
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
