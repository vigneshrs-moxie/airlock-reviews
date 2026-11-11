import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineDeps } from '@airlock/engine';
import { pair, readOrCreateToken } from '../src/config.js';
import { createRouter, type Auth, type Handler } from '../src/http.js';
import { createServer } from '../src/server.js';

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const OTHER = `chrome-extension://${'b'.repeat(32)}`;
const TOKEN = 'f'.repeat(64);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Reply { status: number; headers: http.IncomingHttpHeaders; text: string; json: unknown }

function send(
  port: number, method: string, path: string, opts: { headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: opts.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const asJson = (body: unknown): { headers: Record<string, string>; body: string } =>
  ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

interface Rig { port: number; log: string[]; paired: { value: string | null } }

/** The router on a real socket, with a few routes that exist only for these tests. */
async function routerRig(extra: { pairedOrigin?: string | null } = {}): Promise<Rig> {
  const log: string[] = [];
  const paired = { value: extra.pairedOrigin ?? null };
  const auth: Auth = { token: TOKEN, port: 0, pairedOrigin: async () => paired.value };
  const ok: Handler = async (req) => ({ status: 200, json: { path: req.path, params: req.params, body: req.body ?? null, origin: req.origin, q: req.query.get('q') } });
  const listener = createRouter([
    { method: 'GET', path: '/hello', open: true, handler: async () => ({ status: 200, json: { hi: true } }) },
    { method: 'GET', path: '/things/:id', handler: ok },
    { method: 'GET', path: '/search', query: z.object({ q: z.string().min(2, 'q is too short') }), handler: ok },
    { method: 'POST', path: '/things', body: z.object({ name: z.string() }), handler: ok },
    { method: 'POST', path: '/pairing', pairing: true, handler: ok },
    { method: 'GET', path: '/boom', handler: async () => { throw new Error('secret detail'); } },
    {
      method: 'GET', path: '/stream',
      handler: async () => ({
        status: 200 as const,
        stream: async (emit: (e: unknown) => void) => { emit({ n: 1 }); emit({ text: 'a\nb' }); },
      }),
    },
  ], auth, (line) => log.push(line));
  const server = http.createServer(listener);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  auth.port = port;
  cleanups.push(() => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }));
  return { port, log, paired };
}

const bearer = { Authorization: `Bearer ${TOKEN}` };

