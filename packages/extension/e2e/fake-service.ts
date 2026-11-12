import {
  ApiErrorSchema, checkCommentText, commentBody, DismissalSchema, DismissBodySchema, ForgetPostBodySchema, HelloSchema, LatestReplySchema,
  LearnedReplySchema, PairReplySchema, postMentions, PostBodySchema, PostPreviewBodySchema, PostPreviewReplySchema, PostRecordSchema, PrSummarySchema,
  RemoveLearnedBodySchema, RemoveLearnedReplySchema, RestoreBodySchema, RestoreReplySchema, RunIdSchema, ServiceEventSchema, ServiceStatusSchema, StartReviewBodySchema,
  StartReviewReplySchema, summaryBody, SUMMARY_MAX,
  type Dismissal, type Finding, type LatestReply, type LearnedLine, type Placement, type PostPreviewItem, type PostPreviewReply, type PostRecord,
  type PrSummary, type ReviewDocument, type ServiceEvent,
} from '@airlock/shared';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { E2E_PORT } from './port';

// Written in wxt.config.ts next to the key it comes from.
const EXTENSION_ORIGIN = 'chrome-extension://nbcmjckbkploiemllhkmhegjimgeimoa';

// The sentences the real service answers with (packages/service/src/{http,routes,sse,dismissals,server}.ts).
const NOTHING_HERE = 'Airlock has nothing at this address.';
const WRONG_METHOD = 'This address does not accept that method.';

/** The real service's routes, as method and path pattern, so an unknown address is answered before the token. */
const ROUTES: Array<{ method: string; path: RegExp }> = [
  { method: 'GET', path: /^\/hello$/ },
  { method: 'POST', path: /^\/pair$/ },
  { method: 'GET', path: /^\/status$/ },
  { method: 'GET', path: /^\/pr$/ },
  { method: 'POST', path: /^\/reviews$/ },
  { method: 'GET', path: /^\/reviews\/running$/ },
  { method: 'GET', path: /^\/reviews\/latest$/ },
  { method: 'GET', path: /^\/reviews\/[^/]+\/events$/ },
  { method: 'POST', path: /^\/dismissals$/ },
  { method: 'POST', path: /^\/dismissals\/restore$/ },
  { method: 'POST', path: /^\/posts\/preview$/ },
  { method: 'POST', path: /^\/posts$/ },
  { method: 'POST', path: /^\/posts\/forget$/ },
  { method: 'GET', path: /^\/learned$/ },
  { method: 'POST', path: /^\/learned\/remove$/ },
];
/** The routes that can lead to a GitHub write: the real service refuses them without an Origin, before the token. */
const NEEDS_ORIGIN = new Set(['/posts/preview', '/posts', '/posts/forget', '/learned/remove']);
const NOT_HERE = 'Airlock only answers on this Mac.';
const NOT_THIS_PAGE = 'Airlock does not accept requests from this page.';
const NEEDS_TOKEN = 'Airlock needs its pairing token.';
const NOT_RUNNING = 'Airlock is not reviewing this pull request now.';
const NO_REVIEW = 'Airlock has no review of this pull request yet.';
const NO_SUCH_PR = 'GitHub has no such pull request, or you cannot see it.';
const RUN_GONE = 'Airlock no longer has that review run. Open the latest review instead.';
const NOT_FOUND = 'Airlock cannot find that finding in the stored review.';
const PAIRED_ELSEWHERE =
  'Airlock is already paired with another copy of the extension. In the airlock-reviews folder, run: npm run service -- unpair, then pair again.';
