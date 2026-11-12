import type { ReviewRange } from '@airlock/shared';
import { must, type Exec } from '../util/exec.js';

/** The commits of `head` not reachable from any of `exclude`, one per line as `sha parent...`, in the git folder `dir`. */
async function commitsWithParents(exec: Exec, dir: string, head: string, exclude: string[]): Promise<string[]> {
  const res = await exec('git', ['--git-dir', dir, 'rev-list', '--parents', '--end-of-options', head, ...exclude.map((r) => `^${r}`)]);
  return must(res, `git rev-list ${head}`).split('\n').filter((l) => l.trim() !== '');
}

const isMerge = (line: string): boolean => line.trim().split(/\s+/).length >= 3;

/**
 * True when the range has at least one commit and every commit in base..head is a merge commit or is already contained
 * in `baseRefOfNextStage` (null in step 1: then every commit must be a merge). `dir` is a git folder (the mirror), named
 * with `--git-dir` so that git never has to find it from a working directory.
 * Throws when git cannot list the range.
 */
export async function isSyncMerge(exec: Exec, dir: string, range: ReviewRange, baseRefOfNextStage: string | null): Promise<boolean> {
  const all = await commitsWithParents(exec, dir, range.headSha, [range.baseSha]);
  if (all.length === 0) return false;
  const rest = baseRefOfNextStage === null
    ? all
    : await commitsWithParents(exec, dir, range.headSha, [range.baseSha, baseRefOfNextStage]);
  return rest.every(isMerge);
}
