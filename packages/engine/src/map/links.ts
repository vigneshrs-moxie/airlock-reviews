import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { FileDiff, Link } from '@airlock/shared';
import picomatch from 'picomatch';
import type { LinkRule, Pack } from '../packs/types.js';
import type { Exec } from '../util/exec.js';
import { limiter } from '../util/limit.js';
import { gitGrep, type GrepHit, trackedFiles } from './git-files.js';
import {
  changedExports, type FileSymbols, insideHead, isScript, makeResolver, readSymbols, repoPath, type Resolve,
} from './ts-symbols.js';

const HITS_PER_NAME = 40;
const MAX_NAMES = 600;
const STOP_NAMES = new Set([
  'default', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'metadata', 'config', 'dynamic',
  'revalidate', 'runtime', 'maxDuration', 'generateMetadata',
]);
const OTHER_NAME_RE = /^\s*(?:export\s+)?(?:async\s+)?(?:def|class|func|function|fn)\s+([A-Za-z_]\w*)/;
const TEST_NAME_RE = /^(.*?)\.(?:test|spec|dbtest)\.[^/]*$/;

const addedLines = (f: FileDiff): { no: number; text: string }[] =>
  f.hunks.flatMap((h) => h.lines.flatMap((l) => (l.kind === 'add' && l.newNo !== null ? [{ no: l.newNo, text: l.text }] : [])));

const dirOf = (path: string): string => {
  const d = posix.dirname(path);
  return d === '.' ? '' : d;
};
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const withoutExt = (base: string): string => base.slice(0, base.length - posix.extname(base).length);

const isTestFile = (path: string): boolean =>
  TEST_NAME_RE.test(posix.basename(path)) || path.split('/').includes('__tests__');

/** The file a test exercises: same stem beside it, beside its `__tests__` folder, or under a mirrored `src/`. */
function testSubject(path: string, byDir: Map<string, string[]>): string | null {
  const base = posix.basename(path);
  const stem = TEST_NAME_RE.exec(base)?.[1] ?? withoutExt(base);
  const dir = dirOf(path);
  const segs = dir === '' ? [] : dir.split('/');
  const plain = segs.at(-1) === '__tests__' ? segs.slice(0, -1) : segs;
  const dirs = [dir, plain.join('/')];
  const top = plain.findIndex((s) => s === 'test' || s === 'tests');
  if (top >= 0) dirs.push([...plain.slice(0, top), 'src', ...plain.slice(top + 1)].join('/'));
  for (const d of new Set(dirs)) {
    const found = (byDir.get(d) ?? [])
      .filter((p) => p !== path && !isTestFile(p) && withoutExt(posix.basename(p)) === stem)
      .sort((a, b) => Number(posix.extname(b) === posix.extname(base)) - Number(posix.extname(a) === posix.extname(base)));
    if (found[0] !== undefined) return found[0];
  }
  return null;
}

