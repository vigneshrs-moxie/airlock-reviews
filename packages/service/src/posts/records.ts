import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoSlug, type Exec } from '@airlock/engine';
import { MESSAGE_MAX, PostRecordSchema, visibleText, type ForgetPostBody, type PostRecord } from '@airlock/shared';
import { z } from 'zod';
import { writeList } from '../dismissals.js';
import { readPull, sendReview, type SendResult } from './github.js';
import type { PreviewDeps } from './preview.js';

/** A refusal with the status the route answers with; the message is for the person. */
export class PostError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'PostError';
  }
}

export const EXPIRED = 'This preview has expired. Open the preview again.';
const MOVED = 'The pull request has new commits since this review. Review the push, then post.';
const CLOSED = 'The pull request is closed. Nothing was posted.';
const MERGED = 'The pull request has been merged. Nothing was posted.';
const STATE_UNREAD = 'Airlock could not read whether the pull request is open. Nothing was posted.';
const READ_NO_ANSWER = 'GitHub did not answer when Airlock read the pull request. Nothing was posted.';
const NO_GH = 'Airlock could not run gh, or gh is not signed in. Nothing was posted.';
const UNKNOWN = 'Airlock could not tell whether GitHub accepted the comments. Look at the pull request before posting again.';
const KEPT = 'This review was posted, so Airlock keeps its record.';
const BROKEN =
  'Airlock could not read its record of what was posted on this pull request, so it will not post. Fix or move that file in the posts folder of the Airlock home.';

const RecordsFileSchema = z.array(PostRecordSchema);

/** A sentence cut, as a whole, to MESSAGE_MAX characters (code points), ending in `…` when cut. */
export function fit(sentence: string): string {
  const chars = [...sentence];
  return chars.length <= MESSAGE_MAX ? sentence : `${chars.slice(0, MESSAGE_MAX - 1).join('')}…`;
}

/** Text from a review, for a sentence: hidden characters out, on one line. */
export const shown = (text: string): string => visibleText(text).text.replace(/\s+/g, ' ').trim();

/** Every fingerprint a finding is known by. */
export const keysOf = (fingerprint: string, aliases: readonly string[]): string[] => [fingerprint, ...aliases];

/** The record, posted or of unknown outcome, that holds a finding known by any of these fingerprints. */
export function blockingRecord(records: readonly PostRecord[], keys: readonly string[]): PostRecord | undefined {
  return records.find((r) => r.items.some((item) => keysOf(item.fingerprint, item.aliases).some((k) => keys.includes(k))));
}

/**
 * The file for a pull request, `<home>/posts/<slug>/<number>.json`. A folder that spells the repository in another letter
 * case is the same folder.
 */
async function recordsPath(home: string, repo: string, number: number): Promise<string> {
  const root = join(home, 'posts');
  const slug = repoSlug(repo);
  let folder = slug;
  try {
    const names = await readdir(root);
    folder = names.includes(slug) ? slug : names.find((n) => n.toLowerCase() === slug.toLowerCase()) ?? slug;
  } catch { /* no posts yet */ }
  return join(root, folder, `${number}.json`);
}

/** The stored list, or null when the file is there but is not a list of records. */
async function readRecords(path: string): Promise<PostRecord[] | null> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  try {
    const parsed = RecordsFileSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch { /* not JSON */ }
  return null;
}

/**
 * The records of a pull request for the panel. A stored record that does not match the contract is left out and logged
 * by its file and index (never its content), and the rest are returned; none when there is no file or it cannot be read.
 */
export async function postsFor(
  home: string, repo: string, number: number, log: (line: string) => void = () => undefined,
): Promise<PostRecord[]> {
  let path = '';
  try {
    path = await recordsPath(home, repo, number);
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(raw)) {
      log(`the posts file ${path} is not a list; no post record was read from it`);
      return [];
    }
    const kept: PostRecord[] = [];
    for (const [index, entry] of raw.entries()) {
      const parsed = PostRecordSchema.safeParse(entry);
      if (parsed.success) kept.push(parsed.data);
      else log(`the posts file ${path}: record ${index} does not match the contract and was left out`);
    }
    return kept;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`the posts file ${path} could not be read; no post record was read from it`);
    return [];
  }
}

