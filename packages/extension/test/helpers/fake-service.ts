import { createHmac } from 'node:crypto';
import { minimalDocument, type LatestReply, type PrSummary, type ServiceEvent } from '@airlock/shared';

export const BASE = 'http://127.0.0.1:4611';
export const TOKEN = 'a'.repeat(64);
export const OTHER_TOKEN = 'b'.repeat(64);
export const HEAD = 'c'.repeat(40);
export const RUN_1 = 'run_000000000001';
export const RUN_2 = 'run_000000000002';

export function prSummary(over: Partial<PrSummary> = {}): PrSummary {
  return {
    repo: 'acme/widgets', number: 1, title: 'Add totals', author: 'alice', viewer: 'bob', isOwn: false, stage: 'pr1',
    baseRef: 'main', headRef: 'feature/totals', headSha: HEAD, additions: 10, deletions: 2, changedFiles: 1,
    packs: [{ id: 'generic', title: 'Generic' }], suggestedDepth: 'quick',
    state: 'open', lastReview: null, ...over,
  };
}

export function latestFor(pr: PrSummary, headSha = pr.headSha): LatestReply {
  const doc = minimalDocument();
  return {
    document: { ...doc, id: 'r_0000000001', pr: { ...doc.pr, repo: pr.repo, number: pr.number, headSha } },
    dismissals: [], posts: [],
  };
}

export const prUrl = (repo: string, number: number, tail = ''): string => `https://github.com/${repo}/pull/${number}${tail}`;

/** A reply that never comes, until the request is aborted. */
export function never(req: { signal: AbortSignal | undefined }): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    req.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

/** A reply held back until the test releases it. */
export function held(): { reply: () => Promise<Response>; release: (res: Response) => void; asked: () => boolean } {
  let release!: (res: Response) => void;
  let asked = false;
  const promise = new Promise<Response>((resolve) => { release = resolve; });
  return { reply: () => { asked = true; return promise; }, release: (res) => release(res), asked: () => asked };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export interface Request {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
  signal: AbortSignal | undefined;
}
type Handler = (req: Request) => Response | Promise<Response>;

/** One review run on the fake service: keeps every event and replays them to each new listener, like Task 4's runs. */
export class FakeRun {
  readonly events: ServiceEvent[] = [];
  readonly listeners = new Set<{ controller: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal | undefined }>();
  finished = false;
  attaches = 0;

  emit(event: ServiceEvent): void {
    this.events.push(event);
    for (const l of this.listeners) l.controller.enqueue(frame(event));
    if (event.type === 'done' || event.type === 'failed') {
      this.finished = true;
      for (const l of this.listeners) l.controller.close();
      this.listeners.clear();
    }
  }

  /** Every open stream ends cleanly without a last event, as when the service drops its listeners. */
  close(): void {
    for (const l of this.listeners) l.controller.close();
    this.listeners.clear();
  }

  /** Every open stream breaks at the network level, as when the service stops; the run itself goes on. */
  lose(): void {
    for (const l of this.listeners) l.controller.error(new TypeError('network error'));
    this.listeners.clear();
  }

  open(signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
    this.attaches += 1;
    const past = [...this.events];
    const finished = this.finished;
    let entry: { controller: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal | undefined } | undefined;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
        for (const e of past) controller.enqueue(frame(e));
        if (finished) {
          controller.close();
          return;
        }
        entry = { controller, signal };
        this.listeners.add(entry);
        signal?.addEventListener('abort', () => {
          if (entry && this.listeners.delete(entry)) controller.error(new DOMException('aborted', 'AbortError'));
        });
      },
      cancel: () => {
        if (entry) this.listeners.delete(entry);
      },
    });
  }
}

