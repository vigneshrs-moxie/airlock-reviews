import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEvidence } from '../../src/challenge/proof.js';
import { kitCacheRoot } from '../../src/packs/kit-sync.js';
import { loadPack } from '../../src/packs/load.js';
import type { KitRef, Pack } from '../../src/packs/types.js';
import { preparePacks } from '../../src/pipeline/packs.js';
import type { Exec } from '../../src/util/exec.js';
import { KIT_DIR } from '../helpers/review-scenario.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const TEAM_REPO = 'Moxie-Pest-Control-Phoenix/moxie-review-kit';
const RAJ = fileURLToPath(new URL('../../../../packs/raj-standard/', import.meta.url));

let home: string;
let baseDir: string;
let saved: string | undefined;
beforeEach(async () => {
  saved = process.env.AIRLOCK_HOME;
  home = await mkdtemp(join(tmpdir(), 'airlock-kit-packs-'));
  baseDir = join(home, 'base');
  await mkdir(baseDir);
  process.env.AIRLOCK_HOME = home;
});
afterEach(async () => {
  if (saved === undefined) delete process.env.AIRLOCK_HOME; else process.env.AIRLOCK_HOME = saved;
  await rm(home, { recursive: true, force: true });
});

/**
 * gh answers a commit lookup with `shas[repo]` (a failure when the repository is not listed) and a file with the text of
 * the fixture kit's file of that name, or `files[name]`. git grep finds every helper but `legacyDateHelper`; git ls-files
 * lists nothing.
 */
function fakeExec(shas: Record<string, string>, files: Record<string, string> = {}): Exec & { gh: string[][] } {
  const gh: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'grep') return { stdout: '', stderr: '', code: args.includes('legacyDateHelper') ? 1 : 0 };
    if (cmd === 'git') return { stdout: '', stderr: '', code: 0 };
    gh.push(args);
    const commit = /^repos\/([^/]+\/[^/]+)\/commits\//.exec(args[1] ?? '');
    if (commit) {
      const sha = shas[commit[1]!];
      return sha === undefined ? { stdout: '', stderr: 'HTTP 404: Not Found', code: 1 } : { stdout: `${sha}\n`, stderr: '', code: 0 };
    }
    const name = basename(args.at(-1)!.replace(/\?ref=.*$/, ''));
    const text = files[name] ?? await readFile(join(KIT_DIR, name), 'utf8').catch(() => null);
    return text === null ? { stdout: '', stderr: 'HTTP 404: Not Found', code: 1 } : { stdout: text, stderr: '', code: 0 };
  };
  return Object.assign(exec, { gh });
}

function kitPack(id: string, kit: KitRef | undefined): Pack {
  return {
    id, title: id.toUpperCase(), version: 'local', dir: `/packs/${id}`, repos: ['acme/app'], appRoot: null, stageRules: [],
    tiers: { read: [], trust: [], ignore: [] }, siblings: [], linkRules: [], checks: [],
    standards: [], lenses: [], rules: [], learned: [], ...(kit === undefined ? {} : { kit }),
  };
}
const EXT: KitRef = { repo: 'acme/ext-kit', files: ['skills/ext/decisions.md', 'skills/ext/standard.md'], datedStandards: ['skills/ext/decisions.md'] };

const prepare = (packs: Pack[], exec: Exec, more: Partial<Parameters<typeof preparePacks>[1]> = {}) =>
  preparePacks(packs, { exec, baseDir, changedPaths: [], ...more });
const shape = (p: Pack) => p.standards.map((s) => [s.name, s.dated]);

