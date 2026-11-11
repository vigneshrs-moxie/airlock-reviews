import { choosePacks, fetchPr, findClaude, latestReview, runReview, type ReviewRequest } from '@airlock/engine';
import {
  ApiErrorSchema, LatestReplySchema, PrNumberSchema, PrSummarySchema, RepoSchema, RunIdSchema, ServiceStatusSchema,
  StartReviewBodySchema, StartReviewReplySchema, suggestedDepth, type Dismissal, type LatestReply, type PrSummary,
  type PrInfo, type ServiceStatus, type StartReviewBody,
} from '@airlock/shared';
import { z, type ZodType } from 'zod';
import { plainMessage, type Req, type Res, type Route } from './http.js';
import { LimitError, realTimers, Runs } from './runs.js';
import type { ServiceDeps } from './server.js';
import { RUN_GONE, runStream } from './sse.js';

export const STATUS_CACHE_MS = 60_000;

const NOTHING_HERE = 'Airlock has nothing at this address.';
const NOT_RUNNING = 'Airlock is not reviewing this pull request now.';
const NO_REVIEW = 'Airlock has no review of this pull request yet.';
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

/** The engine request for a start body; depth and pack ids only when the body has them. */
export function engineRequest(body: StartReviewBody, packsDir: string): ReviewRequest {
  return {
    repo: body.repo, number: body.number,
    ...(body.depth === undefined ? {} : { depth: body.depth }),
    ...(body.packIds === undefined ? {} : { packIds: body.packIds }),
    packsDir,
  };
}

/**
 * Status, pull request summary, starting and following reviews, and the latest stored review. `stop` is called when the
 * server closes, and clears the registry's timers.
 */
export function reviewRoutes(deps: ServiceDeps, hidePaths: readonly string[]): { routes: Route[]; stop: () => void } {
  const { config, engine } = deps;
  const timers = deps.timers ?? realTimers;
  const review = deps.review ?? runReview;
  const dismissals = deps.dismissals ?? (async (): Promise<Dismissal[]> => []);
  const runs = new Runs({
    timers,
    ...(deps.limits?.runMinutes === undefined ? {} : { runMinutes: deps.limits.runMinutes }),
    log: deps.log,
    failure: (e) => `Airlock could not review this pull request: ${plainMessage(e, hidePaths)}`,
    launch: (body, emit) => review(engineRequest(body, config.packsDir), engine, emit),
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
        // As in the pipeline: the stage rules of the first selected pack that has any.
        const rules = chosen.packs.find((p) => p.stageRules.length > 0)?.stageRules ?? [];
        let pr: PrInfo;
        try {
          pr = await fetchPr(engine.exec, repo, number, rules);
        } catch (e) {
          // Judged on the whole message: the bounded one may have lost gh's status at its end.
          if (/HTTP 404/.test(e instanceof Error ? e.message : String(e))) return refuse(404, NO_SUCH_PR);
          return refuse(502, `GitHub did not answer: ${plainMessage(e, hidePaths)}`);
        }
        return reply<PrSummary>(PrSummarySchema, 200, {
          repo, number, title: pr.title, author: pr.author, viewer: pr.viewer, isOwn: pr.author === pr.viewer,
          stage: pr.stage, baseRef: pr.baseRef, headRef: pr.headRef, headSha: pr.headSha,
          additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changedFiles,
          packs: chosen.packs.map((p) => ({ id: p.id, title: p.title })), suggestedDepth: suggestedDepth(pr.additions, pr.deletions),
        });
      },
    },
    {
      method: 'POST', path: '/reviews', body: StartReviewBodySchema,
      handler: async (req) => {
        try {
          return reply(StartReviewReplySchema, 200, runs.start(req.body as StartReviewBody));
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
        return reply<LatestReply>(LatestReplySchema, 200, { document, dismissals: await dismissals(repo, number) });
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
  ];
  return { routes, stop: () => runs.close() };
}