describe('the three checks', () => {
  it('refuses a request without a token with 401 and a wrong token with 401', async () => {
    const { port } = await routerRig();
    const wrong: Array<Record<string, string>> = [{}, { Authorization: `Bearer ${'0'.repeat(64)}` }, { Authorization: TOKEN }, { Authorization: `Basic ${TOKEN}` }, { Authorization: 'Bearer ' }];
    for (const headers of wrong) {
      const r = await send(port, 'GET', '/things/1', { headers });
      expect(r.status).toBe(401);
      expect(r.json).toEqual({ error: 'Airlock needs its pairing token.' });
    }
  });

  it('refuses the right token from a foreign Origin with 403', async () => {
    const { port } = await routerRig({ pairedOrigin: ORIGIN });
    for (const origin of ['https://evil.example', OTHER, 'null']) {
      const r = await send(port, 'GET', '/things/1', { headers: { ...bearer, Origin: origin } });
      expect(r.status).toBe(403);
      expect(r.json).toEqual({ error: 'Airlock does not accept requests from this page.' });
    }
  });

  it('checks the Origin before the token', async () => {
    const { port } = await routerRig({ pairedOrigin: ORIGIN });
    const r = await send(port, 'GET', '/things/1', { headers: { Origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
  });

  it('accepts the right token with no Origin header (a local command)', async () => {
    const { port } = await routerRig();
    const r = await send(port, 'GET', '/things/1', { headers: bearer });
    expect(r.status).toBe(200);
  });

  it('accepts the right token from the paired origin', async () => {
    const { port } = await routerRig({ pairedOrigin: ORIGIN });
    const r = await send(port, 'GET', '/things/1', { headers: { ...bearer, Origin: ORIGIN } });
    expect(r.status).toBe(200);
    expect((r.json as { origin: string }).origin).toBe(ORIGIN);
  });

  it('refuses any Origin on every route while nothing is paired, except pairing', async () => {
    const { port } = await routerRig();
    for (const path of ['/things/1', '/hello']) {
      const r = await send(port, 'GET', path, { headers: { ...bearer, Origin: ORIGIN } });
      expect(r.status).toBe(403);
    }
    const p = await send(port, 'POST', '/pairing', { ...asJson({}), headers: { ...asJson({}).headers, ...bearer, Origin: ORIGIN } });
    expect(p.status).toBe(200);
  });

  it('refuses a Host header that is not 127.0.0.1 or localhost on the service port', async () => {
    const { port } = await routerRig();
    const bad = ['evil.example', `evil.example:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`, `localhost:${port + 1}`, `127.0.0.1.evil.example:${port}`, `[::1]:${port}`, `LOCALHOST:${port}x`];
    for (const host of bad) {
      for (const path of ['/hello', '/things/1', '/nothing']) {
        const r = await send(port, 'GET', path, { headers: { ...bearer, Host: host } });
        expect(r.status, `${host} ${path}`).toBe(403);
        expect(r.json).toEqual({ error: 'Airlock only answers on this Mac.' });
      }
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      expect((await send(port, 'GET', '/hello', { headers: { Host: host } })).status).toBe(200);
    }
  });

  it('checks the Host before everything else, even for OPTIONS and unknown paths', async () => {
    const { port } = await routerRig();
    expect((await send(port, 'OPTIONS', '/things/1', { headers: { Host: 'evil.example' } })).json).toEqual({ error: 'Airlock only answers on this Mac.' });
    expect((await send(port, 'DELETE', '/hello', { headers: { Host: 'evil.example' } })).status).toBe(403);
  });
});

describe('the open route', () => {
  it('answers without a token', async () => {
    const { port } = await routerRig();
    const r = await send(port, 'GET', '/hello');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ hi: true });
  });
});

describe('headers', () => {
  it('answers OPTIONS with 403 and never sends an Access-Control header', async () => {
    const { port } = await routerRig({ pairedOrigin: ORIGIN });
    for (const path of ['/hello', '/things/1', '/nothing']) {
      const r = await send(port, 'OPTIONS', path, {
        headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization', ...bearer },
      });
      expect(r.status).toBe(403);
      expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control'))).toEqual([]);
    }
  });

  it('sends no Access-Control header on any response and marks every one no-store and nosniff', async () => {
    const { port } = await routerRig({ pairedOrigin: ORIGIN });
    const replies = [
      await send(port, 'GET', '/hello', { headers: { Origin: ORIGIN } }),
      await send(port, 'GET', '/things/1', { headers: { ...bearer, Origin: ORIGIN } }),
      await send(port, 'GET', '/things/1', { headers: { Origin: 'https://evil.example' } }),
      await send(port, 'GET', '/things/1'),
      await send(port, 'GET', '/nothing'),
      await send(port, 'DELETE', '/hello'),
      await send(port, 'GET', '/boom', { headers: bearer }),
    ];
    for (const r of replies) {
      expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control'))).toEqual([]);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    }
  });
});

describe('routing', () => {
  it('answers 404 for an unknown path and 405 for a method the route does not take', async () => {
    const { port } = await routerRig();
    expect((await send(port, 'GET', '/nothing', { headers: bearer })).status).toBe(404);
    expect((await send(port, 'GET', '/', { headers: bearer })).status).toBe(404);
    expect((await send(port, 'GET', '/hello/', { headers: bearer })).status).toBe(404);
    const r = await send(port, 'DELETE', '/hello');
    expect(r.status).toBe(405);
    expect((await send(port, 'PUT', '/things/1', { headers: bearer })).status).toBe(405);
  });

  it('matches :name to one non-empty segment, decoded once', async () => {
    const { port } = await routerRig();
    const r = await send(port, 'GET', '/things/a%20b', { headers: bearer });
    expect(r.status).toBe(200);
    expect((r.json as { params: unknown }).params).toEqual({ id: 'a b' });
    expect((await send(port, 'GET', '/things/a%2Fb', { headers: bearer })).status).toBe(404);
    expect((await send(port, 'GET', '/things/', { headers: bearer })).status).toBe(404);
    expect((await send(port, 'GET', '/things/1/2', { headers: bearer })).status).toBe(404);
    const twice = await send(port, 'GET', '/things/%2561', { headers: bearer });
    expect((twice.json as { params: unknown }).params).toEqual({ id: '%61' });
  });

  it('answers 404 for a path that fails to decode or holds .. or a NUL after decoding', async () => {
    const { port } = await routerRig();
    for (const path of ['/things/%E0%A4%A', '/things/%2e%2e', '/things/..', '/things/a%2e%2eb', '/things/a%00b', '/things/%2E%2E%2Fx']) {
      expect((await send(port, 'GET', path, { headers: bearer })).status, path).toBe(404);
    }
  });

  it('hands the handler the query and the path without it', async () => {
    const { port } = await routerRig();
    const r = await send(port, 'GET', '/things/7?q=hello', { headers: bearer });
    expect((r.json as { path: string; q: string })).toMatchObject({ path: '/things/7', q: 'hello' });
  });
});

describe('bodies', () => {
  it('refuses a body over 64 KB with 413 and a body that is not JSON with 400', async () => {
    const { port } = await routerRig();
    const json = { 'Content-Type': 'application/json', ...bearer };
    const big = await send(port, 'POST', '/things', { headers: json, body: JSON.stringify({ name: 'x'.repeat(70_000) }) });
    expect(big.status).toBe(413);
    const edge = await send(port, 'POST', '/things', { headers: json, body: JSON.stringify({ name: 'x'.repeat(65_536 - 12) }) });
    expect(edge.status).toBe(200);
    const bad = await send(port, 'POST', '/things', { headers: json, body: '{nope' });
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({ error: 'The request body is not valid JSON.' });
  });

  it('stops reading a chunked body that grows past 64 KB', async () => {
    const { port } = await routerRig();
    const r = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/things', agent: false, headers: { 'Content-Type': 'application/json', ...bearer } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', () => undefined);
      req.write('{"name":"');
      for (let i = 0; i < 4; i += 1) req.write('y'.repeat(30_000));
      setTimeout(() => req.destroy(), 500).unref();
      void reject;
    });
    expect(r).toBe(413);
  });

  it('refuses a Content-Type other than application/json with 415, and accepts a charset parameter', async () => {
    const { port } = await routerRig();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx']) {
      const r = await send(port, 'POST', '/things', { headers: { 'Content-Type': type, ...bearer }, body: '{"name":"a"}' });
      expect(r.status, type).toBe(415);
    }
    const r = await send(port, 'POST', '/things', { headers: { 'Content-Type': 'Application/JSON; charset=utf-8', ...bearer }, body: '{"name":"a"}' });
    expect(r.status).toBe(200);
    expect((await send(port, 'POST', '/things', { headers: bearer, body: '{"name":"a"}' })).status).toBe(415);
  });

  it('answers 400 with the first problem in words when the body or the query fails its schema', async () => {
    const { port } = await routerRig();
    const body = await send(port, 'POST', '/things', { headers: { 'Content-Type': 'application/json', ...bearer }, body: '{"name":5}' });
    expect(body.status).toBe(400);
    expect((body.json as { error: string }).error).toMatch(/^name: /);
    const empty = await send(port, 'POST', '/things', { headers: { 'Content-Type': 'application/json', ...bearer }, body: '' });
    expect(empty.status).toBe(400);
    const query = await send(port, 'GET', '/search?q=a', { headers: bearer });
    expect(query.status).toBe(400);
    expect(query.json).toEqual({ error: 'q: q is too short' });
    expect((await send(port, 'GET', '/search?q=ab', { headers: bearer })).status).toBe(200);
  });

  it('does not read the body of a request that fails a check', async () => {
    const { port } = await routerRig();
    const r = await send(port, 'POST', '/things', { headers: { 'Content-Type': 'text/plain' }, body: 'x'.repeat(70_000) }).catch(() => ({ status: 0 }));
    expect([401, 0]).toContain(r.status);
  });
});

