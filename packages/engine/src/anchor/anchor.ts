import type { Anchor, Candidate, Dropped, FileDiff, Place } from '@airlock/shared';
import { lineInDiff } from '../diff/parse.js';

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

/**
 * Turn a quotation into line numbers in the head file. Whitespace is ignored. Prefers a match inside the
 * diff, then the one nearest `lineHint`. With `file` undefined any match is `outside-diff`. When the whole quote is
 * not found, the longest line of 12 or more characters is tried alone, unless `exact` is set.
 */
export function anchorQuote(
  headText: string | null,
  quote: string,
  lineHint: number | null,
  file: FileDiff | undefined,
  { exact = false }: { exact?: boolean } = {},
): Anchor {
  if (headText === null) return NOT_FOUND;
  const quoteLines = quote.split('\n').map(squash);
  while (quoteLines.length > 0 && quoteLines[0] === '') quoteLines.shift();
  while (quoteLines.length > 0 && quoteLines[quoteLines.length - 1] === '') quoteLines.pop();
  if (quoteLines.length === 0) return NOT_FOUND;

  const hay = headText.split('\n').map(squash);
  let span = quoteLines.length;
  let starts = findRuns(hay, quoteLines);
  if (starts.length === 0 && !exact) {
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

/** Anchor every candidate to the head commit; drop the ones whose quoted code does not exist. */
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
  for (const c of cands) {
    const anchor = anchorQuote(await read(c.path), c.quote, c.lineHint, byPath.get(c.path));
    if (anchor.status === 'not-found') {
      dropped.push({ candidate: c, stage: 'anchor', reason: `quoted code is not in ${c.path} at the head commit`, refutation: null });
      continue;
    }
    const connected: Place[] = [];
    for (const p of c.connected) {
      if (p.quote.trim() === '') { connected.push({ ...p, line: null }); continue; }
      const found = anchorQuote(await read(p.path), p.quote, p.line, byPath.get(p.path));
      connected.push({ ...p, line: found.status === 'not-found' ? null : found.startLine });
    }
    anchored.push({ ...c, connected, anchor });
  }
  return { anchored, dropped };
}
