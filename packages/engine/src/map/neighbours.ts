import { posix } from 'node:path';
import type { FileDiff, Link, Neighbour } from '@airlock/shared';
import picomatch from 'picomatch';
import type { Pack } from '../packs/types.js';
import type { Exec } from '../util/exec.js';
import { limiter } from '../util/limit.js';
import { lastCommitTime, trackedFiles } from './git-files.js';

const CALLERS_PER_FILE = 6;
const SIBLINGS_PER_FILE = 2;
const SIBLINGS_TIMED = 60;
const ROLE_ORDER: Record<Neighbour['role'], number> = { caller: 0, callee: 1, sibling: 2 };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const dirSegments = (path: string): string[] => {
  const d = posix.dirname(path);
  return d === '.' ? [] : d.split('/');
};

/** How many leading directory names two paths share. */
function sharedDirs(a: string, b: string): number {
  const x = dirSegments(a);
  const y = dirSegments(b);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/** Unchanged files with a uses or imports link to a changed file, the nearest 6 per changed file. */
function findCallers(links: Link[], inDiff: Set<string>, changed: Set<string>): Neighbour[] {
  const byTarget = new Map<string, Map<string, Set<string>>>();
  for (const l of links) {
    if ((l.kind !== 'uses' && l.kind !== 'imports') || !changed.has(l.to) || inDiff.has(l.from)) continue;
    const callers = byTarget.get(l.to) ?? new Map<string, Set<string>>();
    byTarget.set(l.to, callers);
    const names = callers.get(l.from) ?? new Set<string>();
    callers.set(l.from, names);
    if (l.kind === 'uses') names.add(l.detail);
  }

  const out = new Map<string, { forFiles: Set<string>; names: Set<string> }>();
  for (const [target, callers] of byTarget) {
    const nearest = [...callers.keys()]
      .sort((a, b) => sharedDirs(b, target) - sharedDirs(a, target) || cmp(a, b))
      .slice(0, CALLERS_PER_FILE);
    for (const c of nearest) {
      const entry = out.get(c) ?? { forFiles: new Set<string>(), names: new Set<string>() };
      out.set(c, entry);
      entry.forFiles.add(target);
      for (const n of callers.get(c) ?? []) entry.names.add(n);
    }
  }
  return [...out].map(([path, e]) => {
    const forFiles = [...e.forFiles].sort(cmp);
    const why = e.names.size > 0 ? `uses ${[...e.names].sort(cmp).join(', ')}` : `imports ${forFiles.join(', ')}`;
    return { path, role: 'caller', forFiles, why };
  });
}

/** For each added file, up to 2 existing files most like it: nearest folder first, then most recently changed. */
async function findSiblings(exec: Exec, headDir: string, files: FileDiff[], inDiff: Set<string>, packs: Pack[]): Promise<Neighbour[]> {
  const added = files.filter((f) => f.status === 'added' && !f.binary);
  if (added.length === 0) return [];
  const tracked = (await trackedFiles(exec, headDir)).filter((p) => !inDiff.has(p));
  const rules = packs.flatMap((p) => p.siblings).map((s) => ({ id: s.id, matches: picomatch(s.glob, { dot: true }) }));
  const limit = limiter(8);
  const times = new Map<string, Promise<number | null>>();
  const timeOf = (path: string): Promise<number | null> => {
    let hit = times.get(path);
    if (!hit) { hit = limit(() => lastCommitTime(exec, headDir, path)); times.set(path, hit); }
    return hit;
  };

  const out = new Map<string, Neighbour>();
  for (const f of added) {
    const rule = rules.find((r) => r.matches(f.path));
    let candidates: string[];
    if (rule) {
      candidates = tracked.filter((p) => rule.matches(p));
    } else {
      const base = posix.basename(f.path);
      const parent = dirSegments(f.path).join('/');
      const grand = dirSegments(f.path).slice(0, -1).join('/');
      candidates = tracked.filter((p) => posix.basename(p) === base && dirSegments(p).join('/') !== parent
        && (grand === '' || p.startsWith(`${grand}/`)));
    }
    const ranked = candidates
      .map((path) => ({ path, shared: sharedDirs(path, f.path) }))
      .sort((a, b) => b.shared - a.shared || cmp(a.path, b.path))
      .slice(0, SIBLINGS_TIMED);
    const timed = await Promise.all(ranked.map(async (c) => ({ ...c, time: await timeOf(c.path) })));
    const best = timed
      .sort((a, b) => b.shared - a.shared || (b.time ?? -1) - (a.time ?? -1) || cmp(a.path, b.path))
      .slice(0, SIBLINGS_PER_FILE);
    for (const s of best) {
      const existing = out.get(s.path);
      if (existing) { existing.forFiles.push(f.path); continue; }
      const when = s.time === null ? 'unknown' : new Date(s.time * 1000).toISOString().slice(0, 10);
      const why = `closest existing ${rule?.id ?? 'file of the same name'}, last changed ${when}`;
      out.set(s.path, { path: s.path, role: 'sibling', forFiles: [f.path], why });
    }
  }
  return [...out.values()];
}

/** Unchanged files a reviewer should see next to the change: its callers and the closest existing siblings of new files. */
export async function findNeighbours(exec: Exec, headDir: string, files: FileDiff[], links: Link[], packs: Pack[]): Promise<Neighbour[]> {
  const inDiff = new Set(files.flatMap((f) => (f.oldPath === null ? [f.path] : [f.path, f.oldPath])));
  const changed = new Set(files.filter((f) => f.status !== 'deleted' && !f.binary).map((f) => f.path));
  const callers = findCallers(links, inDiff, changed);
  const siblings = await findSiblings(exec, headDir, files, inDiff, packs);
  return [...callers, ...siblings].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || cmp(a.path, b.path));
}
