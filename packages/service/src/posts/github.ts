import type { Exec } from '@airlock/engine';
import { isRepo, POST_MAX_ITEMS, PrNumberSchema, visibleText } from '@airlock/shared';
import { z } from 'zod';

/** One comment on a line of the diff: `RIGHT` only, a range only when `start_line` is given. */
export interface ReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  start_line?: number;
  start_side?: 'RIGHT';
  body: string;
}

/** What GitHub is sent. `event` is the literal COMMENT: no other kind of review can be typed. */
export interface ReviewPayload {
  commit_id: string;
  event: 'COMMENT';
  body: string;
  comments: ReviewComment[];
}

export type SendResult =
  | { kind: 'posted'; id: number; url: string }
  | { kind: 'refused'; status: number; message: string }
  | { kind: 'unknown'; message: string };

/**
 * How long the one write may take before Airlock stops waiting and calls its outcome unknown: under the panel's 60-second
 * limit on a call, with room for the read of the pull request before it.
 */
export const SEND_TIMEOUT_MS = 45_000;
/** The most characters of GitHub's reason that are kept. */
export const REFUSAL_MAX = 300;

/** Only the id is read from GitHub's reply; the review's address is built by code from it. */
const CreatedSchema = z.object({ id: z.number().refine((n) => Number.isSafeInteger(n) && n > 0) });
const RefusalSchema = z.object({
  message: z.string().optional(),
  errors: z.array(z.union([z.string(), z.object({ message: z.string().optional() })])).optional(),
});
/** `gh` ends the first line of standard error with `(HTTP <status>)` when GitHub answered with an error status. */
const STATUS = /\(HTTP (\d{3})\)\s*$/;

/** Hidden characters out, runs of white space one space, at most REFUSAL_MAX characters (code points). */
function clean(text: string): string {
  const chars = [...visibleText(text).text.replace(/\s+/g, ' ').trim()];
  return chars.slice(0, REFUSAL_MAX).join('');
}

/** GitHub's reason from the body `gh` prints on standard output, else from its first line of standard error. */
function reason(stdout: string, firstErrorLine: string): string {
  let body: z.infer<typeof RefusalSchema> | null = null;
  try {
    const parsed = RefusalSchema.safeParse(JSON.parse(stdout));
    if (parsed.success) body = parsed.data;
  } catch { /* not JSON */ }
  const details = (body?.errors ?? [])
    .map((e) => (typeof e === 'string' ? e : e.message ?? ''))
    .filter((e) => e.trim() !== '');
  const head = body?.message ?? '';
  const joined = head.trim() === '' ? details.join('; ') : details.length === 0 ? head : `${head}: ${details.join('; ')}`;
  const fallback = firstErrorLine.replace(STATUS, '').replace(/^gh:\s*/, '');
  return clean(joined.trim() === '' ? fallback : joined);
}

/**
 * The one write Airlock makes to GitHub: `gh api --method POST repos/<repo>/pulls/<number>/reviews --input -`, the
 * payload as JSON on standard input, never in the arguments. The payload is rebuilt field by field, so the event is
 * always COMMENT and nothing but these fields can be sent. It runs once: a refusal (GitHub answered with a 4xx status)
 * and an outcome that cannot be known (a 5xx, a timeout, a cut connection, no status, a reply without a usable id) are
 * reported, never retried. The address of a posted review is built from the repository, the number and the id. Throws, before running anything, for a repository name or number that is not one.
 */