const KIT_PACK = 'raj-standard';
// The sentences of the learned routes: a line that is no longer there, and the team's kit.
const LEARNED_GONE = 'That line was already gone; it may have been edited by hand.';
const LEARNED_REMOVED = 'Removed. The reviewer stops following it from the next review.';
const KIT_KEPT = 'This line belongs to the team kit, which is not edited here.';
const LEARNED_CAP = 300;
// The post sentences of packages/service/src/posts/{preview,records}.ts.
const NO_REVIEW_HERE = 'Airlock cannot find that review of this pull request.';
const NOT_ON_DIFF = 'The line is not part of the diff GitHub shows.';
const CHOSEN = 'You chose the summary.';
const EXPIRED = 'This preview has expired. Open the preview again.';
const NO_EARLIER = 'There is no earlier review of this pull request.';
const NOTHING_PUSHED = 'Nothing was pushed since the last review.';
const MOVED = 'The pull request has new commits since this review. Review the push, then post.';
const CLOSED = 'The pull request is closed. Nothing was posted.';
const MERGED = 'The pull request has been merged. Nothing was posted.';
const UNKNOWN = 'Airlock could not tell whether GitHub accepted the comments. Look at the pull request before posting again.';
const KEPT = 'This review was posted, so Airlock keeps its record.';
const PREVIEW_MS = 10 * 60_000;
// The real router's body limits: the preview route takes a full-size preview, every other route 64 KB.
const PREVIEW_BODY_MAX = 512 * 1024;
const BODY_MAX = 64 * 1024;
const TOO_LARGE = 'The request body is too large.';
const ForgetReplySchema = z.object({ forgotten: z.boolean() });

/** What the fake's GitHub does with the next post: takes it (the default), refuses it with a message, or never answers clearly. */
export type GithubAnswer = { accept: true } | { refuse: string } | { unknown: true };

/** One review the fake would have sent to GitHub, exactly as the stored preview held it. */
export interface SentReview {
  repo: string;
  number: number;
  event: 'COMMENT';
  body: string;
  comments: Array<{ path: string; line: number; startLine: number | null; body: string }>;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  /** The JSON body, parsed; undefined when there was none. */
  body?: unknown;
}

/**
 * One step of a scripted review run: an event (checked against the contract before it is written), a keep-alive comment,
 * a real pause, or a wait for the spec's signal.
 */
export type RunStep =
  | { event: ServiceEvent }
  | { comment: string }
  | { pause: number }
  | { until: Promise<void> };

/** A promise the spec resolves when it is ready for a script to go on. */
export interface Signal { promise: Promise<void>; open(): void }

export function signal(): Signal {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

export interface FakePull {
  pr: PrSummary;
  /** The review stored for the pull request, as `GET /reviews/latest` gives it; none by default. */
  latest?: LatestReply;
  /** What a review started on this pull request does, step by step; it starts when `POST /reviews` is answered. */
  script?: RunStep[];
}

export interface FakeServiceOptions {
  port?: number;
  /** The service's pairing token. With it and without `unpaired`, the service starts paired with the extension. */
  token?: string;
  /** Start with no extension paired: `POST /pair` with the token, from an extension, pairs it. */
  unpaired?: boolean;
  /** The pull requests it knows. */
  pulls?: FakePull[];
  /** The learned lines it holds, newest first, as `GET /learned` gives them. */
  learned?: LearnedLine[];
}

/** A run the fake started: every event written so far, in order, and whether its script has finished. */
export interface FakeRun {
  runId: string;
  repo: string;
  number: number;
  /** Everything written to the run's streams so far, events and comments, in order. */
  written: (ServiceEvent | { comment: string })[];
  finished: boolean;
}

export interface FakeService {
  requests: RecordedRequest[];
  /** Replies that did not match the contract (answered with a 500 instead); a spec expects none. */
  problems: string[];
  runs: FakeRun[];
  /** The dismissals stored for a pull request; they survive `stop` and `start`, as the real service's file does. */
  dismissals(repo: string, number: number): Dismissal[];
  /** The post records of a pull request. */
  posts(repo: string, number: number): PostRecord[];
  /** The pull request got a new head, and the next review started on it plays `script`. */
  push(repo: string, number: number, headSha: string, script: RunStep[]): void;
  /** The learned lines held now, newest first; a spec may take one out to stand for an edit by hand. */
  learned: LearnedLine[];
  /** Every preview the fake answered with, in order. */
  previews: PostPreviewReply[];
  /** Every review sent to the fake's GitHub, one per post that reached it, in order. */
  sent: SentReview[];
  /** What GitHub does with the next post; after it, posts are taken again. */
  answerNextPost(answer: GithubAnswer): void;
  /** Stops listening and cuts every open connection; what it holds is kept. */
  stop(): Promise<void>;
  /** Listens again on the same port, with everything it held. */
  start(): Promise<void>;
  /** Stops for good: `stop`, and any script waiting is let go. */
  close(): Promise<void>;
}

type Pull = { pr: PrSummary; document: ReviewDocument | null; dismissals: Dismissal[]; posts: PostRecord[]; script: RunStep[] | null };
type StoredPreview = {
  previewId: string; repo: string; number: number; reviewId: string; headSha: string; expiresAt: number; review: SentReview;
  items: PostRecord['items'];
};
type Stream = { res: ServerResponse; send: (item: ServiceEvent | { comment: string }) => void };
type LiveRun = FakeRun & { streams: Set<Stream> };

class Refusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface Checked<T> { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } } }

