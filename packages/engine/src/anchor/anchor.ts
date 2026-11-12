import type { Anchor, Candidate, Dropped, FileDiff, Place } from '@airlock/shared';
import { lineInDiff } from '../diff/parse.js';
import { commentLine } from './comment-line.js';

const MIN_FALLBACK_CHARS = 12;
const NOT_FOUND: Anchor = { status: 'not-found', startLine: null, endLine: null };

const squash = (s: string): string => s.replace(/\s+/g, '');

/** 1-based start lines where `needle` (whitespace-free lines) matches consecutive lines of `hay`. */
function findRuns(hay: string[], needle: string[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((n, k) => hay[i + k] === n)) starts.push(i + 1);
  }
  return starts;
}

/** The quote's lines without whitespace, with blank lines at either end removed. */
function quoteLinesOf(quote: string): string[] {
  const lines = quote.split('\n').map(squash);
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Every place the whole quote occurs, in file order, ignoring whitespace. There is no fallback to part of the quote. */
export function findQuote(text: string | null, quote: string): { startLine: number; endLine: number }[] {
  const lines = quoteLinesOf(quote);
  if (text === null || lines.length === 0) return [];
  return findRuns(text.split('\n').map(squash), lines).map((s) => ({ startLine: s, endLine: s + lines.length - 1 }));
}

/**
 * Turn a quotation into line numbers in the head file. Whitespace is ignored. Prefers a match inside the
 * diff, then the one nearest `lineHint`. With `file` undefined any match is `outside-diff`. When the whole quote is
 * not found, the longest line of 12 or more characters is tried alone.
 */
export function anchorQuote(headText: string | null, quote: string, lineHint: number | null, file: FileDiff | undefined): Anchor {
  if (headText === null) return NOT_FOUND;
  const quoteLines = quoteLinesOf(quote);
  if (quoteLines.length === 0) return NOT_FOUND;

  const hay = headText.split('\n').map(squash);
  let span = quoteLines.length;
  let starts = findRuns(hay, quoteLines);
  if (starts.length === 0) {
    const longest = quoteLines.reduce((a, b) => (b.length > a.length ? b : a), '');
    if (longest.length < MIN_FALLBACK_CHARS) return NOT_FOUND;
    span = 1;
    starts = findRuns(hay, [longest]);
  }
  if (starts.length === 0) return NOT_FOUND;

  const inDiff = file ? starts.filter((s) => lineInDiff(file, s)) : [];
  const pool = inDiff.length > 0 ? inDiff : starts;
  let best = pool[0] ?? 0;
  if (lineHint !== null) {
    for (const s of pool) if (Math.abs(s - lineHint) < Math.abs(best - lineHint)) best = s;
  }
  return { status: inDiff.length > 0 ? 'in-diff' : 'outside-diff', startLine: best, endLine: best + span - 1 };
}

/** The file's own lines from `startLine` to `endLine` (1-based), as they are written. */
const linesAt = (text: string, startLine: number, endLine: number): string => text.split('\n').slice(startLine - 1, endLine).join('\n');

const NOT_IN_FILE = 'not found in the file';

/**
 * Anchor every candidate to the head commit and drop the ones whose quoted code does not exist there, or whose file
 * cannot be read. A kept candidate's quote becomes the file's own lines at the anchored range, so a finding never shows
 * code that is not in the file. A connected place is quoted the same way when found; when its quote or file is not
 * found it keeps its path, role and quote, gets no line, and its role says it was not found.
 */
export async function anchorCandidates(
  cands: Candidate[],
  files: FileDiff[],
  readHead: (p: string) => Promise<string | null>,
): Promise<{ anchored: (Candidate & { anchor: Anchor })[]; dropped: Dropped[] }> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const cache = new Map<string, Promise<string | null>>();
  const read = (path: string): Promise<string | null> => {
    let hit = cache.get(path);
    if (!hit) {
      hit = byPath.get(path)?.status === 'deleted' ? Promise.resolve(null) : readHead(path).catch(() => null);
      cache.set(path, hit);
    }
    return hit;
  };

  const anchored: (Candidate & { anchor: Anchor })[] = [];
  const dropped: Dropped[] = [];
  const drop = (c: Candidate, reason: string): void => { dropped.push({ candidate: c, stage: 'anchor', reason, refutation: null }); };
  for (const c of cands) {
    const deleted = byPath.get(c.path)?.status === 'deleted';
    const text = await read(c.path);
    if (text === null && !deleted) { drop(c, `the file ${c.path} could not be read`); continue; }
    const anchor = anchorQuote(text, c.quote, c.lineHint, byPath.get(c.path));
    if (text === null || anchor.status === 'not-found' || anchor.startLine === null || anchor.endLine === null) {
      drop(c, `quoted code is not in ${c.path} at the head commit`);
      continue;
    }
    const connected: Place[] = [];
    for (const p of c.connected) {
      if (p.quote.trim() === '') { connected.push({ ...p, line: null }); continue; }
      const placeText = await read(p.path);
      const found = anchorQuote(placeText, p.quote, p.line, byPath.get(p.path));
      if (placeText === null || found.startLine === null || found.endLine === null) {
        connected.push({ ...p, line: null, role: p.role.trim() === '' ? NOT_IN_FILE : `${p.role} (${NOT_IN_FILE})` });
      } else {
        connected.push({ ...p, line: found.startLine, quote: linesAt(placeText, found.startLine, found.endLine) });
      }
    }
    const comment = commentLine(byPath.get(c.path), anchor.startLine, anchor.endLine);
    anchored.push({ ...c, quote: linesAt(text, anchor.startLine, anchor.endLine), connected, anchor: { ...anchor, comment } });
  }
  return { anchored, dropped };
}
