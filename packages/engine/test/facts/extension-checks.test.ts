import type { Fact, FileDiff } from '@airlock/shared';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CODE_CHECK_IDS, gatherChecks, runChecks } from '../../src/facts/checks.js';
import { EXTENSION_CHECKS } from '../../src/facts/extension-checks.js';
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

interface Tree { head?: Record<string, string>; base?: Record<string, string>; sizes?: Record<string, number> }
async function run(files: FileDiff[], tree: Tree = {}, codeChecks: string[] = ALL): Promise<Fact[]> {
  return runChecks(files, [pack(codeChecks)], async (p) => tree.head?.[p] ?? null, {
    readBase: async (p) => tree.base?.[p] ?? null,
    sizeOfHead: async (p) => tree.sizes?.[p] ?? (tree.head?.[p] !== undefined ? Buffer.byteLength(tree.head[p]!) : null),
  });
}
const only = (facts: Fact[], checkId: string): Fact[] => facts.filter((f) => f.checkId === checkId);
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
  const read = (tree: Tree) => async (p: string): Promise<string | null> => tree.head?.[p] ?? null;
  const gather = (files: FileDiff[], tree: Tree, codeChecks: string[] = ALL) => gatherChecks(files, [pack(codeChecks)], read(tree), {
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
    gatherChecks(files, [pack()], async (p) => head[p] ?? null, { sizeOfHead: async () => null });

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
