import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { airlockHome, choosePacks, fetchPr, findClaude, latestReview, repoSlug, runReview, type Pack, type ReviewRequest } from '@airlock/engine';
import {
  ApiErrorSchema, DismissalSchema, DismissBodySchema, ForgetPostBodySchema, LatestReplySchema, PostBodySchema, PostPreviewBodySchema,
  LearnedReplySchema, PostRecordSchema, PrNumberSchema, PrSummarySchema, RemoveLearnedBodySchema, RemoveLearnedReplySchema, RepoSchema, RestoreBodySchema, RestoreReplySchema, ReviewIdSchema,
  RunIdSchema, ServiceStatusSchema, StartReviewBodySchema, StartReviewReplySchema, suggestedDepth, type DismissBody, type Dismissal,
  type ForgetPostBody, type LatestReply, type PostBody, type PostPreviewBody, type PostRecord, type RestoreBody,
  type RemoveLearnedBody, type RestoreReply, type LearnedReply, type RemoveLearnedReply, type PrSummary, type PrInfo, type ReviewDocument, type ServiceStatus, type StartReviewBody, PostPreviewReplySchema, type PostPreviewReply,
} from '@airlock/shared';
import { z, type ZodType } from 'zod';
import { dismiss, DismissError, restore } from './dismissals.js';
import { plainMessage, type Handler, type Req, type Res, type Route } from './http.js';
import { buildPreview, PREVIEW_BODY_MAX, Previews } from './posts/preview.js';
import { forget, post, PostError, postsFor, type PostDeps } from './posts/records.js';
import { listLearned, removeLearnedLine } from './learned.js';
import { LimitError, realTimers, Runs, type RunStart } from './runs.js';
import type { ServiceDeps } from './server.js';
import { RUN_GONE, runStream } from './sse.js';

export const STATUS_CACHE_MS = 60_000;

const NOTHING_HERE = 'Airlock has nothing at this address.';
const NOT_RUNNING = 'Airlock is not reviewing this pull request now.';
const NO_REVIEW = 'Airlock has no review of this pull request yet.';
const NO_EARLIER = 'There is no earlier review of this pull request.';
const NOTHING_PUSHED = 'Nothing was pushed since the last review.';
const NO_SUCH_PR = 'GitHub has no such pull request, or you cannot see it.';

/** `?repo=<owner/name>&number=<n>`, checked with the shared rules. */
const PrQuerySchema = z.object({
  repo: RepoSchema,
  number: z.string().regex(/^[1-9][0-9]*$/, 'not a pull request number').transform(Number).pipe(PrNumberSchema),
});

const RunningReplySchema = StartReviewReplySchema.pick({ runId: true });

/** The router has already checked the query against PrQuerySchema. */
const prOf = (req: Req): { repo: string; number: number } =>
  ({ repo: req.query.get('repo') as string, number: Number(req.query.get('number')) });

/** A reply checked against its contract first; a mismatch throws, which the router answers with a 500. */
function reply<T>(schema: ZodType<T>, status: number, value: T): Res {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`the reply does not match its contract: ${issue === undefined ? 'unknown' : `${issue.path.map(String).join('.')} ${issue.message}`}`);
  }
  return { status, json: parsed.data };
}

const refuse = (status: number, error: string): Res => reply(ApiErrorSchema, status, { error });

const ForgetReplySchema = z.object({ forgotten: z.boolean() });

/** A posting handler: its PostError is the refusal it answers with. */
const posting = (handler: Handler): Handler => async (req) => {
  try {
    return await handler(req);
  } catch (e) {
    if (e instanceof PostError) return refuse(e.status, e.message);
    throw e;
  }
};

/** The engine request for a start body; depth and pack ids only when the body has them. */
export function engineRequest(body: RunStart, packsDir: string): ReviewRequest {
  return {
    repo: body.repo, number: body.number,
    ...(body.depth === undefined ? {} : { depth: body.depth }),
    ...(body.packIds === undefined ? {} : { packIds: body.packIds }),
    ...(body.sinceReviewId === undefined ? {} : { since: { reviewId: body.sinceReviewId } }),
    packsDir,
  };
}

/**
 * Removes the file the engine's store wrote for this document (`<home>/reviews/<slug>/<number>/<head>-<id>.json`), so a
 * review stopped at the ceiling never becomes the latest one. Names that could not be the store's are left alone.
 */
async function discardStored(document: ReviewDocument): Promise<void> {
  const { repo, number, headSha } = document.pr;
  if (!ReviewIdSchema.safeParse(document.id).success || !/^[0-9a-fA-F]{7,40}$/.test(headSha) || !Number.isSafeInteger(number)) return;
  await rm(join(airlockHome(), 'reviews', repoSlug(repo), String(number), `${headSha}-${document.id}.json`), { force: true });
}