function firstProblem(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'unknown';
  return `${issue.path.map(String).join('.')} ${issue.message}`;
}

const today = (now: Date): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/**
 * A stand-in for the Airlock service that speaks its contract: the Host, Origin and token checks, `GET /hello`,
 * `POST /pair`, `GET /status`, `GET /pr`, `POST /reviews`, `GET /reviews/running`, `GET /reviews/<runId>/events` (a real
 * event stream, written step by step from the pull request's script), `GET /reviews/latest`, `POST /dismissals`,
 * `POST /dismissals/restore`, and the post routes `POST /posts/preview`, `POST /posts` and `POST /posts/forget` (which
 * require an Origin, and whose GitHub is in memory: it records what it is sent and answers as `answerNextPost` says), and the learned
 * routes `GET /learned` and `POST /learned/remove` (which requires an Origin and refuses a kit line). Request bodies and query values are checked with the shared schemas, and every reply is
 * checked against its schema before it is sent; a reply that does not match is answered with a 500 and recorded in
 * `problems`. It remembers every request, and can be stopped and started again on the same port.
 */
export async function startFakeService(options: FakeServiceOptions = {}): Promise<FakeService> {
  const { port = E2E_PORT, token, unpaired = false } = options;
  const requests: RecordedRequest[] = [];
  const problems: string[] = [];
  const runs: LiveRun[] = [];
  const pulls: Pull[] = (options.pulls ?? []).map((p) => ({
    pr: PrSummarySchema.parse(p.pr),
    document: p.latest === undefined ? null : LatestReplySchema.parse(p.latest).document,
    dismissals: p.latest?.dismissals ?? [],
    posts: p.latest?.posts ?? [],
    script: p.script ?? null,
  }));
  const learned: LearnedLine[] = [...(options.learned ?? [])];
  const previews: PostPreviewReply[] = [];
  const stored = new Map<string, StoredPreview>();
  const sent: SentReview[] = [];
  const answers: GithubAnswer[] = [];
  let githubIds = 9000;
  let pairedOrigin: string | null = token !== undefined && !unpaired ? EXTENSION_ORIGIN : null;
  let closed = false;
  const releases = new Set<() => void>();

  const pullOf = (repo: unknown, number: unknown): Pull | undefined =>
    pulls.find((p) => p.pr.repo === repo && p.pr.number === number);

  /** A reply checked against its contract; a mismatch is recorded and answered as the real service would, with a 500. */
  function reply<T>(res: ServerResponse, schema: Checked<T>, status: number, value: T): void {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const problem = `${res.req.method ?? '?'} ${res.req.url ?? '?'}: the reply does not match its contract: ${firstProblem(parsed.error)}`;
      problems.push(problem);
      writeJson(res, 500, { error: `Airlock had a problem: ${problem}` });
      return;
    }
    writeJson(res, status, parsed.data);
  }
  const refuse = (res: ServerResponse, status: number, error: string): void => reply(res, ApiErrorSchema, status, { error });

  function bodyOf<T>(schema: Checked<T>, body: unknown): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new Refusal(400, firstProblem(parsed.error));
    return parsed.data;
  }

  function queryOf(url: URL): { repo: string; number: number } {
    const repo = url.searchParams.get('repo') ?? '';
    const raw = url.searchParams.get('number') ?? '';
    if (!/^[1-9][0-9]*$/.test(raw)) throw new Refusal(400, 'number: not a pull request number');
    return { repo, number: Number(raw) };
  }

  /** Writes one step to every open stream of the run and keeps it for later listeners. */
  function write(run: LiveRun, item: ServiceEvent | { comment: string }): void {
    if ('type' in item) {
      const parsed = ServiceEventSchema.safeParse(item);
      if (!parsed.success) {
        problems.push(`run ${run.runId}: an event does not match its contract: ${firstProblem(parsed.error)}`);
        return;
      }
    }
    run.written.push(item);
    for (const stream of run.streams) stream.send(item);
  }

  async function play(run: LiveRun, pull: Pull, script: RunStep[]): Promise<void> {
    for (const step of script) {
      if (closed) return;
      if ('pause' in step) await new Promise((resolve) => setTimeout(resolve, step.pause));
      else if ('until' in step) await new Promise<void>((resolve) => { releases.add(resolve); void step.until.then(resolve); });
      else if ('comment' in step) write(run, step);
      else {
        write(run, step.event);
        // As the engine does, the finished review is stored before the run ends.
        if (step.event.type === 'done') pull.document = step.event.document;
      }
    }
    run.finished = true;
    for (const stream of run.streams) stream.res.end();
    run.streams.clear();
  }

  function events(req: IncomingMessage, res: ServerResponse, runId: string): void {
    const run = runs.find((r) => r.runId === runId);
    if (!RunIdSchema.safeParse(runId).success) { refuse(res, 404, NOTHING_HERE); return; }
    if (run === undefined) { refuse(res, 404, RUN_GONE); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.flushHeaders();
    const stream: Stream = {
      res,
      send: (item) => {
        if (res.writableEnded) return;
        res.write('type' in item ? `data: ${JSON.stringify(item)}\n\n` : `: ${item.comment.replace(/[\r\n]+/g, ' ')}\n\n`);
      },
    };
    for (const item of run.written) stream.send(item);
    if (run.finished) { res.end(); return; }
    run.streams.add(stream);
    req.on('close', () => run.streams.delete(stream));
  }

  function dismiss(res: ServerResponse, body: unknown): void {
    const asked = bodyOf(DismissBodySchema, body);
    const pull = pullOf(asked.repo, asked.number);
    const doc = pull?.document;
    const finding = doc !== null && doc !== undefined && doc.id === asked.reviewId
      ? doc.findings.find((f) => f.id === asked.findingId) : undefined;
    if (pull === undefined || doc === null || doc === undefined || finding === undefined) throw new Refusal(404, NOT_FOUND);
    const now = new Date();
    // As the service does: the first selected pack that is neither the team kit's nor generic, else generic.
    const target = pull.pr.packs.find((p) => p.id !== KIT_PACK && p.id !== 'generic') ?? pull.pr.packs.find((p) => p.id === 'generic');
    const learns = asked.reason !== 'not-now';
    if (learns && target === undefined) throw new Error('Airlock found no pack to save what it learned in.');
    const record: Dismissal = {
      fingerprint: finding.fingerprint, findingId: finding.id, reviewId: doc.id, reason: asked.reason, text: asked.text,
      at: now.toISOString(),
      learned: learns && target !== undefined ? { packId: target.id, kind: asked.reason === 'wrong' ? 'wrong' : 'intended', date: today(now) } : null,
    };
    pull.dismissals = [...pull.dismissals.filter((d) => d.fingerprint !== record.fingerprint), record];
    reply(res, DismissalSchema, 200, record);
  }

  function restore(res: ServerResponse, body: unknown): void {
    const asked = bodyOf(RestoreBodySchema, body);
    const pull = pullOf(asked.repo, asked.number);
    const had = pull?.dismissals.some((d) => d.fingerprint === asked.fingerprint) === true;
    if (pull !== undefined && had) pull.dismissals = pull.dismissals.filter((d) => d.fingerprint !== asked.fingerprint);
    reply(res, RestoreReplySchema, 200, { restored: had, note: null });
  }

  const keysOf = (f: Pick<Finding, 'fingerprint' | 'aliases'>): string[] => [f.fingerprint, ...(f.aliases ?? [])];
  const blocking = (pull: Pull, keys: readonly string[]): PostRecord | undefined =>
    pull.posts.find((r) => r.items.some((item) => [item.fingerprint, ...item.aliases].some((k) => keys.includes(k))));
  const blockedBy = (record: PostRecord, title: string): string => record.outcome === 'posted'
    ? `This finding is already posted on this pull request: ${title}.`
    : `Airlock does not know whether this finding was posted: ${title}. Look at the pull request first.`;

  /** As the service's buildPreview: the exact review a post would send, stored for ten minutes. */
  function preview(res: ServerResponse, body: unknown): void {
    const asked = bodyOf(PostPreviewBodySchema, body);
    const pull = pullOf(asked.repo, asked.number);
    const doc = pull?.document;
    if (pull === undefined || doc === null || doc === undefined || doc.id !== asked.reviewId) throw new Refusal(404, NO_REVIEW_HERE);
    const chosen: Finding[] = [];
    for (const item of asked.items) {
      const finding = doc.findings.find((f) => keysOf(f).includes(item.fingerprint));
      const asKeys = finding === undefined ? [item.fingerprint] : keysOf(finding);
      const fixed = (doc.fixed ?? []).find((f) => keysOf(f).some((k) => asKeys.includes(k)));
      if (fixed !== undefined) throw new Refusal(404, `This finding is fixed, so it cannot be posted: ${fixed.title}.`);
      if (finding === undefined) throw new Refusal(404, NOT_FOUND);
      if (chosen.includes(finding)) throw new Refusal(400, `This finding is chosen twice: ${finding.title}.`);
      const keys = keysOf(finding);
      if (pull.dismissals.some((d) => keys.includes(d.fingerprint))) {
        throw new Refusal(409, `This finding is dismissed; restore it before posting it: ${finding.title}.`);
      }
      const earlier = blocking(pull, keys);
      if (earlier !== undefined) throw new Refusal(409, blockedBy(earlier, finding.title));
      chosen.push(finding);
    }
    const items: PostPreviewItem[] = [];
    const comments: SentReview['comments'] = [];
    const inSummary: { path: string; line: number | null; body: string }[] = [];
    const placements: Placement[] = [];
    // What `postMentions` reads, as the service gives it: each text, whether it is the drafted one, and where it goes.
    const texts: { body: string; isDefault: boolean; inSummary: boolean }[] = [];
    for (const [i, item] of asked.items.entries()) {
      const finding = chosen[i] as Finding;
      const drafted = commentBody(finding);
      const text = item.body ?? drafted;
      const problem = checkCommentText(text);
      if (problem !== null) throw new Refusal(400, problem);
      const place = finding.anchor.comment ?? null;
      if (place !== null && item.placement !== 'summary') {
        const startLine = place.startLine !== null && place.startLine < place.line ? place.startLine : null;
        comments.push({ path: finding.path, line: place.line, startLine, body: text });
        items.push({ fingerprint: item.fingerprint, title: finding.title, path: finding.path, line: place.line, startLine, placement: 'inline', whySummary: null, body: text, mentions: [] });
        placements.push('inline');
        texts.push({ body: text, isDefault: text === drafted, inSummary: false });
      } else {
        const line = place?.line ?? finding.anchor.startLine ?? null;
        inSummary.push({ path: finding.path, line, body: text });
        items.push({
          fingerprint: item.fingerprint, title: finding.title, path: finding.path, line, startLine: null, placement: 'summary',
          whySummary: item.placement === 'summary' ? CHOSEN : NOT_ON_DIFF, body: text, mentions: [],
        });
        placements.push('summary');
        texts.push({ body: text, isDefault: text === drafted, inSummary: true });
      }
    }
    const count = asked.items.length;
    const generated = `Review notes from Airlock: ${count} comment${count === 1 ? '' : 's'}.`;
    const summary = asked.summary ?? generated;
    const summaryProblem = checkCommentText(summary, SUMMARY_MAX);
    if (summaryProblem !== null) throw new Refusal(400, summaryProblem);
    const reviewBody = summaryBody(inSummary, summary);
    // The one rule for which names are warned about, as the service applies it.
    const named = postMentions(texts, { text: summary, isDefault: summary === generated }, reviewBody);
    named.items.forEach((list, i) => { (items[i] as PostPreviewItem).mentions = list; });
    const previewId = `pv_${randomBytes(8).toString('hex')}`;
    const expiresAt = Date.now() + PREVIEW_MS;
    stored.set(previewId, {
      previewId, repo: doc.pr.repo, number: doc.pr.number, reviewId: doc.id, headSha: doc.pr.headSha, expiresAt,
      review: { repo: doc.pr.repo, number: doc.pr.number, event: 'COMMENT', body: reviewBody, comments },
      items: chosen.map((f, i) => ({ fingerprint: f.fingerprint, aliases: f.aliases ?? [], placement: placements[i] as Placement })),
    });
    const answer: PostPreviewReply = {
      previewId, headSha: doc.pr.headSha, viewer: doc.pr.viewer, items, summary, reviewBody, expiresAt: new Date(expiresAt).toISOString(),
      reviewBodyMentions: named.reviewBody,
    };
    previews.push(answer);
    reply(res, PostPreviewReplySchema, 200, answer);
  }

  /** As the service's post: the stored preview, sent once to the fake GitHub, never retried. */
  function post(res: ServerResponse, body: unknown): void {
    const asked = bodyOf(PostBodySchema, body);
    const held = stored.get(asked.previewId);
    if (held === undefined || Date.now() >= held.expiresAt) throw new Refusal(404, EXPIRED);
    const pull = pullOf(held.repo, held.number);
    if (pull === undefined) throw new Refusal(404, NO_REVIEW_HERE);
    if (pull.pr.state === 'merged') throw new Refusal(409, MERGED);
    if (pull.pr.state === 'closed') throw new Refusal(409, CLOSED);
    if (pull.pr.headSha !== held.headSha) throw new Refusal(409, MOVED);
    const earlier = blocking(pull, held.items.flatMap((item) => [item.fingerprint, ...item.aliases]));
    if (earlier !== undefined) throw new Refusal(409, blockedBy(earlier, 'a chosen finding'));
    stored.delete(held.previewId);
    const answer = answers.shift() ?? { accept: true };
    sent.push(held.review);
    const record = {
      id: `post_${randomBytes(6).toString('hex')}`, repo: held.repo, number: held.number, reviewId: held.reviewId, headSha: held.headSha,
      postedAt: new Date().toISOString(), items: held.items,
    };
    if ('refuse' in answer) {
      // Kept for another try, for ten minutes from the refusal, as the service's Previews.keep does.
      stored.set(held.previewId, { ...held, expiresAt: Date.now() + PREVIEW_MS });
      throw new Refusal(502, `GitHub refused the comments: ${answer.refuse}. Nothing was posted.`);
    }
    if ('unknown' in answer) {
      pull.posts = [...pull.posts, { ...record, outcome: 'unknown', githubReviewId: null, url: null }];
      throw new Refusal(504, UNKNOWN);
    }
    githubIds += 1;
    const posted: PostRecord = {
      ...record, outcome: 'posted', githubReviewId: githubIds, url: `https://github.com/${held.repo}/pull/${held.number}#pullrequestreview-${githubIds}`,
    };
    pull.posts = [...pull.posts, posted];
    reply(res, PostRecordSchema, 200, posted);
  }

  function forget(res: ServerResponse, body: unknown): void {
    const asked = bodyOf(ForgetPostBodySchema, body);
    const pull = pullOf(asked.repo, asked.number);
    const record = pull?.posts.find((r) => r.id === asked.id);
    if (pull === undefined || record === undefined) { reply(res, ForgetReplySchema, 200, { forgotten: false }); return; }
    if (record.outcome === 'posted') throw new Refusal(409, KEPT);
    pull.posts = pull.posts.filter((r) => r.id !== asked.id);
    reply(res, ForgetReplySchema, 200, { forgotten: true });
  }

  function removeLearned(res: ServerResponse, body: unknown): void {
    const asked = bodyOf(RemoveLearnedBodySchema, body);
    const at = learned.findIndex((l) => l.pack === asked.pack && l.kind === asked.kind && l.key === asked.key);
    if (at === -1) { reply(res, RemoveLearnedReplySchema, 200, { removed: false, note: LEARNED_GONE }); return; }
    if (learned[at]?.removable !== true || asked.pack === KIT_PACK) throw new Refusal(403, KIT_KEPT);
    learned.splice(at, 1);
    reply(res, RemoveLearnedReplySchema, 200, { removed: true, note: LEARNED_REMOVED });
  }

  function start(res: ServerResponse, body: unknown): void {
    const asked = bodyOf(StartReviewBodySchema, body);
    const existing = runs.find((r) => r.repo === asked.repo && r.number === asked.number && !r.finished);
    if (existing !== undefined) { reply(res, StartReviewReplySchema, 200, { runId: existing.runId, reused: true }); return; }
    const pull = pullOf(asked.repo, asked.number);
    if (pull === undefined || pull.script === null) throw new Refusal(404, NO_SUCH_PR);
    // As the real service answers a start for the push alone.
    if (asked.since === 'last') {
      if (pull.document === null) throw new Refusal(409, NO_EARLIER);
      if (pull.document.pr.headSha === pull.pr.headSha) throw new Refusal(409, NOTHING_PUSHED);
    }
    const run: LiveRun = { runId: `run_${randomBytes(6).toString('hex')}`, repo: asked.repo, number: asked.number, written: [], finished: false, streams: new Set() };
    runs.push(run);
    reply(res, StartReviewReplySchema, 200, { runId: run.runId, reused: false });
    void play(run, pull, pull.script);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.once('error', reject);
    });
    let body: unknown;
    if (text !== '') {
      try { body = JSON.parse(text); } catch { refuse(res, 400, 'The request body is not valid JSON.'); return; }
    }
    requests.push({ method, url: req.url ?? '', headers: req.headers, ...(body === undefined ? {} : { body }) });

    // The checks in the real router's order: Host, OPTIONS, the address (404, then 405), then Origin and the token, which
    // the open /hello skips.
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) { refuse(res, 403, NOT_HERE); return; }
    if (method === 'OPTIONS') { refuse(res, 403, NOT_THIS_PAGE); return; }
    const known = ROUTES.filter((r) => r.path.test(url.pathname));
    if (known.length === 0) { refuse(res, 404, NOTHING_HERE); return; }
    if (!known.some((r) => r.method === method)) { refuse(res, 405, WRONG_METHOD); return; }
    if (method === 'GET' && url.pathname === '/hello') {
      reply(res, HelloSchema, 200, { airlock: true, version: 'test', paired: pairedOrigin !== null });
      return;
    }
    const origin = req.headers.origin ?? null;
    const pairing = method === 'POST' && url.pathname === '/pair';
    if (pairing ? origin === null || !origin.startsWith('chrome-extension://') : origin !== null && origin !== pairedOrigin) {
      refuse(res, 403, NOT_THIS_PAGE);
      return;
    }
    if (NEEDS_ORIGIN.has(url.pathname) && origin === null) { refuse(res, 403, NOT_THIS_PAGE); return; }
    if (token === undefined || req.headers.authorization !== `Bearer ${token}`) { refuse(res, 401, NEEDS_TOKEN); return; }
    if (Buffer.byteLength(text, 'utf8') > (url.pathname === '/posts/preview' ? PREVIEW_BODY_MAX : BODY_MAX)) { refuse(res, 413, TOO_LARGE); return; }

    try {
      if (pairing) {
        if (pairedOrigin !== null && pairedOrigin !== origin) { refuse(res, 409, PAIRED_ELSEWHERE); return; }
        const extension = pairedOrigin === null ? 'new' : 'same';
        pairedOrigin = origin;
        reply(res, PairReplySchema, 200, { paired: true, extension });
        return;
      }
      const stream = /^\/reviews\/([^/]+)\/events$/.exec(url.pathname);
      if (method === 'GET' && stream !== null) { events(req, res, decodeURIComponent(stream[1] as string)); return; }
      if (method === 'GET' && url.pathname === '/status') {
        reply(res, ServiceStatusSchema, 200, {
          version: 'test', claude: true, gh: true, packsDir: '/fake/packs',
          running: runs.filter((r) => !r.finished).map((r) => ({ runId: r.runId, repo: r.repo, number: r.number })),
        });
        return;
      }
      if (method === 'POST' && url.pathname === '/reviews') { start(res, body); return; }
      if (method === 'POST' && url.pathname === '/dismissals') { dismiss(res, body); return; }
      if (method === 'POST' && url.pathname === '/dismissals/restore') { restore(res, body); return; }
      if (method === 'POST' && url.pathname === '/posts/preview') { preview(res, body); return; }
      if (method === 'POST' && url.pathname === '/posts') { post(res, body); return; }
      if (method === 'POST' && url.pathname === '/posts/forget') { forget(res, body); return; }
      if (method === 'POST' && url.pathname === '/learned/remove') { removeLearned(res, body); return; }
      if (method === 'GET' && url.pathname === '/learned') {
        if ((url.searchParams.get('repo') ?? '') === '') throw new Refusal(400, 'repo: not a repository name');
        reply(res, LearnedReplySchema, 200, { lines: [...learned], cap: LEARNED_CAP });
        return;
      }
      if (method === 'GET' && ['/pr', '/reviews/running', '/reviews/latest'].includes(url.pathname)) {
        const { repo, number } = queryOf(url);
        const pull = pullOf(repo, number);
        if (url.pathname === '/pr') {
          if (pull === undefined) refuse(res, 404, NO_SUCH_PR);
          else reply(res, PrSummarySchema, 200, pull.pr);
        } else if (url.pathname === '/reviews/running') {
          const run = runs.find((r) => r.repo === repo && r.number === number && !r.finished);
          if (run === undefined) refuse(res, 404, NOT_RUNNING);
          else reply(res, StartReviewReplySchema.pick({ runId: true }), 200, { runId: run.runId });
        } else if (pull === undefined || pull.document === null) {
          refuse(res, 404, NO_REVIEW);
        } else {
          reply(res, LatestReplySchema, 200, { document: pull.document, dismissals: pull.dismissals, posts: pull.posts });
        }
        return;
      }
      refuse(res, 404, NOTHING_HERE);
    } catch (error) {
      if (error instanceof Refusal) refuse(res, error.status, error.message);
      else refuse(res, 500, `Airlock had a problem: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let server: Server | null = null;
  const listen = async (): Promise<void> => {
    const created = createServer((req, res) => {
      handle(req, res).catch((error: unknown) => {
        problems.push(`${req.method ?? '?'} ${req.url ?? '?'} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) writeJson(res, 500, { error: 'Airlock had a problem: the request could not be handled.' });
        else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      created.once('error', (err: NodeJS.ErrnoException) => {
        reject(
          err.code === 'EADDRINUSE'
            ? new Error(`Port ${port} is already in use: another end-to-end run is going, or a stale process was left behind.`)
            : err,
        );
      });
      created.listen(port, '127.0.0.1', resolve);
    });
    server = created;
  };
  const stop = async (): Promise<void> => {
    const running = server;
    server = null;
    if (running === null) return;
    for (const run of runs) run.streams.clear();
    await new Promise<void>((resolve) => {
      running.close(() => resolve());
      running.closeAllConnections();
    });
  };
  await listen();

  return {
    requests,
    problems,
    runs,
    dismissals: (repo, number) => pullOf(repo, number)?.dismissals ?? [],
    posts: (repo, number) => pullOf(repo, number)?.posts ?? [],
    push: (repo, number, headSha, script) => {
      const pull = pullOf(repo, number);
      if (pull === undefined) throw new Error(`the fake has no pull request ${repo}#${number}`);
      pull.pr = { ...pull.pr, headSha };
      pull.script = script;
    },
    learned,
    previews,
    sent,
    answerNextPost: (answer) => { answers.push(answer); },
    stop,
    start: async () => { if (server === null) await listen(); },
    close: async () => {
      closed = true;
      for (const release of releases) release();
      releases.clear();
      await stop();
    },
  };
}

function writeJson(res: ServerResponse, status: number, json: unknown): void {
  const payload = Buffer.from(JSON.stringify(json), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}
