import { readFile, realpath, stat } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';
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

/**
 * Rule files (CLAUDE.md and friends) read from the base checkout only, at most MAX_FILES files and MAX_BYTES bytes in all.
 * A file that would pass the size limit is skipped and the rest are still read; every file left out is named. With
 * `exec`, a rule file git tracks as a symbolic link is read from the file it points to, when that is inside the
 * repository and not a link itself; a link that points elsewhere is skipped.
 */
export async function loadRepoRules(baseDir: string, changedPaths: string[], exec?: Exec): Promise<RepoRules> {
  const root = await realpath(baseDir);
  const out: RepoRules = { rules: [], leftOut: [] };
  const paths = candidates(changedPaths);
  const links = exec === undefined ? new Set<string>() : await trackedLinks(exec, baseDir, paths);
  let total = 0;
  for (const path of paths) {
    let source = path;
    if (links.has(path)) {
      const held = await readFile(join(baseDir, path), 'utf8').catch(() => null);
      const target = held === null ? null : linkTarget(path, held);
      if (target === null || links.has(target)) continue;
      source = target;
    }
    const full = join(baseDir, source);
    let real: string;
    let size: number;
    try {
      real = await realpath(full);
      const info = await stat(real);
      if (!info.isFile()) continue;
      size = info.size;
    } catch { continue; }
    if (real !== root && !real.startsWith(root + sep)) continue;
    if (out.rules.length >= MAX_FILES) { out.leftOut.push({ path, reason: TOO_MANY }); continue; }
    if (total + size > MAX_BYTES) { out.leftOut.push({ path, reason: TOO_LARGE }); continue; }
    let text: string;
    try { text = await readFile(real, 'utf8'); } catch { continue; }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (total + bytes > MAX_BYTES) { out.leftOut.push({ path, reason: TOO_LARGE }); continue; }
    total += bytes;
    out.rules.push({ path, text });
  }
  return out;
}
