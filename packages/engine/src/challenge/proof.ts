// The proof rules: whether a refutation the challenger offers really proves its ground.
import type { Anchor, Candidate, FileDiff, Place } from '@airlock/shared';
import { posix } from 'node:path';
import { findQuote } from '../anchor/anchor.js';
import type { StandardDocument } from '../lenses/context.js';
import { isWholeUnits } from './standards-text.js';

export type Ground = 'unreachable' | 'pre-existing' | 'guarded-elsewhere' | 'documented-intent' | 'smaller' | 'none';
export interface Refutation { path: string; quote: string; where: 'head' | 'base' | 'standard' }
export type ReadFile = (where: 'head' | 'base', path: string) => Promise<string | null>;

/** The proved place, or none; `ownCode` says the quote was the finding's own lines on the head. */
export type Proof = { place: Place } | { place: null; ownCode: boolean };

/** What a refutation is checked against: files on either side, the diff, and the standards the challenger was given. */
export interface Evidence {
  read: ReadFile;
  files: Map<string, FileDiff>;
  documents: StandardDocument[];
}

type Item = Candidate & { anchor: Anchor };
type Lines = { startLine: number; endLine: number };

const NO_PROOF: Proof = { place: null, ownCode: false };
const OWN_CODE: Proof = { place: null, ownCode: true };

/** `read` with each side and path asked for once; a read that fails counts as a missing file. */
function readOnce(read: ReadFile): ReadFile {
  const cache = new Map<string, Promise<string | null>>();
  return (where, path) => {
    const key = `${where}\0${path}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = Promise.resolve().then(() => read(where, path)).catch(() => null);
      cache.set(key, hit);
    }
    return hit;
  };
}

/** The evidence for one run: `read` is called at most once per side and path, and the diff is looked up by normalised path. */
export function createEvidence(read: ReadFile, files: FileDiff[], documents: StandardDocument[]): Evidence {
  return { read: readOnce(read), files: new Map(files.map((f) => [posix.normalize(f.path), f])), documents };
}

/**
 * A repository-relative path safe to read: no backslash, `%`, `:` or NUL, not starting with `/`, and no empty or `..`
 * segment. Encoded and Windows-style paths are refused rather than decoded.
 */
const isSafePath = (path: string): boolean =>
  path.trim() !== '' && !path.startsWith('/') && !/[\\%:\0]/.test(path)
  && path.split('/').every((s) => s !== '' && s !== '..');

/** A quote proves nothing unless one of its lines, without whitespace, has this many characters and a letter or digit. */
const MIN_PROOF_CHARS = 12;
const hasSubstance = (quote: string): boolean =>
  quote.split('\n').map((l) => l.replace(/\s+/g, '')).some((l) => l.length >= MIN_PROOF_CHARS && /[\p{L}\p{N}]/u.test(l));

const overlaps = (found: Lines, own: Anchor): boolean =>
  own.startLine !== null && found.startLine <= (own.endLine ?? own.startLine) && own.startLine <= found.endLine;

/**
 * True when any of `lines` falls inside a hunk's new-side range. A hunk with no new lines (a pure deletion) covers the
 * two lines on either side of where the deleted lines were.
 */
const insideHunk = (file: FileDiff, lines: Lines): boolean =>
  file.hunks.some((h) => {
    const end = h.newLines === 0 ? h.newStart + 1 : h.newStart + h.newLines - 1;
    return lines.startLine <= end && h.newStart <= lines.endLine;
  });

/** Paths compared the same way on both sides: posix-normalised, and ignoring letter case as a case-insensitive disk would. */
const pathKey = (path: string): string => posix.normalize(path).toLowerCase();
const samePath = (a: string, b: string): boolean => pathKey(a) === pathKey(b);

/** Grounds 1 and 3: code on the head, other than the finding's own lines, quoted in full. */
async function proveOnHead(item: Item, ref: Refutation, { read }: Evidence): Promise<Proof> {
  if (ref.where !== 'head' || !isSafePath(ref.path) || !hasSubstance(ref.quote)) return NO_PROOF;
  const path = posix.normalize(ref.path);
  const found = findQuote(await read('head', path), ref.quote);
  if (found.length === 0) return NO_PROOF;
  if (samePath(path, item.path) && found.some((f) => overlaps(f, item.anchor))) return OWN_CODE;
  return { place: { path, line: found[0]!.startLine, role: 'head', quote: ref.quote } };
}

/**
 * Ground 2: the base version of the finding's own file (or of its old path, when renamed) holds the finding's own quote,
 * and the finding's lines are outside every hunk of its file, so nothing this pull request changed sits beside them.
 * The record cites the finding's quote on the base, under the file's real path.
 */
async function provePreExisting(item: Item, ref: Refutation, { read, files }: Evidence): Promise<Proof> {
  const line = item.anchor.startLine;
  if (ref.where !== 'base' || !isSafePath(ref.path) || line === null) return NO_PROOF;
  const file = files.get(posix.normalize(item.path));
  const own = [posix.normalize(item.path), ...(file?.status === 'renamed' && file.oldPath ? [file.oldPath] : [])];
  const path = own.find((p) => samePath(p, ref.path));
  if (path === undefined) return NO_PROOF;
  if (file !== undefined && insideHunk(file, { startLine: line, endLine: item.anchor.endLine ?? line })) return NO_PROOF;
  const found = findQuote(await read('base', path), item.quote);
  if (found.length === 0) return NO_PROOF;
  const nearest = found.reduce((a, b) => (Math.abs(b.startLine - line) < Math.abs(a.startLine - line) ? b : a));
  return { place: { path, line: nearest.startLine, role: 'base', quote: item.quote } };
}

/** Ground 4: one or more whole consecutive sentences or entries of one standard or learned list the challenger was given. */
function proveIntent(ref: Refutation, { documents }: Evidence): Proof {
  if (ref.where !== 'standard') return NO_PROOF;
  const doc = documents.find((d) => isWholeUnits(ref.quote, d.text));
  return doc ? { place: { path: doc.name, line: null, role: 'standard', quote: ref.quote } } : NO_PROOF;
}

/** The place a drop's refutation proves, if it does; each ground is tied to the side and place that can prove it. */
export async function proveDrop(item: Item, ground: Ground, refutation: Refutation | null, evidence: Evidence): Promise<Proof> {
  if (refutation === null) return NO_PROOF;
  switch (ground) {
    case 'unreachable':
    case 'guarded-elsewhere':
      return proveOnHead(item, refutation, evidence);
    case 'pre-existing':
      return provePreExisting(item, refutation, evidence);
    case 'documented-intent':
      return proveIntent(refutation, evidence);
    default:
      return NO_PROOF;
  }
}
