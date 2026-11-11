import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachKit, KIT_FILES, KIT_REPO, syncKit } from '../../src/packs/kit-sync.js';
import type { Pack } from '../../src/packs/types.js';
import type { Exec } from '../../src/util/exec.js';

const SHA = 'a'.repeat(40);
let home: string;
let saved: string | undefined;
beforeEach(async () => {
  saved = process.env.AIRLOCK_HOME;
  home = await mkdtemp(join(tmpdir(), 'airlock-kit-'));
  process.env.AIRLOCK_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.AIRLOCK_HOME; else process.env.AIRLOCK_HOME = saved;
});

type Call = { cmd: string; args: string[] };
function fakeGh(opts: { sha?: string; resolveFails?: boolean; failPath?: string } = {}) {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    if (args[1]?.includes('/commits/')) {
      if (opts.resolveFails) return { stdout: '', stderr: 'could not resolve host', code: 4 };
      return { stdout: `${opts.sha ?? SHA}\n`, stderr: '', code: 0 };
    }
    const target = args[args.length - 1]!;
    if (opts.failPath && target.includes(opts.failPath)) return { stdout: '', stderr: 'boom', code: 1 };
    return { stdout: `text of ${target}`, stderr: '', code: 0 };
  };
  return { exec, calls };
}

describe('syncKit', () => {
  it('fetches four files once and serves the second call from the cache', async () => {
    const gh = fakeGh();
    const first = await syncKit(gh.exec);
    expect(first).toEqual({ sha: SHA, dir: join(home, 'kit', SHA), stale: false });
    expect(gh.calls[0]).toEqual({ cmd: 'gh', args: ['api', `repos/${KIT_REPO}/commits/main`, '--jq', '.sha'] });
    expect(gh.calls).toHaveLength(5);
    for (const path of KIT_FILES) {
      expect(gh.calls).toContainEqual({
        cmd: 'gh',
        args: ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${KIT_REPO}/contents/${path}?ref=${SHA}`],
      });
    }
    expect((await readdir(first.dir)).sort()).toEqual(['SKILL.md', 'calibration.md', 'orbit.md', 'profile.md']);
    expect(await readFile(join(first.dir, 'orbit.md'), 'utf8')).toContain('skills/moxie-review/orbit.md');

    const second = await syncKit(gh.exec);
    expect(second).toEqual({ sha: SHA, dir: first.dir, stale: false });
    expect(gh.calls).toHaveLength(6); // only the commit lookup was repeated
  });

  it('resolves the given ref', async () => {
    const gh = fakeGh();
    await syncKit(gh.exec, { ref: 'v2' });
    expect(gh.calls[0]!.args[1]).toBe(`repos/${KIT_REPO}/commits/v2`);
  });

  it('falls back to the newest complete cached kit, marked stale, when the commit cannot be resolved', async () => {
    const mk = async (sha: string, complete: boolean, time: number) => {
      const dir = join(home, 'kit', sha);
      await mkdir(dir, { recursive: true });
      for (const f of complete ? ['profile.md', 'orbit.md', 'calibration.md', 'SKILL.md'] : ['profile.md']) {
        await writeFile(join(dir, f), f);
      }
      await utimes(dir, time, time);
    };
    await mk('old', true, 1000);
    await mk('new', true, 2000);
    await mk('newest-but-partial', false, 3000);
    await mk('.new-download-abc123', true, 4000); // in-progress temp folder: ignored
    const result = await syncKit(fakeGh({ resolveFails: true }).exec);
    expect(result).toEqual({ sha: 'new', dir: join(home, 'kit', 'new'), stale: true });
  });

  it('throws with gh stderr when the commit cannot be resolved and nothing is cached', async () => {
    await expect(syncKit(fakeGh({ resolveFails: true }).exec)).rejects.toThrow(/kit could not be fetched.*could not resolve host/s);
  });

  it('treats a malformed commit value as unresolved and deletes nothing', async () => {
    await mkdir(join(home, 'kit'), { recursive: true });
    await writeFile(join(home, 'sentinel.txt'), 'keep');
    for (const bad of ['..', '../x', 'abc', `${SHA}\nextra`]) {
      await expect(syncKit(fakeGh({ sha: bad }).exec)).rejects.toThrow(/kit could not be fetched/);
    }
    expect(await readFile(join(home, 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it('lets two syncs of the same commit run at once and both return the same folder', async () => {
    const gh = fakeGh();
    const [a, b] = await Promise.all([syncKit(gh.exec), syncKit(gh.exec)]);
    expect(a).toEqual({ sha: SHA, dir: join(home, 'kit', SHA), stale: false });
    expect(b).toEqual(a);
    expect((await readdir(join(home, 'kit'))).sort()).toEqual([SHA]);
    expect((await readdir(a.dir)).sort()).toEqual(['SKILL.md', 'calibration.md', 'orbit.md', 'profile.md']);
  });

  it('does not treat a half-finished download as cached', async () => {
    const failing = fakeGh({ failPath: 'calibration.md' });
    await expect(syncKit(failing.exec)).rejects.toThrow(/boom/);
    const kitDir = join(home, 'kit');
    expect((await readdir(kitDir)).filter((n) => n === SHA)).toEqual([]);
    // a leftover folder with fewer than four files is not a cache either
    await mkdir(join(kitDir, SHA), { recursive: true });
    await writeFile(join(kitDir, SHA, 'profile.md'), 'x');
    const ok = fakeGh();
    const result = await syncKit(ok.exec);
    expect(result.stale).toBe(false);
    expect(ok.calls).toHaveLength(5);
    expect((await readdir(result.dir)).sort()).toEqual(['SKILL.md', 'calibration.md', 'orbit.md', 'profile.md']);
    expect((await readdir(kitDir)).sort()).toEqual([SHA]);
  });
});

describe('attachKit', () => {
  it('marks calibration.md as dated, uses the commit as the version, and does not mutate the adapter', async () => {
    const { dir } = await syncKit(fakeGh().exec);
    const adapter = {
      id: 'raj-standard', title: 't', version: 'local', dir: '/x', repos: [], appRoot: null, stageRules: [],
      tiers: { read: [], trust: [], ignore: [] }, siblings: [], linkRules: [], checks: [],
      standards: [], lenses: [], rules: [], learned: [],
    } satisfies Pack;
    const snapshot = structuredClone(adapter);
    const pack = await attachKit(adapter, { sha: SHA, dir });
    expect(pack).not.toBe(adapter);
    expect(adapter).toEqual(snapshot);
    expect(pack.version).toBe(SHA);
    expect(pack.standards.map((s) => [s.name, s.dated])).toEqual([
      ['profile.md', false], ['orbit.md', false], ['calibration.md', true],
    ]);
    expect(pack.standards[1]!.text).toContain('orbit.md');
  });
});
