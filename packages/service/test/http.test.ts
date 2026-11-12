import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineDeps } from '@airlock/engine';
import { MESSAGE_MAX } from '@airlock/shared';
import { pair, pairedOrigin, readOrCreateToken } from '../src/config.js';
import { createRouter, MAX_BODY_BYTES, MAX_DRAINED_BYTES, type Auth, type Handler } from '../src/http.js';
import { keepToken } from '../src/proof.js';
import { createServer } from '../src/server.js';

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const OTHER = `chrome-extension://${'b'.repeat(32)}`;
const TOKEN = 'f'.repeat(64);
/** A keeper whose token file never changes. */
const fixedToken = () => keepToken({ token: TOKEN, signature: null }, { look: async () => null, read: async () => ({ refused: 'unused' }) }, () => performance.now());

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

/**
 * Sends a body in pieces, the next one only once the last was handed to the socket and the event loop turned, and says
 * what the client saw: the status and body of the answer, whether the answer came after the last piece was written, and
 * any error on the request (a broken pipe, a reset).
 */
function sendInPieces(
  port: number, headers: Record<string, string>, pieces: string[],
): Promise<{ status: number; answeredAfterTheLastPiece: boolean; error: string | null; json: unknown }> {
  return new Promise((resolve) => {
    let wroteAll = false;
    let afterAll = false;
    let status = 0;
    let error: string | null = null;
    let json: unknown;
    const done = (): void => resolve({ status, answeredAfterTheLastPiece: afterAll, error, json });
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/things', agent: false, headers }, (res) => {
      status = res.statusCode ?? 0;
      afterAll = wroteAll;
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      // An error that comes after the answer (a reset while the client still writes) is seen before this resolves.
      res.on('end', () => {
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = undefined; }
        setTimeout(done, 50);
      });
    });
    req.on('error', (e) => { error = e.message; setTimeout(done, 50); });
    const next = (i: number): void => {
      if (i === pieces.length) {
        wroteAll = true;
        req.end();
        return;
      }
      req.write(pieces[i] as string, () => setImmediate(() => next(i + 1)));
    };
    next(0);
  });
}

const asJson = (body: unknown): { headers: Record<string, string>; body: string } =>
  ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

interface Rig { port: number; log: string[]; paired: { value: string | null } }

