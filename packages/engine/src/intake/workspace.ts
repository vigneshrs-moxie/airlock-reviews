import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrInfo, ReviewDocument, ReviewRange } from '@airlock/shared';
import { planRereview, type RereviewPlan } from '../rereview/range.js';
import { isSyncMerge } from '../shape/detect.js';
import { mergeCommitRange, mergeRange, type MergeRange } from '../shape/merge-range.js';
import { must, SLOW_EXEC_TIMEOUT_MS, STOPPED, TIMED_OUT, type Exec } from '../util/exec.js';
import { airlockHome, repoSlug } from '../util/paths.js';

export interface Workspace {
  headDir: string;
  baseDir: string;
  /** The bare mirror's git folder: the diff is computed here, where no file of the pull request can change how git reads it. */
  gitDir: string;
  range: ReviewRange;
  /** For a re-review: what it covers. A push is reviewed from the earlier head (the base worktree); otherwise everything. */
  plan?: RereviewPlan;
  /**
   * For a re-review of a push: the pull request's whole range (its base, found as a first review finds it, to the head),
   * which is what GitHub shows. Absent when that base could not be found.
   */
  whole?: ReviewRange;
  /**
   * When every commit of the range is a merge, or a re-review's push is one merge of the base branch: what was changed by
   * hand. For `by-hand`, `range` runs from the merge git makes by itself (the base worktree) to the merge as committed.
   */
  merge?: MergeRange;
  /** Why git could not say whether the range is merges only; the review goes on as for any other range. */
  shapeError?: string;
  dispose(): Promise<void>;
}

export interface WorkspaceRequest {
  repo: string;
  remoteUrl: string; // tests pass a local path
  /**
   * A live pull request. `baseSha` is the base commit GitHub recorded; it is the base when the pull request is merged or
   * its base branch no longer exists. Otherwise the base is where the head meets the base branch's current tip.
   */
  pr?: { number: number; baseRef: string; headSha: string; baseSha?: string; merged?: boolean };
  explicit?: { baseSha: string; headSha: string }; // the replay
  /** With `pr`: a re-review of the pull request after the earlier review `previous`. */
  rereview?: { previous: ReviewDocument; pr: PrInfo };
  reviewId: string;
}

// Serialises clone/fetch/worktree-add per mirror within this process, so concurrent reviews don't race on first clone.
const queues = new Map<string, Promise<unknown>>();
function serialised<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(job, job);
  queues.set(key, run.catch(() => undefined));
  return run;
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/** A review folder older than this was left by a review that crashed or was killed. */
const STALE_WORK_MS = 24 * 60 * 60 * 1000;

