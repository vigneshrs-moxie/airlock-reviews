import type { Fact, FileDiff } from '@airlock/shared';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CODE_CHECK_IDS, gatherChecks, runChecks } from '../../src/facts/checks.js';
import { classifyFiles } from '../../src/facts/classify.js';
import { EXTENSION_CHECKS, FOLLOW_BUDGET } from '../../src/facts/extension-checks.js';
import { loadPack } from '../../src/packs/load.js';
import type { Pack } from '../../src/packs/types.js';

const ALL = Object.keys(EXTENSION_CHECKS);

/** A pack that names the given code checks (all of the extension checks by default) and nothing else. */
const pack = (codeChecks: string[] = ALL): Pack => ({
  id: 'extensions', title: 'Extensions', version: '1', dir: '/x', repos: [], appRoot: null, stageRules: [],
  tiers: { read: [], trust: [], ignore: [] }, siblings: [], linkRules: [], checks: [],
  standards: [], lenses: [], rules: [], learned: [], codeChecks,
});

/**
 * A changed file whose head text is `head`: every line is added when the file is added, otherwise only the lines whose
 * numbers are in `added` (1-based), the rest left as context.
 */
function changed(path: string, head: string, status: FileDiff['status'] = 'modified', added: number[] = []): FileDiff {
  const lines = head.split('\n');
  const isAdded = (n: number): boolean => status === 'added' || added.includes(n);
  return {
    path, oldPath: null, status, binary: false, additions: lines.filter((_, i) => isAdded(i + 1)).length, deletions: 0,
    hunks: [{
      oldStart: 1, oldLines: 0, newStart: 1, newLines: lines.length, header: '',
      lines: lines.map((text, i) => (isAdded(i + 1)
        ? { kind: 'add' as const, oldNo: null, newNo: i + 1, text }
        : { kind: 'ctx' as const, oldNo: i + 1, newNo: i + 1, text })),
    }],
  };
}

/** A changed file's text at the head, from its diff, as the head worktree would hold it (null when it is not changed or deleted). */
function textOf(files: FileDiff[], path: string): string | null {
  const f = files.find((x) => x.path === path && x.status !== 'deleted');
  return f ? f.hunks.flatMap((h) => h.lines.filter((l) => l.newNo !== null).map((l) => l.text)).join('\n') : null;
}

interface Tree { head?: Record<string, string>; base?: Record<string, string>; sizes?: Record<string, number> }
async function run(files: FileDiff[], tree: Tree = {}, codeChecks: string[] = ALL): Promise<Fact[]> {
  return runChecks(files, [pack(codeChecks)], async (p) => tree.head?.[p] ?? textOf(files, p), {
    readBase: async (p) => tree.base?.[p] ?? null,
    sizeOfHead: async (p) => tree.sizes?.[p] ?? (tree.head?.[p] !== undefined ? Buffer.byteLength(tree.head[p]!) : null),
  });
}
const only = (facts: Fact[], checkId: string): Fact[] => facts.filter((f) => f.checkId === checkId);
/**
 * The processor time `work` takes in this test process, in milliseconds. Each test file runs in its own process, so this
 * is the checks' own work, not the wall clock, which other test files running at the same time on a busy machine stretch.
 */
async function cpuTimed<T>(work: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = process.cpuUsage();
  const value = await work();
  const used = process.cpuUsage(start);
  return { ms: (used.user + used.system) / 1000, value };
}
const manifest = (o: Record<string, unknown>): string => JSON.stringify({ manifest_version: 3, name: 'Tool', ...o }, null, 2);