/**
 * The records of a pull request before a preview, a post or a forget. A file that cannot be read, or holds one record
 * that does not parse, stops them (500): read as empty it could let a finding be posted twice, and rewritten without the
 * bad record it would lose it.
 */
export async function recordsOf(home: string, repo: string, number: number): Promise<{ path: string; list: PostRecord[] }> {
  const path = await recordsPath(home, repo, number);
  const list = await readRecords(path);
  if (list === null) throw new PostError(500, BROKEN);
  return { path, list };
}

/** Work on one pull request's records runs one piece after another; other pull requests do not wait. */
const queues = new Map<string, Promise<unknown>>();
function inQueue<T>(repo: string, number: number, work: () => Promise<T>): Promise<T> {
  const key = `${repo.toLowerCase()}#${number}`;
  const run = (queues.get(key) ?? Promise.resolve()).then(work, work);
  const settled = run.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return run;
}

/** What posting needs from the service. */
export interface PostDeps extends PreviewDeps {
  exec: Exec;
  log: (line: string) => void;
}

/** GitHub's reason in a sentence, cut so the whole sentence fits and still ends with `tail`. */
function withReason(lead: string, status: number, message: string, tail: string): string {
  const reason = message.replace(/[\s.]+$/, '') || `HTTP ${status}`;
  const room = MESSAGE_MAX - [...lead].length - [...tail].length;
  const chars = [...reason];
  return `${lead}${chars.length <= room ? reason : `${chars.slice(0, room - 1).join('')}…`}${tail}`;
}

const comments = (n: number): string => `${n} comment${n === 1 ? '' : 's'}`;

/**
 * Posts a stored preview as one review, exactly as stored, in the pull request's queue. The pull request is read first
 * and must be open at the preview's head; no finding of the preview may have a record. A record with an unknown outcome
 * is written before GitHub is called, once: posted, it becomes `posted`; refused, it is removed and the preview is kept
 * for another PREVIEW_MS; anything else, it stays unknown. Nothing is retried. Refusals are PostErrors.
 */