export async function sendReview(exec: Exec, repo: string, number: number, payload: ReviewPayload): Promise<SendResult> {
  if (!isRepo(repo) || !PrNumberSchema.safeParse(number).success) throw new Error('Airlock will not post to that address.');
  if (payload.comments.length > POST_MAX_ITEMS) throw new Error(`A post holds at most ${POST_MAX_ITEMS} comments.`);
  const sent: ReviewPayload = {
    commit_id: payload.commit_id,
    event: 'COMMENT',
    body: payload.body,
    comments: payload.comments.map((c) => ({
      path: c.path, line: c.line, side: 'RIGHT',
      ...(c.start_line === undefined ? {} : { start_line: c.start_line, start_side: 'RIGHT' as const }),
      body: c.body,
    })),
  };
  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await exec('gh', ['api', '--method', 'POST', `repos/${repo}/pulls/${number}/reviews`, '--input', '-'], {
      // The one caller in the repository that may write through gh; the engine's exec refuses any other.
      input: JSON.stringify(sent), timeoutMs: SEND_TIMEOUT_MS, allowGhWrite: true,
    });
  } catch (e) {
    return { kind: 'unknown', message: clean(e instanceof Error ? e.message : String(e)) };
  }
  if (result.code === 0) {
    try {
      const created = CreatedSchema.safeParse(JSON.parse(result.stdout));
      if (created.success) {
        // The address is built here from the id, not taken from the reply.
        return { kind: 'posted', id: created.data.id, url: `https://github.com/${repo}/pull/${number}#pullrequestreview-${created.data.id}` };
      }
    } catch { /* not JSON */ }
    return { kind: 'unknown', message: 'GitHub answered, but its reply could not be read.' };
  }
  const firstErrorLine = result.stderr.split('\n')[0] ?? '';
  const status = STATUS.exec(firstErrorLine)?.[1];
  // Only a 4xx is a refusal. A 5xx can come after the review was made, so it is not known, like no status at all.
  if (result.code === 1 && status !== undefined && status.startsWith('4')) {
    return { kind: 'refused', status: Number(status), message: reason(result.stdout, firstErrorLine) };
  }
  return { kind: 'unknown', message: clean(result.stderr) };
}

/** How long the read of the pull request before a post may take. */
export const READ_TIMEOUT_MS = 10_000;

const PullSchema = z.object({
  state: z.string().optional(), merged: z.boolean().optional(), head: z.object({ sha: z.string() }),
});

export type PullRead =
  | { kind: 'pull'; state: string | null; merged: boolean; headSha: string }
  | { kind: 'missing' }
  | { kind: 'refused'; status: number; message: string }
  | { kind: 'server-error'; status: number }
  | { kind: 'unavailable' }
  | { kind: 'no-answer' }
  | { kind: 'unreadable' };

/** gh's exit code when it is not signed in. */
const GH_NOT_SIGNED_IN = 4;

/**
 * Reads the pull request before a post: `gh api repos/<repo>/pulls/<number>`, a read, within READ_TIMEOUT_MS. Says
 * which it was: the pull request; GitHub's 404; another 4xx with GitHub's reason; a 5xx; gh missing or not signed in
 * (GitHub was never asked); no answer (a timeout, a cut connection, no status); or an answer that is not a pull request. Throws, before running anything, for a repository
 * name or number that is not one.
 */
export async function readPull(exec: Exec, repo: string, number: number): Promise<PullRead> {
  if (!isRepo(repo) || !PrNumberSchema.safeParse(number).success) throw new Error('Airlock will not read that address.');
  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await exec('gh', ['api', `repos/${repo}/pulls/${number}`], { timeoutMs: READ_TIMEOUT_MS });
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'unavailable' } : { kind: 'no-answer' };
  }
  if (result.code === GH_NOT_SIGNED_IN) return { kind: 'unavailable' };
  if (result.code === 0) {
    try {
      const pull = PullSchema.safeParse(JSON.parse(result.stdout));
      if (pull.success) {
        return { kind: 'pull', state: pull.data.state ?? null, merged: pull.data.merged === true, headSha: pull.data.head.sha };
      }
    } catch { /* not JSON */ }
    return { kind: 'unreadable' };
  }
  const firstErrorLine = result.stderr.split('\n')[0] ?? '';
  const status = STATUS.exec(firstErrorLine)?.[1];
  if (result.code !== 1 || status === undefined) return { kind: 'no-answer' };
  if (status === '404') return { kind: 'missing' };
  if (status.startsWith('5')) return { kind: 'server-error', status: Number(status) };
  return { kind: 'refused', status: Number(status), message: reason(result.stdout, firstErrorLine) };
}
