import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineDeps } from '@airlock/engine';
import { pair, readOrCreateToken } from '../src/config.js';
import { createServer, type Service } from '../src/server.js';
import { send } from './helpers.js';

// Every route the real server has, taken from the server itself, so a route added later is checked without editing this.
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const FOREIGN = 'https://evil.example';

let home: string;
let service: Service;
let port: number;
let token: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'airlock-front-door-'));
  service = createServer({
    config: { port: 0, home, packsDir: join(home, 'packs'), version: '1.0.0' },
    engine: {
      exec: async () => { throw new Error('no command runs behind the front door'); },
      runner: { run: () => { throw new Error('no model is asked behind the front door'); } },
      now: () => new Date(),
    } as EngineDeps,
    now: () => new Date(),
    log: () => undefined,
  });
  ({ port } = await service.listen());
  token = await readOrCreateToken(home);
  await pair(home, ORIGIN);
});

afterAll(async () => {
  await service.close();
  await rm(home, { recursive: true, force: true });
});

/** A path that reaches the route: each `:param` filled with a value of the right shape. */
const pathOf = (pattern: string): string => pattern.replace(/:[A-Za-z]+/g, 'run_0123456789ab');
const named = (r: { method: string; path: string }): string => `${r.method} ${r.path}`;

describe('the front door of the real server', () => {
  it('has GET /hello as its only open route', () => {
    expect(service.routes.length).toBeGreaterThan(5);
    expect(service.routes.filter((r) => r.open === true).map(named)).toEqual(['GET /hello']);
  });

  it('answers every other route 401 without the token, even from the paired extension', async () => {
    for (const route of service.routes.filter((r) => r.open !== true)) {
      const r = await send(port, route.method, pathOf(route.path), { headers: { Origin: ORIGIN } });
      expect(r.status, named(route)).toBe(401);
    }
    expect((await send(port, 'GET', '/hello')).status).toBe(200);
  });

  it('answers every other route 403 with the token and a foreign Origin', async () => {
    for (const route of service.routes.filter((r) => r.open !== true)) {
      const r = await send(port, route.method, pathOf(route.path), { headers: { Authorization: `Bearer ${token}`, Origin: FOREIGN } });
      expect(r.status, named(route)).toBe(403);
    }
  });

  it('requires an Origin on the routes that can lead to a GitHub write, even with the token', async () => {
    const strict = service.routes.filter((r) => r.requiresOrigin === true);
    expect(strict.map(named)).toEqual(['POST /posts/preview', 'POST /posts', 'POST /posts/forget']);
    for (const route of strict) {
      const r = await send(port, route.method, pathOf(route.path), { headers: { Authorization: `Bearer ${token}` } });
      expect(r.status, named(route)).toBe(403);
    }
  });

  it('answers every route, /hello included, 403 with a rebinding Host', async () => {
    for (const route of service.routes) {
      const r = await send(port, route.method, pathOf(route.path), { headers: { Authorization: `Bearer ${token}`, Host: `evil.example:${port}` } });
      expect(r.status, named(route)).toBe(403);
    }
  });
});
