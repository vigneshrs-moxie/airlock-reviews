import { posix } from 'node:path';
import type { Fact, FileDiff } from '@airlock/shared';
import picomatch from 'picomatch';

/**
 * Code checks for Chrome extension repositories, named by a pack under `codeChecks:`. Each reads the pull request's files
 * only through the readers it is given (the engine's safe reader on the head and base worktrees), never runs the
 * extension's code, and gives facts for the lenses, never findings.
 */
export interface CodeCheckInput {
  /** The changed files, symbolic links left out. */
  files: FileDiff[];
  readHead: (path: string) => Promise<string | null>;
  readBase: (path: string) => Promise<string | null>;
  sizeOfHead: (path: string) => Promise<number | null>;
}
export type CodeCheck = (input: CodeCheckInput) => Promise<Fact[]>;

const TEST_GLOBS = ['**/tests/**', '**/test/**', '**/__tests__/**', '**/fixtures/**', '**/*.test.*', '**/*.spec.*'].map(
  (g) => picomatch(g, { dot: true }),
);
const isTestPath = (path: string): boolean => TEST_GLOBS.some((m) => m(path));
const SCRIPT_FILE = /\.(?:m?js|cjs|jsx|tsx?|gs)$/i;
const HTML_FILE = /\.html?$/i;
const ARCHIVE = new Set(['zip', 'crx', 'xpi', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar']);
const LARGE_BYTES = 500_000;

const live = (files: FileDiff[]): FileDiff[] => files.filter((f) => f.status !== 'deleted');
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const cut = (s: string, n = 100): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const besideIt = (dir: string, name: string): string => (dir === '.' ? name : `${dir}/${name}`);

/** The added lines of a file, by their line number on the head. */
function addedLines(file: FileDiff): Map<number, string> {
  const out = new Map<number, string>();
  for (const hunk of file.hunks) for (const l of hunk.lines) if (l.kind === 'add' && l.newNo !== null) out.set(l.newNo, l.text);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The manifest

type Side = { kind: 'absent' } | { kind: 'bad'; why: string } | { kind: 'ok'; json: Record<string, unknown>; text: string };

async function manifestSide(read: (path: string) => Promise<string | null>, path: string): Promise<Side> {
  const text = await read(path);
  if (text === null) return { kind: 'absent' };
  try {
    const json: unknown = JSON.parse(text.replace(/^﻿/, ''));
    return isObj(json) ? { kind: 'ok', json, text } : { kind: 'bad', why: 'it is not a JSON object' };
  } catch (err) {
    return { kind: 'bad', why: cut(oneLine(err instanceof Error ? err.message : String(err)), 160) };
  }
}

interface ChangedManifest { path: string; base: Side; head: Side }

/** Every changed manifest.json outside the tests, with both sides read; a renamed one is read at its old path on the base. */
async function changedManifests(input: CodeCheckInput): Promise<ChangedManifest[]> {
  const out: ChangedManifest[] = [];
  for (const f of live(input.files)) {
    if (posix.basename(f.path) !== 'manifest.json' || isTestPath(f.path)) continue;
    const base = f.status === 'added' ? { kind: 'absent' as const } : await manifestSide(input.readBase, f.oldPath ?? f.path);
    out.push({ path: f.path, base, head: await manifestSide(input.readHead, f.path) });
  }
  return out;
}

const NOT_JSON = 'extension-manifest-json';
/** The facts saying a side of a manifest is not JSON: the head stops the comparison, the base leaves "before" unknown. */
function jsonFacts(m: ChangedManifest): Fact[] {
  const out: Fact[] = [];
  if (m.base.kind === 'bad') {
    out.push({ checkId: NOT_JSON, path: m.path, line: null, message: `${m.path} was not valid JSON before this pull request, so what it held before is not known: ${m.base.why}.` });
  }
  if (m.head.kind === 'bad') {
    out.push({ checkId: NOT_JSON, path: m.path, line: null, message: `${m.path} is not valid JSON at the head, so its permissions, hosts and version were not compared: ${m.head.why}.` });
  }
  return out;
}

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
      if (m.base.kind === 'bad') {
        if (after.length > 0) fact(`${label} before: not known (the manifest was not valid JSON before this pull request); after: ${listed(after)}.`);
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
  return out;
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
        const when = m.base.kind === 'bad' ? 'not known whether it was there before'
          : before.includes(entry) ? 'already there before' : 'added in this pull request';
        const at = lines.findIndex((l) => l.includes(JSON.stringify(entry)));
        out.push({
          checkId: 'extension-broad-hosts', path: m.path, line: at >= 0 ? at + 1 : null,
          message: `${label} asks for ${JSON.stringify(entry)}, ${reach(entry)} (${when}).`,
        });
      }
    }
  }
  return out;
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
    input.files.find((f) => isChangelog(f.path) && posix.dirname(f.path) === dir);
  // Manifests whose version changed, or whose earlier version is not known: their changelog needs no fact of its own.
  const settled = new Set<string>();

  for (const m of await changedManifests(input)) {
    out.push(...jsonFacts(m));
    if (m.base.kind === 'bad') settled.add(m.path);
    if (m.head.kind !== 'ok' || m.base.kind === 'bad') continue;
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

  for (const log of live(input.files).filter((f) => isChangelog(f.path) && !isTestPath(f.path))) {
    const manifestPath = besideIt(posix.dirname(log.path), 'manifest.json');
    if (settled.has(manifestPath)) continue;
    const head = await manifestSide(input.readHead, manifestPath);
    if (head.kind !== 'ok') continue;
    const now = versionOf(head);
    const name = posix.basename(log.path);
    fact(log.path, now === null
      ? `${name} changed and manifest.json beside it has no version.`
      : `${name} changed and the version in manifest.json beside it is still ${now}.`);
  }
  return out;
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

/** The script and page files of the pull request that are not tests, with their added lines and their head text. */
async function sources(input: CodeCheckInput, pick: RegExp): Promise<{ file: FileDiff; added: Map<number, string>; head: string | null }[]> {
  const out = [];
  for (const file of live(input.files)) {
    if (!pick.test(file.path) || isTestPath(file.path)) continue;
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
  return out;
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
  return out;
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
    if (f.status === 'added' && ARCHIVE.has(ext)) {
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
  return out;
};

/** The extension checks, by the id a pack names them with. */
export const EXTENSION_CHECKS: Readonly<Record<string, CodeCheck>> = {
  'extension-permissions': permissions,
  'extension-broad-hosts': broadHosts,
  'extension-version-changelog': versionChangelog,
  'extension-remote-code': remoteCode,
  'extension-html-injection': htmlInjection,
  'extension-large-files': largeFiles,
};
