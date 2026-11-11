import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import type { EngineDeps, runReview } from '@airlock/engine';
import type { Hello, PairReply } from '@airlock/shared';
import { pair, pairedOrigin, readOrCreateToken, type ServiceConfig } from './config.js';
import { createRouter, type Auth, type Route } from './http.js';

export interface ServiceDeps {
  config: ServiceConfig;
  engine: EngineDeps;
  review?: typeof runReview;
  now: () => Date;
  log: (line: string) => void;
  /** Shorter limits for tests; the defaults are 30 s and 15 s. */
  limits?: { requestTimeoutMs: number; headersTimeoutMs: number };
}

export const LISTEN_HOST = '127.0.0.1';
const PAIRED_ELSEWHERE =
  'Airlock is already paired with another copy of the extension. Run "airlock-service unpair" and pair again.';

function routesFor(deps: ServiceDeps): Route[] {
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

export function createServer(deps: ServiceDeps): { listen(): Promise<{ port: number; address: string; family: string }>; close(): Promise<void> } {
  let server: http.Server | undefined;
  return {
    async listen() {
      const token = await readOrCreateToken(deps.config.home);
      const auth: Auth = { token, port: deps.config.port, pairedOrigin: () => pairedOrigin(deps.config.home) };
      const created = http.createServer({ connectionsCheckingInterval: 5_000 }, createRouter(routesFor(deps), auth, deps.log, { hidePaths: [deps.config.home, homedir()] }));
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
    async close() {
      const running = server;
      server = undefined;
      if (running === undefined) return;
      await new Promise<void>((resolve) => {
        running.close(() => resolve());
        running.closeAllConnections();
      });
    },
  };
}
