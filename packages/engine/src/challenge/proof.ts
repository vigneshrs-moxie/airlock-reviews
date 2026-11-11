// The proof rules: whether a refutation the challenger offers really proves its ground.
import type { Anchor, Candidate, FileDiff, Place } from '@airlock/shared';
import { posix } from 'node:path';
import { findQuote } from '../anchor/anchor.js';
import { learnedListName, standardDocuments } from '../lenses/context.js';
import { datedEntries } from '../packs/holdout.js';
import type { Pack } from '../packs/types.js';

export type Ground = 'unreachable' | 'pre-existing' | 'guarded-elsewhere' | 'documented-intent' | 'smaller' | 'none';
export interface Refutation { path: string; quote: string; where: 'head' | 'base' | 'standard' }
export type ReadFile = (where: 'head' | 'base', path: string) => Promise<string | null>;

/**
 * The proved place and, in words, where it was found, with `added` set when the proof is code this pull request added;
 * or none, with `ownCode` saying the quote was the finding's own lines on the head.
 */
export type Proof = { place: Place; source: string; added?: boolean } | { place: null; ownCode: boolean };

/**
 * A recorded decision that can prove documented intent, quoted whole: one dated entry of a corrections log or one
 * learned entry. `text` is the record as stored; `path` and `source` name it precisely.
 */
interface DecisionRecord {
  text: string;
  path: string;
  role: 'standard' | 'learned';
  source: string;
}

/** What a refutation is checked against: files on either side, the diff, and the recorded decisions. */
export interface Evidence {
  read: ReadFile;
  /** Every diff entry by path key (normalised, letter case ignored); two entries share a key when their paths differ only in case. */
  files: Map<string, FileDiff[]>;
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
    text: e.body, path: `${d.name}#${e.date}`, role: 'standard' as const, source: `the ${e.date} entry in ${d.name}`,
  })));
  const learned = packs.flatMap((p) => p.learned.map((e) => ({
    text: e.text, path: `${learnedListName(e.kind)}#${e.date}`, role: 'learned' as const,
    source: `a recorded ${e.kind === 'intended' ? 'product fact' : 'earlier correction'} dated ${e.date}`,
  })));
  return [...entries, ...learned];
}

/** The evidence for one run: `read` is called at most once per side and path, and the diff is grouped by path key. */
export function createEvidence(read: ReadFile, files: FileDiff[], packs: Pack[]): Evidence {
  const byKey = new Map<string, FileDiff[]>();
  for (const f of files) byKey.set(pathKey(f.path), [...(byKey.get(pathKey(f.path)) ?? []), f]);
  return { read: readOnce(read), files: byKey, records: decisionRecords(packs) };
}

