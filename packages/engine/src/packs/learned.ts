import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { LearnedEntry } from './types.js';

const SEP = ' · ';
// The repository field may be empty: a line written by hand for no repository.
const LINE = /^(\d{4}-\d{2}-\d{2}) · (.*?) · (.+)$/;

export const learnedFileName = (kind: LearnedEntry['kind']): string =>
  kind === 'wrong' ? 'wrong.md' : 'product-knowledge.md';

function learnedPath(packDir: string, kind: LearnedEntry['kind']): string {
  return join(packDir, 'learned', learnedFileName(kind));
}

function formatLine(e: LearnedEntry): string {
  return `${e.date}${SEP}${e.repo}${SEP}${e.text.replace(/\s*[\r\n]+\s*/g, ' ').trim()}`;
}

/**
 * The entries of a learned file and the numbers of the lines that are not entries (blank lines and `#` comments are
 * neither). Never throws: a line the person edited by hand into something unreadable is the caller's to report.
 */
export function readLearned(text: string, kind: LearnedEntry['kind'], file: string): { entries: LearnedEntry[]; badLines: number[] } {
  const entries: LearnedEntry[] = [];
  const badLines: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '' || line.startsWith('#')) return;
    const m = LINE.exec(line);
    if (!m) { badLines.push(i + 1); return; }
    entries.push({ date: m[1]!, repo: m[2]!, kind, text: m[3]!, where: `${file}:${i + 1}` });
  });
  return { entries, badLines };
}

export function parseLearned(text: string, kind: LearnedEntry['kind'], file: string): LearnedEntry[] {
  const { entries, badLines } = readLearned(text, kind, file);
  if (badLines.length > 0) throw new Error(`${file}:${badLines[0]}: not a learned entry (expected "YYYY-MM-DD${SEP}<repo>${SEP}<text>")`);
  return entries;
}

/**
 * Replaces the file whole: the text goes to a temporary file beside it, which is then renamed over it, so a review that
 * loads its packs at the same moment reads either the old file or the new one, never a part-written one.
 */
async function writeWhole(file: string, text: string): Promise<void> {
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(temp, text);
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function appendLearned(packDir: string, e: LearnedEntry): Promise<void> {
  const file = learnedPath(packDir, e.kind);
  const line = formatLine(e);
  const [parsed] = parseLearned(line, e.kind, `learned entry for ${file}`);
  if (!parsed || parsed.date !== e.date || parsed.repo !== e.repo) {
    throw new Error(`Invalid learned entry for ${file}: date must be YYYY-MM-DD, repo and text non-empty, repo free of line breaks and "${SEP.trim()}"`);
  }
  await mkdir(join(packDir, 'learned'), { recursive: true });
  let existing = '';
  try { existing = await readFile(file, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const lead = existing !== '' && !existing.endsWith('\n') ? '\n' : '';
  await writeWhole(file, `${existing}${lead}${line}\n`);
}

export async function removeLearned(packDir: string, e: LearnedEntry): Promise<boolean> {
  const file = learnedPath(packDir, e.kind);
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.replace(/\r$/, '') === formatLine(e));
  if (at < 0) return false;
  lines.splice(at, 1);
  await writeWhole(file, lines.join('\n'));
  return true;
}
