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
