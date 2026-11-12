import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachKit, kitCacheRoot, kitRefProblem, syncKit } from '../../src/packs/kit-sync.js';
import type { KitRef, Pack } from '../../src/packs/types.js';
import { isGhRead, type Exec } from '../../src/util/exec.js';

const SHA = 'a'.repeat(40);
const TEAM: KitRef = {
  repo: 'acme/review-kit',
  files: ['skills/review/profile.md', 'skills/review/orbit.md', 'skills/review/calibration.md'],
  datedStandards: ['skills/review/calibration.md'],
};
const OTHER: KitRef = { repo: 'acme/ext-kit', files: ['skills/ext/standard.md', 'skills/ext/calibration.md'] };
const TEAM_SLUG = 'acme__review-kit';
const NAMES = ['calibration.md', 'orbit.md', 'profile.md'];

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
function fakeGh(opts: { sha?: string | ((repo: string) => string); resolveFails?: boolean; failPath?: string } = {}) {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    const commit = /^repos\/([^/]+\/[^/]+)\/commits\//.exec(args[1] ?? '');
    if (commit) {
      if (opts.resolveFails) return { stdout: '', stderr: 'could not resolve host', code: 4 };
      const sha = typeof opts.sha === 'function' ? opts.sha(commit[1]!) : opts.sha ?? SHA;
      return { stdout: `${sha}\n`, stderr: '', code: 0 };
    }
    const target = args[args.length - 1]!;
    if (opts.failPath && target.includes(opts.failPath)) return { stdout: '', stderr: 'HTTP 404: Not Found', code: 1 };
    return { stdout: `text of ${target}`, stderr: '', code: 0 };
  };
  return { exec, calls };
}

/** Where syncKit keeps `kit`'s copies, as parts under <home>/kit, followed by `more`. */
const at = (kit: KitRef, ...more: string[]): string[] => [...relative(join(home, 'kit'), kitCacheRoot(kit)).split(sep), ...more];

/** A cached copy under `<home>/kit/<parts...>`, with the given files, dated `time` (seconds). */
async function cache(parts: string[], files: string[], time: number): Promise<string> {
  const dir = join(home, 'kit', ...parts);
  await mkdir(dir, { recursive: true });
  for (const f of files) await writeFile(join(dir, f), `cached ${f}`);
  await utimes(dir, time, time);
  return dir;
}

