import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareWorkspace, type WorkspaceRequest } from '../../src/intake/workspace.js';
import { realExec } from '../../src/util/exec.js';
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
});
