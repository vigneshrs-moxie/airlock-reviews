import {
  ApiErrorSchema, DismissalSchema, HelloSchema, LatestReplySchema, PairReplySchema, PrSummarySchema, RestoreReplySchema,
  RunIdSchema, ServiceEventSchema, ServiceStatusSchema, StartReviewReplySchema,
  type DismissBody, type Dismissal, type Hello, type LatestReply, type PairReply, type PrSummary, type RestoreBody,
  type RestoreReply, type ServiceEvent, type ServiceStatus, type StartReviewBody, type StartReviewReply,
} from '@airlock/shared';
import { EventDataError, readEventStream } from './event-stream';
import { NOT_PROVED, newNonce, proves } from './proof';
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
 * service refused it), `unproven` (what answers could not prove it holds the token, so the token was not sent) or
 * `problem` (anything else, with a sentence to show).
 */
export class ServiceError extends Error {
  constructor(readonly kind: 'offline' | 'unpaired' | 'unproven' | 'problem', message: string) {
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

/**
 * The panel's only way to reach the local service. Every reply is checked against the shared contract.
 *
 * The token is sent only to an address that has just proved it holds it: `send`, the one place the Authorization
 * header is added, first asks `/hello` with a fresh nonce and checks the proof, unless the same token was proved since
 * the last network failure, 401 or failed check. A periodic `hello` always asks with a new nonce.
 */
export class ServiceClient {
  private readonly fetchFn: typeof fetch;
  /** The token whose proof last matched; null after a network failure, a 401 or any hello that did not prove it. */
  private proved: string | null = null;

  constructor(
    private readonly base: string,
    private readonly token: () => Promise<string | null>,
    fetchFn?: typeof fetch,
    private readonly timers: Timers = realTimers,
  ) {
    // Called through a wrapper: an extension page's fetch throws when called without its window as `this`.
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  /**
   * The periodic check. With a token stored it asks with a fresh nonce and checks the proof: a wrong or missing one
   * throws `unproven`, and the token is not sent again until a proof matches. `signal`, on this and the other reads,
   * lets the panel drop a call for a pull request the tab has left.
   */
  async hello(signal?: AbortSignal): Promise<Hello | 'offline'> {
    const token = await this.token();
    return this.ask(token === null || token === '' ? null : token, signal);
  }

  /**
   * Offers a token the person typed, once what answers has proved it holds that token. Refusals, that one included, come
   * back as words; only no answer at all throws.
   */
  pair(token: string): Promise<PairReply | { error: string }> {
    return this.timed(CALL_TIMEOUT_MS, undefined, async (signal) => {
      let res: Response;
      try {
        res = await this.send({ method: 'POST', path: '/pair' }, token, signal);
      } catch (error) {
        // What answers could not prove it holds this token, or did not answer as Airlock: nothing was sent.
        if (error instanceof ServiceError && error.kind !== 'offline') return { error: error.message };
        throw error;
      }
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
   * A refused stream throws the mapped `ServiceError`; an error thrown by `onEvent` itself ends the stream and is
   * rethrown.
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
    // Why a stream that stopped without its last event stopped. Cut at the network level, the next call proves again.
    const cut = (error: unknown): 'lost' | 'offline' => {
      const lost = idle || signal.aborted || error instanceof EventDataError || (error instanceof ServiceError && error.kind === 'problem');
      if (lost) return 'lost';
      this.proved = null;
      return 'offline';
    };

    arm();
    try {
      let res: Response;
      try {
        res = await this.send({ method: 'GET', path: `/reviews/${runId}/events` }, token, AbortSignal.any([signal, silent.signal]));
      } catch (error) {
        if (error instanceof ServiceError && error.kind !== 'offline') throw error;
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
      // A throw from the listener is the panel's own failure, not the service's: it ends the stream and is passed on.
      const listener: { failed: boolean; error: unknown } = { failed: false, error: undefined };
      try {
        await readEventStream(watched, (data) => {
          const event = ServiceEventSchema.safeParse(data);
          if (!event.success) throw new ServiceError('problem', NOT_UNDERSTOOD);
          try {
            onEvent(event.data);
          } catch (error) {
            if (!(error instanceof ServiceError)) {
              listener.failed = true;
              listener.error = error;
            }
            throw error;
          }
          if (event.data.type === 'done' || event.data.type === 'failed') {
            ended = true;
            throw LAST_EVENT;
          }
        });
      } catch (error) {
        if (listener.failed) throw listener.error;
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

  /**
   * Asks `/hello`. With a token, the nonce is new and the proof must match it: a match records the token as proved;
   * anything else forgets any proof, and a wrong or missing proof throws `unproven`. No answer is `'offline'`.
   */
  private async ask(token: string | null, signal?: AbortSignal): Promise<Hello | 'offline'> {
    const nonce = token === null ? null : newNonce();
    try {
      return await this.timed(HELLO_TIMEOUT_MS, signal, async (both) => {
        const address = nonce === null ? this.url('/hello') : this.url('/hello', { nonce });
        const res = await this.fetchFn(address, { signal: both }).catch(() => {
          throw new ServiceError('offline', OFFLINE);
        });
        if (!res.ok) throw await failure(res);
        const hello = await parse(res, HelloSchema);
        if (token === null || nonce === null) return hello;
        if (!(await proves(hello.proof, token, nonce))) throw new ServiceError('unproven', NOT_PROVED);
        this.proved = token;
        return hello;
      });
    } catch (error) {
      if (token !== null) this.proved = null;
      if (error instanceof ServiceError && error.kind === 'offline') return 'offline';
      throw error;
    }
  }

  /** The one gate before the token leaves the panel: a proof for this token, unless one has matched since the last failure. */
  private async proven(token: string, signal: AbortSignal): Promise<void> {
    if (this.proved === token) return;
    if ((await this.ask(token, signal)) === 'offline') throw new ServiceError('offline', OFFLINE);
  }

  /** The only place the Authorization header is added, and only after `proven`. */
  private async send(call: Call, token: string, signal: AbortSignal): Promise<Response> {
    await this.proven(token, signal);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const init: RequestInit = { method: call.method, headers, signal };
    if (call.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(call.body);
    }
    let res: Response;
    try {
      res = await this.fetchFn(this.url(call.path, call.query), init);
    } catch {
      this.proved = null;
      throw new ServiceError('offline', OFFLINE);
    }
    if (res.status === 401) this.proved = null;
    return res;
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