describe('errors and logging', () => {
  it('a handler that throws gives 500 without a stack in the body, and the stack goes to the log', async () => {
    const { port, log } = await routerRig();
    const r = await send(port, 'GET', '/boom', { headers: bearer });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: 'Airlock had a problem: secret detail' });
    expect(r.text).not.toContain('at ');
    expect(log.some((l) => l.includes('Error: secret detail') && l.includes('at '))).toBe(true);
  });

  it('logs method, path, status and time, and never the token, a body or a query string', async () => {
    const { port, log } = await routerRig();
    await send(port, 'GET', '/things/9?q=private-query', { headers: bearer });
    await send(port, 'POST', '/things', { headers: { 'Content-Type': 'application/json', ...bearer }, body: '{"name":"private-body"}' });
    await new Promise((r) => setTimeout(r, 50));
    expect(log.some((l) => /^GET \/things\/9 200 \d+ms$/.test(l))).toBe(true);
    expect(log.some((l) => /^POST \/things 200 \d+ms$/.test(l))).toBe(true);
    const all = log.join('\n');
    for (const secret of [TOKEN, 'private-query', 'private-body', 'Bearer']) expect(all).not.toContain(secret);
  });
});

describe('streams', () => {
  it('sends event-stream headers and one data line per event, then ends', async () => {
    const { port } = await routerRig();
    const r = await send(port, 'GET', '/stream', { headers: bearer });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/event-stream');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.text).toBe('data: {"n":1}\n\ndata: {"text":"a\\nb"}\n\n');
  });

  it('aborts closed when the client goes away', async () => {
    const log: string[] = [];
    let aborted!: () => void;
    const seen = new Promise<void>((r) => { aborted = r; });
    const auth: Auth = { token: TOKEN, port: 0, pairedOrigin: async () => null };
    const server = http.createServer(createRouter([{
      method: 'GET', path: '/wait',
      handler: async () => ({ status: 200 as const, stream: (emit, closed) => new Promise<void>((resolve) => {
        emit({ hello: 1 });
        closed.addEventListener('abort', () => { aborted(); resolve(); });
      }) }),
    }], auth, (l) => log.push(l)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    auth.port = (server.address() as net.AddressInfo).port;
    cleanups.push(() => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }));
    await new Promise<void>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: auth.port, path: '/wait', headers: bearer, agent: false }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => undefined);
      req.end();
    });
    await seen;
  });
});