/** The router on a real socket, with a few routes that exist only for these tests. */
async function routerRig(extra: { pairedOrigin?: string | null } = {}): Promise<Rig> {
  const log: string[] = [];
  const paired = { value: extra.pairedOrigin ?? null };
  const auth: Auth = { tokens: fixedToken(), port: 0, pairedOrigin: async () => paired.value };
  const ok: Handler = async (req) => ({ status: 200, json: { path: req.path, params: req.params, body: req.body ?? null, origin: req.origin, q: req.query.get('q') } });
  const listener = createRouter([
    { method: 'GET', path: '/hello', open: true, handler: async () => ({ status: 200, json: { hi: true } }) },
    { method: 'GET', path: '/things/:id', handler: ok },
    { method: 'GET', path: '/search', query: z.object({ q: z.string().min(2, 'q is too short') }), handler: ok },
    { method: 'POST', path: '/things', body: z.object({ name: z.string() }), handler: ok },
    { method: 'POST', path: '/pairing', pairing: true, handler: ok },
    { method: 'GET', path: '/strict', requiresOrigin: true, handler: ok },
    { method: 'GET', path: '/boom', handler: async () => { throw new Error('secret detail'); } },
    { method: 'GET', path: '/long', handler: async () => { throw new Error(`one\ntwo\r\n${'é'.repeat(400)}`); } },
    { method: 'GET', path: '/enoent', handler: async () => { throw new Error(`ENOENT: no such file or directory, open '${homedir()}/.airlock/service/token'`); } },
    {
      method: 'GET', path: '/stream-fails',
      handler: async () => ({
        status: 200 as const,
        stream: async (emit: (e: unknown) => void) => { emit({ n: 1 }); throw new Error('went wrong'); },
      }),
    },
    { method: 'GET', path: '/echo-query', query: z.object({ q: z.string().regex(/^[a-z]+$/) }), handler: async (req) => ({ status: 200, json: { all: req.query.getAll('q'), text: req.query.toString() } }) },
    { method: 'GET', path: '/plain-query', handler: async (req) => ({ status: 200, json: { text: req.query.toString() } }) },
    {
      method: 'GET', path: '/stream',
      handler: async () => ({
        status: 200 as const,
        stream: async (emit: (e: unknown) => void) => { emit({ n: 1 }); emit({ text: 'a\nb' }); },
      }),
    },
  ], auth, (line) => log.push(line), { hidePaths: [homedir()] });
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

  it('a route that requires an Origin refuses none and a foreign one, and accepts the paired one', async () => {
    const { port } = await routerRig({ pairedOrigin: ORIGIN });
    for (const headers of [bearer, { ...bearer, Origin: OTHER }, { ...bearer, Origin: 'null' }]) {
      const r = await send(port, 'GET', '/strict', { headers });
      expect([r.status, r.json]).toEqual([403, { error: 'Airlock does not accept requests from this page.' }]);
    }
    expect((await send(port, 'GET', '/strict', { headers: { ...bearer, Origin: ORIGIN } })).status).toBe(200);
    // The Origin is checked before the token there too.
    expect((await send(port, 'GET', '/strict', {})).status).toBe(403);
    expect((await send(port, 'GET', '/strict', { headers: { Origin: ORIGIN } })).status).toBe(401);
  });

  it('refuses any Origin on every route while nothing is paired, except pairing and the open /hello', async () => {
    const { port } = await routerRig();
    expect((await send(port, 'GET', '/things/1', { headers: { ...bearer, Origin: ORIGIN } })).status).toBe(403);
    expect((await send(port, 'GET', '/hello', { headers: { Origin: ORIGIN } })).status).toBe(200);
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

  it('answers whatever the Origin header is, still with no Access-Control header, and still under the Host rule', async () => {
    const { port } = await routerRig({ pairedOrigin: ORIGIN });
    for (const origin of [ORIGIN, OTHER, 'https://evil.example', 'null']) {
      const r = await send(port, 'GET', '/hello', { headers: { Origin: origin } });
      expect(r.status, origin).toBe(200);
      expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control'))).toEqual([]);
    }
    expect((await send(port, 'GET', '/hello', { headers: { Origin: 'https://evil.example', Host: 'evil.example' } })).status).toBe(403);
    expect((await send(port, 'GET', '/things/1', { headers: { ...bearer, Origin: 'https://evil.example' } })).status).toBe(403);
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

  it('stops reading a chunked body that grows past the limit and the bound of what it discards, without waiting for its end', async () => {
    const { port } = await routerRig();
    // Past the bound the service answers 413 and closes while the client is still sending, so the client sees the 413
    // or, when the close reaches it first, the closed connection: either is the end, and neither is waiting for the body.
    const status = await new Promise<number | 'closed'>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no reply to the oversized chunked body')), 10_000);
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/things', agent: false, headers: { 'Content-Type': 'application/json', ...bearer } }, (res) => {
        res.resume();
        clearTimeout(timer);
        resolve(res.statusCode ?? 0);
      });
      req.on('error', () => { clearTimeout(timer); resolve('closed'); });
      req.write('{"name":"');
      // Never ended: past 64 KB and the 2 MiB discarded after it, the service stops reading and answers.
      const piece = 'y'.repeat(30_000);
      for (let i = 0; i * piece.length < MAX_BODY_BYTES + MAX_DRAINED_BYTES + 100_000; i += 1) req.write(piece);
    });
    expect([413, 'closed']).toContain(status);
  });

  it('reads a body over the limit to its end, up to the bound, before it answers 413, so the client sees the answer and no broken pipe', async () => {
    const { port } = await routerRig();
    const piece = 'z'.repeat(10_000);
    const pieces = ['{"name":"', ...Array.from({ length: 20 }, () => piece), '"}'];
    const bytes = pieces.reduce((n, p) => n + Buffer.byteLength(p), 0);
    expect(bytes).toBeGreaterThan(MAX_BODY_BYTES);
    for (const announced of [false, true]) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...bearer, ...(announced ? { 'Content-Length': String(bytes) } : {}) };
      const seen = await sendInPieces(port, headers, pieces);
      expect(seen, `Content-Length announced: ${announced}`).toEqual({ status: 413, answeredAfterTheLastPiece: true, error: null, json: { error: 'The request body is too large.' } });
    }
  });

  it('answers 413 at once, reading nothing, when the announced Content-Length is past the limit and the bound', async () => {
    const { port } = await routerRig();
    const r = await send(port, 'POST', '/things', {
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(MAX_BODY_BYTES + MAX_DRAINED_BYTES + 1), ...bearer },
    }).catch((e: Error) => ({ status: 0, error: e.message }));
    expect(r.status).toBe(413);
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

  it('answers 401 to a large body without a token and does not parse it', async () => {
    const { port } = await routerRig();
    const r = await send(port, 'POST', '/things', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(70_000) }) });
    expect(r.status).toBe(401);
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

