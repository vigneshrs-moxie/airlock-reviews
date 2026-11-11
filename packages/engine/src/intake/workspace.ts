import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewRange } from '@airlock/shared';
import { must, type Exec } from '../util/exec.js';
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
    must(await exec('git', ['--git-dir', mirror, 'fetch', '--prune', 'origin', '+refs/heads/*:refs/heads/*']), 'git fetch');
    return;
  }
  await mkdir(join(mirror, '..'), { recursive: true });
  must(await exec('git', ['clone', '--bare', remoteUrl, mirror]), 'git clone --bare');
}

async function requireCommit(exec: Exec, mirror: string, sha: string): Promise<void> {
  const r = await exec('git', ['--git-dir', mirror, 'rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  if (r.code !== 0) throw new Error(`Commit ${sha} was not found in the mirror of this repository`);
}

export function prepareWorkspace(exec: Exec, req: WorkspaceRequest): Promise<Workspace> {
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
    await exec('git', ['--git-dir', mirror, 'fetch', 'origin', `pull/${number}/head`]);
    await requireCommit(exec, mirror, headSha);
    const baseSha = must(await exec('git', ['--git-dir', mirror, 'merge-base', baseRef, headSha]), `git merge-base ${baseRef} ${headSha}`).trim();
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
      await exec('git', ['--git-dir', mirror, 'worktree', 'prune']);
    },
  };
}