describe('a pack names its kit', () => {
  it("raj-standard attaches the same three standards as before, now from its manifest's kit", async () => {
    const raj = await loadPack(RAJ);
    expect(raj.kit).toEqual({
      repo: TEAM_REPO,
      files: ['skills/moxie-review/profile.md', 'skills/moxie-review/orbit.md', 'skills/moxie-review/calibration.md'],
      datedStandards: ['skills/moxie-review/calibration.md'],
    });
    expect(raj.standards).toEqual([]);

    const exec = fakeExec({ [TEAM_REPO]: SHA });
    const ready = await prepare([raj], exec, { holdout: { pr: 7, reviewedAt: '2026-06-01T00:00:00Z' } });
    expect(ready.errors).toEqual([]);
    expect(ready.questions).toEqual([]);
    const [pack] = ready.packs;
    expect(pack!.version).toBe(SHA);
    expect(shape(pack!)).toEqual([['profile.md', false], ['orbit.md', false], ['calibration.md', true]]);
    // the hold-out drops the dated entries from the day of the review on, as before
    const calibration = pack!.standards[2]!.text;
    expect(calibration).toContain('CAL_EARLY_MARKER');
    expect(calibration).not.toContain('CAL_LATE_MARKER');
    // the helper check reads orbit.md, as before
    expect(ready.missingHelpers).toEqual(['legacyDateHelper']);
    // fetched from the manifest's repository, three files at one commit, cached under the repository
    expect(exec.gh.map((a) => a.at(-1))).toEqual([
      '.sha', ...raj.kit!.files.map((f) => `repos/${TEAM_REPO}/contents/${f}?ref=${SHA}`),
    ]);
    expect((await readdir(join(kitCacheRoot(raj.kit!), SHA))).sort())
      .toEqual(['calibration.md', 'orbit.md', 'profile.md']);
  });

  it('a pack without a kit is left as it is, and nothing is fetched for it', async () => {
    const plain = kitPack('plain', undefined);
    const exec = fakeExec({});
    const ready = await prepare([plain], exec);
    expect(ready.packs).toEqual([plain]);
    expect(exec.gh).toEqual([]);
  });

  it("the replay's kitDir and kitSha stand in for raj-standard's kit when it is the team review kit, and every other kit pack is synced", async () => {
    const teamKit = { files: ['k/profile.md', 'k/orbit.md', 'k/calibration.md'], datedStandards: ['k/calibration.md'] };
    // in any letter case, and after another kit pack in the selection
    const team = kitPack('raj-standard', { repo: 'moxie-pest-control-phoenix/Moxie-Review-Kit', ...teamKit });
    const ext = kitPack('ext', EXT);
    const exec = fakeExec({ 'acme/ext-kit': OTHER_SHA }, { 'decisions.md': 'Decisions.', 'standard.md': 'Standard.' });
    const ready = await prepare([kitPack('plain', undefined), ext, team], exec, { kitDir: KIT_DIR, kitSha: 'c'.repeat(40) });
    expect(ready.errors).toEqual([]);
    expect(ready.packs.map((p) => [p.id, p.version])).toEqual([['plain', 'local'], ['ext', OTHER_SHA], ['raj-standard', 'c'.repeat(40)]]);
    expect(shape(ready.packs[2]!)).toEqual([['profile.md', false], ['orbit.md', false], ['calibration.md', true]]);
    expect(ready.packs[2]!.standards[2]!.text).toContain('CAL_EARLY_MARKER');
    expect(shape(ready.packs[1]!)).toEqual([['decisions.md', true], ['standard.md', false]]);
    expect(exec.gh.length).toBeGreaterThan(0);
    expect(exec.gh.every((a) => a.some((x) => x.startsWith('repos/acme/ext-kit/')))).toBe(true);

    // with no team kit pack selected, the folder is given to no pack: the other kit is synced
    const alone = fakeExec({ 'acme/ext-kit': OTHER_SHA }, { 'decisions.md': 'Decisions.', 'standard.md': 'Standard.' });
    const extOnly = await prepare([ext], alone, { kitDir: KIT_DIR, kitSha: 'c'.repeat(40) });
    expect(extOnly.packs.map((p) => p.version)).toEqual([OTHER_SHA]);
    // another pack naming the team kit's repository is synced normally: the folder goes to raj-standard only
    const second = kitPack('second', { repo: TEAM_REPO, ...teamKit });
    const both = fakeExec({ [TEAM_REPO]: SHA });
    const two = await prepare([second, team], both, { kitDir: KIT_DIR, kitSha: 'c'.repeat(40) });
    expect(two.packs.map((p) => [p.id, p.version])).toEqual([['second', SHA], ['raj-standard', 'c'.repeat(40)]]);
    expect(both.gh[0]).toEqual(['api', `repos/${TEAM_REPO}/commits/main`, '--jq', '.sha']);
    // and a kit pack naming another repository with the team kit's file names is not given it either
    const lookalike = kitPack('lookalike', { repo: 'acme/review-kit', ...teamKit });
    await expect(prepare([lookalike], fakeExec({}), { kitDir: KIT_DIR })).rejects.toThrow(/could not be fetched from acme\/review-kit/);
  });

  it('when the kit cannot be fetched the newest cached copy is used and the review is told it is stale', async () => {
    const cached = join(kitCacheRoot(EXT), OTHER_SHA);
    await mkdir(cached, { recursive: true });
    for (const name of ['decisions.md', 'standard.md']) await writeFile(join(cached, name), `cached ${name}`);
    await utimes(cached, new Date('2026-03-04T12:00:00Z'), new Date('2026-03-04T12:00:00Z'));
    const ready = await prepare([kitPack('ext', EXT)], fakeExec({}));
    expect(ready.packs[0]!.version).toBe(OTHER_SHA);
    expect(ready.packs[0]!.standards[1]!.text).toBe('cached standard.md');
    expect(ready.questions.map((q) => q.text)).toEqual(['The review kit acme/ext-kit could not be refreshed; the copy from 2026-03-04 was used.']);
    expect(ready.errors).toEqual([]);
  });

  it('with no cache preparing the packs fails with a sentence naming the kit', async () => {
    await expect(prepare([kitPack('plain', undefined), kitPack('ext', EXT)], fakeExec({})))
      .rejects.toThrow('The review kit could not be fetched from acme/ext-kit and none is cached: HTTP 404: Not Found');
    // a kit folder given for the team kit's pack that lacks one of its files is named too
    const team = kitPack('raj-standard', { repo: TEAM_REPO, files: ['k/profile.md', 'k/decisions.md'] });
    await expect(prepare([team], fakeExec({}), { kitDir: KIT_DIR }))
      .rejects.toThrow(/The review kit Moxie-Pest-Control-Phoenix\/moxie-review-kit could not be read from .*decisions\.md/);
  });

  it('a dated standard named by the manifest counts as recorded decisions for the challenger', async () => {
    const decision = 'Refunds are always made by hand, never by the nightly job, on purpose.';
    const exec = fakeExec({ 'acme/ext-kit': OTHER_SHA }, {
      'decisions.md': `# Decisions\n\n2026-10-01 · ${decision}\n`,
      'standard.md': '# Standard\n\n2026-10-02 · An undated standard line that only looks like an entry.\n',
    });
    const { packs } = await prepare([kitPack('ext', EXT)], exec);
    const records = createEvidence(async () => null, [], packs).records.filter((r) => r.role === 'standard');
    expect(records.map((r) => [r.text, r.path])).toEqual([[decision, 'EXT: decisions.md#2026-10-01']]);

    const undated = await prepare([kitPack('ext', { ...EXT, datedStandards: [] })], exec);
    expect(createEvidence(async () => null, [], undated.packs).records).toEqual([]);
  });
});
