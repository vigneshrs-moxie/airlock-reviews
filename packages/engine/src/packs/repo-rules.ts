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

/** Rule files (CLAUDE.md and friends) read from the base checkout only. */
export async function loadRepoRules(baseDir: string, changedPaths: string[]): Promise<{ path: string; text: string }[]> {
  const root = await realpath(baseDir);
  const out: { path: string; text: string }[] = [];
  let total = 0;
  for (const path of candidates(changedPaths)) {
    if (out.length >= MAX_FILES) break;
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
    if (total + size > MAX_BYTES) break;
    let text: string;
    try { text = await readFile(real, 'utf8'); } catch { continue; }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (total + bytes > MAX_BYTES) break;
    total += bytes;
    out.push({ path, text });
  }
  return out;
}