function frame(event: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

/** A stand-in for the local service, reached through the fetch it hands out. Answers like Tasks 3 to 5 describe. */
export class FakeService {
  down = false;
  paired = true;
  token = TOKEN;
  /**
   * What `GET /hello?nonce=` proves with: the token by default (as the real service does), another key to play
   * something else on the port that answers like Airlock, or null for a hello with no proof.
   */
  proofKey: string | null | undefined = undefined;
  readonly calls: string[] = [];
  readonly requests: Request[] = [];
  readonly prs = new Map<string, PrSummary>();
  readonly latest = new Map<string, LatestReply>();
  readonly running = new Map<string, string>();
  readonly runs = new Map<string, FakeRun>();
  private readonly overrides = new Map<string, Handler>();
  private nextRun = 1;

  constructor() {
    this.addPr(prSummary());
  }

  addPr(pr: PrSummary): PrSummary {
    this.prs.set(`${pr.repo}#${pr.number}`, pr);
    return pr;
  }

  /** Starts a run for the pull request as if another panel had started it. */
  startRun(repo: string, number: number, runId = `run_${String(this.nextRun++).padStart(12, '0')}`): FakeRun {
    const run = new FakeRun();
    this.runs.set(runId, run);
    this.running.set(`${repo}#${number}`, runId);
    return run;
  }

  /** Replaces the answer to one route, named like `GET /pr`. */
  on(route: string, handler: Handler): void {
    this.overrides.set(route, handler);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const route = `${method} ${url.pathname.replace(/^\/reviews\/run_[0-9a-f]+\/events$/, '/reviews/:runId/events')}`;
    this.calls.push(route);
    const req: Request = { method, url, headers, body, signal: init?.signal ?? undefined };
    this.requests.push(req);
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (this.down || url.origin !== BASE) throw new TypeError('Failed to fetch');
    const override = this.overrides.get(route);
    if (override) return override(req);
    return this.answer(route, req);
  };

  private answer(route: string, req: Request): Response {
    if (route === 'GET /hello') {
      // As the real service: a nonce, when given, is 32 lower-case hex characters, given once.
      const nonces = req.url.searchParams.getAll('nonce');
      if (nonces.length > 1) return json({ error: 'A query value was given twice.' }, 400);
      if (nonces.length === 1 && !/^[0-9a-f]{32}$/.test(nonces[0] as string)) return json({ error: 'nonce: not a nonce' }, 400);
      const nonce = req.url.searchParams.get('nonce');
      const key = this.proofKey === undefined ? this.token : this.proofKey;
      const proof = nonce === null || key === null ? {} : { proof: createHmac('sha256', key).update(`airlock-hello:${nonce}`).digest('hex') };
      return json({ airlock: true, version: '0.1.0', paired: this.paired, ...proof });
    }
    if (req.headers.get('authorization') !== `Bearer ${this.token}`) {
      return json({ error: 'Airlock needs the pairing token. Run "npm run service -- token".' }, 401);
    }
    const key = `${req.url.searchParams.get('repo')}#${req.url.searchParams.get('number')}`;
    switch (route) {
      case 'POST /pair':
        this.paired = true;
        return json({ paired: true, extension: 'new' });
      case 'GET /pr': {
        const pr = this.prs.get(key);
        return pr ? json(pr) : json({ error: 'No such pull request.' }, 404);
      }
      case 'GET /reviews/running': {
        const runId = this.running.get(key);
        return runId ? json({ runId }) : json({ error: 'No review is running.' }, 404);
      }
      case 'GET /reviews/latest': {
        const latest = this.latest.get(key);
        return latest ? json(latest) : json({ error: 'No stored review.' }, 404);
      }
      case 'POST /reviews': {
        const b = req.body as { repo: string; number: number };
        const existing = this.running.get(`${b.repo}#${b.number}`);
        if (existing) return json({ runId: existing, reused: true });
        const runId = `run_${String(this.nextRun++).padStart(12, '0')}`;
        this.startRun(b.repo, b.number, runId);
        return json({ runId, reused: false });
      }
      case 'GET /reviews/:runId/events': {
        const runId = req.url.pathname.split('/')[2] ?? '';
        const run = this.runs.get(runId);
        if (!run) return json({ error: 'No such review run.' }, 404);
        return new Response(run.open(req.signal), {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        });
      }
      default:
        return json({ error: 'Not found.' }, 404);
    }
  }
}
