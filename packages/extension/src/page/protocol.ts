// The messages between the panel and the content script. No imports beyond the zod-free address rules: the content script
// loads this on every github.com page. The panel checks replies with its own schema (state/jump.ts).
import { isRepo } from '../../../shared/src/pr-ref';

/** The panel's one request to the content script of its own tab: which pull request, which file, which new-side line. */
export interface JumpRequest {
  type: 'airlock:jump';
  repo: string;
  number: number;
  anchorId: string;
  path: string;
  line: number | null;
}

export type View = 'react' | 'classic';

/** Which view was recognised (null for neither) and the names of the selectors that found nothing. On every reply. */
interface PageReportFields { view: View | null; missing: string[] }

/**
 * `line`: the row was found and marked. `file`: the file was found and no line was asked for. `asked`: the address
 * fragment was set but the row was not found, or neither view was recognised.
 */
export type JumpReply = PageReportFields & (
  | { ok: true; how: 'line' | 'file' | 'asked' }
  | { ok: false; reason: 'not-files-page' | 'file-not-on-page' }
);

/** The reply for a page that is not this pull request's Files changed page, and for any failure while answering. */
export const notFilesPage = (): JumpReply => ({ ok: false, reason: 'not-files-page', view: null, missing: [] });

const KEYS = ['anchorId', 'line', 'number', 'path', 'repo', 'type'];
const ANCHOR = /^diff-[0-9a-f]{64}$/;
export const PATH_MAX = 1000;

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** The request when `message` is exactly one, with exactly these six fields; null for anything else. */
export function parseJumpRequest(message: unknown): JumpRequest | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  if (Object.keys(message).sort().join() !== KEYS.join()) return null;
  const m = message as Record<string, unknown>;
  if (m.type !== 'airlock:jump') return null;
  if (typeof m.repo !== 'string' || !isRepo(m.repo) || !positiveInteger(m.number)) return null;
  if (typeof m.anchorId !== 'string' || !ANCHOR.test(m.anchorId)) return null;
  if (typeof m.path !== 'string' || m.path.length > PATH_MAX) return null;
  const line = m.line === null ? null : positiveInteger(m.line) ? m.line : undefined;
  if (line === undefined) return null;
  return { type: 'airlock:jump', repo: m.repo, number: m.number, anchorId: m.anchorId, path: m.path, line };
}

// Notes: the panel's list of open findings, each shown under its line on the Files changed page. Private to this browser.

export type NoteSeverity = 'block' | 'fix' | 'ask' | 'note';

/** One note: the finding's id, the file's anchor (`diff-` plus the SHA-256 of its path) and its new-side line. */
export interface PageNote { id: string; anchorId: string; line: number; severity: NoteSeverity; title: string }

/** Every note the panel wants shown for this pull request; a note not in the list is removed. */
export interface NotesMessage { type: 'airlock:notes'; pr: { repo: string; number: number }; notes: PageNote[] }
export interface ClearNotesMessage { type: 'airlock:notes-clear' }

/**
 * `placed`: notes under their line now. `waiting`: notes whose line is not on the page yet (not loaded, folded or outside
 * the diff); each is placed when its line appears. `view` and `missing` as in a jump's reply. On a page that is not this
 * pull request's Files changed view, nothing is held: zero and zero, view null.
 */
export interface NotesReply extends PageReportFields { placed: number; waiting: number }
/** The reply to a notes message that failed validation: a sentence for the panel to show. Nothing on the page changed. */
export interface NotesRefused { error: string }

/** From the content script to the extension: the person pressed `Open in Airlock` on this note. */
export interface NoteOpenMessage { type: 'airlock:note-open'; id: string }

export const NOTES_MAX = 60;
export const TITLE_MAX = 200;
/** A finding's id: `c_` and eight lowercase hexadecimal digits. */
export const NOTE_ID = /^c_[0-9a-f]{8}$/;
export const SEVERITIES: readonly NoteSeverity[] = ['block', 'fix', 'ask', 'note'];

const exactly = (value: unknown, keys: string): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).sort().join() === keys;

/** Why one note is refused, or null when it is valid. */
function noteProblem(n: unknown): string | null {
  if (!exactly(n, 'anchorId,id,line,severity,title')) return 'a note has missing or unexpected fields';
  if (typeof n.id !== 'string' || !NOTE_ID.test(n.id)) return 'a note id is not valid';
  if (typeof n.anchorId !== 'string' || !ANCHOR.test(n.anchorId)) return 'a file anchor is not valid';
  if (!positiveInteger(n.line)) return 'a line is not a positive whole number';
  if (!SEVERITIES.includes(n.severity as NoteSeverity)) return 'a severity is unknown';
  if (typeof n.title !== 'string' || n.title.length === 0 || n.title.length > TITLE_MAX) {
    return `a title is empty or longer than ${TITLE_MAX} characters`;
  }
  return null;
}

/**
 * A notes or clear message, checked field by field. Null for a message that is neither type (not for the notes); a string
 * saying what is wrong for one of those types that fails validation.
 */
export function readNotesMessage(message: unknown): NotesMessage | ClearNotesMessage | string | null {
  const type = (message as { type?: unknown } | null)?.type;
  if (typeof message !== 'object' || (type !== 'airlock:notes' && type !== 'airlock:notes-clear')) return null;
  if (type === 'airlock:notes-clear') return exactly(message, 'type') ? { type } : 'the message has unexpected fields';
  if (!exactly(message, 'notes,pr,type')) return 'the message has missing or unexpected fields';
  const { pr, notes } = message;
  if (!exactly(pr, 'number,repo') || typeof pr.repo !== 'string' || !isRepo(pr.repo) || !positiveInteger(pr.number)) {
    return 'the pull request is not valid';
  }
  if (!Array.isArray(notes)) return 'the notes are not a list';
  if (notes.length > NOTES_MAX) return `more than ${NOTES_MAX} notes`;
  for (const n of notes) {
    const problem = noteProblem(n);
    if (problem !== null) return problem;
  }
  const valid = notes as PageNote[];
  if (new Set(valid.map((n) => n.id)).size !== valid.length) return 'two notes have the same id';
  return {
    type,
    pr: { repo: pr.repo, number: pr.number },
    notes: valid.map(({ id, anchorId, line, severity, title }) => ({ id, anchorId, line, severity, title })),
  };
}

/** The sentence the panel shows for a refused notes message. */
export const notesRefused = (problem: string): NotesRefused => ({ error: `The page refused Airlock's notes: ${problem}.` });
