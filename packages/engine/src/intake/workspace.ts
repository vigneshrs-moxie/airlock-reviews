import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewRange } from '@airlock/shared';
import { must, SLOW_EXEC_TIMEOUT_MS, TIMED_OUT, type Exec } from '../util/exec.js';
import { airlockHome, repoSlug } from '../util/paths.js';

export interface Workspace {
  headDir: string;
  baseDir: string;
  /** The bare mirror's git folder: the diff is computed here, where no file of the pull request can change how git reads it. */
  gitDir: string;
  range: ReviewRange;
  dispose(): Promise<void>;
}

export interface WorkspaceRequest {
  repo: string;
  remoteUrl: string; // tests pass a local path
  pr?: { number: number; baseRef: string; headSha: string }; // live pull request
  explicit?: { baseSha: string; headSha: string }; // replay and re-review
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

async function ensureMirror(exec: Exec, mirror: string, remoteUrl: string): Promise<void> {
  if (await exists(mirror)) {
    const fetchArgs = ['--git-dir', mirror, 'fetch', '--prune', 'origin', '+refs/heads/*:refs/heads/*'];
    must(await exec('git', fetchArgs, { timeoutMs: SLOW_EXEC_TIMEOUT_MS }), 'git fetch');
    return;
  }
  await mkdir(join(mirror, '..'), { recursive: true });
  must(await exec('git', ['clone', '--bare', remoteUrl, mirror], { timeoutMs: SLOW_EXEC_TIMEOUT_MS }), 'git clone --bare');
}

async function requireCommit(exec: Exec, mirror: string, sha: string): Promise<void> {
  const r = await exec('git', ['--git-dir', mirror, 'rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  // A lookup that timed out says nothing about the commit.
  if (r.code === TIMED_OUT) throw new Error(`git rev-parse ${sha}: ${r.stderr}`);
  if (r.code !== 0) throw new Error(`Commit ${sha} was not found in the mirror of this repository`);
}

/** A branch name git cannot read as an option or as anything but a branch: letters, digits, `.`, `_`, `/`, `-`. */
const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

export async function prepareWorkspace(exec: Exec, req: WorkspaceRequest): Promise<Workspace> {
  const baseRef = req.pr?.baseRef;
  if (baseRef !== undefined && (!BRANCH_NAME.test(baseRef) || baseRef.startsWith('-'))) {
    throw new Error(`The base branch ${JSON.stringify(baseRef)} is not a branch name Airlock can use.`);
  }
  return serialised(join(airlockHome(), 'repos', `${repoSlug(req.repo)}.git`), () => prepare(exec, req));
}

async function prepare(exec: Exec, req: WorkspaceRequest): Promise<Workspace> {
  const home = airlockHome();
  const mirror = join(home, 'repos', `${repoSlug(req.repo)}.git`);
  await ensureMirror(exec, mirror, req.remoteUrl);

  let range: ReviewRange;
  if (req.explicit) {
    range = { baseSha: req.explicit.baseSha, headSha: req.explicit.headSha, kind: 'explicit' };
  } else if (req.pr) {
    const { number, baseRef, headSha } = req.pr;
    // The head lands in FETCH_HEAD; a remote without pull refs is fine when the commit is already here.
    const fetched = await exec('git', ['--git-dir', mirror, 'fetch', 'origin', `pull/${number}/head`], { timeoutMs: SLOW_EXEC_TIMEOUT_MS });
    if (fetched.code === TIMED_OUT) throw new Error(`git fetch pull/${number}/head: ${fetched.stderr}`);
    await requireCommit(exec, mirror, headSha);
    // The full ref, so a tag of the same name cannot stand in for the branch.
    const baseSha = must(await exec('git', ['--git-dir', mirror, 'merge-base', `refs/heads/${baseRef}`, headSha]), `git merge-base ${baseRef} ${headSha}`).trim();
    range = { baseSha, headSha, kind: 'full' };
  } else {
    throw new Error('prepareWorkspace needs either pr or explicit');
  }
  await requireCommit(exec, mirror, range.baseSha);
  await requireCommit(exec, mirror, range.headSha);

  const reviewDir = join(home, 'work', req.reviewId);
  const headDir = join(reviewDir, 'head');
  const baseDir = join(reviewDir, 'base');
  // A leftover folder from an earlier run would block the name; clear it and any stale registration.
  await rm(reviewDir, { recursive: true, force: true });
  await exec('git', ['--git-dir', mirror, 'worktree', 'prune']);
  await mkdir(reviewDir, { recursive: true });
  // With core.symlinks=false a link is checked out as a small file holding its target, so no review read can leave the worktree.
  const addWorktree = (dir: string, sha: string) =>
    exec('git', ['-c', 'core.symlinks=false', '--git-dir', mirror, 'worktree', 'add', '--detach', dir, sha]);
  must(await addWorktree(headDir, range.headSha), 'git worktree add (head)');
  must(await addWorktree(baseDir, range.baseSha), 'git worktree add (base)');

  return {
    headDir, baseDir, gitDir: mirror, range,
    async dispose() {
      await rm(reviewDir, { recursive: true, force: true });
      // Cleanup runs even after the review was stopped, so it never carries the review's signal.
      await exec('git', ['--git-dir', mirror, 'worktree', 'prune'], { signal: undefined });
    },
  };
}