describe('the extension code checks', () => {
  it('are each a known code check a pack can name', () => {
    expect([...ALL].sort()).toEqual([
      'extension-broad-hosts', 'extension-html-injection', 'extension-large-files', 'extension-loaded-files',
      'extension-permissions', 'extension-remote-code', 'extension-version-changelog',
    ]);
    for (const id of ALL) expect(CODE_CHECK_IDS).toContain(id);
  });

  it('reports a host permission added to the manifest, with the old and new lists', async () => {
    const before = manifest({ version: '1.0.0', permissions: ['storage'], host_permissions: ['https://*.pestroutes.com/*'] });
    const after = manifest({
      version: '1.0.0', permissions: ['storage'],
      host_permissions: ['https://*.pestroutes.com/*', 'https://script.google.com/*'],
    });
    const facts = only(await run([changed('manifest.json', after, 'modified', [8])], {
      head: { 'manifest.json': after }, base: { 'manifest.json': before },
    }), 'extension-permissions');
    expect(facts).toEqual([{
      checkId: 'extension-permissions', path: 'manifest.json', line: null,
      message: 'host_permissions before: https://*.pestroutes.com/*; after: https://*.pestroutes.com/*, https://script.google.com/*; added: https://script.google.com/*.',
    }]);
  });

  it('reports permissions added and removed, and the whole list of a new manifest', async () => {
    const before = manifest({ permissions: ['storage', 'tabs'] });
    const after = manifest({ permissions: ['storage', 'scripting'] });
    expect(only(await run([changed('manifest.json', after)], { head: { 'manifest.json': after }, base: { 'manifest.json': before } }),
      'extension-permissions').map((f) => f.message)).toEqual([
      'permissions before: storage, tabs; after: storage, scripting; added: scripting; removed: tabs.',
    ]);

    const fresh = manifest({ permissions: ['storage'], content_scripts: [{ matches: ['https://*.pestroutes.com/*'], js: ['content.js'] }] });
    expect(only(await run([changed('manifest.json', fresh, 'added')], { head: { 'manifest.json': fresh } }),
      'extension-permissions').map((f) => f.message)).toEqual([
      'permissions before: none (the manifest is new); after: storage; added: storage.',
      'content_scripts matches before: none (the manifest is new); after: https://*.pestroutes.com/*; added: https://*.pestroutes.com/*.',
    ]);

    // the same lists in another order are no change
    const same = manifest({ permissions: ['tabs', 'storage'] });
    expect(only(await run([changed('manifest.json', same)], { head: { 'manifest.json': same }, base: { 'manifest.json': before } }),
      'extension-permissions')).toEqual([]);
  });

  it('reports all_urls and a bare scheme wildcard', async () => {
    const before = manifest({ host_permissions: ['*://*/*'] });
    const after = manifest({
      host_permissions: ['<all_urls>', '*://*/*', 'https://*/*', 'https://*.pestroutes.com/*', 'file:///*'],
      content_scripts: [{ matches: ['http://*/*'], js: ['content.js'] }],
    });
    const facts = only(await run([changed('manifest.json', after)], {
      head: { 'manifest.json': after }, base: { 'manifest.json': before },
    }), 'extension-broad-hosts');
    const lineOf = (s: string): number => after.split('\n').findIndex((l) => l.includes(JSON.stringify(s))) + 1;
    expect(facts).toEqual([
      { checkId: 'extension-broad-hosts', path: 'manifest.json', line: lineOf('<all_urls>'), message: 'host_permissions asks for "<all_urls>", every site (added in this pull request).' },
      { checkId: 'extension-broad-hosts', path: 'manifest.json', line: lineOf('*://*/*'), message: 'host_permissions asks for "*://*/*", every site (already there before).' },
      { checkId: 'extension-broad-hosts', path: 'manifest.json', line: lineOf('https://*/*'), message: 'host_permissions asks for "https://*/*", every site (added in this pull request).' },
      { checkId: 'extension-broad-hosts', path: 'manifest.json', line: lineOf('file:///*'), message: 'host_permissions asks for "file:///*", every file on the computer (added in this pull request).' },
      { checkId: 'extension-broad-hosts', path: 'manifest.json', line: lineOf('http://*/*'), message: 'content_scripts matches asks for "http://*/*", every site (added in this pull request).' },
    ].sort((a, b) => a.line - b.line));
  });

  it('reports a version change without a changelog change, and a changelog change without a version change', async () => {
    const v1 = manifest({ version: '1.2.0' });
    const v2 = manifest({ version: '1.3.0' });
    const bumped = await run([changed('manifest.json', v2)], { head: { 'manifest.json': v2 }, base: { 'manifest.json': v1 } });
    expect(only(bumped, 'extension-version-changelog')).toEqual([{
      checkId: 'extension-version-changelog', path: 'manifest.json', line: null,
      message: 'The version changed from 1.2.0 to 1.3.0 and CHANGELOG.md beside it did not change.',
    }]);

    // both changed: nothing to say
    const log = '# Changelog\n\n## 1.3.0\n- Faster scan.\n';
    expect(only(await run([changed('manifest.json', v2), changed('CHANGELOG.md', log)], {
      head: { 'manifest.json': v2, 'CHANGELOG.md': log }, base: { 'manifest.json': v1 },
    }), 'extension-version-changelog')).toEqual([]);

    // the changelog changed and the manifest did not
    const reverse = await run([changed('CHANGELOG.md', log)], { head: { 'manifest.json': v1, 'CHANGELOG.md': log }, base: { 'manifest.json': v1 } });
    expect(only(reverse, 'extension-version-changelog')).toEqual([{
      checkId: 'extension-version-changelog', path: 'CHANGELOG.md', line: null,
      message: 'CHANGELOG.md changed and the version in manifest.json beside it is still 1.2.0.',
    }]);

    // the manifest changed, the version did not, and the changelog changed
    const touched = manifest({ version: '1.2.0', permissions: ['storage'] });
    expect(only(await run([changed('manifest.json', touched), changed('CHANGELOG.md', log)], {
      head: { 'manifest.json': touched, 'CHANGELOG.md': log }, base: { 'manifest.json': v1 },
    }), 'extension-version-changelog').map((f) => f.path)).toEqual(['CHANGELOG.md']);

    // a version that went down is said
    expect(only(await run([changed('manifest.json', v1)], { head: { 'manifest.json': v1 }, base: { 'manifest.json': v2 } }),
      'extension-version-changelog').map((f) => f.message)).toEqual([
      'The version changed from 1.3.0 to 1.2.0, which is not higher, and CHANGELOG.md beside it did not change.',
    ]);

    // a changelog with no manifest beside it says nothing
    expect(only(await run([changed('docs/CHANGELOG.md', log)], { head: { 'docs/CHANGELOG.md': log } }), 'extension-version-changelog')).toEqual([]);
  });

  it('reports eval, new Function and a non-https address, and not the same words inside a comment or a test file', async () => {
    const code = [
      'const run = (s) => eval(s);', // 1
      'const make = new Function("a", "return a");', // 2
      'fetch("http://example.com/api");', // 3
      '// eval(x) and new Function() and http://old.example.com in a comment', // 4
      '/* eval(y)', // 5
      '   fetch("http://inside.example.com") */', // 6
      'const ok = "https://script.google.com/macros/s/abc/exec";', // 7
      'const label = "do not eval( this";', // 8
      'const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");', // 9
      'const ws = new WebSocket("ws://example.com/feed"); // eval(z)', // 10
      'retrieval(x);', // 11
    ].join('\n');
    const test = 'eval("1"); fetch("http://localhost/test");';
    const html = '<!-- <script src="http://old.example.com/a.js"></script> -->\n<script src="http://cdn.example.com/lib.js"></script>\n<script src="popup.js"></script>';
    const facts = only(await run([
      changed('background.js', code, 'added'), changed('tests/background.test.js', test, 'added'),
      changed('tests/helper.js', test, 'added'), changed('popup.html', html, 'added'),
    ], { head: { 'manifest.json': manifest({}), 'background.js': code, 'tests/background.test.js': test, 'tests/helper.js': test, 'popup.html': html } }), 'extension-remote-code');
    expect(facts.map((f) => `${f.path}:${f.line} ${f.message}`)).toEqual([
      'background.js:1 An added line runs text as code with eval.',
      'background.js:2 An added line builds a function from text with new Function.',
      'background.js:3 An added line has the address http://example.com/api, which is not https.',
      'background.js:10 An added line has the address ws://example.com/feed, which is not wss.',
      'popup.html:2 An added line loads a script from http://cdn.example.com/lib.js, which is not https.',
    ]);
  });

  it('looks only at added lines', async () => {
    const code = 'const run = (s) => eval(s);\nconst x = 1;';
    expect(only(await run([changed('content.js', code, 'modified', [2])], { head: { 'content.js': code } }), 'extension-remote-code')).toEqual([]);
  });

  it('reports innerHTML given a variable and not innerHTML given a literal', async () => {
    const code = [
      'row.innerHTML = "<td>" + customer.name + "</td>";', // 1
      'cell.innerHTML = customer.name;', // 2
      'box.innerHTML = "";', // 3
      "box.innerHTML = '<b>Loading</b>';", // 4
      'box.innerHTML = `<p>${note}</p>`;', // 5
      'box.innerHTML = `<p>fixed</p>`;', // 6
      'panel.outerHTML = html;', // 7
      'list.insertAdjacentHTML("beforeend", item);', // 8
      "list.insertAdjacentHTML('beforeend', '<li>none</li>');", // 9
      'box.innerHTML += more;', // 10
      '// box.innerHTML = notInCode;', // 11
      'if (box.innerHTML === "") start();', // 12
      'box.innerHTML = "<b>"', // 13
      '  + title;', // 14
    ].join('\n');
    const facts = only(await run([changed('popup.js', code, 'added')], { head: { 'popup.js': code } }), 'extension-html-injection');
    expect(facts.map((f) => `${f.line} ${f.message}`)).toEqual([
      '1 An added line gives innerHTML something other than fixed text.',
      '2 An added line gives innerHTML something other than fixed text.',
      '5 An added line gives innerHTML something other than fixed text.',
      '7 An added line gives outerHTML something other than fixed text.',
      '8 An added line gives insertAdjacentHTML something other than fixed text.',
      '10 An added line gives innerHTML something other than fixed text.',
      '13 An added line gives innerHTML something other than fixed text.',
    ]);
    // the same lines in a test file are not reported
    expect(only(await run([changed('tests/popup.test.js', code, 'added')], { head: { 'manifest.json': manifest({}), 'tests/popup.test.js': code } }),
      'extension-html-injection')).toEqual([]);
  });

  it('a manifest that is not valid JSON is a fact saying so, not a crash', async () => {
    const broken = '{ "manifest_version": 3, "version": "1.0.0", }';
    const facts = await run([changed('manifest.json', broken)], {
      head: { 'manifest.json': broken }, base: { 'manifest.json': manifest({ version: '1.0.0' }) },
    });
    expect(facts.map((f) => f.checkId)).toEqual(['extension-manifest-json']);
    expect(facts[0]).toMatchObject({ path: 'manifest.json', line: null });
    expect(facts[0]!.message).toBe('manifest.json could not be read as JSON, so its permissions and version were not compared and so no file could be trusted as a test.');

    // an unreadable base manifest is said, and the head's lists are given in full
    const good = manifest({ version: '1.0.1', permissions: ['storage'] });
    const fromBroken = await run([changed('manifest.json', good)], { head: { 'manifest.json': good }, base: { 'manifest.json': broken } });
    expect(fromBroken.map((f) => f.checkId)).toEqual(['extension-manifest-json', 'extension-permissions']);
    expect(fromBroken[0]!.message).toBe('manifest.json could not be read as JSON before this pull request, so what it held before is not known.');
    expect(fromBroken[1]!.message).toBe('permissions before: not known (the manifest could not be read before this pull request); after: storage.');
  });

  it('reports a file over 500 kB and an archive added to the repository', async () => {
    const facts = only(await run([
      changed('vendor/big.js', 'x', 'added'), changed('build.zip', '', 'added'), changed('release.crx', '', 'modified'),
      changed('content.js', 'ok', 'modified'), { ...changed('old.zip', '', 'deleted') },
    ], { sizes: { 'vendor/big.js': 812_345, 'build.zip': 40_000, 'release.crx': 600_000, 'content.js': 2_000 } }), 'extension-large-files');
    expect(facts.map((f) => `${f.path} ${f.message}`)).toEqual([
      'build.zip An archive (.zip) is added to the repository.',
      'release.crx release.crx is 600 kB, over the 500 kB a file should stay under.',
      'vendor/big.js vendor/big.js is 812 kB, over the 500 kB a file should stay under.',
    ]);
  });

  it('never reads a symbolic link and never runs anything: only the given readers are used', async () => {
    const reads: string[] = [];
    const link = { ...changed('manifest.json', 'target.json', 'added'), mode: '120000' };
    const facts = await runChecks([link], [pack()], async (p) => { reads.push(`head ${p}`); return null; }, {
      readBase: async (p) => { reads.push(`base ${p}`); return null; },
      sizeOfHead: async (p) => { reads.push(`size ${p}`); return null; },
    });
    expect(facts).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('a pack runs only the code checks it names, and each once', async () => {
    const code = 'el.innerHTML = name;\neval(s);';
    const files = [changed('content.js', code, 'added')];
    const tree = { head: { 'content.js': code } };
    expect((await run(files, tree, ['extension-html-injection'])).map((f) => f.checkId)).toEqual(['extension-html-injection']);
    expect(await run(files, tree, [])).toEqual([]);
    const twice = await runChecks(files, [pack(['extension-remote-code']), { ...pack(['extension-remote-code']), id: 'other' }],
      async (p) => tree.head[p as 'content.js'] ?? null);
    expect(twice.map((f) => f.checkId)).toEqual(['extension-remote-code']);
  });
});

describe('the Orbit checks with the code-check hook', () => {
  const orbitDir = fileURLToPath(new URL('../../../../packs/orbit-mine/', import.meta.url));

  it('orbit-mine names no code check, and a change that trips every extension check gives it only its own facts, as before', async () => {
    const orbit = await loadPack(orbitDir);
    expect(orbit.codeChecks).toBeUndefined();
    const before = manifest({ version: '1.0.0', host_permissions: ['https://a.example.com/*'] });
    const after = manifest({ version: '1.1.0', host_permissions: ['<all_urls>'] });
    const code = 'el.innerHTML = name;\neval(s);\nfetch("http://x.example.com");\nawait db.$queryRawUnsafe(sql);';
    const files = [
      changed('manifest.json', after), changed('app/src/lib/report.ts', code, 'added'), changed('build.zip', '', 'added'),
      changed('app/prisma/migrations/0160_x/migration.sql', 'CREATE TABLE "x" ();', 'added'),
    ];
    const tree = { head: { 'manifest.json': after, 'app/src/lib/report.ts': code }, base: { 'manifest.json': before } };
    const withHook = await runChecks(files, [orbit], async (p) => tree.head[p as keyof typeof tree.head] ?? null, {
      readBase: async (p) => tree.base[p as keyof typeof tree.base] ?? null, sizeOfHead: async () => 900_000,
    });
    const asBefore = await runChecks(files, [orbit], async (p) => tree.head[p as keyof typeof tree.head] ?? null);
    expect(withHook).toEqual(asBefore);
    expect(withHook.map((f) => `${f.checkId} ${f.path}${f.line === null ? '' : `:${f.line}`}`)).toEqual([
      'migration-without-schema app/prisma/migrations/0160_x/migration.sql',
      'raw-unsafe app/src/lib/report.ts:4',
    ]);
  });
});

describe('files the extension loads', () => {
  const read = (tree: Tree, files: FileDiff[]) => async (p: string): Promise<string | null> => tree.head?.[p] ?? textOf(files, p);
  const gather = (files: FileDiff[], tree: Tree, codeChecks: string[] = ALL) => gatherChecks(files, [pack(codeChecks)], read(tree, files), {
    readBase: async (p) => tree.base?.[p] ?? null, sizeOfHead: async () => null,
  });

  it('names every file the head manifest loads, whatever its path, for the read tier, and says when one sits with the tests', async () => {
    const head = manifest({
      background: { service_worker: 'inject.spec.js' },
      content_scripts: [{ matches: ['https://a.example.com/*'], js: ['fixtures/inject.js'], css: ['./styles/page.css'] }],
      web_accessible_resources: [{ resources: ['pages/*.html'], matches: ['https://a.example.com/*'] }],
      action: { default_popup: 'popup/popup.html' },
      options_ui: { page: 'options/options.html' },
      side_panel: { default_path: 'panel/panel.html' },
      devtools_page: 'tools/devtools.html',
      chrome_url_overrides: { newtab: 'tab/new.html' },
      sandbox: { pages: ['sandbox/box.html'] },
    });
    const files = [
      'fixtures/inject.js', 'inject.spec.js', 'styles/page.css', 'pages/a.html', 'pages/deep/b.html', 'popup/popup.html',
      'options/options.html', 'panel/panel.html', 'tools/devtools.html', 'tab/new.html', 'sandbox/box.html',
      'lib/test/sender.js', 'tests/real.test.js',
    ].map((p) => changed(p, 'x;', 'modified'));
    const { facts, readClosely } = await gather(files, { head: { 'manifest.json': head } });
    // a star in a manifest entry crosses folders, as it does in Chrome
    expect(readClosely.map((r) => r.path).sort()).toEqual([
      'fixtures/inject.js', 'inject.spec.js', 'options/options.html', 'pages/a.html', 'pages/deep/b.html', 'panel/panel.html', 'popup/popup.html',
      'sandbox/box.html', 'styles/page.css', 'tab/new.html', 'tools/devtools.html',
    ]);
    expect(readClosely[0]).toEqual({ path: expect.any(String), packId: 'extensions', reason: 'loaded by manifest.json' });
    expect(only(facts, 'extension-loaded-files').map((f) => `${f.path} ${f.message}`)).toEqual([
      'fixtures/inject.js fixtures/inject.js sits under a test or fixture folder but the extension loads it.',
      'inject.spec.js inject.spec.js is named like a test but the extension loads it.',
    ]);
  });

  it('reads the older manifest shapes, and only the top-level manifest', async () => {
    const top = manifest({
      manifest_version: 2, background: { scripts: ['bg.js'], page: 'bg.html' }, browser_action: { default_popup: 'pop.html' },
      page_action: { default_popup: 'page.html' }, options_page: 'opts.html', web_accessible_resources: ['img/*.svg', 'tests/hook.js'],
    });
    const inner = manifest({ version: '1.0.0', permissions: ['tabs'], host_permissions: ['<all_urls>'], background: { service_worker: 'worker.js' } });
    const files = ['bg.js', 'bg.html', 'pop.html', 'page.html', 'opts.html', 'img/a.svg', 'tests/hook.js', 'route/worker.js', 'worker.js']
      .map((p) => changed(p, 'x;'));
    files.push(changed('route/manifest.json', inner, 'added'), changed('fixtures/manifest.json', inner, 'added'));
    const { facts, readClosely } = await gather(files, {
      head: { 'manifest.json': top, 'route/manifest.json': inner, 'fixtures/manifest.json': inner },
    });
    // a manifest anywhere but the top gives no facts and loads nothing
    expect(facts.filter((f) => f.path !== 'manifest.json' && f.path.endsWith('manifest.json'))).toEqual([]);
    expect(readClosely.map((r) => `${r.path} ${r.reason}`).sort()).toEqual([
      'bg.html loaded by manifest.json', 'bg.js loaded by manifest.json', 'img/a.svg loaded by manifest.json',
      'opts.html loaded by manifest.json', 'page.html loaded by manifest.json', 'pop.html loaded by manifest.json',
      'tests/hook.js loaded by manifest.json',
    ]);
    expect(only(facts, 'extension-loaded-files').map((f) => f.path)).toEqual(['tests/hook.js']);
  });

  it('a file under tests/ that the manifest loads is scanned like any other, and one it does not load is not', async () => {
    const head = manifest({ content_scripts: [{ matches: ['https://a.example.com/*'], js: ['tests/inject.js'] }] });
    const code = 'el.innerHTML = name;';
    const files = [changed('tests/inject.js', code, 'added'), changed('tests/other.js', code, 'added')];
    const { facts } = await gather(files, { head: { 'manifest.json': head, 'tests/inject.js': code, 'tests/other.js': code } });
    expect(only(facts, 'extension-html-injection').map((f) => f.path)).toEqual(['tests/inject.js']);
  });

  it('says when a source file loads code from a test or fixture path', async () => {
    const code = [
      "import { rows } from './fixtures/rows.js';", // 1
      "importScripts('tests/helpers.js', 'util.js');", // 2
      "chrome.scripting.executeScript({ target: { tabId }, files: ['test/inject.js'] });", // 3
      "import { ok } from './lib/ok.js';", // 4
      "// importScripts('tests/commented.js');", // 5
      "import x from 'some-package';", // 6
    ].join('\n');
    const facts = only((await gather([changed('src/background.js', code, 'added')], { head: { 'src/background.js': code } })).facts,
      'extension-loaded-files');
    expect(facts.map((f) => `${f.line} ${f.message}`)).toEqual([
      '1 An added line loads src/fixtures/rows.js, which sits under a test or fixture folder.',
      '2 An added line loads src/tests/helpers.js, which sits under a test or fixture folder.',
      '3 An added line loads test/inject.js, which sits under a test or fixture folder.',
    ]);
    // a test file loading its fixtures is not reported
    expect(only((await gather([changed('tests/a.test.js', code, 'added')], { head: { 'manifest.json': manifest({}), 'tests/a.test.js': code } })).facts,
      'extension-loaded-files')).toEqual([]);
  });

  it('skips files the classifier ignores, unless the manifest loads them', async () => {
    const code = 'eval(s);';
    const files = ['vendor/lib.min.js', 'dist/bundle.js', 'loaded.min.js'].map((p) => changed(p, code, 'added'));
    const head = manifest({ background: { service_worker: 'loaded.min.js' } });
    const { facts } = await gather(files, { head: { 'manifest.json': head, 'vendor/lib.min.js': code, 'dist/bundle.js': code, 'loaded.min.js': code } });
    expect(only(facts, 'extension-remote-code').map((f) => f.path)).toEqual(['loaded.min.js']);
  });
});

describe('manifest edge cases', () => {
  it('a modified manifest whose base cannot be read is unknown before, not new', async () => {
    const after = manifest({ version: '1.1.0', permissions: ['storage'], host_permissions: ['<all_urls>'] });
    const facts = await run([changed('manifest.json', after)], { head: { 'manifest.json': after } });
    expect(facts.map((f) => `${f.checkId} ${f.message}`)).toEqual([
      'extension-permissions permissions before: not known (the manifest could not be read before this pull request); after: storage.',
      'extension-permissions host_permissions before: not known (the manifest could not be read before this pull request); after: <all_urls>.',
      'extension-broad-hosts host_permissions asks for "<all_urls>", every site (not known whether it was there before).',
    ]);
  });

  it('comments in the manifest are read past', async () => {
    const before = '{\n  // the first version\n  "manifest_version": 3, "version": "1.0.0", "permissions": ["storage"]\n}';
    const after = '{\n  /* now with tabs */\n  "manifest_version": 3, "version": "1.0.0", "permissions": ["storage", "tabs"] // tabs for the switcher\n}';
    expect((await run([changed('manifest.json', after)], { head: { 'manifest.json': after }, base: { 'manifest.json': before } }))
      .map((f) => f.message)).toEqual(['permissions before: storage; after: storage, tabs; added: tabs.']);
  });

  it('a deleted changelog is not a changed one, and a file renamed to an archive is reported', async () => {
    const v1 = manifest({ version: '1.0.0' });
    const v2 = manifest({ version: '1.0.1' });
    const facts = await run([changed('manifest.json', v2), changed('CHANGELOG.md', '', 'deleted')], {
      head: { 'manifest.json': v2 }, base: { 'manifest.json': v1 },
    });
    expect(only(facts, 'extension-version-changelog').map((f) => f.path)).toEqual(['manifest.json']);
    const renamed = { ...changed('build.zip', ''), status: 'renamed' as const, oldPath: 'build.txt' };
    expect(only(await run([renamed]), 'extension-large-files').map((f) => f.message)).toEqual(['An archive (.zip) is added to the repository.']);
  });
});

describe('matching what the manifest names', () => {
  const gather = (files: FileDiff[], head: Record<string, string>) =>
    gatherChecks(files, [pack()], async (p) => head[p] ?? textOf(files, p), { sizeOfHead: async () => null });

  it('a star crosses folders, letter case is ignored, a leading ./ or / is dropped, and an entry with .. promotes nothing and is said', async () => {
    const head = manifest({
      web_accessible_resources: [{ resources: ['*.js', './Docs/Guide.HTML', '/img/*.svg', '../outside.js', 'a/../b.js'], matches: ['<all_urls>'] }],
    });
    const files = ['tests/x.js', 'lib/__tests__/x.js', 'docs/guide.html', 'img/deep/a.svg', 'outside.js', 'b.js', 'tests/real.test.ts', 'notes.txt']
      .map((p) => changed(p, 'x;'));
    const { facts, readClosely } = await gather(files, { 'manifest.json': head });
    expect(readClosely.map((r) => r.path).sort()).toEqual(['b.js', 'docs/guide.html', 'img/deep/a.svg', 'lib/__tests__/x.js', 'outside.js', 'tests/x.js']);
    expect(only(facts, 'extension-loaded-files').filter((f) => f.path === 'manifest.json').map((f) => f.message)).toEqual([
      'The manifest names a path outside the extension: ../outside.js.',
      'The manifest names a path outside the extension: a/../b.js.',
    ]);
  });

  it('scripts a page the manifest loads pulls in are promoted too, relative to the page, local ones only', async () => {
    const head = manifest({ action: { default_popup: 'popup/popup.html' } });
    const page = [
      '<script src="../tests/pop.js"></script>',
      '<script src="https://cdn.example.com/x.js"></script>',
      '<script defer src="/lib/a.js?v=2"></script>',
      '<!-- <script src="old.js"></script> -->',
      '<script src="//cdn.example.com/y.js"></script>',
    ].join('\n');
    const files = ['tests/pop.js', 'lib/a.js', 'popup/old.js', 'x.js', 'y.js'].map((p) => changed(p, 'x;'));
    const { facts, readClosely } = await gather(files, { 'manifest.json': head, 'popup/popup.html': page });
    expect(readClosely.map((r) => `${r.path} ${r.reason}`).sort()).toEqual([
      'lib/a.js loaded by popup/popup.html', 'tests/pop.js loaded by popup/popup.html',
    ]);
    expect(only(facts, 'extension-loaded-files').map((f) => f.message)).toEqual([
      'tests/pop.js sits under a test or fixture folder but the extension loads it.',
    ]);
  });

  it('when the head manifest cannot be read, no code file is trusted as a test, and the fact says so', async () => {
    const code = 'eval(s);';
    const files = [changed('tests/x.test.js', code, 'added'), changed('README.md', 'words')];
    for (const head of [{}, { 'manifest.json': '{ "manifest_version": 3, ' }] as Record<string, string>[]) {
      const { facts, notTrusted } = await gather(files, { ...head, 'tests/x.test.js': code });
      expect(notTrusted.map((r) => `${r.path} ${r.packId}: ${r.reason}`)).toEqual([
        'tests/x.test.js extensions: manifest.json could not be read, so no file is trusted as a test',
      ]);
      expect(facts.map((f) => f.message)).toContain(head['manifest.json'] === undefined
        ? 'manifest.json could not be read at the head, so no file could be trusted as a test.'
        : 'manifest.json could not be read as JSON, so its permissions and version were not compared and so no file could be trusted as a test.');
      // and the test file is scanned like any other
      expect(only(facts, 'extension-remote-code').map((f) => f.path)).toEqual(['tests/x.test.js']);
    }
    // with a manifest, the same test file is trusted and not scanned
    const fine = await gather(files, { 'manifest.json': manifest({}), 'tests/x.test.js': code });
    expect(fine.notTrusted).toEqual([]);
    expect(only(fine.facts, 'extension-remote-code')).toEqual([]);
  });
});

describe('what loaded scripts load, through the whole chain', () => {
  const gather = (files: FileDiff[], head: Record<string, string>) =>
    gatherChecks(files, [pack()], async (p) => head[p] ?? textOf(files, p), { sizeOfHead: async () => null });
  const promoted = (r: { readClosely: { path: string; reason: string }[] }): string[] =>
    r.readClosely.map((c) => `${c.path} ${c.reason}`).sort();

  it('follows import, importScripts, new Worker, executeScript, registerContentScripts and an offscreen page from the head text, not getURL', async () => {
    const head = {
      'manifest.json': manifest({ background: { service_worker: 'bg/sw.js' }, action: { default_popup: 'popup/popup.html' } }),
      // the service worker, unchanged: its addresses resolve from its own folder, chrome.scripting's from the root
      'bg/sw.js': [
        "importScripts('lib/helpers.min.js');",
        "chrome.scripting.executeScript({ target: { tabId }, files: ['inject/a.js'] });",
        'chrome.scripting.registerContentScripts([{',
        "  id: 'x', matches: ['https://a.example.com/*'],",
        "  js: ['inject/b.js'],",
        '}]);',
        "chrome.offscreen.createDocument({ url: 'off/off.html', reasons: ['DOM_PARSER'], justification: 'x' });",
        "const icon = chrome.runtime.getURL('inject/not-code.js');",
      ].join('\n'),
      'bg/lib/helpers.min.js': 'x;',
      'off/off.html': '<script src="off.js"></script>',
      'popup/popup.html': '<script type="module" src="popup.js"></script>',
      'popup/popup.js': "import { a } from './lib/a.js';\nconst later = () => import('./dyn.js');",
      // a worker started from a page script resolves from the page; what the worker loads resolves from the worker
      'popup/lib/a.js': "export const a = new Worker('workers/w.js');",
      'popup/workers/w.js': "importScripts('deep/x.js');",
    };
    const changedFiles = [
      'bg/lib/helpers.min.js', 'inject/a.js', 'inject/b.js', 'off/off.js', 'popup/dyn.js', 'popup/workers/deep/x.js', 'inject/not-code.js',
    ].map((p) => changed(p, 'y;'));
    expect(promoted(await gather(changedFiles, head))).toEqual([
      'bg/lib/helpers.min.js loaded by bg/sw.js',
      'inject/a.js loaded by bg/sw.js',
      'inject/b.js loaded by bg/sw.js',
      'off/off.js loaded by off/off.html',
      'popup/dyn.js loaded by popup/popup.js',
      'popup/workers/deep/x.js loaded by popup/workers/w.js',
    ]);
  });

  it('follows a chain three deep to a changed file under tests/, whatever its tier', async () => {
    const head = {
      'manifest.json': manifest({ background: { service_worker: 'background.js' } }),
      'background.js': "importScripts('one.js');",
      'one.js': "importScripts('two.js');",
      'two.js': "importScripts('tests/three.js');",
    };
    const result = await gather([changed('tests/three.js', 'z;'), changed('CHANGELOG.md', 'words')], head);
    expect(promoted(result)).toEqual(['tests/three.js loaded by two.js']);
    expect(only(result.facts, 'extension-loaded-files').map((f) => f.message)).toEqual([
      'tests/three.js sits under a test or fixture folder but the extension loads it.',
    ]);
  });

  it('a loop ends: a loads b, b loads a, and each is read once', async () => {
    const head: Record<string, string> = {
      'manifest.json': manifest({ background: { service_worker: 'a.js' } }),
      'a.js': "importScripts('b.js');",
      'b.js': "importScripts('a.js');",
    };
    const reads: string[] = [];
    const result = await gatherChecks([changed('b.js', 'x;')], [pack()], async (p) => { reads.push(p); return head[p] ?? null; }, { sizeOfHead: async () => null });
    expect(promoted(result)).toEqual(['b.js loaded by a.js']);
    expect(reads.filter((p) => p !== 'manifest.json').sort()).toEqual(['a.js', 'b.js']);
  });

  it(`stops after ${FOLLOW_BUDGET.files} files read, with a fact saying so, and then trusts no code file`, async () => {
    const head: Record<string, string> = { 'manifest.json': manifest({ background: { service_worker: 's0.js' } }) };
    for (let i = 0; i < 250; i++) head[`s${i}.js`] = `importScripts('s${i + 1}.js');`;
    const files = [changed('s150.js', head['s150.js']!), changed('s240.js', head['s240.js']!), changed('tests/a.test.js', 'x;')];
    const result = await gather(files, head);
    expect(promoted(result)).toEqual(['s150.js loaded by s149.js']);
    expect(only(result.facts, 'extension-loaded-files').map((f) => `${f.path} ${f.message}`)).toEqual([
      `manifest.json Not everything the extension loads could be followed (more than ${FOLLOW_BUDGET.files} files load one another), so a changed file only the rest load is not read closely for that, and no file is trusted as a test.`,
    ]);
    expect(result.notTrusted.map((r) => `${r.path}: ${r.reason}`)).toEqual([
      's150.js: not everything the extension loads could be followed, so no file is trusted as a test',
      's240.js: not everything the extension loads could be followed, so no file is trusted as a test',
      'tests/a.test.js: not everything the extension loads could be followed, so no file is trusted as a test',
    ]);
  });

  it('a changed script or page a built-in rule ignores and nothing loads is skimmed with a fact; one the extension loads is promoted', async () => {
    const head = {
      'manifest.json': manifest({ background: { service_worker: 'background.js' } }),
      'background.js': "importScripts('vendor/used.min.js');",
    };
    const files = ['vendor/lib.min.js', 'dist/bundle.js', 'dist/page.html', 'api.generated.js', 'vendor/used.min.js', 'dist/logo.png', 'package-lock.json', 'dist/types.ts']
      .map((p) => changed(p, 'x;'));
    const result = await gather(files, head);
    expect(promoted(result)).toEqual(['vendor/used.min.js loaded by background.js']);
    expect((result.notIgnored ?? []).map((r) => `${r.path} ${r.packId}: ${r.reason}`)).toEqual([
      'vendor/lib.min.js extensions: minified file by its name, but an extension has no build step, so Chrome may load this file',
      'dist/bundle.js extensions: build output by its name, but an extension has no build step, so Chrome may load this file',
      'dist/page.html extensions: build output by its name, but an extension has no build step, so Chrome may load this file',
      'api.generated.js extensions: generated file by its name, but an extension has no build step, so Chrome may load this file',
    ]);
    expect(only(result.facts, 'extension-loaded-files').map((f) => `${f.path}: ${f.message}`)).toEqual([
      'api.generated.js: A built-in rule would leave api.generated.js out as a generated file, but an extension has no build step, so Chrome may load this file: it is skimmed.',
      'dist/bundle.js: A built-in rule would leave dist/bundle.js out as build output, but an extension has no build step, so Chrome may load this file: it is skimmed.',
      'dist/page.html: A built-in rule would leave dist/page.html out as build output, but an extension has no build step, so Chrome may load this file: it is skimmed.',
      'vendor/lib.min.js: A built-in rule would leave vendor/lib.min.js out as a minified file, but an extension has no build step, so Chrome may load this file: it is skimmed.',
    ]);
    // the tier hook raises them to skim, never higher, and a binary stays ignored
    const tiers = classifyFiles(files, [pack()], result);
    expect(tiers.map((t) => `${t.path} ${t.tier}`)).toEqual([
      'vendor/lib.min.js skim', 'dist/bundle.js skim', 'dist/page.html skim', 'api.generated.js skim', 'vendor/used.min.js read',
      'dist/logo.png ignored', 'package-lock.json ignored', 'dist/types.ts ignored',
    ]);
    // a pack that does not name extension-loaded-files gives no such fact and raises nothing
    const none = await gatherChecks(files, [pack(['extension-remote-code'])], async (p) => (head as Record<string, string>)[p] ?? null, { sizeOfHead: async () => null });
    expect(only(none.facts, 'extension-loaded-files')).toEqual([]);
    expect(none.notIgnored).toEqual([]);
  });
});

describe('hostile input stays fast', () => {
  const gather = (files: FileDiff[], head: Record<string, string>) =>
    gatherChecks(files, [pack()], async (p) => head[p] ?? textOf(files, p), { sizeOfHead: async () => null });
  const timed = async (work: () => Promise<unknown>): Promise<number> => (await cpuTimed(work)).ms;

  it('a manifest entry of many stars against a long path', async () => {
    // the review measured 14 stars against 80 letters; this is ten times both
    const entry = `${'*a'.repeat(140)}*!`;
    const path = 'a'.repeat(800);
    const head = { 'manifest.json': manifest({ web_accessible_resources: [{ resources: [entry], matches: ['<all_urls>'] }] }) };
    expect(await timed(() => gather([changed(path, 'x;')], head))).toBeLessThan(200);
  });

  it('an import followed by a long run of spaces, or by a long comment, and no quote', async () => {
    for (const line of [`import${' '.repeat(15_000)}x`, `import/*${'c'.repeat(200_000)}*/x`, `import ${'import '.repeat(30_000)}`]) {
      const head = { 'manifest.json': manifest({ background: { service_worker: 'background.js' } }), 'background.js': line };
      expect(await timed(() => gather([changed('background.js', line, 'added')], head))).toBeLessThan(200);
    }
  });

  it('a manifest page made of <script repeated with no closing bracket', async () => {
    const page = '<script'.repeat(30_000);
    const head = { 'manifest.json': manifest({ action: { default_popup: 'popup.html' } }), 'popup.html': page };
    expect(await timed(() => gather([changed('popup.html', page, 'added')], head))).toBeLessThan(200);
  });

  it('matching still works past the cut: a loader at the end of a long minified line is followed', async () => {
    const line = `${'var a=1;'.repeat(1000)}importScripts('lib/late.js');`;
    const head = { 'manifest.json': manifest({ background: { service_worker: 'background.js' } }), 'background.js': line };
    expect((await gather([changed('lib/late.js', 'x;')], head)).readClosely.map((c) => c.path)).toEqual(['lib/late.js']);
  });
});

describe('the follower on hostile input: a budget, and then nothing trusted', () => {
  const withBackground = (code: string, extra: Record<string, string> = {}): Record<string, string> => ({
    'manifest.json': manifest({ background: { service_worker: 'background.js' } }), 'background.js': code, ...extra,
  });
  const gather = (files: FileDiff[], head: Record<string, string>) =>
    gatherChecks(files, [pack()], async (p) => head[p] ?? textOf(files, p), { sizeOfHead: async () => null });
  const timed = cpuTimed;
  const NOT_ALL = 'not everything the extension loads could be followed, so no file is trusted as a test';

  it("the re-check's three inputs each finish under 200 ms", async () => {
    // a 2 MB script of unclosed executeScript lists, and one of unclosed importScripts calls, followed from the manifest
    for (const code of ['executeScript(files:['.repeat(95_000), 'importScripts('.repeat(140_000)]) {
      const { ms } = await timed(() => gather([changed('tests/a.test.js', 'x;')], withBackground("importScripts('big.js');", { 'big.js': code })));
      expect(ms, code.slice(0, 14)).toBeLessThan(200);
    }
    // 100 long "*" entries against 300 changed files with long paths: the entry length bound
    const entries = Array.from({ length: 100 }, () => `*${'a/'.repeat(250)}b`);
    const files = Array.from({ length: 300 }, (_, i) => changed(`${'a/'.repeat(500)}${i}.js`, 'x;'));
    const head = { 'manifest.json': manifest({ web_accessible_resources: [{ resources: entries, matches: ['<all_urls>'] }] }) };
    const { ms, value } = await timed(() => gather(files, head));
    expect(ms).toBeLessThan(200);
    expect(only(value.facts, 'extension-loaded-files').map((f) => f.message)).toEqual([
      'Not everything the extension loads could be followed (the manifest names a path longer than 256 characters), so a changed file only the rest load is not read closely for that, and no file is trusted as a test.',
    ]);
  });

  it('entries under the length bound against many long paths stop at the matching budget', async () => {
    const entries = Array.from({ length: 100 }, () => `*${'a/'.repeat(120)}b`);
    const files = Array.from({ length: 300 }, (_, i) => changed(`${'a/'.repeat(500)}${i}.js`, 'x;'));
    const head = { 'manifest.json': manifest({ web_accessible_resources: [{ resources: entries, matches: ['<all_urls>'] }] }) };
    const { ms, value } = await timed(() => gather(files, head));
    // Spending the whole matching budget is the slowest honest stop: held to well under the two seconds allowed for the
    // whole check, with room for a busy machine (it measured about 200 ms of CPU at the earlier, larger budget).
    expect(ms).toBeLessThan(1000);
    expect(only(value.facts, 'extension-loaded-files').map((f) => f.message)).toEqual([
      'Not everything the extension loads could be followed (matching the manifest\'s "*" entries against the changed files would take too long), so a changed file only the rest load is not read closely for that, and no file is trusted as a test.',
    ]);
  });

  const whole = async (content: string): Promise<{ ms: number; value: Awaited<ReturnType<typeof gather>> }> => {
    const names = Array.from({ length: 200 }, (_, i) => `lib/f${i}.js`);
    const head: Record<string, string> = withBackground(`importScripts(${names.map((n) => `'${n}'`).join(', ')});`);
    for (const n of names) head[n] = content;
    const files = [changed('lib/f199.js', 'x;'), changed('tests/a.test.js', 'x;'), changed('README.md', 'words')];
    return timed(() => gather(files, head));
  };
  const notFollowed = (why: string): string =>
    `Not everything the extension loads could be followed (${why}), so a changed file only the rest load is not read closely for that, and no file is trusted as a test.`;

  it('a pull request whose extension loads 200 such files finishes the whole check under two seconds, with the fact and nothing trusted', async () => {
    // the re-check's input: a list that never ends stops the follower at the first such file
    const unclosed = await whole('executeScript(files:['.repeat(95_000));
    expect(unclosed.ms).toBeLessThan(2000);
    expect(only(unclosed.value.facts, 'extension-loaded-files').map((f) => f.message))
      .toContain(notFollowed('a call that loads files has a list that does not end within 20,000 characters'));
    expect(unclosed.value.notTrusted.map((r) => `${r.path}: ${r.reason}`)).toEqual([`lib/f199.js: ${NOT_ALL}`, `tests/a.test.js: ${NOT_ALL}`]);
    expect(unclosed.value.readClosely.map((r) => r.path)).toEqual(['lib/f199.js']); // found before the stop, still read closely
    // 1 MB files dense with loader words and no call left open: the text budget stops it
    const dense = await whole(`${"import x from './a.js'; ".repeat(20_000)}${'import '.repeat(80_000)}`);
    expect(dense.ms).toBeLessThan(2000);
    expect(only(dense.value.facts, 'extension-loaded-files').map((f) => f.message))
      .toContain(notFollowed(`the files it loads hold more than ${FOLLOW_BUDGET.bytes.toLocaleString('en-US')} characters`));
    expect(dense.value.notTrusted.map((r) => r.path)).toEqual(['lib/f199.js', 'tests/a.test.js']);
    // and many small calls, each closed: the calls budget stops it
    const calls = await whole("importScripts('a.js');".repeat(30_000));
    expect(calls.ms).toBeLessThan(2000);
    expect(only(calls.value.facts, 'extension-loaded-files').map((f) => f.message))
      .toContain(notFollowed(`they hold more than ${FOLLOW_BUDGET.calls.toLocaleString('en-US')} calls that load files`));
  });

  it('a loaded script that is there and cannot be read is a fact and leaves nothing trusted; one that is not there is a fact only', async () => {
    const head = withBackground("importScripts('lib/huge.js', 'lib/gone.js');");
    const files = [changed('tests/a.test.js', 'x;'), changed('tests/b.test.js', 'y;')];
    const run = (present: string[]) => gatherChecks(files, [pack()], async (p) => head[p] ?? textOf(files, p), {
      sizeOfHead: async () => null, presentAtHead: async (p) => present.includes(p),
    });
    const there = await run(['lib/huge.js']);
    expect(only(there.facts, 'extension-loaded-files').map((f) => `${f.path}: ${f.message}`)).toEqual([
      'background.js: background.js loads lib/gone.js, which is not in the extension at the head.',
      'lib/huge.js: lib/huge.js, loaded by background.js, could not be read (too large, a link, or spelled differently on disk), so what it loads was not followed and no file is trusted as a test.',
    ]);
    expect(there.notTrusted.map((r) => r.path)).toEqual(['tests/a.test.js', 'tests/b.test.js']);
    const gone = await run([]);
    expect(only(gone.facts, 'extension-loaded-files').map((f) => f.message)).toEqual([
      'background.js loads lib/huge.js, which is not in the extension at the head.',
      'background.js loads lib/gone.js, which is not in the extension at the head.',
    ]);
    expect(gone.notTrusted).toEqual([]);
  });
});

describe('paths and pages the follower resolves as a browser does', () => {
  const gather = (files: FileDiff[], head: Record<string, string>) =>
    gatherChecks(files, [pack()], async (p) => head[p] ?? textOf(files, p), { sizeOfHead: async () => null });
  const promoted = (r: { readClosely: { path: string; reason: string }[] }): string[] => r.readClosely.map((c) => `${c.path} ${c.reason}`).sort();

  it('.. stops at the root, percent escapes are decoded (a bad one read as written), and the pages of tabs, windows, setPopup, setOptions and an iframe are followed', async () => {
    const head = {
      'manifest.json': manifest({ background: { service_worker: 'background.js' } }),
      'background.js': [
        "importScripts('../tests/shared.js', 'lib/my%20helper.js', 'lib/100%.js');",
        "chrome.tabs.create({ url: 'dash/dash.html' });",
        "chrome.tabs.create({ url: chrome.runtime.getURL('report.html') });",
        "chrome.windows.create({ url: ['win.html'], type: 'popup' });",
        "chrome.action.setPopup({ popup: 'p2.html' });",
        "chrome.sidePanel.setOptions({ tabId, path: 'side.html', enabled: true });",
      ].join('\n'),
      'dash/dash.html': '<iframe src="frame.html"></iframe><script src="dash.js"></script>',
      'dash/frame.html': '<script src="../framed.js"></script>',
      'report.html': '<script src="report.js"></script>',
      'win.html': '<script src="win.js"></script>',
      'p2.html': '<script src="p2.js"></script>',
      'side.html': '<script src="side.js"></script>',
    };
    const files = ['tests/shared.js', 'lib/my helper.js', 'lib/100%.js', 'dash/dash.js', 'framed.js', 'report.js', 'win.js', 'p2.js', 'side.js']
      .map((p) => changed(p, 'x;'));
    expect(promoted(await gather(files, head))).toEqual([
      'dash/dash.js loaded by dash/dash.html',
      'framed.js loaded by dash/frame.html',
      'lib/100%.js loaded by background.js',
      'lib/my helper.js loaded by background.js',
      'p2.js loaded by p2.html',
      'report.js loaded by report.html',
      'side.js loaded by side.html',
      'tests/shared.js loaded by background.js',
      'win.js loaded by win.html',
    ]);
  });

  it('a loader in the overlap of two pieces of a cut line gives its fact once', async () => {
    const line = `${'var a=1;'.repeat(210)}importScripts('tests/x.js');${'var b=2;'.repeat(100)}`;
    expect(line.indexOf('importScripts')).toBeGreaterThan(1500);
    expect(line.indexOf('importScripts') + 30).toBeLessThan(2000);
    // the check itself, not only the runner that drops repeated facts
    const files = [changed('src/background.js', line, 'added')];
    const head: Record<string, string> = { 'manifest.json': manifest({}), 'src/background.js': line };
    const { facts } = await EXTENSION_CHECKS['extension-loaded-files']!({
      files, readHead: async (p) => head[p] ?? null, readBase: async () => null, sizeOfHead: async () => null,
      presentAtHead: async () => false, isIgnored: () => false,
    });
    expect(facts.map((f) => `${f.line} ${f.message}`)).toEqual(['1 An added line loads src/tests/x.js, which sits under a test or fixture folder.']);
  });
});
