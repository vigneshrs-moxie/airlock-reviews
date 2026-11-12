import { posix } from 'node:path';
import type { Fact, FileDiff } from '@airlock/shared';
import picomatch from 'picomatch';
import { builtInIgnoreWords } from './classify.js';

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
/** A check's facts, and what it says about tiers: changed files to read closely, and changed files not to trust as tests. */
export interface CodeCheckResult {
  facts: Fact[];
  readClosely?: { path: string; reason: string }[];
  notTrusted?: { path: string; reason: string }[];
}
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
/** The extension's manifest: only the one at the top of the repository counts. */
const MANIFEST = 'manifest.json';
const isManifest = (path: string): boolean => path === MANIFEST;

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
 * The top-level manifest.json when it changed, with both sides read; a renamed one is read at its old path on the
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
const headNotJson = (path: string): string =>
  `${path} could not be read as JSON, so its permissions and version were not compared and so no file could be trusted as a test.`;
/** The facts saying a side of a manifest is not JSON: the head stops the comparison, the base leaves "before" unknown. */
function jsonFacts(m: ChangedManifest): Fact[] {
  const out: Fact[] = [];
  if (m.base.kind === 'bad') {
    out.push({ checkId: NOT_JSON, path: m.path, line: null, message: `${m.path} could not be read as JSON before this pull request, so what it held before is not known.` });
  }
  if (m.head.kind === 'bad') {
    out.push({ checkId: NOT_JSON, path: m.path, line: null, message: headNotJson(m.path) });
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

  for (const log of live(input.files).filter((f) => isChangelog(f.path) && posix.dirname(f.path) === '.')) {
    const manifestPath = MANIFEST;
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

/** Page text with every comment blanked, line breaks kept; a loop, not a pattern, so many unclosed `<!--` cost one pass. */
function htmlView(text: string): string[] {
  let out = '';
  let at = 0;
  for (;;) {
    const open = text.indexOf('<!--', at);
    if (open < 0) break;
    const close = text.indexOf('-->', open + 4);
    const end = close < 0 ? text.length : close + 3;
    out += text.slice(at, open) + text.slice(open, end).replace(/[^\n]/g, ' ');
    at = end;
  }
  return (out + text.slice(at)).split('\n');
}

/**
 * No pattern of these checks sees more than MAX_LINE characters of one line: a longer line (a minified file is one) is cut
 * into pieces of MAX_LINE, each starting PIECE_STEP after the one before, so a call that crosses a cut is still whole in
 * one piece when it is shorter than the overlap. Every pattern's work is then bounded by the piece, whatever the file.
 */
const MAX_LINE = 2000;
const PIECE_STEP = 1500;
function pieces(line: string): string[] {
  if (line.length <= MAX_LINE) return [line];
  const out: string[] = [];
  for (let i = 0; ; i += PIECE_STEP) {
    out.push(line.slice(i, i + MAX_LINE));
    if (i + MAX_LINE >= line.length) return out;
  }
}

/** Lines cut into pieces (see `pieces`) and joined, with the line each piece came from (1-based), for patterns that span lines. */
function scanText(lines: string[]): { text: string; lineAt: (index: number) => number } {
  const parts: string[] = [];
  const lineOf: number[] = [];
  lines.forEach((line, i) => { for (const p of pieces(line)) { parts.push(p); lineOf.push(i + 1); } });
  const starts: number[] = [];
  let offset = 0;
  for (const p of parts) { starts.push(offset); offset += p.length + 1; }
  const lineAt = (index: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= index) lo = mid; else hi = mid - 1; }
    return lineOf[lo] ?? 1;
  };
  return { text: parts.join('\n'), lineAt };
}

// ---------------------------------------------------------------------------------------------------------------------
// The files the extension loads

/** A path named relative to `dir`, from the repository root (a leading `/` is the extension's root); null when it leaves it. */
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

/**
 * How Chrome matches a manifest entry against the extension's files: from the extension's root after a leading `./` or
 * `/`, letter case ignored here, a `*` matching any run of characters (`/` included) and every other character itself.
 * No regular expression: runs of `*` are one `*`, and a two-pointer match goes back only to the last `*`, so an entry
 * full of stars costs at most its length times the path's.
 */
function entryMatches(entry: string, path: string): boolean {
  const p = entry.toLowerCase().replace(/\*+/g, '*');
  const t = path.toLowerCase();
  let i = 0;
  let j = 0;
  let star = -1;
  let from = 0;
  while (j < t.length) {
    if (i < p.length && p[i] === '*') {
      star = i++;
      from = j;
    } else if (i < p.length && p[i] === t[j]) {
      i++;
      j++;
    } else if (star >= 0) {
      // the last star takes one more character, and the rest of the entry is tried from there
      i = star + 1;
      j = ++from;
    } else return false;
  }
  while (i < p.length && p[i] === '*') i++;
  return i === p.length;
}
const stripLead = (entry: string): string => entry.replace(/^(?:\.?\/)+/, '');

interface Loaded {
  /** The changed files the extension loads, each with why (`loaded by <the manifest, a page or a script>`). */
  files: Map<string, string>;
  /** Whether the head's manifest.json could be read; when not, nothing can be trusted as a test. */
  manifestRead: boolean;
  facts: Fact[];
}

/** At most this many files are read while following what loads what; past it a fact says the rest were not followed. */
export const MAX_FOLLOWED = 200;

const loadedMemo = new WeakMap<CodeCheckInput, Promise<Loaded>>();

/**
 * The changed files the extension loads, from the head's top-level manifest.json, read whether it changed or not: every
 * path it names (a `*` taking in every changed file it matches), and then, through the whole chain, what each loaded page
 * and script loads in turn, read from its head text whether or not it changed (see `loadsIn` and `pageScripts`). An entry
 * holding `..` promotes nothing and is a fact; past MAX_FOLLOWED files read, a fact says the rest were not followed.
 */
function loadedFiles(input: CodeCheckInput): Promise<Loaded> {
  let hit = loadedMemo.get(input);
  if (!hit) { hit = findLoaded(input); loadedMemo.set(input, hit); }
  return hit;
}

const SRC_ATTRIBUTE = /\bsrc\s{0,50}=\s{0,50}["']?\s{0,50}([^"'\s>]{1,1000})/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The `src` of every `<script>` tag in page text (comments already blanked). A loop, not one pattern: each tag is read up to
 * its `>`, the next `<` or MAX_LINE characters, whichever is first, so the tags' texts never overlap and a page of many
 * unclosed `<script` costs one pass.
 */
function scriptSources(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  let gt = -2; // the first `>` at or after the current tag; -1 when there is none left
  for (let at = lower.indexOf('<script'); at >= 0; at = lower.indexOf('<script', at + 7)) {
    if (/\w/.test(lower[at + 7] ?? '')) continue;
    if (gt !== -1 && gt < at) gt = lower.indexOf('>', at);
    const lt = lower.indexOf('<', at + 1);
    const end = Math.min(gt < 0 ? text.length : gt, lt < 0 ? text.length : lt, at + MAX_LINE);
    const src = text.slice(at, end).match(SRC_ATTRIBUTE)?.[1];
    if (src !== undefined) out.push(src);
  }
  return out;
}

/** The local scripts a page pulls in with `<script src>`, relative to the page. */
function pageScripts(text: string, page: string): string[] {
  const out: string[] = [];
  for (const raw of scriptSources(htmlView(text).join('\n'))) {
    const src = raw.replace(/[?#].*$/, '');
    if (src === '' || HAS_SCHEME.test(src) || src.startsWith('//')) continue;
    const path = resolveIn(posix.dirname(page), src);
    if (path !== null) out.push(path);
  }
  return out;
}

/** A path a script loads with a literal string, on which line, and the folder the loaded file's own relative addresses resolve against. */
interface Load { line: number; path: string; base: string }

const FROM_OR_IMPORT = /\b(?:from|import)\s{0,200}(?:\(\s{0,200})?(['"`])([^'"`\n]{1,500})\1/g;
const IMPORT_SCRIPTS = /\bimportScripts\s{0,200}\(([^)]{0,1500})\)/g;
const WORKER = /\bnew\s{1,200}(?:Shared)?Worker\s{0,200}\(\s{0,200}(['"`])([^'"`\n]{1,500})\1/g;
const SCRIPT_CALL = /\b(executeScript|registerContentScripts|updateContentScripts|createDocument)\s{0,200}\(/g;
/** How far past one of SCRIPT_CALL's names its `files`, `js` or `url` is looked for. */
const CALL_WINDOW = 1000;
const LIST_OF = (key: string): RegExp => new RegExp(`\\b${key}\\s{0,50}:\\s{0,50}\\[([^\\]]{0,1000})\\]`);
const URL_FIELD = /\burl\s{0,50}:\s{0,50}(['"`])([^'"`\n]{1,500})\1/;
const QUOTED = /(['"`])([^'"`\n]{1,500})\1/g;

/**
 * Every repository path the script `file` (its lines with comments blanked) loads code from with a literal string:
 * `import … from`, `import '…'` and `import('…')` (relative ones, from the script's folder); `importScripts` and
 * `new Worker` (from `base`, the folder of the page or worker the script runs in); `executeScript({ files })`, the `js`
 * lists of `registerContentScripts` and `updateContentScripts`, and `offscreen.createDocument({ url })` (from the
 * extension's root). `getURL` is not followed: it names any resource, not code. Every pattern is bounded and sees at most
 * MAX_LINE characters of a line, so no input makes it slow.
 */
function loadsIn(lines: string[], file: string, base: string): Load[] {
  const { text, lineAt } = scanText(lines);
  const out: Load[] = [];
  /** `baseOf` is the base of the loaded file: the same as this script's, its own folder (a worker), or the root. */
  const add = (at: number, from: string, named: string, baseOf: 'same' | 'own' | 'root'): void => {
    if (named.includes('${') || HAS_SCHEME.test(named) || named.startsWith('//')) return;
    const path = resolveIn(from, named.replace(/[?#].*$/, ''));
    if (path === null) return;
    out.push({ line: lineAt(at), path, base: baseOf === 'same' ? base : baseOf === 'own' ? posix.dirname(path) : '.' });
  };
  const quotedIn = (inner: string, at: number, from: string, baseOf: 'same' | 'root'): void => {
    for (const q of inner.matchAll(QUOTED)) add(at + q.index, from, q[2]!, baseOf);
  };
  for (const m of text.matchAll(FROM_OR_IMPORT)) {
    const spec = m[2]!;
    if (spec.startsWith('.') || spec.startsWith('/')) add(m.index + m[0].length - 1, posix.dirname(file), spec, 'same');
  }
  for (const m of text.matchAll(IMPORT_SCRIPTS)) quotedIn(m[1]!, m.index + m[0].indexOf('(') + 1, base, 'same');
  for (const m of text.matchAll(WORKER)) add(m.index + m[0].length - 1, base, m[2]!, 'own');
  for (const m of text.matchAll(SCRIPT_CALL)) {
    const call = text.slice(m.index, m.index + CALL_WINDOW);
    if (m[1] === 'createDocument') {
      const url = call.match(URL_FIELD);
      if (url?.index !== undefined) add(m.index + url.index, '.', url[2]!, 'root');
      continue;
    }
    // chrome.scripting takes paths from the extension's root
    const list = call.match(LIST_OF(m[1] === 'executeScript' ? 'files' : 'js'));
    if (list?.index !== undefined) quotedIn(list[1]!, m.index + list.index + list[0].indexOf('[') + 1, '.', 'root');
  }
  return out;
}

async function findLoaded(input: CodeCheckInput): Promise<Loaded> {
  const files = new Map<string, string>();
  const facts: Fact[] = [];
  const changed = live(input.files);
  if (changed.length === 0) return { files, manifestRead: true, facts };
  const side = await manifestSide(input.readHead, MANIFEST, 'absent');
  if (side.kind !== 'ok') return { files, manifestRead: false, facts };

  // Letter case is ignored, as Chrome on a Mac ignores it.
  const changedPath = new Map(changed.map((f) => [f.path.toLowerCase(), f.path]));
  const queue: { path: string; base: string }[] = [];
  /** `path` is loaded by `by`: promoted when it changed, and followed when it is a script or a page. */
  const follow = (path: string, by: string, base: string): void => {
    const hit = changedPath.get(path.toLowerCase());
    if (hit !== undefined && !files.has(hit)) files.set(hit, `loaded by ${by}`);
    if (HTML_FILE.test(path) || SCRIPT_FILE.test(path)) queue.push({ path, base });
  };

  const background = side.json.background;
  const worker = isObj(background) ? background.service_worker : undefined;
  for (const named of namedPaths(side.json)) {
    const entry = stripLead(named);
    if (entry.split('/').includes('..')) {
      facts.push({ checkId: 'extension-loaded-files', path: MANIFEST, line: null, message: `The manifest names a path outside the extension: ${cut(named)}.` });
      continue;
    }
    // A service worker's addresses resolve from its own folder; the other scripts run in a page at the root or a site's page.
    const base = named === worker ? posix.dirname(entry) : '.';
    if (entry.includes('*')) {
      for (const f of changed) if (entryMatches(entry, f.path)) follow(f.path, MANIFEST, base);
    } else if (entry !== '') follow(entry, MANIFEST, base);
  }

  const seen = new Set<string>();
  for (let next = 0; next < queue.length; next++) {
    const { path, base } = queue[next]!;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    if (seen.size >= MAX_FOLLOWED) {
      facts.push({
        checkId: 'extension-loaded-files', path: MANIFEST, line: null,
        message: `More than ${MAX_FOLLOWED} files load one another from ${MANIFEST} on, so the rest were not followed: a changed file only they load is not read closely for being loaded.`,
      });
      break;
    }
    seen.add(key);
    const text = await input.readHead(changedPath.get(key) ?? path);
    if (text === null) continue;
    if (HTML_FILE.test(path)) {
      for (const script of pageScripts(text, path)) follow(script, path, posix.dirname(path));
    } else {
      for (const load of loadsIn(scriptViews(text).code, path, base)) follow(load.path, path, load.base);
    }
  }
  return { files, manifestRead: true, facts };
}

const withTests = (path: string): string | null =>
  underTestFolder(path) ? 'sits under a test or fixture folder' : namedLikeTest(path) ? 'is named like a test' : null;

/** What the added lines of `file` load: read from the whole head text where it holds the line, else from the line alone. */
function addedLoads(file: string, added: Map<number, string>, head: string | null): Load[] {
  const headLines = head?.split('\n');
  const inHead = (n: number, text: string): boolean => headLines?.[n - 1]?.replace(/\r$/, '') === text.replace(/\r$/, '');
  const base = posix.dirname(file);
  const out = head === null ? [] : loadsIn(scriptViews(head).code, file, base).filter((l) => {
    const text = added.get(l.line);
    return text !== undefined && inHead(l.line, text);
  });
  for (const [n, text] of added) {
    if (!inHead(n, text)) out.push(...loadsIn([scriptViews(text).code[0]!], file, base).map((l) => ({ ...l, line: n })));
  }
  return out;
}

const CODE_FILE = /\.(?:m?js|cjs|jsx|tsx?|gs|html?|css|json)$/i;
const NO_MANIFEST = 'manifest.json could not be read, so no file is trusted as a test';

const loadedFilesCheck: CodeCheck = async (input) => {
  const loaded = await loadedFiles(input);
  const facts: Fact[] = [...loaded.facts];
  for (const path of loaded.files.keys()) {
    const where = withTests(path);
    if (where !== null) facts.push({ checkId: 'extension-loaded-files', path, line: null, message: `${path} ${where} but the extension loads it.` });
  }
  // The built-in rules leave out minified, built and generated files as if a build made them; here a person committed them.
  for (const f of live(input.files)) {
    if (f.binary || !SCRIPT_FILE.test(f.path) || loaded.files.has(f.path)) continue;
    const words = builtInIgnoreWords(f.path);
    if (words !== null) {
      facts.push({
        checkId: 'extension-loaded-files', path: f.path, line: null,
        message: `${f.path} is not reviewed (${words}, a built-in rule), but an extension has no build step, so Chrome may load this file.`,
      });
    }
  }
  const notTrusted: { path: string; reason: string }[] = [];
  if (!loaded.manifestRead) {
    // Unread, the manifest could load any file: none is trusted as a test, and the fact says why.
    const side = await manifestSide(input.readHead, MANIFEST, 'absent');
    facts.push({
      checkId: NOT_JSON, path: MANIFEST, line: null,
      message: side.kind === 'bad' ? headNotJson(MANIFEST) : `${MANIFEST} could not be read at the head, so no file could be trusted as a test.`,
    });
    for (const f of live(input.files)) if (CODE_FILE.test(f.path)) notTrusted.push({ path: f.path, reason: NO_MANIFEST });
  }
  for (const { file, added, head } of await sources(input, SCRIPT_FILE)) {
    // A test loading its own fixtures is not news; a file the extension loads is not a test.
    if (!loaded.files.has(file.path) && withTests(file.path) !== null) continue;
    for (const { line, path: target } of addedLoads(file.path, added, head)) {
      const where = withTests(target);
      if (where !== null) {
        facts.push({ checkId: 'extension-loaded-files', path: file.path, line, message: `An added line loads ${target}, which ${where}.` });
      }
    }
  }
  return { facts, readClosely: [...loaded.files].map(([path, reason]) => ({ path, reason })), notTrusted };
};

/**
 * The script or page files of the pull request worth scanning, with their added lines and their head text: not a trusted test
 * (one only while the manifest can be read) and not an ignored file (minified, built, vendored), unless the extension loads it.
 */
async function sources(input: CodeCheckInput, pick: RegExp): Promise<{ file: FileDiff; added: Map<number, string>; head: string | null }[]> {
  const loaded = await loadedFiles(input);
  const out = [];
  for (const file of live(input.files)) {
    if (!pick.test(file.path) || file.binary) continue;
    const scanned = loaded.files.has(file.path) || (!input.isIgnored(file.path) && !(isTrustedTest(file.path) && loaded.manifestRead));
    if (!scanned) continue;
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

const EVAL = /(?<![\w$])eval\s{0,200}\(/;
const FUNCTION = /(?<![\w$.])Function\s{0,200}\(/;
const PLAIN_ADDRESS = /\b(?:http|ws):\/\/[^\s'"`<>)\\]{1,1000}/gi;
const XML_NAMESPACE = /^http:\/\/www\.w3\.org\//i;
const secure = (address: string): string => (/^ws:/i.test(address) ? 'wss' : 'https');

const remoteCode: CodeCheck = async (input) => {
  const out: Fact[] = [];
  for (const { file, added, head } of await sources(input, SCRIPT_FILE)) {
    const fact = (line: number, message: string): void => { out.push({ checkId: 'extension-remote-code', path: file.path, line, message }); };
    const views = viewOfLines(head, added, (t) => { const v = scriptViews(t); return v.code.map((code, i) => ({ code, bare: v.bare[i]! })); });
    for (const [n, view] of views) {
      // The two views have the same length, so their pieces line up.
      const bares = pieces(view.bare);
      pieces(view.code).forEach((code, i) => {
        const bare = bares[i]!;
        if (EVAL.test(bare)) fact(n, 'An added line runs text as code with eval.');
        if (FUNCTION.test(bare)) fact(n, 'An added line builds a function from text with new Function.');
        for (const [address] of code.matchAll(PLAIN_ADDRESS)) {
          if (!XML_NAMESPACE.test(address)) fact(n, `An added line has the address ${cut(address)}, which is not ${secure(address)}.`);
        }
      });
    }
  }
  for (const { file, added, head } of await sources(input, HTML_FILE)) {
    for (const [n, line] of viewOfLines(head, added, htmlView)) {
      for (const piece of pieces(line)) {
        for (const address of scriptSources(piece).filter((src) => /^(?:http|ws):\/\//i.test(src))) {
          out.push({
            checkId: 'extension-remote-code', path: file.path, line: n,
            message: `An added line loads a script from ${cut(address)}, which is not ${secure(address)}.`,
          });
        }
      }
    }
  }
  // A piece overlaps the one before it, so one address may be seen twice: each fact once.
  return { facts: [...new Map(out.map((f) => [JSON.stringify([f.line, f.message]), f])).values()] };
};

const SINK = /\.(innerHTML|outerHTML)\s{0,200}(?:\+=|=(?!=))|\.(insertAdjacentHTML)\s{0,200}\(/g;

/**
 * The hand scanners below look at most MAX_LINE characters past where they start, so a file of many unclosed calls or
 * strings costs no more than its length times MAX_LINE; what runs past that is not one fixed text.
 */
const scanEnd = (text: string, i: number): number => Math.min(text.length, i + MAX_LINE);

/** The end of the string literal opening at `i` (the index of its closing quote), or -1 when it is not one fixed text. */
function literalEnd(text: string, i: number): number {
  const quote = text[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return -1;
  for (let j = i + 1, end = scanEnd(text, i); j < end; j++) {
    const c = text[j];
    if (c === '\\') { j++; continue; }
    if (c === quote) return j;
    if (quote === '`' && c === '$' && text[j + 1] === '{') return -1;
    if (quote !== '`' && c === '\n') return -1;
  }
  return -1;
}

const skipSpace = (text: string, i: number): number => {
  for (const end = scanEnd(text, i); i < end && /\s/.test(text[i]!);) i++;
  return i;
};

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
  for (let j = i, end = scanEnd(text, i); j < end; j++) {
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
      const { text, lineAt } = scanText(scriptViews(head).code);
      scan(text, (index) => { const n = lineAt(index); return added.has(n) ? n : null; });
    } else {
      for (const [n, text] of added) scan(scanText([scriptViews(text).code[0]!]).text, () => n);
    }
  }
  // A long line's pieces overlap, so one sink may be seen twice: each fact once.
  return { facts: [...new Map(out.map((f) => [JSON.stringify([f.line, f.message]), f])).values()] };
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
