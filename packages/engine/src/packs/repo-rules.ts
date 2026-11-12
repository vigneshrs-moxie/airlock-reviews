import { readFile, realpath, stat } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';
import { FULL_COMMIT_ID } from '../intake/git-ids.js';
import type { Exec } from '../util/exec.js';

const ROOT_FILES = ['CLAUDE.md', 'AGENTS.md', 'REVIEW.md', '.cursorrules', '.github/copilot-instructions.md'];
const NESTED_FILES = ['AGENTS.md', 'CLAUDE.md'];
const MAX_FILES = 8;
const MAX_BYTES = 64_000;

function candidates(changedPaths: string[]): string[] {
  const dirs = new Set<string>();
  for (const raw of changedPaths) {
    const p = posix.normalize(raw.replaceAll('\\', '/'));
    if (p.startsWith('../') || p.startsWith('/')) continue;
    for (let d = posix.dirname(p); d !== '.' && d !== '/'; d = posix.dirname(d)) dirs.add(d);
  }
  const ordered = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  return [...ROOT_FILES, ...ordered.flatMap((d) => NESTED_FILES.map((f) => `${d}/${f}`))];
}

export interface RepoRules {
  rules: { path: string; text: string }[];
  /** Rule files that exist but were not read because of the count or size limit, each with why in words. */
  leftOut: { path: string; reason: string }[];
}

const TOO_MANY = `more than ${MAX_FILES} rule files`;
const TOO_LARGE = `it would take the rule files past ${MAX_BYTES.toLocaleString('en-US')} bytes`;

const LINK_MODE = '120000';

/**
 * The candidate rule files git tracks as symbolic links. The base is checked out with links as small files holding
 * their target, so git's index is the only place that says which files are links.
 */
async function trackedLinks(exec: Exec, baseDir: string, paths: string[]): Promise<Set<string>> {
  const res = await exec('git', ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...paths], { cwd: baseDir });
  if (res.code !== 0) throw new Error(`git ls-files failed (exit ${res.code}): ${res.stderr}`);
  const links = new Set<string>();
  for (const record of res.stdout.split('\0')) {
    const m = /^(\d{6}) \S+ \d+\t(.+)$/s.exec(record);
    if (m && m[1] === LINK_MODE) links.add(m[2]!);
  }
  return links;
}

/** Where a link at `path` holding `target` points, as a path inside the repository, or null when it leaves it. */
function linkTarget(path: string, target: string): string | null {
  const t = target.trim();
  if (t === '' || t.startsWith('/') || t.includes('\0')) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(path), t));
  return resolved === '..' || resolved.startsWith('../') || resolved === '.' ? null : resolved;
}

/** A rule file that exists: its size in bytes, and how to read its text (null when it cannot be read). */
interface Found { size: number; read: () => Promise<string | null> }

/**
 * The rule files among `paths`, in that order, at most MAX_FILES files and MAX_BYTES bytes in all. `find` gives each
 * path's file, or null when there is none to read. A file that would pass the size limit is skipped and the rest are
 * still read; every file left out by a limit is named.
 */
async function collect(paths: string[], find: (path: string) => Promise<Found | null>): Promise<RepoRules> {
  const out: RepoRules = { rules: [], leftOut: [] };
  let total = 0;
  for (const path of paths) {
    const found = await find(path);
    if (found === null) continue;
    if (out.rules.length >= MAX_FILES) { out.leftOut.push({ path, reason: TOO_MANY }); continue; }
    if (total + found.size > MAX_BYTES) { out.leftOut.push({ path, reason: TOO_LARGE }); continue; }
    const text = await found.read();
    if (text === null) continue;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (total + bytes > MAX_BYTES) { out.leftOut.push({ path, reason: TOO_LARGE }); continue; }
    total += bytes;
    out.rules.push({ path, text });
  }
  return out;
}

/**
 * Rule files (CLAUDE.md and friends) read from the base checkout only, at most MAX_FILES files and MAX_BYTES bytes in all.
 * A file that would pass the size limit is skipped and the rest are still read; every file left out is named. With
 * `exec`, a rule file git tracks as a symbolic link is read from the file it points to, when that is inside the
 * repository and not a link itself; a link that points elsewhere is skipped.
 */
export async function loadRepoRules(baseDir: string, changedPaths: string[], exec?: Exec): Promise<RepoRules> {
  const root = await realpath(baseDir);
  const paths = candidates(changedPaths);
  const links = exec === undefined ? new Set<string>() : await trackedLinks(exec, baseDir, paths);
  return collect(paths, async (path) => {
    let source = path;
    if (links.has(path)) {
      const held = await readFile(join(baseDir, path), 'utf8').catch(() => null);
      const target = held === null ? null : linkTarget(path, held);
      if (target === null || links.has(target)) return null;
      source = target;
    }
    let real: string;
    let size: number;
    try {
      real = await realpath(join(baseDir, source));
      const info = await stat(real);
      if (!info.isFile()) return null;
      size = info.size;
    } catch { return null; }
    if (real !== root && !real.startsWith(root + sep)) return null;
    return { size, read: () => readFile(real, 'utf8').catch(() => null) };
  });
}