/** Removes folders under `work` not changed for STALE_WORK_MS; the caller then prunes the mirror's worktree list. */
async function removeStaleWork(work: string): Promise<void> {
  const names = await readdir(work).catch(() => [] as string[]);
  const cutoff = Date.now() - STALE_WORK_MS;
  await Promise.all(names.map(async (name) => {
    const dir = join(work, name);
    const info = await stat(dir).catch(() => null);
    if (info?.isDirectory() && info.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }));
}

async function ensureMirror(exec: Exec, mirror: string, remoteUrl: string): Promise<void> {
  if (await exists(mirror)) {
    const fetchArgs = ['--git-dir', mirror, 'fetch', '--prune', 'origin', '+refs/heads/*:refs/heads/*'];
    must(await exec('git', fetchArgs, { timeoutMs: SLOW_EXEC_TIMEOUT_MS }), 'git fetch');
    return;
  }
  await mkdir(join(mirror, '..'), { recursive: true });
  must(await exec('git', ['clone', '--bare', remoteUrl, mirror], { timeoutMs: SLOW_EXEC_TIMEOUT_MS }), 'git clone --bare');
}

/** True when the mirror has the object `spec` names (a commit or a ref); a lookup that timed out throws. */
async function has(exec: Exec, mirror: string, spec: string): Promise<boolean> {
  const r = await exec('git', ['--git-dir', mirror, 'rev-parse', '--verify', '--quiet', spec]);
  // A lookup that timed out says nothing about the commit.
  if (r.code === TIMED_OUT) throw new Error(`git rev-parse ${spec}: ${r.stderr}`);
  return r.code === 0;
}

async function requireCommit(exec: Exec, mirror: string, sha: string): Promise<void> {
  if (!(await has(exec, mirror, `${sha}^{commit}`))) throw new Error(`Commit ${sha} was not found in the mirror of this repository`);
}

/** A full commit id: 40 (SHA-1) or 64 (SHA-256) hexadecimal characters. */
const FULL_COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * The base GitHub recorded for the pull request, from the mirror; when the mirror does not have it, it is fetched once by
 * its id. Throws one plain sentence when it still cannot be had.
 */
async function recordedBase(exec: Exec, mirror: string, number: number, baseSha: string): Promise<string> {
  if (await has(exec, mirror, `${baseSha}^{commit}`)) return baseSha;
  const fetched = await exec('git', ['--git-dir', mirror, 'fetch', 'origin', baseSha], { timeoutMs: SLOW_EXEC_TIMEOUT_MS });
  if (fetched.code === TIMED_OUT) throw new Error(`git fetch ${baseSha}: ${fetched.stderr}`);
  if (!(await has(exec, mirror, `${baseSha}^{commit}`))) {
    throw new Error(`The base commit of pull request #${number} (${baseSha}) could not be fetched, so the pull request cannot be reviewed.`);
  }
  return baseSha;
}

/** A branch name git cannot read as an option or as anything but a branch: letters, digits, `.`, `_`, `/`, `-`. */
const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

export async function prepareWorkspace(exec: Exec, req: WorkspaceRequest): Promise<Workspace> {
  const baseRef = req.pr?.baseRef;
  if (baseRef !== undefined && (!BRANCH_NAME.test(baseRef) || baseRef.startsWith('-'))) {
    throw new Error(`The base branch ${JSON.stringify(baseRef)} is not a branch name Airlock can use.`);
  }
  const recorded = req.pr?.baseSha;
  if (recorded !== undefined && !FULL_COMMIT_ID.test(recorded)) {
    throw new Error(`The base commit GitHub recorded for pull request #${req.pr!.number}, ${JSON.stringify(recorded)}, is not a full commit id.`);
  }
  return serialised(join(airlockHome(), 'repos', `${repoSlug(req.repo)}.git`), () => prepare(exec, req));
}

async function prepare(exec: Exec, req: WorkspaceRequest): Promise<Workspace> {
  const home = airlockHome();
  const mirror = join(home, 'repos', `${repoSlug(req.repo)}.git`);
  await ensureMirror(exec, mirror, req.remoteUrl);

  let range: ReviewRange;
  let plan: RereviewPlan | undefined;
  let whole: ReviewRange | undefined;
  if (req.explicit) {
    range = { baseSha: req.explicit.baseSha, headSha: req.explicit.headSha, kind: 'explicit' };
  } else if (req.pr) {
    const { number, baseRef, headSha, baseSha: recordedSha, merged } = req.pr;
    // The head lands in FETCH_HEAD; a remote without pull refs is fine when the commit is already here.
    const fetched = await exec('git', ['--git-dir', mirror, 'fetch', 'origin', `pull/${number}/head`], { timeoutMs: SLOW_EXEC_TIMEOUT_MS });
    if (fetched.code === TIMED_OUT) throw new Error(`git fetch pull/${number}/head: ${fetched.stderr}`);
    await requireCommit(exec, mirror, headSha);
    // Once merged, the base branch contains the head, so its tip would leave nothing to review; a deleted base branch has
    // no tip. Then the base GitHub recorded is used. An open pull request keeps the branch's current tip, since the
    // recorded base can be older than a base the branch has merged in since.
    const wholeBase = async (): Promise<string> => {
      const branch = `refs/heads/${baseRef}`; // the full ref, so a tag of the same name cannot stand in for the branch
      const useRecorded = merged === true || !(await has(exec, mirror, branch));
      if (useRecorded && recordedSha === undefined) {
        throw new Error(`Pull request #${number} is merged or its base branch ${baseRef} no longer exists, and no base commit was given.`);
      }
      const from = useRecorded ? await recordedBase(exec, mirror, number, recordedSha!) : branch;
      return must(await exec('git', ['--git-dir', mirror, 'merge-base', from, headSha]), `git merge-base ${from} ${headSha}`).trim();
    };
    // A re-review covers only the push when it can be reviewed alone; otherwise the whole pull request, as a first review.
    if (req.rereview) plan = await planRereview(exec, mirror, req.rereview.previous, { ...req.rereview.pr, headSha });
    if (plan?.kind === 'push' || plan?.kind === 'base-merge') {
      range = { baseSha: plan.baseSha, headSha: plan.headSha, kind: 'rereview' };
      // The whole pull request's range, as a first review would take it, is what GitHub shows. When its base cannot be
      // found the review goes on with the push alone, and the caller says so.
      try {
        whole = { baseSha: await wholeBase(), headSha, kind: 'full' };
      } catch (err) {
        if (err instanceof Error && err.message === STOPPED) throw err;
      }
    } else {
      range = { baseSha: await wholeBase(), headSha, kind: 'full' };
    }
  } else {
    throw new Error('prepareWorkspace needs either pr or explicit');
  }
  await requireCommit(exec, mirror, range.baseSha);
  await requireCommit(exec, mirror, range.headSha);
  const shape = await shapeOf(exec, mirror, range, plan);
  // What was changed by hand is reviewed from the merge git makes by itself, made in this mirror.
  if (shape.merge?.kind === 'by-hand') range = { ...range, baseSha: shape.merge.baseSha };

  const reviewDir = join(home, 'work', req.reviewId);
  const headDir = join(reviewDir, 'head');
  const baseDir = join(reviewDir, 'base');
  // Folders left by a review that crashed or was killed more than a day ago go; so does a leftover folder with this
  // review's name. The prune below then clears their registrations in this mirror.
  await removeStaleWork(join(home, 'work'));
  await rm(reviewDir, { recursive: true, force: true });
  await exec('git', ['--git-dir', mirror, 'worktree', 'prune']);
  const dispose = async (): Promise<void> => {
    await rm(reviewDir, { recursive: true, force: true });
    // Cleanup runs even after the review was stopped, so it never carries the review's signal.
    await exec('git', ['--git-dir', mirror, 'worktree', 'prune'], { signal: undefined });
  };
  await mkdir(reviewDir, { recursive: true });
  // With core.symlinks=false a link is checked out as a small file holding its target, so no review read can leave the worktree.
  const addWorktree = (dir: string, sha: string) =>
    exec('git', ['-c', 'core.symlinks=false', '--git-dir', mirror, 'worktree', 'add', '--detach', dir, sha]);
  try {
    must(await addWorktree(headDir, range.headSha), 'git worktree add (head)');
    must(await addWorktree(baseDir, range.baseSha), 'git worktree add (base)');
  } catch (err) {
    // The caller gets no workspace to dispose of, so a failure or a stop here removes the folder and its registration.
    try {
      await dispose();
    } catch {
      // the original error matters more; the 24-hour sweep removes what is left
    }
    throw err;
  }

  return {
    headDir, baseDir, gitDir: mirror, range, ...(plan === undefined ? {} : { plan }), ...(whole === undefined ? {} : { whole }), ...shape,
    dispose,
  };
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * For a range of merges only (or a re-review's push of one merge of the base branch), what was changed by hand; when the
 * merge git makes by itself cannot be made, `unsupported` with the reason. When git cannot say whether the range is
 * merges only, the reason as `shapeError`. Nothing for any other range. A stop is passed on.
 */
async function shapeOf(
  exec: Exec, mirror: string, range: ReviewRange, plan: RereviewPlan | undefined,
): Promise<{ merge?: MergeRange; shapeError?: string }> {
  if (plan?.kind !== 'base-merge') {
    try {
      if (!(await isSyncMerge(exec, mirror, range, null))) return {};
    } catch (err) {
      if (messageOf(err) === STOPPED) throw err;
      return { shapeError: messageOf(err) };
    }
  }
  try {
    return { merge: plan?.kind === 'base-merge' ? await mergeCommitRange(exec, mirror, range.headSha) : await mergeRange(exec, mirror, range) };
  } catch (err) {
    if (messageOf(err) === STOPPED) throw err;
    return { merge: { kind: 'unsupported', reason: `Airlock could not make the merge git would make by itself: ${messageOf(err).trim()}` } };
  }
}
