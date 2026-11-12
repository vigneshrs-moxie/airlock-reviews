import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareWorkspace, type WorkspaceRequest } from '../../src/intake/workspace.js';
import { realExec, type Exec } from '../../src/util/exec.js';
import { makeTempRepo, type TempRepo } from '../helpers/temp-repo.js';

let home: string;
let savedHome: string | undefined;
const repos: TempRepo[] = [];

beforeEach(async () => {
  savedHome = process.env.AIRLOCK_HOME;
  home = await mkdtemp(join(tmpdir(), 'airlock-home-'));
  process.env.AIRLOCK_HOME = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.AIRLOCK_HOME;
  else process.env.AIRLOCK_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
  for (const r of repos.splice(0)) await rm(r.dir, { recursive: true, force: true });
});

async function remote(): Promise<TempRepo> {
  const r = await makeTempRepo();
  repos.push(r);
  return r;
}

const exists = (p: string) => stat(p).then(() => true, () => false);

describe('prepareWorkspace', () => {
  it('creates head and base worktrees at the two commits', async () => {
    const r = await remote();
    await r.write('a.txt', 'one');
    const base = await r.commit('one');
    await r.write('a.txt', 'two');
    const head = await r.commit('two');
    const ws = await prepareWorkspace(realExec, {
      repo: 'acme/app', remoteUrl: r.dir, explicit: { baseSha: base, headSha: head }, reviewId: 'r1',
    });
    expect(await readFile(join(ws.baseDir, 'a.txt'), 'utf8')).toBe('one');
    expect(await readFile(join(ws.headDir, 'a.txt'), 'utf8')).toBe('two');
    expect(ws.range).toEqual({ baseSha: base, headSha: head, kind: 'explicit' });
    await ws.dispose();
  });

  it('uses the merge-base as the base for a branch that is behind its target', async () => {
    const r = await remote();
    await r.write('a.txt', 'root');
    const branchPoint = await r.commit('root');
    await r.git('checkout', '-b', 'feature');
    await r.write('b.txt', 'feature');
    const head = await r.commit('feature work');
    await r.git('checkout', 'main');
    await r.write('a.txt', 'main moved on');
    await r.commit('main advances');
    const ws = await prepareWorkspace(realExec, {
      repo: 'acme/app', remoteUrl: r.dir, pr: { number: 7, baseRef: 'main', headSha: head }, reviewId: 'r2',
    });
    expect(ws.range.baseSha).toBe(branchPoint);
    expect(ws.range.headSha).toBe(head);
    expect(await readFile(join(ws.baseDir, 'a.txt'), 'utf8')).toBe('root');
    expect(await readFile(join(ws.headDir, 'b.txt'), 'utf8')).toBe('feature');
    await ws.dispose();
  });

  it('reuses the mirror on a second call and sees a new commit', async () => {
    const r = await remote();
    await r.write('a.txt', 'one');
    const first = await r.commit('one');
    const req = (sha: string, reviewId: string): WorkspaceRequest => ({
      repo: 'acme/app', remoteUrl: r.dir, explicit: { baseSha: first, headSha: sha }, reviewId,
    });
    const ws1 = await prepareWorkspace(realExec, req(first, 'r3'));
    await r.write('a.txt', 'two');
    const second = await r.commit('two');
    const ws2 = await prepareWorkspace(realExec, req(second, 'r4'));
    expect(await readFile(join(ws2.headDir, 'a.txt'), 'utf8')).toBe('two');
    await ws1.dispose();
    await ws2.dispose();
  });

  it('allows the same review id again after dispose', async () => {
    const r = await remote();
    await r.write('a.txt', 'one');
    const sha = await r.commit('one');
    const req: WorkspaceRequest = { repo: 'acme/app', remoteUrl: r.dir, explicit: { baseSha: sha, headSha: sha }, reviewId: 'same' };
    await (await prepareWorkspace(realExec, req)).dispose();
    const again = await prepareWorkspace(realExec, req);
    expect(await exists(join(again.headDir, 'a.txt'))).toBe(true);
    await again.dispose();
  });

  it('prepares two reviews of the same repository at the same time', async () => {
    const r = await remote();
    await r.write('a.txt', 'one');
    const sha = await r.commit('one');
    const req = (reviewId: string): WorkspaceRequest => ({
      repo: 'acme/app', remoteUrl: r.dir, explicit: { baseSha: sha, headSha: sha }, reviewId,
    });
    const [a, b] = await Promise.all([prepareWorkspace(realExec, req('p1')), prepareWorkspace(realExec, req('p2'))]);
    expect(await exists(a.headDir)).toBe(true);
    expect(await exists(b.headDir)).toBe(true);
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('dispose removes the worktrees', async () => {
    const r = await remote();
    await r.write('a.txt', 'one');
    const sha = await r.commit('one');
    const ws = await prepareWorkspace(realExec, {
      repo: 'acme/app', remoteUrl: r.dir, explicit: { baseSha: sha, headSha: sha }, reviewId: 'r5',
    });
    expect(await exists(ws.headDir)).toBe(true);
    await ws.dispose();
    expect(await exists(ws.headDir)).toBe(false);
    expect(await exists(ws.baseDir)).toBe(false);
  });

  it('checks a symbolic link out as a small regular file holding its target, so nothing outside can be read through it', async () => {
    const r = await remote();
    const outside = await mkdtemp(join(tmpdir(), 'airlock-outside-'));
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'SECRET OUTSIDE THE REPOSITORY');
    await r.write('a.txt', 'one');
    const base = await r.commit('one');
    await symlink(secret, join(r.dir, 'link.txt'));
    const head = await r.commit('add a link');
    try {
      const ws = await prepareWorkspace(realExec, {
        repo: 'acme/app', remoteUrl: r.dir, explicit: { baseSha: base, headSha: head }, reviewId: 'links',
      });
      const path = join(ws.headDir, 'link.txt');
      expect((await lstat(path)).isSymbolicLink()).toBe(false);
      expect((await lstat(path)).isFile()).toBe(true);
      expect(await readFile(path, 'utf8')).toBe(secret);
      await ws.dispose();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('fails with a clear message when a SHA is unknown', async () => {
    const r = await remote();
    await r.write('a.txt', 'one');
    await r.commit('one');
    await expect(
      prepareWorkspace(realExec, {
        repo: 'acme/app', remoteUrl: r.dir, explicit: { baseSha: 'deadbeef', headSha: 'deadbeef' }, reviewId: 'r6',
      }),
    ).rejects.toThrow(/deadbeef/);
  });

  it('treats a timed-out commit lookup as a failure, not as a commit that is missing', async () => {
    const r = await remote();
    await r.write('a.txt', '1');
    const sha = await r.commit('one');
    const exec: Exec = async (cmd, args, opts) =>
      (args.includes('rev-parse') ? { stdout: '', stderr: 'timed out after 60 s', code: 124 } : realExec(cmd, args, opts));
    const req: WorkspaceRequest = { repo: 'acme/app', remoteUrl: r.dir, explicit: { baseSha: sha, headSha: sha }, reviewId: 't1' };
    const err = await prepareWorkspace(exec, req).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toMatch(/timed out after 60 s/);
    expect(err?.message).not.toMatch(/was not found/);
  });

  it('gives clone and fetch ten minutes and other git commands the default', async () => {
    const r = await remote();
    await r.write('a.txt', '1');
    const sha = await r.commit('one');
    const seen: { args: string[]; timeoutMs: number | undefined }[] = [];
    const exec: Exec = async (cmd, args, opts) => {
      seen.push({ args, timeoutMs: opts?.timeoutMs });
      return realExec(cmd, args, opts);
    };
    const req = (id: string): WorkspaceRequest => ({ repo: 'acme/app', remoteUrl: r.dir, explicit: { baseSha: sha, headSha: sha }, reviewId: id });
    await (await prepareWorkspace(exec, req('t2'))).dispose();
    await (await prepareWorkspace(exec, req('t3'))).dispose();
    const slow = seen.filter((s) => s.args.includes('clone') || s.args.includes('fetch'));
    expect(slow.map((s) => s.args.find((a) => a === 'clone' || a === 'fetch'))).toEqual(['clone', 'fetch']);
    expect(slow.every((s) => s.timeoutMs === 600_000)).toBe(true);
    expect(seen.filter((s) => !slow.includes(s)).every((s) => s.timeoutMs === undefined)).toBe(true);
  });

  it('refuses a base branch name that is not a plain branch name before any git call', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => { calls.push(args); return { stdout: '', stderr: '', code: 0 }; };
    for (const baseRef of ['-main', 'main;rm', 'main branch', '']) {
      const req: WorkspaceRequest = { repo: 'acme/app', remoteUrl: '/x', pr: { number: 7, baseRef, headSha: 'a'.repeat(40) }, reviewId: 'b1' };
      await expect(prepareWorkspace(exec, req)).rejects.toThrow(/is not a branch name Airlock can use/);
    }
    expect(calls).toEqual([]);
  });

  it('gives merge-base the full branch ref, so a tag of the same name cannot stand in for it', async () => {
    const r = await remote();
    await r.write('a.txt', '1');
    const root = await r.commit('root');
    await r.git('checkout', '-b', 'feature');
    await r.write('b.txt', '2');
    const head = await r.commit('feature work');
    await r.git('checkout', 'main');
    await r.write('c.txt', '3');
    await r.commit('main advances');
    await r.git('tag', 'main', head); // a tag named like the base branch, pointing at the head
    const seen: string[][] = [];
    const exec: Exec = async (cmd, args, opts) => { seen.push(args); return realExec(cmd, args, opts); };
    const ws = await prepareWorkspace(exec, { repo: 'acme/app', remoteUrl: r.dir, pr: { number: 7, baseRef: 'main', headSha: head }, reviewId: 'b2' });
    expect(seen.find((a) => a.includes('merge-base'))).toContain('refs/heads/main');
    expect(ws.range.baseSha).toBe(root);
    await ws.dispose();
  });

  describe('the base of a merged pull request, or one whose base branch is gone', () => {
    /** main at `root`, feature with one commit, then (optionally) feature merged into main. */
    async function merged(mergeIt: boolean) {
      const r = await remote();
      await r.write('a.txt', 'root');
      const root = await r.commit('root');
      await r.git('checkout', '-b', 'feature');
      await r.write('b.txt', 'feature');
      const head = await r.commit('feature work');
      await r.git('checkout', 'main');
      if (mergeIt) await r.git('merge', '--no-ff', '-m', 'Merge feature', 'feature');
      return { r, root, head };
    }
    const spy = () => {
      const seen: string[][] = [];
      const exec: Exec = async (cmd, args, opts) => { seen.push(args); return realExec(cmd, args, opts); };
      return { seen, exec };
    };

    it('a merged pull request whose base branch contains its head is reviewed from the base GitHub recorded', async () => {
      const { r, root, head } = await merged(true);
      const { seen, exec } = spy();
      const ws = await prepareWorkspace(exec, {
        repo: 'acme/app', remoteUrl: r.dir, pr: { number: 7, baseRef: 'main', headSha: head, baseSha: root, merged: true }, reviewId: 'm1',
      });
      expect(ws.range).toEqual({ baseSha: root, headSha: head, kind: 'full' });
      expect(seen.find((a) => a.includes('merge-base'))!.slice(-2)).toEqual([root, head]);
      await ws.dispose();
    });

    it('a pull request whose base branch was deleted is reviewed from the recorded base too', async () => {
      const r = await remote();
      await r.write('a.txt', 'root');
      const root = await r.commit('root');
      await r.git('checkout', '-b', 'release');
      await r.git('checkout', '-b', 'feature');
      await r.write('b.txt', 'feature');
      const head = await r.commit('feature work');
      await r.git('checkout', 'main');
      await r.git('branch', '-D', 'release');
      const ws = await prepareWorkspace(realExec, {
        repo: 'acme/app', remoteUrl: r.dir, pr: { number: 7, baseRef: 'release', headSha: head, baseSha: root }, reviewId: 'm2',
      });
      expect(ws.range).toEqual({ baseSha: root, headSha: head, kind: 'full' });
      await ws.dispose();
    });

    it('an open pull request whose base branch exists keeps the branch\'s tip as before, whatever base GitHub recorded', async () => {
      const r = await remote();
      await r.write('a.txt', '1');
      const older = await r.commit('older');
      await r.write('a.txt', '2');
      const branchPoint = await r.commit('branch point');
      await r.git('checkout', '-b', 'feature');
      await r.write('b.txt', '3');
      const head = await r.commit('feature work');
      await r.git('checkout', 'main');
      const { seen, exec } = spy();
      const ws = await prepareWorkspace(exec, {
        repo: 'acme/app', remoteUrl: r.dir, pr: { number: 7, baseRef: 'main', headSha: head, baseSha: older, merged: false }, reviewId: 'm3',
      });
      const mirror = join(home, 'repos', 'acme__app.git');
      expect(seen.filter((a) => a.includes('merge-base'))).toEqual([['--git-dir', mirror, 'merge-base', 'refs/heads/main', head]]);
      expect(ws.range.baseSha).toBe(branchPoint);
      await ws.dispose();
    });

    it('fetches a recorded base the mirror does not have, once, by its id', async () => {
      const { r, head } = await merged(true);
      // A commit on no branch or tag, so a mirror of the branches does not have it.
      await r.git('checkout', '-b', 'gone', 'feature~1');
      await r.write('c.txt', 'only here');
      const hidden = await r.commit('hidden base');
      await r.git('update-ref', 'refs/hidden/base', hidden);
      await r.git('checkout', 'main');
      await r.git('branch', '-D', 'gone');
      await r.git('config', 'uploadpack.allowAnySHA1InWant', 'true');
      const { seen, exec } = spy();
      // A file:// address makes git copy only what the branches reach, as a clone from GitHub does.
      const ws = await prepareWorkspace(exec, {
        repo: 'acme/app', remoteUrl: `file://${r.dir}`, pr: { number: 7, baseRef: 'main', headSha: head, baseSha: hidden, merged: true }, reviewId: 'm4',
      });
      expect(seen.filter((a) => a.includes('fetch') && a.includes(hidden))).toHaveLength(1);
      expect(ws.range.headSha).toBe(head);
      await ws.dispose();
    });

    it('says plainly when the recorded base cannot be fetched', async () => {
      const { r, head } = await merged(true);
      const missing = 'f'.repeat(40);
      const { seen, exec } = spy();
      await expect(prepareWorkspace(exec, {
        repo: 'acme/app', remoteUrl: r.dir, pr: { number: 7, baseRef: 'main', headSha: head, baseSha: missing, merged: true }, reviewId: 'm5',
      })).rejects.toThrow(`The base commit of pull request #7 (${missing}) could not be fetched, so the pull request cannot be reviewed.`);
      expect(seen.filter((a) => a.includes('fetch') && a.includes(missing))).toHaveLength(1);
    });

    it('refuses a recorded base that is not a full commit id before any git call', async () => {
      const calls: string[][] = [];
      const exec: Exec = async (cmd, args) => { calls.push(args); return { stdout: '', stderr: '', code: 0 }; };
      for (const baseSha of ['abc1234', 'g'.repeat(40), `${'a'.repeat(40)}\n`, '--upload-pack=x', 'a'.repeat(41)]) {
        const req: WorkspaceRequest = { repo: 'acme/app', remoteUrl: '/x', pr: { number: 7, baseRef: 'main', headSha: 'a'.repeat(40), baseSha, merged: true }, reviewId: 'b9' };
        await expect(prepareWorkspace(exec, req)).rejects.toThrow(/is not a full commit id/);
      }
      expect(calls).toEqual([]);
    });
  });

  it('removes the review folder and its worktree registration when it fails after making the folder', async () => {
    const r = await remote();
    await r.write('a.txt', '1');
    const sha = await r.commit('one');
    const exec: Exec = async (cmd, args, opts) => (args.includes('worktree') && args.includes('add') && args.at(-2)!.endsWith('base')
      ? { stdout: '', stderr: 'fatal: no room left', code: 128 } : realExec(cmd, args, opts));
    const req: WorkspaceRequest = { repo: 'acme/app', remoteUrl: r.dir, explicit: { baseSha: sha, headSha: sha }, reviewId: 'r_fail' };
    await expect(prepareWorkspace(exec, req)).rejects.toThrow(/no room left/);
    expect(await exists(join(home, 'work', 'r_fail'))).toBe(false);
    const mirror = join(home, 'repos', 'acme__app.git');
    const listed = await realExec('git', ['--git-dir', mirror, 'worktree', 'list', '--porcelain']);
    expect(listed.stdout).not.toContain('r_fail');
  });

  it('removes the review folder when it is stopped while adding a worktree', async () => {
    const r = await remote();
    await r.write('a.txt', '1');
    const sha = await r.commit('one');
    const exec: Exec = async (cmd, args, opts) => {
      if (args.includes('worktree') && args.includes('add')) throw new Error('The review was stopped.');
      return realExec(cmd, args, opts);
    };
    const req: WorkspaceRequest = { repo: 'acme/app', remoteUrl: r.dir, explicit: { baseSha: sha, headSha: sha }, reviewId: 'r_stop' };
    await expect(prepareWorkspace(exec, req)).rejects.toThrow('The review was stopped.');
    expect(await exists(join(home, 'work', 'r_stop'))).toBe(false);
  });

  it('removes review folders left under work for more than a day, and keeps newer ones', async () => {
    const r = await remote();
    await r.write('a.txt', '1');
    const sha = await r.commit('one');
    const old = join(home, 'work', 'r_old');
    const fresh = join(home, 'work', 'r_fresh');
    await mkdir(join(old, 'head'), { recursive: true });
    await mkdir(fresh, { recursive: true });
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
    await utimes(old, twoDaysAgo, twoDaysAgo);
    const ws = await prepareWorkspace(realExec, { repo: 'acme/app', remoteUrl: r.dir, explicit: { baseSha: sha, headSha: sha }, reviewId: 'r_now' });
    expect(await exists(old)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    await ws.dispose();
  });
});