describe('syncKit', () => {
  it('fetches the listed files once and serves the second call from the cache', async () => {
    const gh = fakeGh();
    const first = await syncKit(gh.exec, TEAM);
    expect(first).toEqual({ sha: SHA, dir: join(kitCacheRoot(TEAM), SHA), stale: false });
    expect(gh.calls[0]).toEqual({ cmd: 'gh', args: ['api', 'repos/acme/review-kit/commits/main', '--jq', '.sha'] });
    expect(gh.calls).toHaveLength(4);
    for (const path of TEAM.files) {
      expect(gh.calls).toContainEqual({
        cmd: 'gh',
        args: ['api', '-H', 'Accept: application/vnd.github.raw', `repos/acme/review-kit/contents/${path}?ref=${SHA}`],
      });
    }
    expect((await readdir(first.dir)).sort()).toEqual(NAMES);
    expect(await readFile(join(first.dir, 'orbit.md'), 'utf8')).toContain('skills/review/orbit.md');

    const second = await syncKit(gh.exec, TEAM);
    expect(second).toEqual({ sha: SHA, dir: first.dir, stale: false });
    expect(gh.calls).toHaveLength(5); // only the commit lookup was repeated
  });

  it("resolves the manifest's ref, and the given ref over it", async () => {
    const gh = fakeGh();
    await syncKit(gh.exec, { ...TEAM, ref: 'release' });
    expect(gh.calls[0]!.args[1]).toBe('repos/acme/review-kit/commits/release');
    await syncKit(gh.exec, { ...TEAM, ref: 'release' }, { ref: 'v2' });
    expect(gh.calls[4]!.args[1]).toBe('repos/acme/review-kit/commits/v2');
  });

  it('two packs with different kits are cached side by side by repository and commit', async () => {
    const other = 'b'.repeat(40);
    const gh = fakeGh({ sha: (repo) => (repo === 'acme/ext-kit' ? other : SHA) });
    const team = await syncKit(gh.exec, TEAM);
    const ext = await syncKit(gh.exec, OTHER);
    expect(team.dir).toBe(join(kitCacheRoot(TEAM), SHA));
    expect(ext).toEqual({ sha: other, dir: join(kitCacheRoot(OTHER), other), stale: false });
    expect((await readdir(join(home, 'kit'))).sort()).toEqual(['acme__ext-kit', TEAM_SLUG]);
    expect((await readdir(team.dir)).sort()).toEqual(NAMES);
    expect((await readdir(ext.dir)).sort()).toEqual(['calibration.md', 'standard.md']);
    expect(await readFile(join(ext.dir, 'calibration.md'), 'utf8')).toContain('skills/ext/calibration.md');
    expect(await readFile(join(team.dir, 'calibration.md'), 'utf8')).toContain('skills/review/calibration.md');

    // The same commit of two repositories is still two folders.
    const same = fakeGh();
    expect((await syncKit(same.exec, OTHER)).dir).toBe(join(kitCacheRoot(OTHER), SHA));
    expect((await readdir(kitCacheRoot(OTHER))).sort()).toEqual([SHA, other].sort());
  });

  it("the cache key holds the repository and a short hash of the kit's file list, whatever their order", () => {
    const root = kitCacheRoot(TEAM);
    expect(relative(join(home, 'kit'), root).split(sep)).toEqual([TEAM_SLUG, expect.stringMatching(/^[0-9a-f]{12}$/)]);
    expect(kitCacheRoot({ ...TEAM, files: [...TEAM.files].reverse(), datedStandards: [], ref: 'v2' })).toBe(root);
    expect(kitCacheRoot({ ...TEAM, files: TEAM.files.slice(0, 2) })).not.toBe(root);
  });

  it("two kits naming one repository with different files keep their own copies and never delete each other's", async () => {
    const two: KitRef = { repo: TEAM.repo, files: ['skills/review/profile.md', 'skills/review/register.md'] };
    const gh = fakeGh();
    const a = await syncKit(gh.exec, TEAM);
    const b = await syncKit(gh.exec, two);
    expect(a.sha).toBe(b.sha);
    expect(a.dir).not.toBe(b.dir);
    expect((await readdir(a.dir)).sort()).toEqual(NAMES);
    expect((await readdir(b.dir)).sort()).toEqual(['profile.md', 'register.md']);
    // each is served from its own copy now, with only the commit looked up again
    const calls = gh.calls.length;
    expect(await syncKit(gh.exec, TEAM)).toEqual(a);
    expect(await syncKit(gh.exec, two)).toEqual(b);
    expect(gh.calls.length).toBe(calls + 2);
    // and each still has its copy to fall back on
    expect(await syncKit(fakeGh({ resolveFails: true }).exec, TEAM)).toEqual({ ...a, stale: true });
    expect(await syncKit(fakeGh({ resolveFails: true }).exec, two)).toEqual({ ...b, stale: true });
  });

  it('a copy in the place used before the file list was in the key is not a cache', async () => {
    await cache([TEAM_SLUG, SHA], NAMES, 1000); // <home>/kit/<slug>/<sha>/
    await expect(syncKit(fakeGh({ resolveFails: true }).exec, TEAM)).rejects.toThrow(/none is cached/);
  });

  it('when the kit cannot be fetched the newest cached copy is used and marked stale', async () => {
    await cache(at(TEAM, 'old'), NAMES, 1000);
    const newer = await cache(at(TEAM, 'new'), NAMES, 2000);
    await cache(at(TEAM, 'newest-but-partial'), ['profile.md'], 3000);
    await cache(at(TEAM, '.new-download-abc123'), NAMES, 4000); // in-progress temp folder: ignored
    await cache(at(OTHER, 'other-kit'), NAMES, 5000); // another kit's copy: never this kit's
    await cache(['f'.repeat(40)], NAMES, 6000); // the old place, <home>/kit/<sha>/: ignored
    expect(await syncKit(fakeGh({ resolveFails: true }).exec, TEAM)).toEqual({ sha: 'new', dir: newer, stale: true });

    // A listed file that is gone (renamed in the kit) falls back the same way, and leaves no partial copy.
    const renamed = fakeGh({ failPath: 'calibration.md' });
    expect(await syncKit(renamed.exec, TEAM)).toEqual({ sha: 'new', dir: newer, stale: true });
    expect(await readdir(kitCacheRoot(TEAM))).not.toContain(SHA);
  });

  it('with no cache it throws a sentence naming the kit and what went wrong', async () => {
    await cache(['f'.repeat(40)], NAMES, 6000); // a copy in the old place is not a cache
    await expect(syncKit(fakeGh({ resolveFails: true }).exec, TEAM))
      .rejects.toThrow('The review kit could not be fetched from acme/review-kit and none is cached: could not resolve host');
    await expect(syncKit(fakeGh({ failPath: 'calibration.md' }).exec, TEAM))
      .rejects.toThrow(/could not be fetched from acme\/review-kit and none is cached: skills\/review\/calibration\.md: HTTP 404/);
  });

  it('treats a malformed commit value as unresolved and deletes nothing', async () => {
    await mkdir(join(home, 'kit'), { recursive: true });
    await writeFile(join(home, 'sentinel.txt'), 'keep');
    for (const bad of ['..', '../x', 'abc', `${SHA}\nextra`]) {
      await expect(syncKit(fakeGh({ sha: bad }).exec, TEAM)).rejects.toThrow(/kit could not be fetched from acme\/review-kit/);
    }
    expect(await readFile(join(home, 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it('lets two syncs of the same commit run at once and both return the same folder', async () => {
    const gh = fakeGh();
    const [a, b] = await Promise.all([syncKit(gh.exec, TEAM), syncKit(gh.exec, TEAM)]);
    expect(a).toEqual({ sha: SHA, dir: join(kitCacheRoot(TEAM), SHA), stale: false });
    expect(b).toEqual(a);
    expect((await readdir(kitCacheRoot(TEAM))).sort()).toEqual([SHA]);
    expect((await readdir(a.dir)).sort()).toEqual(NAMES);
  });

  it('does not treat a half-finished download as cached', async () => {
    await expect(syncKit(fakeGh({ failPath: 'calibration.md' }).exec, TEAM)).rejects.toThrow(/HTTP 404/);
    const kitDir = kitCacheRoot(TEAM);
    expect((await readdir(kitDir)).filter((n) => n === SHA)).toEqual([]);
    // a leftover folder without every listed file is not a cache either
    await mkdir(join(kitDir, SHA), { recursive: true });
    await writeFile(join(kitDir, SHA, 'profile.md'), 'x');
    const ok = fakeGh();
    const result = await syncKit(ok.exec, TEAM);
    expect(result.stale).toBe(false);
    expect(ok.calls).toHaveLength(4);
    expect((await readdir(result.dir)).sort()).toEqual(NAMES);
    expect((await readdir(kitDir)).sort()).toEqual([SHA]);
  });

  it('only reads are made: every gh call is a GET of a commit or a file', async () => {
    const gh = fakeGh({ sha: (repo) => (repo === 'acme/ext-kit' ? 'b'.repeat(40) : SHA) });
    await syncKit(gh.exec, TEAM);
    await syncKit(gh.exec, OTHER, { ref: 'v2' });
    await syncKit(fakeGh({ resolveFails: true }).exec, TEAM); // the fallback makes no other call
    expect(gh.calls.length).toBeGreaterThan(0);
    for (const { cmd, args } of gh.calls) {
      expect(cmd).toBe('gh');
      expect(isGhRead(args)).toBe(true);
      const joined = args.join(' ');
      expect(joined).toMatch(new RegExp(
        '^api (repos/acme/(review|ext)-kit/commits/[\\w.-]+ --jq \\.sha'
        + '|-H Accept: application/vnd\\.github\\.raw repos/acme/(review|ext)-kit/contents/[\\w./-]+\\?ref=[0-9a-f]{40})$'));
      for (const write of ['--method', '-X', '-f', '-F', '--field', '--raw-field', '--input']) expect(args).not.toContain(write);
    }
  });

  it('refuses a kit that fails the manifest checks before running anything', async () => {
    const gh = fakeGh();
    await expect(syncKit(gh.exec, { ...TEAM, repo: 'acme' })).rejects.toThrow(/"acme" is not <owner>\/<name>/);
    await expect(syncKit(gh.exec, { ...TEAM, files: ['../secrets.md'] })).rejects.toThrow(/\.\./);
    await expect(syncKit(gh.exec, TEAM, { ref: '../x' })).rejects.toThrow(/ref/);
    expect(gh.calls).toEqual([]);
  });
});

describe('kitRefProblem', () => {
  const ok = (kit: Partial<KitRef>) => kitRefProblem({ ...TEAM, ...kit });
  it('accepts the team kit and a kit without dated standards', () => {
    expect(ok({})).toBeNull();
    expect(kitRefProblem(OTHER)).toBeNull();
    expect(ok({ ref: 'release/2026-11' })).toBeNull();
  });
  it.each([
    ['acme'], ['acme/'], ['/acme/kit'], ['acme/kit/extra'], ['acme/..'], ['acme/kit?x=1'], ['acme/ kit'], [''],
  ])('refuses the repository %j', (repo) => {
    expect(ok({ repo })).toMatch(/is not <owner>\/<name>/);
  });
  it.each([
    ['../a.md'], ['skills/../a.md'], ['skills/..'], ['/etc/passwd'], ['skills\\a.md'], ['skills/a\u0000.md'], ['skills/a\n.md'],
    ['skills//a.md'], ['./a.md'], ['skills/'], [''], ['a.md?ref=main'], ['a.md#x'], ['%2e%2e/a.md'],
  ])('refuses the file path %j', (path) => {
    expect(ok({ files: [path] })).toMatch(/file path/);
  });
  it('refuses no files, two files with the same name, a dated standard that is not listed, and a bad ref', () => {
    expect(ok({ files: [] })).toMatch(/at least one file/);
    expect(ok({ files: ['a/x.md', 'b/x.md'], datedStandards: [] })).toMatch(/"x\.md" twice/);
    expect(ok({ datedStandards: ['calibration.md'] })).toMatch(/dated standard "calibration\.md" is not one of the kit's files/);
    for (const ref of ['../main', 'a..b', '-x', 'main?x', 'a b', '/main', 'main/']) expect(ok({ ref })).toMatch(/ref/);
  });
});

describe('attachKit', () => {
  const adapter = (kit: KitRef): Pack => ({
    id: 'raj-standard', title: 't', version: 'local', dir: '/x', repos: [], appRoot: null, stageRules: [],
    tiers: { read: [], trust: [], ignore: [] }, siblings: [], linkRules: [], checks: [],
    standards: [], lenses: [], rules: [], learned: [], kit,
  });

  it("attaches the kit's files in the manifest's order, marks its dated standards, uses the commit as the version, and does not mutate the adapter", async () => {
    const { dir } = await syncKit(fakeGh().exec, TEAM);
    const before = adapter(TEAM);
    const snapshot = structuredClone(before);
    const pack = await attachKit(before, { sha: SHA, dir });
    expect(pack).not.toBe(before);
    expect(before).toEqual(snapshot);
    expect(pack.version).toBe(SHA);
    expect(pack.standards.map((s) => [s.name, s.dated])).toEqual([
      ['profile.md', false], ['orbit.md', false], ['calibration.md', true],
    ]);
    expect(pack.standards[1]!.text).toContain('orbit.md');
  });

  it('marks nothing dated when the manifest names no dated standard, and names the kit when a file is missing', async () => {
    const { dir } = await syncKit(fakeGh().exec, OTHER);
    const pack = await attachKit(adapter(OTHER), { sha: SHA, dir });
    expect(pack.standards.map((s) => [s.name, s.dated])).toEqual([['standard.md', false], ['calibration.md', false]]);
    await expect(attachKit(adapter(TEAM), { sha: SHA, dir }))
      .rejects.toThrow(/The review kit acme\/review-kit could not be read from .*: profile\.md/);
  });
});
