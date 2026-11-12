import { posix } from 'node:path';
import type { Fact, FileDiff } from '@airlock/shared';
import picomatch from 'picomatch';

/**
 * Code checks for Chrome extension repositories, named by a pack under `codeChecks:`. Each reads the pull request's files
 * only through the readers it is given (the engine's safe reader on the head and base worktrees), never runs the
 * extension's code, and gives facts for the lenses, never findings. A check may also name changed files to be read
 * closely whatever their path says: the files the extension's manifest loads.
 */
export interface CodeCheckInput {
  /** The changed files, symbolic links left out. */
  files: FileDiff[];
  readHead: (path: string) => Promise<string | null>;
  readBase: (path: string) => Promise<string | null>;
  sizeOfHead: (path: string) => Promise<number | null>;
  /** Whether the packs' ignore globs or the built-in ones leave a path out of the review. */
  isIgnored: (path: string) => boolean;
}
export interface CodeCheckResult { facts: Fact[]; readClosely?: { path: string; reason: string }[] }
export type CodeCheck = (input: CodeCheckInput) => Promise<CodeCheckResult>;

/** Files the review trusts as tests: under the top-level `tests/` folder, or named or placed as the engine's built-in rules say. */
const TRUSTED_TEST = ['tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*'].map((g) => picomatch(g, { dot: true }));
const isTrustedTest = (path: string): boolean => TRUSTED_TEST.some((m) => m(path));
const TEST_FOLDERS = new Set(['tests', 'test', '__tests__', 'fixtures']);
/** Under a folder named for tests or fixtures, at any depth. */
const underTestFolder = (path: string): boolean => path.split('/').slice(0, -1).some((s) => TEST_FOLDERS.has(s));
const namedLikeTest = (path: string): boolean => /\.(?:test|spec)\./i.test(posix.basename(path));
const SCRIPT_FILE = /\.(?:m?js|cjs|jsx|tsx?|gs)$/i;
const HTML_FILE = /\.html?$/i;
const ARCHIVE = new Set(['zip', 'crx', 'xpi', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar']);
const LARGE_BYTES = 500_000;

const live = (files: FileDiff[]): FileDiff[] => files.filter((f) => f.status !== 'deleted');
const cut = (s: string, n = 100): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const besideIt = (dir: string, name: string): string => (dir === '.' ? name : `${dir}/${name}`);
const isManifest = (path: string): boolean => posix.basename(path) === 'manifest.json' && !isTrustedTest(path);

/** The added lines of a file, by their line number on the head. */
function addedLines(file: FileDiff): Map<number, string> {
  const out = new Map<number, string>();
  for (const hunk of file.hunks) for (const l of hunk.lines) if (l.kind === 'add' && l.newNo !== null) out.set(l.newNo, l.text);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The manifest

/** One side of a manifest: not there (new), not readable (unknown), not JSON (bad), or read. */
type Side =
  | { kind: 'absent' } | { kind: 'unknown' } | { kind: 'bad' }
  | { kind: 'ok'; json: Record<string, unknown>; text: string };

/** Reads a manifest, its comments blanked first (Chrome accepts them); `missing` is what an unreadable file is. */
async function manifestSide(read: (path: string) => Promise<string | null>, path: string, missing: 'absent' | 'unknown'): Promise<Side> {
  const text = await read(path);
  if (text === null) return { kind: missing };
  try {
    const json: unknown = JSON.parse(scriptViews(text.replace(/^﻿/, '')).code.join('\n'));
    return isObj(json) ? { kind: 'ok', json, text } : { kind: 'bad' };
  } catch {
    return { kind: 'bad' };
  }
}

interface ChangedManifest { path: string; base: Side; head: Side }

/**
 * Every changed manifest.json outside the trusted tests, with both sides read; a renamed one is read at its old path on the
 * base. Only an added manifest is new: one whose base cannot be read is unknown before.
 */
async function changedManifests(input: CodeCheckInput): Promise<ChangedManifest[]> {
  const out: ChangedManifest[] = [];
  for (const f of live(input.files)) {
    if (!isManifest(f.path)) continue;
    const base = f.status === 'added' ? { kind: 'absent' as const } : await manifestSide(input.readBase, f.oldPath ?? f.path, 'unknown');
    out.push({ path: f.path, base, head: await manifestSide(input.readHead, f.path, 'unknown') });
  }
  return out;
}

const NOT_JSON = 'extension-manifest-json';
/** The facts saying a side of a manifest is not JSON: the head stops the comparison, the base leaves "before" unknown. */
function jsonFacts(m: ChangedManifest): Fact[] {
  const out: Fact[] = [];
  if (m.base.kind === 'bad') {
    out.push({ checkId: NOT_JSON, path: m.path, line: null, message: `${m.path} could not be read as JSON before this pull request, so what it held before is not known.` });
  }
  if (m.head.kind === 'bad') {
    out.push({ checkId: NOT_JSON, path: m.path, line: null, message: `${m.path} could not be read as JSON, so its permissions and version were not compared.` });
  }
  return out;
}
const beforeUnknown = (s: Side): boolean => s.kind === 'bad' || s.kind === 'unknown';

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const unique = (list: string[]): string[] => [...new Set(list)];

/** The lists of a manifest that say what the extension may do and where, by the name the facts use. */
const LISTS: [string, (m: Record<string, unknown>) => string[]][] = [
  ['permissions', (m) => strings(m.permissions)],
  ['optional_permissions', (m) => strings(m.optional_permissions)],
  ['host_permissions', (m) => strings(m.host_permissions)],
  ['optional_host_permissions', (m) => strings(m.optional_host_permissions)],
  ['content_scripts matches', (m) => (Array.isArray(m.content_scripts) ? m.content_scripts.flatMap((c) => (isObj(c) ? strings(c.matches) : [])) : [])],
];

const listed = (list: string[]): string => (list.length > 0 ? list.join(', ') : 'none');

const permissions: CodeCheck = async (input) => {
  const out: Fact[] = [];
  for (const m of await changedManifests(input)) {
    out.push(...jsonFacts(m));
    if (m.head.kind !== 'ok') continue;
    for (const [label, pick] of LISTS) {
      const after = unique(pick(m.head.json));
      const fact = (message: string): void => { out.push({ checkId: 'extension-permissions', path: m.path, line: null, message }); };
      if (beforeUnknown(m.base)) {
        if (after.length > 0) fact(`${label} before: not known (the manifest could not be read before this pull request); after: ${listed(after)}.`);
        continue;
      }
      const before = m.base.kind === 'ok' ? unique(pick(m.base.json)) : [];
      const added = after.filter((x) => !before.includes(x));
      const removed = before.filter((x) => !after.includes(x));
      if (added.length === 0 && removed.length === 0) continue;
      const was = m.base.kind === 'absent' ? 'none (the manifest is new)' : listed(before);
      fact(`${label} before: ${was}; after: ${listed(after)}${added.length > 0 ? `; added: ${added.join(', ')}` : ''}${removed.length > 0 ? `; removed: ${removed.join(', ')}` : ''}.`);
    }
  }
  return { facts: out };
};

// `<all_urls>`, or a match pattern whose host is every host (`*://*/*`, `https://*/*`) or none at all (`file:///*`).
const isBroad = (entry: string): boolean => entry === '<all_urls>' || /^[a-z*][a-z0-9+.*-]*:\/\/\*?\//i.test(entry);
const reach = (entry: string): string => (/^file:/i.test(entry) ? 'every file on the computer' : 'every site');

const broadHosts: CodeCheck = async (input) => {
  const out: Fact[] = [];
  for (const m of await changedManifests(input)) {
    out.push(...jsonFacts(m));
    if (m.head.kind !== 'ok') continue;
    const lines = m.head.text.split('\n');
    for (const [label, pick] of LISTS) {
      const before = m.base.kind === 'ok' ? pick(m.base.json) : [];
      for (const entry of unique(pick(m.head.json)).filter(isBroad)) {
        const when = beforeUnknown(m.base) ? 'not known whether it was there before'
          : before.includes(entry) ? 'already there before' : 'added in this pull request';
        const at = lines.findIndex((l) => l.includes(JSON.stringify(entry)));
        out.push({
          checkId: 'extension-broad-hosts', path: m.path, line: at >= 0 ? at + 1 : null,
          message: `${label} asks for ${JSON.stringify(entry)}, ${reach(entry)} (${when}).`,
        });
      }
    }
  }
  return { facts: out };
};

const versionOf = (s: Side): string | null => (s.kind === 'ok' && typeof s.json.version === 'string' ? s.json.version : null);

/** Whether dotted version `b` is higher than `a`; null when either is not made of numbers. */
function isHigher(a: string, b: string): boolean | null {
  const parse = (v: string): number[] | null => (/^\d+(?:\.\d+)*$/.test(v) ? v.split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? 0) - (x[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

const isChangelog = (path: string): boolean => /^changelog(?:\.md)?$/i.test(posix.basename(path));

const versionChangelog: CodeCheck = async (input) => {
  const out: Fact[] = [];
  const fact = (path: string, message: string): void => { out.push({ checkId: 'extension-version-changelog', path, line: null, message }); };
  const changelogIn = (dir: string): FileDiff | undefined =>
    live(input.files).find((f) => isChangelog(f.path) && posix.dirname(f.path) === dir);
  // Manifests whose version changed, or whose earlier version is not known: their changelog needs no fact of its own.
  const settled = new Set<string>();

  for (const m of await changedManifests(input)) {
    out.push(...jsonFacts(m));
    if (beforeUnknown(m.base)) settled.add(m.path);
    if (m.head.kind !== 'ok' || beforeUnknown(m.base)) continue;
    const now = versionOf(m.head);
    if (now === null) continue;
    const was = versionOf(m.base);
    if (m.base.kind === 'ok' && was === now) continue;
    settled.add(m.path);
    if (changelogIn(posix.dirname(m.path)) !== undefined) continue;
    if (m.base.kind === 'absent') {
      fact(m.path, `${m.path} is new, at version ${now}, and this pull request has no CHANGELOG.md beside it.`);
    } else if (was === null) {
      fact(m.path, `The version is now ${now} and CHANGELOG.md beside it did not change.`);
    } else {
      const lower = isHigher(was, now) === false ? ', which is not higher,' : '';
      fact(m.path, `The version changed from ${was} to ${now}${lower} and CHANGELOG.md beside it did not change.`);
    }
  }

  for (const log of live(input.files).filter((f) => isChangelog(f.path) && !isTrustedTest(f.path))) {
    const manifestPath = besideIt(posix.dirname(log.path), 'manifest.json');
    if (settled.has(manifestPath)) continue;
    const head = await manifestSide(input.readHead, manifestPath, 'absent');
    if (head.kind !== 'ok') continue;
    const now = versionOf(head);
    const name = posix.basename(log.path);
    fact(log.path, now === null
      ? `${name} changed and manifest.json beside it has no version.`
      : `${name} changed and the version in manifest.json beside it is still ${now}.`);
  }
  return { facts: out };
};

// ---------------------------------------------------------------------------------------------------------------------
// Scripts

/**
 * Two views of script text with every line break kept in place: `code` with comments blanked, and `bare` with the inside
 * of strings blanked as well. A best effort without a parser: a regular expression literal holding `//` may blank the rest
 * of its line.
 */
function scriptViews(text: string): { code: string[]; bare: string[] } {
  let code = '';
  let bare = '';
  let state: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code';
  const keep = (c: string, b = c): void => { code += c; bare += b; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const n = text[i + 1];
    if (c === '\n') {
      if (state === 'line' || state === "'" || state === '"') state = 'code';
      keep('\n');
      continue;
    }
    if (state === 'code') {
      if (c === '/' && (n === '/' || n === '*')) { state = n === '/' ? 'line' : 'block'; keep('  '); i++; continue; }
      if (c === "'" || c === '"' || c === '`') state = c;
      keep(c);
    } else if (state === 'line') {
      keep(' ');
    } else if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; keep('  '); i++; } else keep(' ');
    } else if (c === '\\' && n !== undefined && n !== '\n') {
      keep(c + n, '  ');
      i++;
    } else if (c === state) {
      state = 'code';
      keep(c);
    } else {
      keep(c, ' ');
    }
  }
  return { code: code.split('\n'), bare: bare.split('\n') };
}

const htmlView = (text: string): string[] => text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')).split('\n');

// ---------------------------------------------------------------------------------------------------------------------
// The files the extension loads

/** A path the manifest at `dir` names, from the repository root; null when it leaves the repository. */
function resolveIn(dir: string, named: string): string | null {
  const from = named.startsWith('/') ? '.' : dir;
  const joined = posix.normalize(posix.join(from === '.' ? '' : from, named.replace(/^\/+/, '')));
  if (joined === '.' || joined === '' || joined.startsWith('../') || joined === '..') return null;
  return joined.replace(/^\.\//, '');
}

/** Every path a manifest names as something Chrome loads: scripts, pages, styles and web-accessible resources. */
function namedPaths(m: Record<string, unknown>): string[] {
  const out: string[] = [];
  const one = (v: unknown): void => { if (typeof v === 'string' && v !== '') out.push(v); };
  const all = (v: unknown): void => { for (const s of strings(v)) one(s); };
  const pick = (v: unknown, key: string): unknown => (isObj(v) ? v[key] : undefined);
  one(pick(m.background, 'service_worker'));
  all(pick(m.background, 'scripts'));
  one(pick(m.background, 'page'));
  if (Array.isArray(m.content_scripts)) for (const c of m.content_scripts) { all(pick(c, 'js')); all(pick(c, 'css')); }
  if (Array.isArray(m.web_accessible_resources)) {
    for (const w of m.web_accessible_resources) { if (typeof w === 'string') one(w); else all(pick(w, 'resources')); }
  }
  for (const key of ['action', 'browser_action', 'page_action']) one(pick(m[key], 'default_popup'));
  one(m.options_page);
  one(pick(m.options_ui, 'page'));
  one(pick(m.side_panel, 'default_path'));
  one(m.devtools_page);
  if (isObj(m.chrome_url_overrides)) for (const v of Object.values(m.chrome_url_overrides)) one(v);
  all(pick(m.sandbox, 'pages'));
  return out;
}

const loadedMemo = new WeakMap<CodeCheckInput, Promise<Map<string, string>>>();

/**
 * The changed files the head's manifests load, each with why (`loaded by <manifest>`): the top-level manifest.json, read
 * at the head whether it changed or not, and any other changed manifest.json, each read from its own folder. A glob the
 * manifest names takes in every changed file it matches.
 */
function loadedFiles(input: CodeCheckInput): Promise<Map<string, string>> {
  let hit = loadedMemo.get(input);
  if (!hit) { hit = findLoaded(input); loadedMemo.set(input, hit); }
  return hit;
}

async function findLoaded(input: CodeCheckInput): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const changed = live(input.files);
  if (changed.length === 0) return out;
  for (const manifestPath of unique(['manifest.json', ...changed.filter((f) => isManifest(f.path)).map((f) => f.path)])) {
    const side = await manifestSide(input.readHead, manifestPath, 'absent');
    if (side.kind !== 'ok') continue;
    for (const named of namedPaths(side.json)) {
      const path = resolveIn(posix.dirname(manifestPath), named);
      if (path === null) continue;
      const glob = /[*?[\]{}]/.test(path) ? picomatch(path, { dot: true }) : null;
      for (const f of changed) {
        if (!out.has(f.path) && (glob ? glob(f.path) : f.path === path)) out.set(f.path, `loaded by ${manifestPath}`);
      }
    }
  }
  return out;
}

const withTests = (path: string): string | null =>
  underTestFolder(path) ? 'sits under a test or fixture folder' : namedLikeTest(path) ? 'is named like a test' : null;

const IMPORT = /\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?\(?\s*['"]([^'"]+)['"]/g;
const IMPORT_SCRIPTS = /\bimportScripts\s*\(([^)]*)\)/g;
const EXECUTE_SCRIPT = /\bexecuteScript\s*\(\s*\{(?:[^{}]|\{[^{}]*\})*?\bfiles\s*:\s*\[([^\]]*)\]/g;
const QUOTED = /['"`]([^'"`]+)['"`]/g;

/** The repository paths an added line of `file` loads code from with a literal path. */
function loadsOn(code: string, file: string): string[] {
  const dir = posix.dirname(file);
  const out: string[] = [];
  const add = (from: string, named: string): void => { const p = resolveIn(from, named); if (p !== null) out.push(p); };
  for (const [, spec] of code.matchAll(IMPORT)) if (spec!.startsWith('.') || spec!.startsWith('/')) add(dir, spec!);
  for (const [, args] of code.matchAll(IMPORT_SCRIPTS)) for (const [, p] of args!.matchAll(QUOTED)) add(dir, p!);
  // chrome.scripting takes paths from the extension's root
  for (const [, list] of code.matchAll(EXECUTE_SCRIPT)) for (const [, p] of list!.matchAll(QUOTED)) add('.', p!);
  return out;
}

const loadedFilesCheck: CodeCheck = async (input) => {
  const loaded = await loadedFiles(input);
  const facts: Fact[] = [];
  for (const path of loaded.keys()) {
    const where = withTests(path);
    if (where !== null) facts.push({ checkId: 'extension-loaded-files', path, line: null, message: `${path} ${where} but the extension loads it.` });
  }
  for (const { file, added, head } of await sources(input, SCRIPT_FILE)) {
    // A test loading its own fixtures is not news; a file the extension loads is not a test.
    if (!loaded.has(file.path) && withTests(file.path) !== null) continue;
    for (const [n, code] of viewOfLines(head, added, (t) => scriptViews(t).code)) {
      for (const target of loadsOn(code, file.path)) {
        const where = withTests(target);
        if (where !== null) {
          facts.push({ checkId: 'extension-loaded-files', path: file.path, line: n, message: `An added line loads ${target}, which ${where}.` });
        }
      }
    }
  }
  return { facts, readClosely: [...loaded].map(([path, reason]) => ({ path, reason })) };
};

/**
 * The script or page files of the pull request worth scanning, with their added lines and their head text: not a trusted test
 * and not an ignored file (minified, built, vendored), unless the extension loads it.
 */
async function sources(input: CodeCheckInput, pick: RegExp): Promise<{ file: FileDiff; added: Map<number, string>; head: string | null }[]> {
  const loaded = await loadedFiles(input);
  const out = [];
  for (const file of live(input.files)) {
    if (!pick.test(file.path) || file.binary) continue;
    if (!loaded.has(file.path) && (isTrustedTest(file.path) || input.isIgnored(file.path))) continue;
    const added = addedLines(file);
    if (added.size === 0) continue;
    out.push({ file, added, head: await input.readHead(file.path) });
  }
  return out;
}

/** The view of each added line: from the whole head file when it holds that line, else from the line alone. */
function viewOfLines<T>(head: string | null, added: Map<number, string>, view: (text: string) => T[]): Map<number, T> {
  const whole = head === null ? null : view(head);
  const headLines = head?.split('\n');
  const out = new Map<number, T>();
  for (const [n, text] of added) {
    const same = whole !== null && headLines?.[n - 1]?.replace(/\r$/, '') === text.replace(/\r$/, '');
    out.set(n, same ? whole[n - 1]! : view(text)[0]!);
  }
  return out;
}

const EVAL = /(?<![\w$])eval\s*\(/;
const FUNCTION = /(?<![\w$.])Function\s*\(/;
const PLAIN_ADDRESS = /\b(?:http|ws):\/\/[^\s'"`<>)\\]+/gi;
const XML_NAMESPACE = /^http:\/\/www\.w3\.org\//i;
const SCRIPT_SRC = /<script\b[^>]*?\bsrc\s*=\s*["']?\s*((?:http|ws):\/\/[^\s"'>]+)/gi;
const secure = (address: string): string => (/^ws:/i.test(address) ? 'wss' : 'https');

const remoteCode: CodeCheck = async (input) => {
  const out: Fact[] = [];
  for (const { file, added, head } of await sources(input, SCRIPT_FILE)) {
    const fact = (line: number, message: string): void => { out.push({ checkId: 'extension-remote-code', path: file.path, line, message }); };
    const views = viewOfLines(head, added, (t) => { const v = scriptViews(t); return v.code.map((code, i) => ({ code, bare: v.bare[i]! })); });
    for (const [n, { code, bare }] of views) {
      if (EVAL.test(bare)) fact(n, 'An added line runs text as code with eval.');
      if (FUNCTION.test(bare)) fact(n, 'An added line builds a function from text with new Function.');
      for (const [address] of code.matchAll(PLAIN_ADDRESS)) {
        if (!XML_NAMESPACE.test(address)) fact(n, `An added line has the address ${cut(address)}, which is not ${secure(address)}.`);
      }
    }
  }
  for (const { file, added, head } of await sources(input, HTML_FILE)) {
    for (const [n, line] of viewOfLines(head, added, htmlView)) {
      for (const [, address] of line.matchAll(SCRIPT_SRC)) {
        out.push({
          checkId: 'extension-remote-code', path: file.path, line: n,
          message: `An added line loads a script from ${cut(address!)}, which is not ${secure(address!)}.`,
        });
      }
    }
  }
  return { facts: out };
};

const SINK = /\.(innerHTML|outerHTML)\s*(?:\+=|=(?!=))|\.(insertAdjacentHTML)\s*\(/g;

/** The end of the string literal opening at `i` (the index of its closing quote), or -1 when it is not one fixed text. */
function literalEnd(text: string, i: number): number {
  const quote = text[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return -1;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') { j++; continue; }
    if (c === quote) return j;
    if (quote === '`' && c === '$' && text[j + 1] === '{') return -1;
    if (quote !== '`' && c === '\n') return -1;
  }
  return -1;
}

const skipSpace = (text: string, i: number): number => { while (i < text.length && /\s/.test(text[i]!)) i++; return i; };

/** Whether the value starting at `i` is one fixed text: a string literal with nothing joined to it or called on it. */
function isFixedText(text: string, i: number): boolean {
  const start = skipSpace(text, i);
  const end = literalEnd(text, start);
  if (end < 0) return false;
  const next = text[skipSpace(text, end + 1)];
  return next === undefined || !/[+.[?|&*-]/.test(next);
}

/** The start of the second argument of a call whose arguments start at `i`, or -1 when there is none. */
function secondArgument(text: string, i: number): number {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j]!;
    const end = literalEnd(text, j);
    if (end >= 0) { j = end; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) return -1; depth--; } else if (c === ',' && depth === 0) return j + 1;
  }
  return -1;
}

const htmlInjection: CodeCheck = async (input) => {
  const out: Fact[] = [];
  for (const { file, added, head } of await sources(input, SCRIPT_FILE)) {
    const report = (line: number, sink: string): void => {
      out.push({ checkId: 'extension-html-injection', path: file.path, line, message: `An added line gives ${sink} something other than fixed text.` });
    };
    const scan = (text: string, lineOf: (index: number) => number | null): void => {
      for (const m of text.matchAll(SINK)) {
        const line = lineOf(m.index);
        if (line === null) continue;
        const after = m.index + m[0].length;
        const value = m[2] === undefined ? after : secondArgument(text, after);
        if (value < 0 || !isFixedText(text, value)) report(line, m[1] ?? m[2]!);
      }
    };
    const headLines = head?.split('\n');
    const whole = head !== null && [...added].every(([n, t]) => headLines?.[n - 1]?.replace(/\r$/, '') === t.replace(/\r$/, ''));
    if (whole) {
      const code = scriptViews(head).code.join('\n');
      const starts = [0];
      for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
      scan(code, (index) => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= index) lo = mid; else hi = mid - 1; }
        return added.has(lo + 1) ? lo + 1 : null;
      });
    } else {
      for (const [n, text] of added) scan(scriptViews(text).code[0]!, () => n);
    }
  }
  return { facts: out };
};

// ---------------------------------------------------------------------------------------------------------------------
// Files

const extensionOf = (path: string): string => {
  const name = posix.basename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};

const largeFiles: CodeCheck = async (input) => {
  const out: Fact[] = [];
  for (const f of live(input.files)) {
    const ext = extensionOf(f.path);
    const becameArchive = f.status === 'renamed' && f.oldPath !== null && extensionOf(f.oldPath) !== ext;
    if (ARCHIVE.has(ext) && (f.status === 'added' || becameArchive)) {
      out.push({ checkId: 'extension-large-files', path: f.path, line: null, message: `An archive (.${ext}) is added to the repository.` });
    }
    const size = await input.sizeOfHead(f.path);
    if (size !== null && size > LARGE_BYTES) {
      out.push({
        checkId: 'extension-large-files', path: f.path, line: null,
        message: `${f.path} is ${Math.round(size / 1000)} kB, over the ${LARGE_BYTES / 1000} kB a file should stay under.`,
      });
    }
  }
  return { facts: out };
};

/** The extension checks, by the id a pack names them with. */
export const EXTENSION_CHECKS: Readonly<Record<string, CodeCheck>> = {
  'extension-permissions': permissions,
  'extension-broad-hosts': broadHosts,
  'extension-version-changelog': versionChangelog,
  'extension-remote-code': remoteCode,
  'extension-html-injection': htmlInjection,
  'extension-large-files': largeFiles,
  'extension-loaded-files': loadedFilesCheck,
};