/**
 * Status, pull request summary, starting and following reviews, and the latest stored review. `stop` is called when the
 * server closes: it clears the registry's timers, stops the running reviews and resolves once they have settled (at most
 * five seconds).
 */
export function reviewRoutes(
  deps: ServiceDeps & { dismissals: NonNullable<ServiceDeps['dismissals']> }, hidePaths: readonly string[]): { routes: Route[]; stop: () => Promise<void> } {
  const { config, engine } = deps;
  const timers = deps.timers ?? realTimers;
  const review = deps.review ?? runReview;
  const { dismissals } = deps;
  const posts: PostDeps = {
    home: config.home, exec: engine.exec, now: deps.now, log: deps.log, previews: new Previews(), dismissals,
  };
  const runs = new Runs({
    timers,
    ...(deps.limits?.runMinutes === undefined ? {} : { runMinutes: deps.limits.runMinutes }),
    log: deps.log,
    failure: (e) => plainMessage(e, hidePaths, 'Airlock could not review this pull request: '),
    launch: (body, emit, signal) => review(engineRequest(body, config.packsDir), { ...engine, signal }, emit),
    discard: discardStored,
  });

  let tools: { at: number; claude: boolean; gh: boolean } | null = null;
  const toolsFound = async (): Promise<{ claude: boolean; gh: boolean }> => {
    const now = deps.now().getTime();
    if (tools !== null && now - tools.at < STATUS_CACHE_MS) return tools;
    const [claude, gh] = await Promise.all([
      findClaude().then((path) => path !== null, () => false),
      engine.exec('gh', ['auth', 'status']).then((r) => r.code === 0, () => false),
    ]);
    tools = { at: now, claude, gh };
    return tools;
  };

  /** The pull request from GitHub, or the refusal to answer with. The stage rules are the first selected pack's that has any. */
  const readPr = async (repo: string, number: number, packs: Pack[]): Promise<{ pr: PrInfo } | { refusal: Res }> => {
    const rules = packs.find((p) => p.stageRules.length > 0)?.stageRules ?? [];
    try {
      return { pr: await fetchPr(engine.exec, repo, number, rules) };
    } catch (e) {
      // Judged on the whole message: the bounded one may have lost gh's status at its end.
      if (/HTTP 404/.test(e instanceof Error ? e.message : String(e))) return { refusal: refuse(404, NO_SUCH_PR) };
      return { refusal: refuse(502, plainMessage(e, hidePaths, 'GitHub did not answer: ')) };
    }
  };

  /** A start body with `since: 'last'` made into the stored review it continues from, or the refusal to answer with. */
  const resolveSince = async (body: StartReviewBody): Promise<RunStart | Res> => {
    if (body.since === undefined) return body;
    const last = await latestReview(body.repo, body.number);
    if (last === null) return refuse(409, NO_EARLIER);
    const chosen = await choosePacks(config.packsDir, body.repo);
    const read = await readPr(body.repo, body.number, chosen.packs);
    if ('refusal' in read) return read.refusal;
    if (read.pr.headSha.toLowerCase() === last.pr.headSha.toLowerCase()) return refuse(409, NOTHING_PUSHED);
    return {
      ...body, depth: body.depth ?? last.depth, packIds: body.packIds ?? last.packs.map((p) => p.id), sinceReviewId: last.id,
    };
  };

  const routes: Route[] = [
    {
      method: 'GET', path: '/status',
      handler: async () => {
        const { claude, gh } = await toolsFound();
        return reply<ServiceStatus>(ServiceStatusSchema, 200, {
          version: config.version, claude, gh, packsDir: config.packsDir, running: runs.active(),
        });
      },
    },
    {
      method: 'GET', path: '/pr', query: PrQuerySchema,
      handler: async (req) => {
        const { repo, number } = prOf(req);
        const chosen = await choosePacks(config.packsDir, repo);
        for (const e of chosen.errors) deps.log(`packs for ${repo}: ${e.message}`);
        const read = await readPr(repo, number, chosen.packs);
        if ('refusal' in read) return read.refusal;
        const { pr } = read;
        const last = await latestReview(repo, number);
        return reply<PrSummary>(PrSummarySchema, 200, {
          repo, number, title: pr.title, author: pr.author, viewer: pr.viewer, isOwn: pr.author === pr.viewer,
          stage: pr.stage, baseRef: pr.baseRef, headRef: pr.headRef, headSha: pr.headSha,
          additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changedFiles,
          packs: chosen.packs.map((p) => ({ id: p.id, title: p.title })), suggestedDepth: suggestedDepth(pr.additions, pr.deletions),
          state: pr.merged === true ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
          lastReview: last === null ? null : { reviewId: last.id, headSha: last.pr.headSha, createdAt: last.createdAt, depth: last.depth },
        });
      },
    },
    {
      method: 'POST', path: '/reviews', body: StartReviewBodySchema,
      handler: async (req) => {
        try {
          const body = req.body as StartReviewBody;
          // A review of either kind already running for this pull request is the answer, whatever this start asks.
          const resolved = runs.running(body.repo, body.number) === null ? await resolveSince(body) : body;
          if ('status' in resolved) return resolved;
          return reply(StartReviewReplySchema, 200, runs.start(resolved));
        } catch (e) {
          if (e instanceof LimitError) return refuse(429, e.message);
          throw e;
        }
      },
    },
    {
      method: 'GET', path: '/reviews/running', query: PrQuerySchema,
      handler: async (req) => {
        const { repo, number } = prOf(req);
        const runId = runs.running(repo, number);
        return runId === null ? refuse(404, NOT_RUNNING) : reply(RunningReplySchema, 200, { runId });
      },
    },
    {
      method: 'GET', path: '/reviews/latest', query: PrQuerySchema,
      handler: async (req) => {
        const { repo, number } = prOf(req);
        const document = await latestReview(repo, number);
        if (document === null) return refuse(404, NO_REVIEW);
        return reply<LatestReply>(LatestReplySchema, 200, {
          document, dismissals: await dismissals(repo, number), posts: await postsFor(config.home, repo, number, deps.log),
        });
      },
    },
    {
      method: 'GET', path: '/reviews/:runId/events',
      handler: async (req) => {
        const runId = req.params['runId'] as string;
        if (!RunIdSchema.safeParse(runId).success) return refuse(404, NOTHING_HERE);
        if (runs.events(runId) === null) return refuse(404, RUN_GONE);
        return runStream(() => runs.events(runId), timers);
      },
    },
    {
      method: 'POST', path: '/dismissals', body: DismissBodySchema,
      handler: async (req) => {
        try {
          return reply<Dismissal>(DismissalSchema, 200, await dismiss(deps, req.body as DismissBody));
        } catch (e) {
          if (e instanceof DismissError) return refuse(e.status, e.message);
          throw e;
        }
      },
    },
    {
      method: 'POST', path: '/dismissals/restore', body: RestoreBodySchema,
      handler: async (req) => {
        try {
          return reply<RestoreReply>(RestoreReplySchema, 200, await restore(deps, req.body as RestoreBody));
        } catch (e) {
          if (e instanceof DismissError) return refuse(e.status, e.message);
          throw e;
        }
      },
    },
    {
      method: 'GET', path: '/learned', query: z.object({ repo: RepoSchema }),
      handler: async (req) => reply<LearnedReply>(LearnedReplySchema, 200, await listLearned(deps, req.query.get('repo') as string)),
    },
    // The routes that can lead to the one GitHub write require the paired extension's Origin, not only the token.
    {
      method: 'POST', path: '/posts/preview', requiresOrigin: true, maxBodyBytes: PREVIEW_BODY_MAX, body: PostPreviewBodySchema,
      handler: posting(async (req) =>
        reply<PostPreviewReply>(PostPreviewReplySchema, 200, await buildPreview(posts, req.body as PostPreviewBody))),
    },
    {
      // Strict: the request carries the preview id and nothing else.
      method: 'POST', path: '/posts', requiresOrigin: true, body: PostBodySchema.strict(),
      handler: posting(async (req) => reply<PostRecord>(PostRecordSchema, 200, await post(posts, (req.body as PostBody).previewId))),
    },
    {
      method: 'POST', path: '/posts/forget', requiresOrigin: true, body: ForgetPostBodySchema,
      handler: posting(async (req) => reply(ForgetReplySchema, 200, await forget(posts, req.body as ForgetPostBody))),
    },
    {
      method: 'POST', path: '/learned/remove', requiresOrigin: true, body: RemoveLearnedBodySchema,
      handler: async (req) => {
        try {
          return reply<RemoveLearnedReply>(RemoveLearnedReplySchema, 200, await removeLearnedLine(deps, req.body as RemoveLearnedBody));
        } catch (e) {
          if (e instanceof DismissError) return refuse(e.status, e.message);
          throw e;
        }
      },
    },
  ];
  return { routes, stop: () => runs.close() };
}
