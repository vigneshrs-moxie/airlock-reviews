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
/**
 * A refusal's body. For a validation failure GitHub adds an `errors` list whose entries are strings or objects
 * (`resource`, `field`, `code`, sometimes `message`); see docs/reference/github-post-notes.md.
 */
const RefusalSchema = z.object({
  message: z.string().optional(),
  errors: z.array(z.union([
    z.string(),
    z.object({ message: z.string().optional(), field: z.string().optional(), code: z.string().optional() }),
  ])).optional(),
});
type RefusalEntry = NonNullable<z.infer<typeof RefusalSchema>['errors']>[number];

/** An entry of the errors list in words: a string as it is; an object as its message, else `<field>: <code>`. */
function entryText(e: RefusalEntry): string {
  if (typeof e === 'string') return e;
  if (e.message !== undefined && e.message.trim() !== '') return e.message;
  return [e.field, e.code].filter((part) => part !== undefined && part.trim() !== '').join(': ');
}
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
  const details = (body?.errors ?? []).map(entryText).filter((e) => e.trim() !== '');
  const head = body?.message ?? '';
  const joined = head.trim() === '' ? details.join('; ') : details.length === 0 ? head : `${head}: ${details.join('; ')}`;
  const fallback = firstErrorLine.replace(STATUS, '').replace(/^gh:\s*/, '');
  return clean(joined.trim() === '' ? fallback : joined);
}

/**
 * Every check `sendReview` makes before it runs anything, and the payload as it will be sent: rebuilt field by field, so
 * the event is always COMMENT and nothing but these fields can be sent. Throws for a repository name or number that is
 * not one, and for more than POST_MAX_ITEMS comments. The caller runs it before it writes its record of the post, so a
 * check that fails leaves no record.
 */
export function reviewToSend(repo: string, number: number, payload: ReviewPayload): ReviewPayload {
  if (!isRepo(repo) || !PrNumberSchema.safeParse(number).success) throw new Error('Airlock will not post to that address.');
  if (payload.comments.length > POST_MAX_ITEMS) throw new Error(`A post holds at most ${POST_MAX_ITEMS} comments.`);
  return {
    commit_id: payload.commit_id,
    event: 'COMMENT',
    body: payload.body,
    comments: payload.comments.map((c) => ({
      path: c.path, line: c.line, side: 'RIGHT',
      ...(c.start_line === undefined ? {} : { start_line: c.start_line, start_side: 'RIGHT' as const }),
      body: c.body,
    })),
  };
}

/**
 * The one write Airlock makes to GitHub: `gh api --method POST repos/<repo>/pulls/<number>/reviews --input -`, the
 * payload as JSON on standard input, never in the arguments. The payload goes through `reviewToSend`, so the event is
 * always COMMENT and nothing but its fields can be sent. It runs once: a refusal (GitHub answered with a 4xx status)
 * and an outcome that cannot be known (a 5xx, a timeout, a cut connection, no status, a reply without a usable id) are
 * reported, never retried. The address of a posted review is built from the repository, the number and the id. Throws,
 * before running anything, where `reviewToSend` throws.
 */
export async function sendReview(exec: Exec, repo: string, number: number, payload: ReviewPayload): Promise<SendResult> {
  const sent = reviewToSend(repo, number, payload);
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

/** A GitHub login as `gh api user --jq .login` prints it: letters, digits, `-` and `_` (an enterprise login), at most 100. */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/**
 * The account `gh` is signed in as now: `gh api user --jq .login`, a read, within READ_TIMEOUT_MS. Null when it cannot be
 * read: gh missing or not signed in, an error, no answer in time, or an answer that is not a login.
 */
export async function readLogin(exec: Exec): Promise<string | null> {
  try {
    const result = await exec('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: READ_TIMEOUT_MS });
    const login = result.stdout.trim();
    return result.code === 0 && LOGIN.test(login) ? login : null;
  } catch {
    return null;
  }
}

/** How long the list of a pull request's reviews may take: every page of it. */
export const LIST_TIMEOUT_MS = 30_000;

const GitHubReviewSchema = z.object({
  id: z.number().refine((n) => Number.isSafeInteger(n) && n > 0),
  user: z.object({ login: z.string() }).nullable().optional(),
  commit_id: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
});

/** A review GitHub holds on a pull request: who wrote it (null for a deleted account), at which commit, and its text. */
export interface GitHubReview { id: number; login: string | null; commitId: string | null; body: string }

/**
 * The JSON values printed one after another, as `gh api --paginate` prints one array per page; null unless the whole
 * text is such values. Strings are read as strings, so a bracket inside a review's text is not a page's end.
 */
function jsonValues(text: string): unknown[] | null {
  const values: unknown[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      if (depth === 0) return null;
      inString = true;
    } else if (c === '[' || c === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === ']' || c === '}') {
      depth -= 1;
      if (depth < 0) return null;
      if (depth === 0) {
        try { values.push(JSON.parse(text.slice(start, i + 1))); } catch { return null; }
      }
    } else if (depth === 0 && !/\s/.test(c)) {
      return null;
    }
  }
  return depth === 0 && !inString ? values : null;
}

/**
 * Every review of a pull request: `gh api repos/<repo>/pulls/<number>/reviews --paginate`, a read, within
 * LIST_TIMEOUT_MS. Null unless every page was read whole and every entry is a review. Throws, before running anything,
 * for a repository name or number that is not one.
 */
export async function listReviews(exec: Exec, repo: string, number: number): Promise<GitHubReview[] | null> {
  if (!isRepo(repo) || !PrNumberSchema.safeParse(number).success) throw new Error('Airlock will not read that address.');
  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await exec('gh', ['api', `repos/${repo}/pulls/${number}/reviews`, '--paginate'], { timeoutMs: LIST_TIMEOUT_MS });
  } catch {
    return null;
  }
  if (result.code !== 0) return null;
  const pages = jsonValues(result.stdout);
  if (pages === null || pages.length === 0 || !pages.every((page) => Array.isArray(page))) return null;
  const parsed = z.array(GitHubReviewSchema).safeParse(pages.flat());
  if (!parsed.success) return null;
  return parsed.data.map((r) => ({ id: r.id, login: r.user?.login ?? null, commitId: r.commit_id ?? null, body: r.body ?? '' }));
}