function transform(token: string, how: LinkRule['transform']): string {
  if (how === 'none') return token;
  const pascal = token.split(/[^A-Za-z0-9]+/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  return how === 'pascal' ? pascal : pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

interface CompiledRule { rule: LinkRule; capture: RegExp; applies: (path: string) => boolean }

function compileRules(packs: Pack[]): CompiledRule[] {
  return packs.flatMap((pack) => pack.linkRules.map((rule) => {
    const build = <T>(step: string, source: string, make: () => T): T => {
      try {
        return make();
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(`pack "${pack.id}" link rule "${rule.id}": invalid ${step} ${JSON.stringify(source)}: ${why}`);
      }
    };
    const applies = build('from glob', rule.from, () => picomatch(rule.from, { dot: true }));
    const capture = build('capture', rule.capture, () => new RegExp(rule.capture, 'g'));
    return { rule, capture, applies };
  }));
}

interface FileNames { path: string; added: boolean; names: string[] }

/** The (name, defining file) pairs to search, at most 600 distinct names: added files first, then files with fewer names, then path. */
function pickNames(files: FileNames[]): { picks: { name: string; path: string }[]; skippedNames: number } {
  const order = [...files].sort((a, b) => Number(b.added) - Number(a.added) || a.names.length - b.names.length || cmp(a.path, b.path));
  const kept = new Set<string>();
  const all = new Set<string>();
  const picks: { name: string; path: string }[] = [];
  for (const f of order) {
    for (const name of f.names) {
      all.add(name);
      if (!kept.has(name) && kept.size >= MAX_NAMES) continue;
      kept.add(name);
      picks.push({ name, path: f.path });
    }
  }
  return { picks, skippedNames: all.size - kept.size };
}

/** Reads each file of the head at most once; files outside `headDir` read as missing. */
function symbolReader(headDir: string, resolve: Resolve): (path: string) => Promise<FileSymbols> {
  const cache = new Map<string, Promise<FileSymbols>>();
  const read = limiter(32);
  const load = async (path: string): Promise<FileSymbols> => {
    const rel = repoPath(path);
    if (rel === null || !isScript(rel) || !(await insideHead(headDir, rel))) return { imports: [], exports: [] };
    const text = await read(() => readFile(join(headDir, rel), 'utf8').catch(() => null));
    return text === null ? { imports: [], exports: [] } : readSymbols(rel, text, resolve);
  };
  return (path) => {
    let hit = cache.get(path);
    if (!hit) { hit = load(path); cache.set(path, hit); }
    return hit;
  };
}

/**
 * Code-only links between the changed files and the rest of the head: imports, uses, tests and pack conventions.
 * `skippedNames` counts changed names left unsearched once 600 distinct names were reached.
 */
export async function findLinks(exec: Exec, headDir: string, files: FileDiff[], packs: Pack[]): Promise<{ links: Link[]; skippedNames: number }> {
  const rules = compileRules(packs);
  const limit = limiter(8);
  const greps = new Map<string, Promise<GrepHit[]>>();
  const grep = (token: string, pathspecs: string[] = []): Promise<GrepHit[]> => {
    const key = [token, ...pathspecs].join('\0');
    let hit = greps.get(key);
    if (!hit) { hit = limit(() => gitGrep(exec, headDir, token, pathspecs)); greps.set(key, hit); }
    return hit;
  };
  const resolve = await makeResolver(headDir, packs.find((p) => p.appRoot !== null)?.appRoot ?? null);
  const symbols = symbolReader(headDir, resolve);
  const live = files.filter((f) => f.status !== 'deleted' && !f.binary);

  const byDir = new Map<string, string[]>();
  if (live.some((f) => isTestFile(f.path))) {
    for (const p of await trackedFiles(exec, headDir)) {
      const list = byDir.get(dirOf(p)) ?? [];
      list.push(p);
      byDir.set(dirOf(p), list);
    }
  }

  const links: Link[] = [];
  const searches: Promise<Link[]>[] = [];
  const named: FileNames[] = [];

  const uses = async (name: string, defining: string): Promise<Link[]> => {
    const out: Link[] = [];
    for (const h of await grep(name)) {
      if (out.length >= HITS_PER_NAME) break;
      if (h.path === defining) continue;
      if (isScript(h.path) && !(await symbols(h.path)).imports.some((i) => i.resolved === defining)) continue;
      out.push({ from: h.path, to: defining, kind: 'uses', detail: name, line: h.line });
    }
    return out;
  };

  const convention = async (c: CompiledRule, f: FileDiff, token: string): Promise<Link[]> => {
    const hits = (await grep(token, c.rule.searchIn.map((g) => `:(glob)${g}`)))
      .filter((h) => h.path !== f.path).slice(0, HITS_PER_NAME);
    return hits.map((h) => ({ from: f.path, to: h.path, kind: 'convention', detail: `${c.rule.detail}: ${token}`, line: h.line }));
  };

  for (const f of live) {
    const added = addedLines(f);
    let names: string[];
    if (isScript(f.path)) {
      const s = await symbols(f.path);
      for (const i of s.imports) {
        if (i.resolved !== null && i.resolved !== f.path) {
          links.push({ from: f.path, to: i.resolved, kind: 'imports', detail: i.spec, line: i.line });
        }
      }
      names = changedExports(s, f);
    } else {
      names = [...new Set(added.flatMap((l) => OTHER_NAME_RE.exec(l.text)?.[1] ?? []))];
    }
    named.push({ path: f.path, added: f.status === 'added', names: names.filter((n) => n.length >= 4 && !STOP_NAMES.has(n)) });

    if (isTestFile(f.path)) {
      const subject = testSubject(f.path, byDir);
      if (subject !== null) links.push({ from: f.path, to: subject, kind: 'tests', detail: 'test subject', line: null });
    }

    for (const c of rules.filter((r) => r.applies(f.path))) {
      const tokens = new Set<string>();
      for (const l of added) {
        for (const m of l.text.matchAll(c.capture)) {
          const token = m[1] === undefined ? '' : transform(m[1], c.rule.transform);
          if (token !== '') tokens.add(token);
        }
      }
      for (const t of tokens) searches.push(convention(c, f, t));
    }
  }

  const { picks, skippedNames } = pickNames(named);
  for (const p of picks) searches.push(uses(p.name, p.path));
  links.push(...(await Promise.all(searches)).flat());
  const unique = new Map(links.map((l) => [JSON.stringify([l.from, l.to, l.kind, l.detail, l.line]), l]));
  const sorted = [...unique.values()].sort((a, b) =>
    cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.kind, b.kind) || (a.line ?? 0) - (b.line ?? 0) || cmp(a.detail, b.detail));
  return { links: sorted, skippedNames };
}
