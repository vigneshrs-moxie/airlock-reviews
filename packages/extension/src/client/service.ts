import {
  ApiErrorSchema, DismissalSchema, HelloSchema, LatestReplySchema, PairReplySchema, PrSummarySchema, RestoreReplySchema,
  RunIdSchema, ServiceEventSchema, ServiceStatusSchema, StartReviewReplySchema,
  type DismissBody, type Dismissal, type Hello, type LatestReply, type PairReply, type PrSummary, type RestoreBody,
  type RestoreReply, type ServiceEvent, type ServiceStatus, type StartReviewBody, type StartReviewReply,
} from '@airlock/shared';
import { readEventStream } from './event-stream';

export const NOT_UNDERSTOOD = 'Airlock got a reply from its service that it does not understand.';
const NO_TOKEN = 'This panel is not paired with the Airlock service yet.';
const REFUSED_TOKEN = 'The Airlock service does not accept this panel’s pairing token.';
const OFFLINE = 'The Airlock service is not answering.';

/** How long a call may take before the service counts as not answering. The event stream has no limit. */
const HELLO_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 60_000;

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

type Call = { method: 'GET' | 'POST'; path: string; query?: Record<string, string>; body?: unknown };

/** The panel's only way to reach the local service. Every reply is checked against the shared contract. */
export class ServiceClient {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly base: string,
    private readonly token: () => Promise<string | null>,
    fetchFn?: typeof fetch,
  ) {
    // Called through a wrapper: an extension page's fetch throws when called without its window as `this`.
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  async hello(): Promise<Hello | 'offline'> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url('/hello'), { signal: AbortSignal.timeout(HELLO_TIMEOUT_MS) });
    } catch {
      return 'offline';
    }
    if (!res.ok) throw await failure(res);
    return parse(res, HelloSchema);
  }

  /** Offers a token the person typed. Refusals come back as the service's words; only no answer at all throws. */
  async pair(token: string): Promise<PairReply | { error: string }> {
    const res = await this.send({ method: 'POST', path: '/pair' }, token);
    if (res.ok) return parse(res, PairReplySchema);
    return { error: (await failure(res)).message };
  }

  status(): Promise<ServiceStatus> {
    return this.call({ method: 'GET', path: '/status' }, ServiceStatusSchema);
  }

  pr(repo: string, number: number): Promise<PrSummary> {
    return this.call({ method: 'GET', path: '/pr', query: prQuery(repo, number) }, PrSummarySchema);
  }

  start(body: StartReviewBody): Promise<StartReviewReply> {
    return this.call({ method: 'POST', path: '/reviews', body }, StartReviewReplySchema);
  }

  async running(repo: string, number: number): Promise<string | null> {
    const reply = await this.call({ method: 'GET', path: '/reviews/running', query: prQuery(repo, number) }, RunningReplySchema, true);
    return reply === null ? null : reply.runId;
  }

  latest(repo: string, number: number): Promise<LatestReply | null> {
    return this.call({ method: 'GET', path: '/reviews/latest', query: prQuery(repo, number) }, LatestReplySchema, true);
  }

  dismiss(body: DismissBody): Promise<Dismissal> {
    return this.call({ method: 'POST', path: '/dismissals', body }, DismissalSchema);
  }

  restore(body: RestoreBody): Promise<RestoreReply> {
    return this.call({ method: 'POST', path: '/dismissals/restore', body }, RestoreReplySchema);
  }

  /**
   * Follows a run's events from its first one. `'ended'` once a `done` or `failed` event arrived; `'lost'` when the
   * stream broke, closed early, was aborted, or carried an event that does not match the contract (that event is
   * not passed on). A refused stream throws the mapped `ServiceError`.
   */
  async events(runId: string, onEvent: (e: ServiceEvent) => void, signal: AbortSignal): Promise<'ended' | 'lost'> {
    if (!RunIdSchema.safeParse(runId).success) throw new ServiceError('problem', NOT_UNDERSTOOD);
    let res: Response;
    try {
      res = await this.send({ method: 'GET', path: `/reviews/${runId}/events` }, await this.storedToken(), signal);
    } catch (error) {
      if (error instanceof ServiceError && error.kind !== 'offline') throw error;
      return 'lost';
    }
    if (!res.ok) throw await failure(res);
    if (res.body === null) return 'lost';
    let ended = false;
    try {
      await readEventStream(res.body, (data) => {
        const event = ServiceEventSchema.safeParse(data);
        if (!event.success) throw new ServiceError('problem', NOT_UNDERSTOOD);
        onEvent(event.data);
        // The service closes the stream after the last event; stop reading here rather than rely on it.
        if (event.data.type === 'done' || event.data.type === 'failed') {
          ended = true;
          throw LAST_EVENT;
        }
      });
    } catch {
      // Reading stopped: after the last event, or because the stream broke or carried something unexpected.
    }
    return ended ? 'ended' : 'lost';
  }

  private call<T>(call: Call, schema: Schema<T>): Promise<T>;
  private call<T>(call: Call, schema: Schema<T>, noneOn404: true): Promise<T | null>;
  private async call<T>(call: Call, schema: Schema<T>, noneOn404 = false): Promise<T | null> {
    const res = await this.send(call, await this.storedToken());
    if (noneOn404 && res.status === 404) return null;
    if (!res.ok) throw await failure(res);
    return parse(res, schema);
  }

  private async storedToken(): Promise<string> {
    const token = await this.token();
    if (token === null || token === '') throw new ServiceError('unpaired', NO_TOKEN);
    return token;
  }

  private async send(call: Call, token: string, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const init: RequestInit = {
      method: call.method,
      headers,
      signal: signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS),
    };
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
