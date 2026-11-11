// The proof rules: whether a refutation the challenger offers really proves its ground.
import type { Anchor, Candidate, FileDiff, Place } from '@airlock/shared';
import { posix } from 'node:path';
import { findQuote } from '../anchor/anchor.js';
import { learnedListName, standardDocuments } from '../lenses/context.js';
import { datedEntries } from '../packs/holdout.js';
import type { Pack } from '../packs/types.js';
import { isWholeEntry, isWholeUnits } from './standards-text.js';

export type Ground = 'unreachable' | 'pre-existing' | 'guarded-elsewhere' | 'documented-intent' | 'smaller' | 'none';
export interface Refutation { path: string; quote: string; where: 'head' | 'base' | 'standard' }
export type ReadFile = (where: 'head' | 'base', path: string) => Promise<string | null>;

/**
 * The proved place and, in words, where it was found; or none, with `ownCode` saying the quote was the finding's own
 * lines on the head.
 */
export type Proof = { place: Place; source: string } | { place: null; ownCode: boolean };

/**
 * A recorded decision that can prove documented intent: one dated entry of a corrections log (quoted as whole
 * sentences) or one learned entry (quoted whole). `path` and `source` name it precisely.
 */
interface DecisionRecord {
  text: string;
  quotedWhole: boolean;
  path: string;
  role: 'standard' | 'learned';
  source: string;
}

/** What a refutation is checked against: files on either side, the diff, and the recorded decisions. */
export interface Evidence {
  read: ReadFile;
  /** The diff by path key (normalised, letter case ignored). */
  files: Map<string, FileDiff>;
  records: DecisionRecord[];
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

/**
 * The decisions on record: each entry of a dated standard (split as the hold-out splits it) and each learned entry.
 * Undated standards state rules and hazards, not decisions, so they are not records.
 */
function decisionRecords(packs: Pack[]): DecisionRecord[] {
  const entries = standardDocuments(packs).filter((d) => d.dated).flatMap((d) => datedEntries(d.text).map((e) => ({
    text: e.body, quotedWhole: false, path: `${d.name}#${e.date}`, role: 'standard' as const,
    source: `the ${e.date} entry in ${d.name}`,
  })));
  const learned = packs.flatMap((p) => p.learned.map((e) => ({
    text: e.text, quotedWhole: true, path: `${learnedListName(e.kind)}#${e.date}`, role: 'learned' as const,
    source: `a recorded ${e.kind === 'intended' ? 'product fact' : 'earlier correction'} dated ${e.date}`,
  })));
  return [...entries, ...learned];
}

/** The evidence for one run: `read` is called at most once per side and path, and the diff is looked up by path key. */
export function createEvidence(read: ReadFile, files: FileDiff[], packs: Pack[]): Evidence {
  return { read: readOnce(read), files: new Map(files.map((f) => [pathKey(f.path), f])), records: decisionRecords(packs) };
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
  const line = found[0]!.startLine;
  return { place: { path, line, role: 'head', quote: ref.quote }, source: `${path}:${line} on the head` };
}

/** True when a place with a line sits in a file this pull request added, or inside a hunk of its file. */
const changedHere = (files: Evidence['files'], path: string, lines: Lines): boolean => {
  const file = files.get(pathKey(path));
  return file !== undefined && (file.status === 'added' || insideHunk(file, lines));
};

/**
 * Ground 2: the finding's own code is unchanged and was already there. All must hold: the refutation names the
 * finding's own file (or its old path, when renamed) on the base; the finding's lines are outside every hunk of its
 * file; no connected place with a line was changed by this pull request; the finding's whole quote is on the head at
 * its anchored lines; and it is in that base file. The record cites the finding's quote on the base, under the file's
 * real path.
 */
async function provePreExisting(item: Item, ref: Refutation, { read, files }: Evidence): Promise<Proof> {
  const line = item.anchor.startLine;
  if (ref.where !== 'base' || !isSafePath(ref.path) || line === null) return NO_PROOF;
  const end = item.anchor.endLine ?? line;
  const headPath = posix.normalize(item.path);
  const file = files.get(pathKey(item.path));
  const own = [headPath, ...(file?.status === 'renamed' && file.oldPath ? [file.oldPath] : [])];
  const path = own.find((p) => samePath(p, ref.path));
  if (path === undefined) return NO_PROOF;
  if (file !== undefined && insideHunk(file, { startLine: line, endLine: end })) return NO_PROOF;
  if (item.connected.some((p) => p.line !== null && changedHere(files, p.path, { startLine: p.line, endLine: p.line }))) {
    return NO_PROOF;
  }
  const onHead = findQuote(await read('head', headPath), item.quote).some((f) => f.startLine === line && f.endLine === end);
  if (!onHead) return NO_PROOF;
  const found = findQuote(await read('base', path), item.quote);
  if (found.length === 0) return NO_PROOF;
  const nearest = found.reduce((a, b) => (Math.abs(b.startLine - line) < Math.abs(a.startLine - line) ? b : a));
  return {
    place: { path, line: nearest.startLine, role: 'base', quote: item.quote },
    source: `${path}:${nearest.startLine} on the base`,
  };
}

/**
 * Ground 4: a recorded decision says so. The quote is a whole learned entry, or whole consecutive sentences inside one
 * dated entry of a corrections log.
 */
function proveIntent(ref: Refutation, { records }: Evidence): Proof {
  if (ref.where !== 'standard') return NO_PROOF;
  const record = records.find((r) => (r.quotedWhole ? isWholeEntry(ref.quote, r.text) : isWholeUnits(ref.quote, r.text)));
  if (record === undefined) return NO_PROOF;
  return { place: { path: record.path, line: null, role: record.role, quote: ref.quote }, source: record.source };
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