/** One entry of a commit's tree, as `git ls-tree -l` gives it; `size` is null for anything but a blob. */
interface TreeEntry { mode: string; type: string; id: string; size: number | null }

/** One entry of a folder of the tree: its full path in the tree, its own name, and what `git ls-tree -l` says of it. */
interface Listed { path: string; name: string; entry: TreeEntry }

/**
 * The entries directly inside each folder of `dirs` ('' for the top of the tree; real paths, taken literally) of
 * `commit`'s tree, in git's order, by folder: one `git ls-tree` for the top and one for all the other folders.
 */
async function listFolders(exec: Exec, gitDir: string, commit: string, dirs: string[]): Promise<Map<string, Listed[]>> {
  const out = new Map<string, Listed[]>(dirs.map((d) => [d, []]));
  const inner = dirs.filter((d) => d !== '');
  const calls = [...(dirs.includes('') ? [[]] : []), ...(inner.length > 0 ? [['--', ...inner.map((d) => `${d}/`)]] : [])];
  for (const paths of calls) {
    const res = await exec('git', ['--git-dir', gitDir, '--literal-pathspecs', 'ls-tree', '-z', '-l', '--full-tree', commit, ...paths]);
    if (res.code !== 0) throw new Error(`git ls-tree failed (exit ${res.code}): ${res.stderr}`);
    for (const record of res.stdout.split('\0')) {
      const m = /^(\d{6}) (\w+) ([0-9a-f]+) +(\d+|-)\t(.+)$/s.exec(record);
      if (!m) continue;
      const path = m[5]!;
      const dir = posix.dirname(path);
      const entry = { mode: m[1]!, type: m[2]!, id: m[3]!, size: m[4] === '-' ? null : Number(m[4]) };
      out.get(dir === '.' ? '' : dir)?.push({ path, name: posix.basename(path), entry });
    }
  }
  return out;
}

/** Of a folder's entries, the one named `name`: spelled exactly so first, else the first whose name differs only by case. */
function named(entries: Listed[], name: string): Listed | undefined {
  const lower = name.toLowerCase();
  return entries.find((e) => e.name === name) ?? entries.find((e) => e.name.toLowerCase() === lower);
}

/**
 * The entries of `commit`'s tree at `paths` (from the top of the tree), by the path as given, each part of the path matched
 * as a disk that ignores letter case would match it (see named): a first review reads the rule files from a checkout on
 * such a disk, so `Claude.md` is read for `CLAUDE.md`. One tree level is listed per git call.
 */
async function treeEntries(exec: Exec, gitDir: string, commit: string, paths: string[]): Promise<Map<string, TreeEntry>> {
  const entries = new Map<string, TreeEntry>();
  const listed = new Map<string, Listed[]>();
  /** Each path still being looked for, and the real path of the folder its parts so far were found in. */
  let looking = paths.map((path) => ({ path, parts: path.split('/'), dir: '' }));
  for (let depth = 0; looking.length > 0; depth++) {
    const dirs = [...new Set(looking.map((l) => l.dir))].filter((d) => !listed.has(d));
    for (const [dir, found] of await listFolders(exec, gitDir, commit, dirs)) listed.set(dir, found);
    const deeper: typeof looking = [];
    for (const l of looking) {
      const last = depth === l.parts.length - 1;
      const here = listed.get(l.dir) ?? [];
      const hit = named(last ? here : here.filter((e) => e.entry.type === 'tree'), l.parts[depth]!);
      if (hit === undefined) continue;
      if (last) entries.set(l.path, hit.entry);
      else deeper.push({ ...l, dir: hit.path });
    }
    looking = deeper;
  }
  return entries;
}

/**
 * The rule files `loadRepoRules` would read from a checkout of `commit` on a disk that ignores letter case (this Mac's),
 * read from the git folder `gitDir` instead (a re-review has no checkout of the pull request's base), with the same order,
 * names and limits: a name in another letter case is found (see treeEntries). Each file is read as git stores it, with
 * no filter or conversion; a link is read from the file it points to, when that is inside the repository and not a link
 * itself. `commit` must be a full commit id. Throws when git cannot list the tree.
 */
export async function loadRepoRulesAt(exec: Exec, gitDir: string, commit: string, changedPaths: string[]): Promise<RepoRules> {
  if (!FULL_COMMIT_ID.test(commit)) throw new Error(`The base commit ${JSON.stringify(commit)} is not a full commit id.`);
  const paths = candidates(changedPaths);
  const entries = await treeEntries(exec, gitDir, commit, paths);
  const blob = async (id: string): Promise<string | null> => {
    const res = await exec('git', ['--git-dir', gitDir, 'cat-file', 'blob', id]);
    return res.code === 0 ? res.stdout : null;
  };
  return collect(paths, async (path) => {
    let entry = entries.get(path);
    if (entry === undefined) return null;
    if (entry.mode === LINK_MODE) {
      const held = await blob(entry.id);
      const target = held === null ? null : linkTarget(path, held);
      if (target === null) return null;
      entry = (await treeEntries(exec, gitDir, commit, [target])).get(target);
      if (entry === undefined || entry.mode === LINK_MODE) return null;
    }
    if (entry.type !== 'blob' || entry.size === null) return null;
    const { id, size } = entry;
    return { size, read: () => blob(id) };
  });
}
