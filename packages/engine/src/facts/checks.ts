import { posix } from 'node:path';
import type { Fact, FileDiff } from '@airlock/shared';
import picomatch from 'picomatch';
import { SYMLINK_MODE } from '../diff/parse.js';
import type { CheckDef, Pack } from '../packs/types.js';
import { isIgnoredPath, type FromChecks, type ReadClosely } from './classify.js';
import { EXTENSION_CHECKS, type CodeCheck, type CodeCheckInput } from './extension-checks.js';

type ReadHead = (path: string) => Promise<string | null>;

/** The code checks a pack can name under `codeChecks:`, by id. */
export const CODE_CHECKS: Readonly<Record<string, CodeCheck>> = { ...EXTENSION_CHECKS };
export const CODE_CHECK_IDS: readonly string[] = Object.keys(CODE_CHECKS);

/** What the code checks may look at besides the head: the base side of the pull request and the size of a head file. */
export interface OtherSides {
  /** Reads a file of the base worktree; nothing is at the base when not given. */
  readBase?: (path: string) => Promise<string | null>;
  /** The size in bytes of a head file; unknown when not given. */
  sizeOfHead?: (path: string) => Promise<number | null>;
  /** Whether anything is at a path at the head, readable or not; nothing is, when not given. */
  presentAtHead?: (path: string) => Promise<boolean>;
}

const nothing = async (): Promise<null> => null;
const factKey = (f: Fact): string => JSON.stringify([f.checkId, f.path, f.line, f.message]);

const matches = (globs: string[], path: string): boolean => globs.some((g) => picomatch(g, { dot: true })(path));
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(pack: Pack, check: CheckDef, source: string): RegExp {
  try {
    return new RegExp(source);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`pack "${pack.id}" check "${check.id}": invalid pattern ${JSON.stringify(source)}: ${why}`);
  }
}

const inScope = (check: CheckDef, path: string): boolean =>
  matches(check.paths, path) && !matches(check.exceptPaths ?? [], path);

const byPathThenLine = (a: Fact, b: Fact): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : (a.line ?? 0) - (b.line ?? 0);

/** Reads each path once, however many checks ask for it. */
function once<T>(read: (path: string) => Promise<T>): (path: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (path) => {
    let hit = cache.get(path);
    if (!hit) { hit = read(path); cache.set(path, hit); }
    return hit;
  };
}

/**
 * Runs each pack's own checks, then the code checks it names (facts/extension-checks.ts), in pack order. A code check runs
 * once however many packs name it, and a fact two code checks both give (a manifest that is not JSON) is kept once.
 * Nothing here runs code from the pull request: files are only read through the given readers.
 */
export async function runChecks(files: FileDiff[], packs: Pack[], readHead: ReadHead, sides: OtherSides = {}): Promise<Fact[]> {
  return (await gatherChecks(files, packs, readHead, sides)).facts;
}

/**
 * runChecks, with what the code checks said about tiers (each entry with the first pack that named the check): files to read
 * closely whatever their path says, and files not to trust as tests. The facts stage runs this before it settles the tiers.
 */
export async function gatherChecks(
  files: FileDiff[], packs: Pack[], readHead: ReadHead, sides: OtherSides = {},
): Promise<{ facts: Fact[] } & FromChecks> {
  const read = once(readHead);
  const out: Fact[] = [];
  for (const pack of packs) {
    for (const check of pack.checks) {
      const facts = await runOne(pack, check, files, read);
      out.push(...facts.sort(byPathThenLine));
    }
  }

  // A symbolic link holds a path, not code, so no code check reads it.
  const live = files.filter((f) => f.mode !== SYMLINK_MODE);
  const input: CodeCheckInput = {
    files: live, readHead: read, readBase: once(sides.readBase ?? nothing), sizeOfHead: once(sides.sizeOfHead ?? nothing),
    presentAtHead: once(sides.presentAtHead ?? (async () => false)),
    isIgnored: (path) => isIgnoredPath(path, packs),
  };
  const ran = new Set<string>();
  const seen = new Set<string>();
  const readClosely: ReadClosely[] = [];
  const notTrusted: ReadClosely[] = [];
  const notIgnored: ReadClosely[] = [];
  for (const pack of packs) {
    for (const id of pack.codeChecks ?? []) {
      if (ran.has(id)) continue;
      ran.add(id);
      const check = Object.hasOwn(CODE_CHECKS, id) ? CODE_CHECKS[id] : undefined;
      if (check === undefined) throw new Error(`No code check is called "${id}".`);
      const result = await check(input);
      for (const fact of result.facts.sort(byPathThenLine)) {
        const key = factKey(fact);
        if (!seen.has(key)) { seen.add(key); out.push(fact); }
      }
      for (const r of result.readClosely ?? []) {
        if (!readClosely.some((c) => c.path === r.path)) readClosely.push({ path: r.path, packId: pack.id, reason: r.reason });
      }
      for (const r of result.notTrusted ?? []) {
        if (!notTrusted.some((c) => c.path === r.path)) notTrusted.push({ path: r.path, packId: pack.id, reason: r.reason });
      }
      for (const r of result.notIgnored ?? []) {
        if (!notIgnored.some((c) => c.path === r.path)) notIgnored.push({ path: r.path, packId: pack.id, reason: r.reason });
      }
    }
  }
  return { facts: out, readClosely, notTrusted, notIgnored };
}

async function runOne(pack: Pack, check: CheckDef, files: FileDiff[], read: ReadHead): Promise<Fact[]> {
  const fact = (path: string, line: number | null, message = check.message): Fact => ({ checkId: check.id, path, line, message });
  const pattern = check.pattern !== undefined ? compile(pack, check, check.pattern) : null;
  // A symbolic link holds a path, not code, so no check reads it.
  const live = files.filter((f) => f.status !== 'deleted' && f.mode !== SYMLINK_MODE);
  const facts: Fact[] = [];

  switch (check.kind) {
    case 'added-line-matches':
      if (!pattern) break;
      for (const f of live.filter((x) => inScope(check, x.path))) {
        for (const hunk of f.hunks) {
          for (const l of hunk.lines) {
            if (l.kind === 'add' && l.newNo !== null && pattern.test(l.text)) facts.push(fact(f.path, l.newNo));
          }
        }
      }
      break;
    case 'file-pair': {
      const triggers = live.filter((f) => matches(check.paths, f.path));
      const missing = (check.requires ?? []).some((r) => !files.some((f) => matches([r.path], f.path)));
      if (missing) for (const f of triggers) facts.push(fact(f.path, null));
      break;
    }
    case 'new-file-requires':
      for (const f of live.filter((x) => x.status === 'added' && matches(check.paths, x.path))) {
        const folder = posix.dirname(f.path);
        const dir = posix.basename(folder);
        const above = posix.dirname(folder);
        const parent = folder === '.' || above === '.' ? '' : posix.basename(above);
        for (const req of check.requires ?? []) {
          const target = req.path.replaceAll('{self}', f.path).replaceAll('{parent}', parent).replaceAll('{dir}', dir);
          const text = await read(target);
          const wanted = req.pattern !== undefined
            ? compile(pack, check, req.pattern.replaceAll('{parent}', escapeRegExp(parent)).replaceAll('{dir}', escapeRegExp(dir)))
            : null;
          if (text === null || (wanted !== null && !wanted.test(text))) {
            facts.push(fact(f.path, null, `${check.message} (missing in ${target})`));
          }
        }
      }
      break;
    case 'file-touched':
      for (const f of files.filter((x) => inScope(check, x.path))) facts.push(fact(f.path, null));
      break;
  }
  return facts;
}
