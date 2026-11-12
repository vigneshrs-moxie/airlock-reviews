import {
  ApiErrorSchema, DismissalSchema, DismissBodySchema, HelloSchema, LatestReplySchema, PairReplySchema, PrSummarySchema,
  RestoreBodySchema, RestoreReplySchema, RunIdSchema, ServiceEventSchema, ServiceStatusSchema, StartReviewBodySchema,
  StartReviewReplySchema,
  type Dismissal, type LatestReply, type PrSummary, type ReviewDocument, type ServiceEvent,
} from '@airlock/shared';
import { createHmac, randomBytes } from 'node:crypto';
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
];
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
  /**
   * What `GET /hello?nonce=` proves with: the token by default, as the real service does; another key to play
   * something else on the port that answers like Airlock; null for a hello with no proof.
   */
  proofKey?: string | null;
  /** The pull requests it knows. */
  pulls?: FakePull[];
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
  /** Stops listening and cuts every open connection; what it holds is kept. */
  stop(): Promise<void>;
  /** Listens again on the same port, with everything it held. */
  start(): Promise<void>;
  /** Stops for good: `stop`, and any script waiting is let go. */
  close(): Promise<void>;
}

type Pull = { pr: PrSummary; document: ReviewDocument | null; dismissals: Dismissal[]; script: RunStep[] | null };
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
 * A stand-in for the Airlock service that speaks its contract: the Host, Origin and token checks, `GET /hello` (with
 * the proof that it holds the token, for a nonce),
 * `POST /pair`, `GET /status`, `GET /pr`, `POST /reviews`, `GET /reviews/running`, `GET /reviews/<runId>/events` (a real
 * event stream, written step by step from the pull request's script), `GET /reviews/latest`, `POST /dismissals` and
 * `POST /dismissals/restore`. Request bodies and query values are checked with the shared schemas, and every reply is
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
    script: p.script ?? null,
  }));
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

  function start(res: ServerResponse, body: unknown): void {
    const asked = bodyOf(StartReviewBodySchema, body);
    const existing = runs.find((r) => r.repo === asked.repo && r.number === asked.number && !r.finished);
    if (existing !== undefined) { reply(res, StartReviewReplySchema, 200, { runId: existing.runId, reused: true }); return; }
    const pull = pullOf(asked.repo, asked.number);
    if (pull === undefined || pull.script === null) throw new Refusal(404, NO_SUCH_PR);
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
      // As the real service: a nonce, when given, is 32 lower-case hex characters, given once, and the reply proves the
      // token with it.
      const nonces = url.searchParams.getAll('nonce');
      if (nonces.length > 1) { refuse(res, 400, 'A query value was given twice.'); return; }
      const nonce = nonces[0];
      if (nonce !== undefined && !/^[0-9a-f]{32}$/.test(nonce)) { refuse(res, 400, 'nonce: not a nonce'); return; }
      const key = options.proofKey === undefined ? token : options.proofKey;
      const proof = nonce === undefined || key === undefined || key === null
        ? {}
        : { proof: createHmac('sha256', key).update(`airlock-hello:${nonce}`).digest('hex') };
      reply(res, HelloSchema, 200, { airlock: true, version: 'test', paired: pairedOrigin !== null, ...proof });
      return;
    }
    const origin = req.headers.origin ?? null;
    const pairing = method === 'POST' && url.pathname === '/pair';
    if (pairing ? origin === null || !origin.startsWith('chrome-extension://') : origin !== null && origin !== pairedOrigin) {
      refuse(res, 403, NOT_THIS_PAGE);
      return;
    }
    if (token === undefined || req.headers.authorization !== `Bearer ${token}`) { refuse(res, 401, NEEDS_TOKEN); return; }

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
          reply(res, LatestReplySchema, 200, { document: pull.document, dismissals: pull.dismissals, posts: [] });
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