describe('a quiet log (fix round)', () => {
  it('adds no line for a thousand GET /hello answered with 200, and still logs a refused one', async () => {
    const { port, log } = await routerRig();
    for (let i = 0; i < 1000; i += 1) expect((await send(port, 'GET', '/hello')).status).toBe(200);
    expect((await send(port, 'GET', '/hello', { headers: { Host: 'evil.example' } })).status).toBe(403);
    await send(port, 'GET', '/things/1', { headers: bearer });
    for (let i = 0; i < 100 && !log.some((l) => l.startsWith('GET /things/1 ')); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(log.filter((l) => l.startsWith('GET /hello 200'))).toEqual([]);
    expect(log.filter((l) => /^GET \/hello 403 \d+ms$/.test(l))).toHaveLength(1);
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
    const auth: Auth = { tokens: fixedToken(), port: 0, pairedOrigin: async () => null };
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

interface Service { port: number; address: string; family: string; home: string; token: string; log: string[] }

async function startService(limits?: { requestTimeoutMs: number; headersTimeoutMs: number }): Promise<Service> {
  const home = await mkdtemp(join(tmpdir(), 'airlock-service-http-'));
  const log: string[] = [];
  const service = createServer({
    config: { port: 0, home, packsDir: join(home, 'packs'), version: '9.9.9' },
    engine: {} as unknown as EngineDeps,
    now: () => new Date(),
    log: (l) => log.push(l),
    ...(limits === undefined ? {} : { limits }),
  });
  const { port, address, family } = await service.listen();
  cleanups.push(async () => { await service.close(); await rm(home, { recursive: true, force: true }); });
  return { port, address, family, home, token: await readOrCreateToken(home), log };
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
    expect(second.json).toEqual({ error: 'Airlock is already paired with another copy of the extension. In the airlock-reviews folder, run: npm run service -- unpair, then pair again.' });
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

  it('reports the address it really bound, and refuses a connection on a non-loopback address', async () => {
    const s = await startService();
    expect(s.address).toBe('127.0.0.1');
    expect(s.family).toBe('IPv4');
    const outside = Object.values(networkInterfaces()).flat().find((i) => i !== undefined && i.family === 'IPv4' && !i.internal);
    if (outside === undefined) return;
    const code = await new Promise<string>((resolve) => {
      const c = net.connect({ host: outside.address, port: s.port }, () => { c.destroy(); resolve('connected'); });
      c.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
    });
    expect(code).toBe('ECONNREFUSED');
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

function raw(port: number, text: string, waitMs = 3_000): Promise<string> {
  return new Promise((resolve) => {
    const c = net.connect({ host: '127.0.0.1', port }, () => c.write(text));
    let got = '';
    const done = (): void => { clearTimeout(timer); c.destroy(); resolve(got); };
    const timer = setTimeout(done, waitMs);
    c.on('data', (d: Buffer) => { got += d.toString('latin1'); if (got.includes('\r\n\r\n')) setTimeout(done, 50); });
    c.on('error', done);
    c.on('close', done);
  });
}
const statusOf = (reply: string): number => Number(/^HTTP\/1\.[01] (\d{3})/.exec(reply)?.[1] ?? 0);

describe('fix round 1: queries', () => {
  it('refuses a repeated query key with 400 before the schema runs', async () => {
    const { port } = await routerRig();
    for (const path of ['/echo-query?q=../x&q=ok', '/echo-query?q=ok&q=ok', '/plain-query?a=1&a=2']) {
      const r = await send(port, 'GET', path, { headers: bearer });
      expect(r.status, path).toBe(400);
      expect(r.json).toEqual({ error: 'A query value was given twice.' });
    }
  });

  it('hands the handler a query built from the validated object', async () => {
    const { port } = await routerRig();
    const r = await send(port, 'GET', '/echo-query?q=abc&extra=1', { headers: bearer });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ all: ['abc'], text: 'q=abc' });
    const plain = await send(port, 'GET', '/plain-query?x=1', { headers: bearer });
    expect((plain.json as { text: string }).text).toBe('x=1');
  });
});

describe('fix round 1: pairing', () => {
  it('twenty concurrent pair() calls with two origins leave one origin and one winner', async () => {
    const home = await mkdtemp(join(tmpdir(), 'airlock-service-race-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const origins = [ORIGIN, OTHER];
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => pair(home, origins[i % 2] as string)));
    const winner = await pairedOrigin(home);
    expect(winner === ORIGIN || winner === OTHER).toBe(true);
    expect(results.filter((r) => r === 'paired')).toHaveLength(1);
    results.forEach((r, i) => {
      if (origins[i % 2] === winner) expect(['paired', 'already']).toContain(r);
      else expect(r).toBe('other');
    });
  });

  it('refuses an uppercase origin, a trailing slash and a path at pairing', async () => {
    const s = await startService();
    for (const origin of [`chrome-extension://${'A'.repeat(32)}`, `${ORIGIN}/`, `${ORIGIN}/panel.html`]) {
      const r = await send(s.port, 'POST', '/pair', { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}`, Origin: origin }, body: '{}' });
      expect(r.status, origin).toBe(403);
    }
  });

  it('does not follow a symbolic link at the token path: it writes a new token and leaves the target alone', async () => {
    const home = await mkdtemp(join(tmpdir(), 'airlock-service-link-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const target = join(home, 'elsewhere');
    await writeFile(target, `${'d'.repeat(64)}\n`);
    await chmod(target, 0o644);
    await mkdir(join(home, 'service'), { recursive: true });
    await symlink(target, join(home, 'service', 'token'));
    const token = await readOrCreateToken(home);
    expect(token).not.toBe('d'.repeat(64));
    expect((await stat(target)).mode & 0o777).toBe(0o644);
    expect(await readFile(target, 'utf8')).toBe(`${'d'.repeat(64)}\n`);
    const own = await stat(join(home, 'service', 'token'));
    expect(own.mode & 0o777).toBe(0o600);
    expect(own.isFile()).toBe(true);
  });
});

describe('fix round 1: the Host header and the request line', () => {
  it('refuses odd Host headers and request forms', async () => {
    const { port } = await routerRig();
    const head = (host: string | null, line = 'GET /hello HTTP/1.1', extra = ''): string =>
      `${line}\r\n${host === null ? '' : `Host: ${host}\r\n`}${extra}Connection: close\r\n\r\n`;
    const cases: Array<[string, string, number]> = [
      ['case only', head(`LOCALHOST:${port}`), 403],
      ['trailing dot', head(`localhost.:${port}`), 403],
      ['trailing dot on the address', head(`127.0.0.1.:${port}`), 403],
      ['HTTP/1.0 without Host', head(null, 'GET /hello HTTP/1.0'), 403],
      ['absolute form with an evil Host', head('evil.example', `GET http://127.0.0.1:${port}/hello HTTP/1.1`), 403],
      ['absolute form with a good Host', head(`127.0.0.1:${port}`, `GET http://evil.example/hello HTTP/1.1`), 404],
      ['evil Host with X-Forwarded-Host', head('evil.example', 'GET /hello HTTP/1.1', `X-Forwarded-Host: 127.0.0.1:${port}\r\n`), 403],
    ];
    for (const [name, text, want] of cases) {
      expect(statusOf(await raw(port, text)), name).toBe(want);
    }
  });
});

describe('fix round 1: body sizes', () => {
  const json = { 'Content-Type': 'application/json', ...bearer };
  const bodyOf = (bytes: number): string => `{"name":"${'x'.repeat(bytes - 11)}"}`;

  it('accepts exactly 65,536 bytes and refuses 65,537, with Content-Length and chunked', async () => {
    const { port } = await routerRig();
    for (const chunked of [false, true]) {
      for (const [bytes, want] of [[65_536, 200], [65_537, 413]] as const) {
        const body = bodyOf(bytes);
        expect(Buffer.byteLength(body)).toBe(bytes);
        const headers = chunked ? json : { ...json, 'Content-Length': String(bytes) };
        const r = await send(port, 'POST', '/things', { headers, body }).catch(() => ({ status: 0 }));
        expect(r.status, `${bytes} chunked=${chunked}`).toBe(want);
      }
    }
  });

  it('accepts a small body sent with Content-Length', async () => {
    const { port } = await routerRig();
    const body = '{"name":"a"}';
    const r = await send(port, 'POST', '/things', { headers: { ...json, 'Content-Length': String(body.length) }, body });
    expect(r.status).toBe(200);
  });
});

describe('fix round 1: errors', () => {
  it('replaces absolute paths under the home folder with <path> in the 500 body, and keeps the full message in the log', async () => {
    const { port, log } = await routerRig();
    const r = await send(port, 'GET', '/enoent', { headers: bearer });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: "Airlock had a problem: ENOENT: no such file or directory, open '<path>'" });
    expect(log.some((l) => l.includes(`${homedir()}/.airlock/service/token`))).toBe(true);
  });

  it('ends a stream whose handler throws with a failed event', async () => {
    const { port } = await routerRig();
    const r = await send(port, 'GET', '/stream-fails', { headers: bearer });
    expect(r.text).toBe('data: {"n":1}\n\ndata: {"type":"failed","message":"Airlock had a problem: went wrong"}\n\n');
  });
});

describe('task 4 fix round 1: bounded error text', () => {
  it('collapses line breaks and cuts the whole 500 sentence once, to what the panel shows', async () => {
    const { port, log } = await routerRig();
    const r = await send(port, 'GET', '/long', { headers: bearer });
    expect(r.status).toBe(500);
    const error = (r.json as { error: string }).error;
    expect(error.startsWith('Airlock had a problem: one two é')).toBe(true);
    expect([...error]).toHaveLength(MESSAGE_MAX);
    expect(MESSAGE_MAX).toBe(300);
    expect(error.endsWith('…')).toBe(true);
    // The log keeps the whole message.
    expect(log.some((l) => l.includes('é'.repeat(400)))).toBe(true);
  });
});

describe('fix round 1: the service', () => {
  it('cuts off a request that stalls within the request timeout plus 10 seconds', async () => {
    const s = await startService({ requestTimeoutMs: 1_000, headersTimeoutMs: 500 });
    const started = Date.now();
    await new Promise<void>((resolve) => {
      const c = net.connect({ host: '127.0.0.1', port: s.port }, () => {
        c.write(`POST /pair HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nAuthorization: Bearer ${s.token}\r\nOrigin: ${ORIGIN}\r\n\r\n{"half":`);
      });
      c.on('error', () => resolve());
      c.on('close', () => resolve());
      c.resume();
    });
    expect(Date.now() - started).toBeLessThan(11_000);
  }, 20_000);
});
