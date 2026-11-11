import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import {
  createSdkRunner, realExec, withRetry, type AgentRequest, type AgentResult, type AgentRunner, type EngineDeps, type runReview,
} from '@airlock/engine';
import type { Dismissal, Hello, PairReply } from '@airlock/shared';
import { pair, pairedOrigin, readOrCreateToken, type ServiceConfig } from './config.js';
import { dismissalsFor } from './dismissals.js';
import { createRouter, type Auth, type Route } from './http.js';
import { reviewRoutes } from './routes.js';
import type { Timers } from './runs.js';

export interface ServiceDeps {
  config: ServiceConfig;
  engine: EngineDeps;
  review?: typeof runReview;
  now: () => Date;
  log: (line: string) => void;
  /**
   * Request limits (30 s and 15 s by default; shorter in tests) and the most a review may run, in minutes (a positive
   * number, 90 by default).
   */
  limits?: { requestTimeoutMs?: number; headersTimeoutMs?: number; runMinutes?: number };
  /** The keep-alive and the dropping of finished runs; real timers by default. */
  timers?: Timers;
  /** The dismissals recorded for a pull request; the stored ones (under the service's home) by default. */
  dismissals?: (repo: string, number: number) => Promise<Dismissal[]>;
}

/**
 * The engine's dependencies for real use: real commands, the Claude runner with one retry, the real clock. The runner
 * is built on the first model call, so nothing touches Claude until a review runs.
 */
export function defaultEngineDeps(): EngineDeps {
  let runner: AgentRunner | undefined;
  return {
    exec: realExec,
    runner: { run: <T>(req: AgentRequest<T>): Promise<AgentResult<T>> => (runner ??= withRetry(createSdkRunner(), 1)).run(req) },
    now: () => new Date(),
  };
}

export const LISTEN_HOST = '127.0.0.1';
const PAIRED_ELSEWHERE =
  'Airlock is already paired with another copy of the extension. In the airlock-reviews folder, run: npm run service -- unpair, then pair again.';

function frontRoutes(deps: ServiceDeps): Route[] {
  const { home, version } = deps.config;
  return [
    {
      method: 'GET', path: '/hello', open: true,
      handler: async () => {
        const hello: Hello = { airlock: true, version, paired: (await pairedOrigin(home)) !== null };
        return { status: 200, json: hello };
      },
    },
    {
      method: 'POST', path: '/pair', pairing: true,
      handler: async (req) => {
        // The router has already required a chrome-extension Origin on this route.
        const result = await pair(home, req.origin as string);
        if (result === 'other') return { status: 409, json: { error: PAIRED_ELSEWHERE } };
        const reply: PairReply = { paired: true, extension: result === 'paired' ? 'new' : 'same' };
        return { status: 200, json: reply };
      },
    },
  ];
}

export interface Service {
  /** Every route the service answers, in the order the router tries them. */
  readonly routes: readonly Route[];
  listen(): Promise<{ port: number; address: string; family: string }>;
  close(): Promise<void>;
}

/** Throws a RangeError for a run limit that is not a positive number. */
export function createServer(deps: ServiceDeps): Service {
  const runMinutes = deps.limits?.runMinutes;
  if (runMinutes !== undefined && !(Number.isFinite(runMinutes) && runMinutes > 0)) {
    throw new RangeError(`limits.runMinutes must be a positive number, got ${runMinutes}`);
  }
  const hidePaths = [deps.config.home, homedir()];
  const reviews = reviewRoutes(
    { ...deps, dismissals: deps.dismissals ?? ((repo, number) => dismissalsFor(deps.config.home, repo, number)) }, hidePaths);
  const routes = [...frontRoutes(deps), ...reviews.routes];
  let server: http.Server | undefined;
  return {
    routes,
    async listen() {
      const token = await readOrCreateToken(deps.config.home);
      const auth: Auth = { token, port: deps.config.port, pairedOrigin: () => pairedOrigin(deps.config.home) };
      const created = http.createServer({ connectionsCheckingInterval: 5_000 }, createRouter(routes, auth, deps.log, { hidePaths }));
      created.requestTimeout = deps.limits?.requestTimeoutMs ?? 30_000;
      created.headersTimeout = deps.limits?.headersTimeoutMs ?? 15_000;
      created.keepAliveTimeout = 5_000;
      await new Promise<void>((resolve, reject) => {
        created.once('error', reject);
        created.listen({ port: deps.config.port, host: LISTEN_HOST }, () => {
          created.off('error', reject);
          resolve();
        });
      });
      const bound = created.address() as AddressInfo;
      auth.port = bound.port;
      server = created;
      created.on('error', (e) => deps.log(`server error: ${e.message}`));
      return { port: bound.port, address: bound.address, family: bound.family };
    },
    /** Closes the port and stops every running review; resolves once they have settled, or after five seconds. */
    async close() {
      const stopped = reviews.stop();
      const running = server;
      server = undefined;
      if (running !== undefined) {
        await new Promise<void>((resolve) => {
          running.close(() => resolve());
          running.closeAllConnections();
        });
      }
      await stopped;
    },
  };
}