/** A leading list marker such as `- `, `* ` or `1. `; the challenger may copy it with a learned entry. */
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
/** A record proves intent only when it is this long without whitespace and has this many words. */
const MIN_RECORD_CHARS = 40;
const MIN_RECORD_WORDS = 4;
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** True when `quote` is the whole record (runs of whitespace collapsed, a leading list marker allowed) and the record is long enough. */
function isWholeRecord(quote: string, record: string): boolean {
  const longEnough = record.replace(/\s+/g, '').length >= MIN_RECORD_CHARS
    && record.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length >= MIN_RECORD_WORDS;
  return longEnough && collapse(quote.replace(LIST_MARKER, '')) === collapse(record);
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

// A line that is only a comment: one starting with //, #, --, /*, * (which covers the closing */ too) or a JSX {/* comment.
const COMMENT_LINE = /^(?:\/\/|#|--|\/\*|\*|\{\s*\/\*)/;
/** True when every non-blank line of the quote is a comment: a comment states a claim, it does not enforce one. */
const onlyComments = (quote: string): boolean => {
  const lines = quote.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return lines.length > 0 && lines.every((l) => COMMENT_LINE.test(l));
};

/** True when any of `lines` of the head file is a line this pull request added. */
const addedByThisPr = (files: Evidence['files'], path: string, lines: Lines): boolean =>
  (files.get(pathKey(path)) ?? []).some((f) => f.hunks.some((h) => h.lines.some((l) =>
    l.kind === 'add' && l.newNo !== null && l.newNo >= lines.startLine && l.newNo <= lines.endLine)));

/**
 * Grounds 1 and 3: code on the head, other than the finding's own lines, quoted in full. A quote made only of comments
 * proves nothing. A proof on lines this pull request added still counts, marked `added` so the reason says so.
 */
async function proveOnHead(item: Item, ref: Refutation, { read, files }: Evidence): Promise<Proof> {
  if (ref.where !== 'head' || !isSafePath(ref.path) || !hasSubstance(ref.quote) || onlyComments(ref.quote)) return NO_PROOF;
  const path = posix.normalize(ref.path);
  const found = findQuote(await read('head', path), ref.quote);
  if (found.length === 0) return NO_PROOF;
  if (samePath(path, item.path) && found.some((f) => overlaps(f, item.anchor))) return OWN_CODE;
  const line = found[0]!.startLine;
  const added = addedByThisPr(files, path, found[0]!);
  return { place: { path, line, role: 'head', quote: ref.quote }, source: `${path}:${line} on the head`, ...(added ? { added } : {}) };
}

/**
 * True unless a connected place can be shown untouched. A place whose file is not in the diff is untouched. In the diff,
 * it is touched when its file was added or deleted, when it has no resolved line, when its line falls inside a hunk, or
 * when the diff holds its path twice in different letter case.
 */
function mayBeTouched(files: Evidence['files'], place: Item['connected'][number]): boolean {
  const entries = files.get(pathKey(place.path)) ?? [];
  if (entries.length === 0) return false;
  if (entries.length > 1 || place.line === null) return true;
  const file = entries[0]!;
  return file.status === 'added' || file.status === 'deleted' || insideHunk(file, { startLine: place.line, endLine: place.line });
}

/**
 * Ground 2: the finding's own code is unchanged and was already there. All must hold: the diff holds the finding's
 * file at most once; the refutation names the finding's own file (or its old path, when renamed) on the base; the
 * finding's lines are outside every hunk of its file; every connected place can be shown untouched; the finding's
 * whole quote is on the head at its anchored lines; and it is in that base file. The record cites the finding's quote
 * on the base, under the file's real path.
 */
async function provePreExisting(item: Item, ref: Refutation, { read, files }: Evidence): Promise<Proof> {
  const line = item.anchor.startLine;
  if (ref.where !== 'base' || !isSafePath(ref.path) || line === null) return NO_PROOF;
  const end = item.anchor.endLine ?? line;
  const headPath = posix.normalize(item.path);
  const entries = files.get(pathKey(item.path)) ?? [];
  if (entries.length > 1) return NO_PROOF;
  const file = entries[0];
  const own = [headPath, ...(file?.status === 'renamed' && file.oldPath ? [file.oldPath] : [])];
  const path = own.find((p) => samePath(p, ref.path));
  if (path === undefined) return NO_PROOF;
  if (file !== undefined && insideHunk(file, { startLine: line, endLine: end })) return NO_PROOF;
  if (item.connected.some((p) => mayBeTouched(files, p))) return NO_PROOF;
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
 * Ground 4: a recorded decision says so. The quote is one whole record: a learned entry, or a dated entry of a
 * corrections log from the first word after its date to its end. The refutation records the record as stored.
 */
function proveIntent(ref: Refutation, { records }: Evidence): Proof {
  if (ref.where !== 'standard') return NO_PROOF;
  const record = records.find((r) => isWholeRecord(ref.quote, r.text));
  if (record === undefined) return NO_PROOF;
  return { place: { path: record.path, line: null, role: record.role, quote: record.text }, source: record.source };
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