export async function post(deps: PostDeps, previewId: string): Promise<PostRecord> {
  const found = deps.previews.get(previewId, deps.now());
  if (found === null) throw new PostError(404, EXPIRED);
  return inQueue(found.repo, found.number, async () => {
    // Taken again inside the queue, and it must be the same one: a post just before this one may have spent it, or sent
    // it and had it refused and kept again, and a press made while that one was in flight is not a second try.
    const preview = deps.previews.get(previewId, deps.now());
    if (preview === null || preview !== found) throw new PostError(404, EXPIRED);
    const { repo, number } = preview;

    // Only the pull request is read, not the signed-in user: nothing else stands between the person and the post.
    const pr = await readPull(deps.exec, repo, number);
    if (pr.kind === 'missing') throw new PostError(502, fit(`GitHub has no pull request ${number} in ${repo}.`));
    if (pr.kind === 'refused') {
      throw new PostError(502, withReason('GitHub refused to show the pull request: ', pr.status, pr.message, '. Nothing was posted.'));
    }
    if (pr.kind === 'server-error') {
      throw new PostError(502, `GitHub had an error (HTTP ${pr.status}) when Airlock read the pull request. Nothing was posted.`);
    }
    if (pr.kind === 'unavailable') throw new PostError(502, NO_GH);
    if (pr.kind === 'no-answer') throw new PostError(502, READ_NO_ANSWER);
    if (pr.kind === 'unreadable') throw new PostError(502, STATE_UNREAD);
    if (pr.merged) throw new PostError(409, MERGED);
    if (pr.state === null) throw new PostError(502, STATE_UNREAD);
    if (pr.state !== 'open') throw new PostError(409, CLOSED);
    if (pr.headSha !== preview.headSha) throw new PostError(409, MOVED);

    // Dismissed in another panel since the preview was made: not posted.
    const dismissals = await deps.dismissals(repo, number);
    for (const item of preview.items) {
      const keys = keysOf(item.fingerprint, item.aliases);
      if (dismissals.some((d) => keys.includes(d.fingerprint))) {
        throw new PostError(409, fit(`This finding is dismissed; restore it before posting it: ${shown(item.title)}.`));
      }
    }

    const { path, list } = await recordsOf(deps.home, repo, number);
    for (const item of preview.items) {
      const earlier = blockingRecord(list, keysOf(item.fingerprint, item.aliases));
      if (earlier !== undefined) {
        throw new PostError(409, fit(earlier.outcome === 'posted'
          ? `This finding is already posted on this pull request: ${shown(item.title)}.`
          : `Airlock does not know whether this finding was posted: ${shown(item.title)}. Look at the pull request first.`));
      }
    }

    let id: string;
    do id = `post_${randomBytes(6).toString('hex')}`; while (list.some((r) => r.id === id));
    const record: PostRecord = PostRecordSchema.parse({
      id, repo, number, reviewId: preview.reviewId, headSha: preview.headSha, postedAt: deps.now().toISOString(),
      outcome: 'unknown', githubReviewId: null, url: null,
      items: preview.items.map((i) => ({ fingerprint: i.fingerprint, aliases: i.aliases, placement: i.placement })),
    });
    // The preview is spent before anything can reach GitHub; it comes back only if nothing was sent.
    deps.previews.remove(previewId);
    try {
      await writeList(path, [...list, record]);
    } catch (e) {
      deps.previews.add(preview);
      throw e;
    }

    const where = `post ${repo}#${number}: ${comments(preview.items.length)}`;
    let result: SendResult;
    try {
      result = await sendReview(deps.exec, repo, number, preview.payload);
    } catch (e) {
      result = { kind: 'unknown', message: e instanceof Error ? e.message : String(e) };
    }

    if (result.kind === 'posted') {
      deps.log(`${where}, posted`);
      const posted: PostRecord = { ...record, outcome: 'posted', githubReviewId: result.id, url: result.url };
      try {
        await writeList(path, [...list, PostRecordSchema.parse(posted)]);
      } catch (e) {
        deps.log(`${where}: the record could not be updated and stays unknown: ${e instanceof Error ? e.message : String(e)}`);
      }
      return posted;
    }
    if (result.kind === 'refused') {
      deps.log(`${where}, refused (HTTP ${result.status})`);
      const lead = 'GitHub refused the comments: ';
      try {
        await writeList(path, list);
      } catch (e) {
        // The unknown record stays and blocks these findings, so the preview is not kept; the person is told how to clear it.
        deps.log(`${where}: the record could not be removed and stays unknown: ${e instanceof Error ? e.message : String(e)}`);
        throw new PostError(502, withReason(lead, result.status, result.message,
          '. Nothing was posted, but Airlock could not clear its own record: press "It was not posted" before trying again.'));
      }
      deps.previews.keep(preview, deps.now());
      throw new PostError(502, withReason(lead, result.status, result.message, '. Nothing was posted.'));
    }
    deps.log(`${where}, outcome unknown`);
    throw new PostError(504, UNKNOWN);
  });
}

/** Removes a record whose outcome is unknown, once the person says it was not posted. A posted one is kept (409). */
export async function forget(deps: Pick<PostDeps, 'home'>, body: ForgetPostBody): Promise<{ forgotten: boolean }> {
  return inQueue(body.repo, body.number, async () => {
    const { path, list } = await recordsOf(deps.home, body.repo, body.number);
    const found = list.find((r) => r.id === body.id);
    if (found === undefined) return { forgotten: false };
    if (found.outcome !== 'unknown') throw new PostError(409, KEPT);
    await writeList(path, list.filter((r) => r.id !== body.id));
    return { forgotten: true };
  });
}
