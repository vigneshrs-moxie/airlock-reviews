import {
  ApiErrorSchema, DismissalSchema, HelloSchema, LatestReplySchema, PairReplySchema, PrSummarySchema, RestoreReplySchema,
  RunIdSchema, ServiceEventSchema, ServiceStatusSchema, StartReviewReplySchema,
  type DismissBody, type Dismissal, type Hello, type LatestReply, type PairReply, type PrSummary, type RestoreBody,
  type RestoreReply, type ServiceEvent, type ServiceStatus, type StartReviewBody, type StartReviewReply,
} from '@airlock/shared';
import { EventDataError, readEventStream } from './event-stream';
import { realTimers, type Timers } from './timers';

export const NOT_UNDERSTOOD = 'Airlock got a reply from its service that it does not understand.';
const NO_TOKEN = 'This panel is not paired with the Airlock service yet.';
const REFUSED_TOKEN = 'The Airlock service does not accept this panel’s pairing token.';
const OFFLINE = 'The Airlock service is not answering.';

/** How long a call may take, reply read included, before the service counts as not answering. */
export const HELLO_TIMEOUT_MS = 5_000;
export const CALL_TIMEOUT_MS = 60_000;
/** The service sends a keep-alive every 15 seconds; a stream silent for three of them is lost. */
export const STREAM_IDLE_MS = 45_000;

/**
 * Why a call to the service failed, in the panel's terms: `offline` (no answer), `unpaired` (no token, or the
 * service refused it) or `problem` (anything else, with a sentence to show).
 */
export class ServiceError extends Error {
  constructor(readonly kind: 'offline' | 'unpaired' | 'problem', message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}

interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

const RunningReplySchema = StartReviewReplySchema.pick({ runId: true });

/** Thrown inside the stream reader to stop it after a `done` or `failed` event. */
const LAST_EVENT = new Error('last event');
/** Errors the stream when it has been silent too long. */
const IDLE = new Error('the stream was silent too long');

type Call = { method: 'GET' | 'POST'; path: string; query?: Record<string, string>; body?: unknown };

/** The panel's only way to reach the local service. Every reply is checked against the shared contract. */
export class ServiceClient {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly base: string,
    private readonly token: () => Promise<string | null>,
    fetchFn?: typeof fetch,
    private readonly timers: Timers = realTimers,
  ) {
    // Called through a wrapper: an extension page's fetch throws when called without its window as `this`.
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  /** `signal`, on this and the other reads, lets the panel drop a call for a pull request the tab has left. */
  async hello(signal?: AbortSignal): Promise<Hello | 'offline'> {
    try {
      return await this.timed(HELLO_TIMEOUT_MS, signal, async (both) => {
        const res = await this.fetchFn(this.url('/hello'), { signal: both }).catch(() => {
          throw new ServiceError('offline', OFFLINE);
        });
        if (!res.ok) throw await failure(res);
        return parse(res, HelloSchema);
      });
    } catch (error) {
      if (error instanceof ServiceError && error.kind === 'offline') return 'offline';
      throw error;
    }
  }

  /** Offers a token the person typed. Refusals come back as the service's words; only no answer at all throws. */
  pair(token: string): Promise<PairReply | { error: string }> {
    return this.timed(CALL_TIMEOUT_MS, undefined, async (signal) => {
      const res = await this.send({ method: 'POST', path: '/pair' }, token, signal);
      if (res.ok) return parse(res, PairReplySchema);
      return { error: (await failure(res)).message };
    });
  }

  status(): Promise<ServiceStatus> {
    return this.call({ method: 'GET', path: '/status' }, ServiceStatusSchema);
  }

  pr(repo: string, number: number, signal?: AbortSignal): Promise<PrSummary> {
    return this.call({ method: 'GET', path: '/pr', query: prQuery(repo, number) }, PrSummarySchema, false, signal);
  }

  start(body: StartReviewBody): Promise<StartReviewReply> {
    return this.call({ method: 'POST', path: '/reviews', body }, StartReviewReplySchema);
  }

  async running(repo: string, number: number, signal?: AbortSignal): Promise<string | null> {
    const call = { method: 'GET', path: '/reviews/running', query: prQuery(repo, number) } as const;
    const reply = await this.call(call, RunningReplySchema, true, signal);
    return reply === null ? null : reply.runId;
  }

  latest(repo: string, number: number, signal?: AbortSignal): Promise<LatestReply | null> {
    return this.call({ method: 'GET', path: '/reviews/latest', query: prQuery(repo, number) }, LatestReplySchema, true, signal);
  }

  dismiss(body: DismissBody): Promise<Dismissal> {
    return this.call({ method: 'POST', path: '/dismissals', body }, DismissalSchema);
  }

  restore(body: RestoreBody): Promise<RestoreReply> {
    return this.call({ method: 'POST', path: '/dismissals/restore', body }, RestoreReplySchema);
  }

  /**
   * Follows a run's events from its first one.
   * - `'ended'`: a `done` or `failed` event arrived (reading stops there).
   * - `'offline'`: the request or the read failed at the network level.
   * - `'lost'`: the stream closed without a last event, was silent for `STREAM_IDLE_MS`, was aborted by `signal`,
   *   or carried an event that is not JSON or does not match the contract (that event is not passed on).
   * A refused stream throws the mapped `ServiceError`.
   */
  async events(runId: string, onEvent: (e: ServiceEvent) => void, signal: AbortSignal): Promise<'ended' | 'lost' | 'offline'> {
    if (!RunIdSchema.safeParse(runId).success) throw new ServiceError('problem', NOT_UNDERSTOOD);
    const token = await this.storedToken();
    const silent = new AbortController();
    let idle = false;
    let watcher: TransformStreamDefaultController<Uint8Array> | undefined;
    let timer: unknown;
    const arm = (): void => {
      if (timer !== undefined) this.timers.clearTimeout(timer);
      timer = this.timers.setTimeout(() => {
        idle = true;
        silent.abort();
        watcher?.error(IDLE);
      }, STREAM_IDLE_MS);
    };
    // Why a stream that stopped without its last event stopped.
    const cut = (error: unknown): 'lost' | 'offline' =>
      idle || signal.aborted || error instanceof EventDataError || (error instanceof ServiceError && error.kind === 'problem')
        ? 'lost'
        : 'offline';

    arm();
    try {
      let res: Response;
      try {
        res = await this.send({ method: 'GET', path: `/reviews/${runId}/events` }, token, AbortSignal.any([signal, silent.signal]));
      } catch (error) {
        return cut(error);
      }
      if (!res.ok) {
        const refused = await failure(res).catch((error: unknown) => error);
        if (refused instanceof ServiceError && refused.kind !== 'offline') throw refused;
        return cut(refused);
      }
      if (res.body === null) return 'lost';
      const watched = res.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          start(controller) {
            watcher = controller;
          },
          transform(chunk, controller) {
            arm();
            controller.enqueue(chunk);
          },
        }),
      );
      let ended = false;
      try {
        await readEventStream(watched, (data) => {
          const event = ServiceEventSchema.safeParse(data);
          if (!event.success) throw new ServiceError('problem', NOT_UNDERSTOOD);
          onEvent(event.data);
          if (event.data.type === 'done' || event.data.type === 'failed') {
            ended = true;
            throw LAST_EVENT;
          }
        });
      } catch (error) {
        return ended ? 'ended' : cut(error);
      }
      return ended ? 'ended' : 'lost';
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  private call<T>(call: Call, schema: Schema<T>): Promise<T>;
  private call<T>(call: Call, schema: Schema<T>, noneOn404: false, signal?: AbortSignal): Promise<T>;
  private call<T>(call: Call, schema: Schema<T>, noneOn404: true, signal?: AbortSignal): Promise<T | null>;
  private async call<T>(call: Call, schema: Schema<T>, noneOn404 = false, signal?: AbortSignal): Promise<T | null> {
    const token = await this.storedToken();
    return this.timed(CALL_TIMEOUT_MS, signal, async (both) => {
      const res = await this.send(call, token, both);
      if (noneOn404 && res.status === 404) return null;
      if (!res.ok) throw await failure(res);
      return parse(res, schema);
    });
  }

