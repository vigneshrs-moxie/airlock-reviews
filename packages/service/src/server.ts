import http from 'node:http';
import type { AddressInfo } from 'node:net';
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

export function createServer(deps: ServiceDeps): { listen(): Promise<{ port: number }>; close(): Promise<void> } {
  let server: http.Server | undefined;
  return {
    async listen() {
      const token = await readOrCreateToken(deps.config.home);
      const auth: Auth = { token, port: deps.config.port, pairedOrigin: () => pairedOrigin(deps.config.home) };
      const created = http.createServer(createRouter(routesFor(deps), auth, deps.log));
      created.requestTimeout = 30_000;
      created.headersTimeout = 15_000;
      created.keepAliveTimeout = 5_000;
      await new Promise<void>((resolve, reject) => {
        created.once('error', reject);
        created.listen({ port: deps.config.port, host: LISTEN_HOST }, () => {
          created.off('error', reject);
          resolve();
        });
      });
      const port = (created.address() as AddressInfo).port;
      auth.port = port;
      server = created;
      return { port };
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
