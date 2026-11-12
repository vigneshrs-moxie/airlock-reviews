import type { ReviewRange } from '@airlock/shared';
import { asMaterial } from '../agent/prompt.js';
import { must, type Exec } from '../util/exec.js';

/**
 * What a range of merges only leaves to review. `by-hand`: what was changed by hand in its one merge, from `baseSha`, the
 * merge git makes by itself (a commit in the mirror that no ref points at), to `headSha`, the merge as committed; `files`
 * is how many files differ. `nothing-by-hand`: the merge is exactly what git makes by itself. `unsupported`: a shape
 * Airlock does not review (several merges, an octopus merge), and why, as a sentence.
 */
export type MergeRange =
  | { kind: 'by-hand'; baseSha: string; headSha: string; files: number }
  | { kind: 'nothing-by-hand' }
  | { kind: 'unsupported'; reason: string };

/** Told to every model stage of a review of what was changed by hand in a merge; the branch names go in mergeNoteBlock. */
export const MERGE_NOTE = 'This pull request only merges one branch into another (the two are named in the material labelled "merge"), '
  + 'and this review covers what was changed by hand in that merge. The base side is the merge git produced by itself, with '
  + 'conflict markers where it could not decide; the head side is what was committed. Review whether each resolution keeps '
  + 'what both sides intended, and treat anything else changed by hand as a change to review.';

/** The two branch names of a merge, as material: they come from the pull request. */
export const mergeNoteBlock = (mergedIn: string, into: string): string => asMaterial('merge', `Merged in: ${mergedIn}\nInto: ${into}`);

/** A full commit or tree id as git prints it: 40 (SHA-1) or 64 (SHA-256) hexadecimal characters. */
const FULL_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function fullId(what: string, id: string): string {
  if (!FULL_ID.test(id)) throw new Error(`The ${what} ${JSON.stringify(id)} is not a full commit id.`);
  return id;
}

/** Who made the mechanical merge and when: fixed, so the same merge always gives the same commit id. */
const MECHANICAL_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Airlock', GIT_AUTHOR_EMAIL: 'airlock@localhost', GIT_AUTHOR_DATE: '946684800 +0000',
  GIT_COMMITTER_NAME: 'Airlock', GIT_COMMITTER_EMAIL: 'airlock@localhost', GIT_COMMITTER_DATE: '946684800 +0000',
};
const MECHANICAL_MESSAGE = 'The merge git makes by itself, made by Airlock to review what was changed by hand';

const lines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter((l) => l !== '');

/** The id of the tree `spec` names. */
async function treeOf(exec: Exec, mirror: string, spec: string): Promise<string> {
  return must(await exec('git', ['--git-dir', mirror, 'rev-parse', '--verify', '--end-of-options', `${spec}^{tree}`]), `git rev-parse ${spec}^{tree}`).trim();
}

/**
 * The tree of the merge git makes by itself of `ours` and `theirs`. Exit code 0 (clean) or 1 (conflicts, left in the tree
 * as markers) is an answer only when the first line is the id of a tree, since a bad argument also exits 1.
 */
async function mechanicalTree(exec: Exec, mirror: string, ours: string, theirs: string): Promise<string> {
  const made = await exec('git', ['--git-dir', mirror, 'merge-tree', '--write-tree', '--no-messages', ours, theirs]);
  const tree = made.stdout.split('\n')[0]?.trim() ?? '';
  if ((made.code === 0 || made.code === 1) && FULL_ID.test(tree)) {
    const type = await exec('git', ['--git-dir', mirror, 'cat-file', '-t', tree]);
    if (type.code === 0 && type.stdout.trim() === 'tree') return tree;
  }
  throw new Error(`git merge-tree ${ours} ${theirs}: ${made.stderr.trim() || 'no tree was written'}`);
}

/** Compares the merge `merge` of `parents` with the merge git makes by itself, and commits that one when they differ. */
async function fromMerge(exec: Exec, mirror: string, merge: string, parents: string[]): Promise<MergeRange> {
  if (parents.length !== 2) {
    return { kind: 'unsupported', reason: `Its merge commit joins ${parents.length} branches, and Airlock reviews what was changed by hand only in a merge of two.` };
  }
  const [ours, theirs] = parents.map((p) => fullId('parent', p)) as [string, string];
  const mechanical = await mechanicalTree(exec, mirror, ours, theirs);
  const committed = await treeOf(exec, mirror, merge);
  if (mechanical === committed) return { kind: 'nothing-by-hand' };
  const changed = must(
    await exec('git', ['--git-dir', mirror, 'diff-tree', '-r', '-z', '--no-renames', '--name-only', mechanical, committed]),
    `git diff-tree ${mechanical} ${committed}`,
  ).split('\0').filter((p) => p !== '').length;
  // No ref is made: the commit lives in the mirror only as long as a worktree or a later review needs it.
  const made = await exec(
    'git', ['--git-dir', mirror, 'commit-tree', '--no-gpg-sign', mechanical, '-p', ours, '-m', MECHANICAL_MESSAGE], { env: MECHANICAL_IDENTITY },
  );
  const commit = fullId('mechanical merge', must(made, `git commit-tree ${mechanical}`).trim());
  return { kind: 'by-hand', baseSha: commit, headSha: merge, files: changed };
}

/**
 * For a range whose commits are all merges: with exactly one merge of exactly two parents, what was changed by hand in it,
 * against the merge git makes by itself in the mirror; otherwise `unsupported` with the reason. Every id is checked as a
 * full commit id before it reaches git. Throws when git cannot answer.
 */
export async function mergeRange(exec: Exec, mirror: string, range: ReviewRange): Promise<MergeRange> {
  const base = fullId('base commit', range.baseSha);
  const head = fullId('head commit', range.headSha);
  const listed = lines(must(
    await exec('git', ['--git-dir', mirror, 'rev-list', '--parents', '--end-of-options', head, `^${base}`]),
    `git rev-list ${head} ^${base}`,
  )).map((l) => l.split(/\s+/));
  if (listed.some((c) => c.length < 3)) return { kind: 'unsupported', reason: 'Not every commit in it is a merge.' };
  if (listed.length !== 1) {
    return { kind: 'unsupported', reason: `It has ${listed.length} merge commits, and Airlock reviews what was changed by hand only in a single merge.` };
  }
  const [merge, ...parents] = listed[0]!;
  return fromMerge(exec, mirror, fullId('merge commit', merge!), parents);
}

/** What was changed by hand in the merge commit `merge`, as mergeRange gives it for a range holding only that merge. */
export async function mergeCommitRange(exec: Exec, mirror: string, merge: string): Promise<MergeRange> {
  const sha = fullId('merge commit', merge);
  const [line] = lines(must(
    await exec('git', ['--git-dir', mirror, 'rev-list', '--parents', '-n', '1', '--end-of-options', sha]), `git rev-list ${sha}`,
  ));
  const parents = line?.split(/\s+/).slice(1) ?? [];
  if (parents.length < 2) return { kind: 'unsupported', reason: 'It is not a merge commit.' };
  return fromMerge(exec, mirror, sha, parents);
}