  /** Runs `work` with a signal that aborts after `ms` on the injected timers, or when `outer` aborts. */
  private async timed<T>(ms: number, outer: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const timeout = new AbortController();
    const handle = this.timers.setTimeout(() => timeout.abort(), ms);
    try {
      return await work(outer === undefined ? timeout.signal : AbortSignal.any([outer, timeout.signal]));
    } finally {
      this.timers.clearTimeout(handle);
    }
  }

  private async storedToken(): Promise<string> {
    const token = await this.token();
    if (token === null || token === '') throw new ServiceError('unpaired', NO_TOKEN);
    return token;
  }

  private async send(call: Call, token: string, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const init: RequestInit = { method: call.method, headers, signal };
    if (call.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(call.body);
    }
    try {
      return await this.fetchFn(this.url(call.path, call.query), init);
    } catch {
      throw new ServiceError('offline', OFFLINE);
    }
  }

  private url(path: string, query?: Record<string, string>): string {
    const search = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`;
    return `${this.base}${path}${search}`;
  }
}

function prQuery(repo: string, number: number): Record<string, string> {
  return { repo, number: String(number) };
}

/** The body as JSON, or undefined when it is not JSON. A body that stops halfway counts as no answer. */
async function bodyOf(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new ServiceError('offline', OFFLINE);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function parse<T>(res: Response, schema: Schema<T>): Promise<T> {
  const result = schema.safeParse(await bodyOf(res));
  if (!result.success) throw new ServiceError('problem', NOT_UNDERSTOOD);
  return result.data;
}

/** The one place a refusal becomes the panel's terms: 401 is unpaired; anything else a problem in the service's words. */
async function failure(res: Response): Promise<ServiceError> {
  const body = ApiErrorSchema.safeParse(await bodyOf(res));
  if (res.status === 401) return new ServiceError('unpaired', body.success ? body.data.error : REFUSED_TOKEN);
  return new ServiceError('problem', body.success ? body.data.error : NOT_UNDERSTOOD);
}
