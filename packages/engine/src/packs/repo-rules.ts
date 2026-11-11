import { readFile, realpath, stat } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';

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

/**
 * Rule files (CLAUDE.md and friends) read from the base checkout only, at most MAX_FILES files and MAX_BYTES bytes in all.
 * A file that would pass the size limit is skipped and the rest are still read; every file left out is named.
 */
export async function loadRepoRules(baseDir: string, changedPaths: string[]): Promise<RepoRules> {
  const root = await realpath(baseDir);
  const out: RepoRules = { rules: [], leftOut: [] };
  let total = 0;
  for (const path of candidates(changedPaths)) {
    const full = join(baseDir, path);
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