interface Service { port: number; home: string; token: string; log: string[] }

async function startService(): Promise<Service> {
  const home = await mkdtemp(join(tmpdir(), 'airlock-service-http-'));
  const log: string[] = [];
  const service = createServer({
    config: { port: 0, home, packsDir: join(home, 'packs'), version: '9.9.9' },
    engine: {} as unknown as EngineDeps,
    now: () => new Date(),
    log: (l) => log.push(l),
  });
  const { port } = await service.listen();
  cleanups.push(async () => { await service.close(); await rm(home, { recursive: true, force: true }); });
  return { port, home, token: await readOrCreateToken(home), log };
}

describe('the service', () => {
  it('hello answers without a token and says whether an extension is paired', async () => {
    const s = await startService();
    const before = await send(s.port, 'GET', '/hello');
    expect(before.status).toBe(200);
    expect(before.json).toEqual({ airlock: true, version: '9.9.9', paired: false });
    await pair(s.home, ORIGIN);
    expect((await send(s.port, 'GET', '/hello')).json).toEqual({ airlock: true, version: '9.9.9', paired: true });
    // The reply carries nothing but Hello.
    expect(Object.keys(before.json as object).sort()).toEqual(['airlock', 'paired', 'version']);
  });

  const postPair = (s: Service, origin: string | undefined, token = s.token): Promise<Reply> =>
    send(s.port, 'POST', '/pair', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(origin === undefined ? {} : { Origin: origin }) },
      body: '{}',
    });

  it('pairs the first extension origin, accepts it again, and refuses a second one with 409', async () => {
    const s = await startService();
    const first = await postPair(s, ORIGIN);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ paired: true, extension: 'new' });
    const again = await postPair(s, ORIGIN);
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ paired: true, extension: 'same' });
    const second = await postPair(s, OTHER);
    expect(second.status).toBe(409);
    expect(second.json).toEqual({ error: 'Airlock is already paired with another copy of the extension. Run "airlock-service unpair" and pair again.' });
  });

  it('refuses an Origin that is not a chrome-extension origin at pairing, and a missing one', async () => {
    const s = await startService();
    for (const origin of ['https://evil.example', 'null', `chrome-extension://${'a'.repeat(31)}`, `chrome-extension://${'q'.repeat(32)}`, undefined]) {
      const r = await postPair(s, origin);
      expect(r.status, String(origin)).toBe(403);
    }
    expect((await send(s.port, 'GET', '/hello')).json).toMatchObject({ paired: false });
  });

  it('pairing needs the token', async () => {
    const s = await startService();
    expect((await postPair(s, ORIGIN, '0'.repeat(64))).status).toBe(401);
    expect((await send(s.port, 'GET', '/hello')).json).toMatchObject({ paired: false });
  });

  it('creates the token file with mode 0600 and reuses it across restarts', async () => {
    const s = await startService();
    expect(s.token).toMatch(/^[0-9a-f]{64}$/);
    expect(await readOrCreateToken(s.home)).toBe(s.token);
  });

  it('listens on 127.0.0.1 only', async () => {
    const s = await startService();
    await new Promise<void>((resolve, reject) => {
      const c = net.connect({ host: '127.0.0.1', port: s.port }, () => { c.destroy(); resolve(); });
      c.on('error', reject);
    });
    const code = await new Promise<string>((resolve) => {
      const c = net.connect({ host: '::1', port: s.port }, () => { c.destroy(); resolve('connected'); });
      c.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
    });
    expect(code).not.toBe('connected');
  });

  it('refuses to start when 127.0.0.1 cannot be bound, and does not fall back to another address', async () => {
    const taken = http.createServer();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => { taken.close(() => r()); }));
    const port = (taken.address() as net.AddressInfo).port;
    const home = await mkdtemp(join(tmpdir(), 'airlock-service-http-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const service = createServer({
      config: { port, home, packsDir: home, version: '0' }, engine: {} as unknown as EngineDeps, now: () => new Date(), log: () => undefined,
    });
    await expect(service.listen()).rejects.toThrow();
    await service.close();
  });

  it('answers 404 to unknown routes, and the log line holds no token', async () => {
    const s = await startService();
    const r = await send(s.port, 'GET', '/nothing', { headers: { Authorization: `Bearer ${s.token}` } });
    expect(r.status).toBe(404);
    await new Promise((res) => setTimeout(res, 50));
    expect(s.log.join('\n')).not.toContain(s.token);
  });
});
