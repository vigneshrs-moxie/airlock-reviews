import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineDeps } from '@airlock/engine';
import { main } from '../src/cli.js';
import { pair, pairedOrigin, readOrCreateToken, replaceToken } from '../src/config.js';
import { helloProof, keepToken } from '../src/proof.js';
import { createServer } from '../src/server.js';
import { FakeClock, send } from './helpers.js';

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const NONCE = '0123456789abcdef'.repeat(2);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The real server on a free port, in a temporary home, on a clock the test moves. */
async function startService(): Promise<{ port: number; home: string; clock: FakeClock }> {
  const home = await mkdtemp(join(tmpdir(), 'airlock-proof-'));
  const clock = new FakeClock();
  const service = createServer({
    config: { port: 0, home, packsDir: join(home, 'packs'), version: '9.9.9' },
    engine: {
      exec: async () => ({ stdout: '', stderr: 'gh: Not Found (HTTP 404)', code: 1 }),
      runner: { run: () => { throw new Error('no model is asked in these tests'); } },
      now: clock.date,
    } as EngineDeps,
    now: clock.date,
    log: () => undefined,
  });
  const { port } = await service.listen();
  cleanups.push(async () => { await service.close(); await rm(home, { recursive: true, force: true }); });
  return { port, home, clock };
}

const expected = (token: string, nonce: string): string =>
  createHmac('sha256', token).update(`airlock-hello:${nonce}`).digest('hex');

/** A route behind the token that answers 404 once the token is accepted, and 401 before. */
const behindToken = (port: number, token: string) =>
  send(port, 'GET', '/reviews/running?repo=acme/widgets&number=1', { headers: { Authorization: `Bearer ${token}` } });

describe('the proof that the service holds the token', () => {
  it('is the HMAC-SHA256 of "airlock-hello:<nonce>" keyed with the token, in lower-case hex', () => {
    const token = 'ab'.repeat(32);
    expect(helloProof(token, NONCE)).toBe(expected(token, NONCE));
    expect(helloProof(token, NONCE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hello with a nonce returns the proof for the token and without one returns none', async () => {
    const s = await startService();
    const token = await readOrCreateToken(s.home);
    const proved = await send(s.port, 'GET', `/hello?nonce=${NONCE}`);
    expect(proved.status).toBe(200);
    expect(proved.json).toEqual({ airlock: true, version: '9.9.9', paired: false, proof: expected(token, NONCE) });
    const plain = await send(s.port, 'GET', '/hello');
    expect(plain.json).toEqual({ airlock: true, version: '9.9.9', paired: false });
    // Still open: any Origin, no token, and no Access-Control header.
    const fromAPage = await send(s.port, 'GET', `/hello?nonce=${NONCE}`, { headers: { Origin: 'https://evil.example' } });
    expect(fromAPage.status).toBe(200);
    expect(Object.keys(fromAPage.headers).filter((h) => h.startsWith('access-control'))).toEqual([]);
  });

  it('refuses a malformed nonce or a repeated one with 400, and gives no proof', async () => {
    const s = await startService();
    for (const query of ['nonce=', 'nonce=abc', `nonce=${NONCE.toUpperCase()}`, `nonce=${NONCE}0`, `nonce=${'g'.repeat(32)}`, `nonce=${NONCE}&nonce=${NONCE}`]) {
      const r = await send(s.port, 'GET', `/hello?${query}`);
      expect(r.status, query).toBe(400);
      expect(r.text, query).not.toContain('proof');
    }
  });

  it('still answers /hello only under the Host rule', async () => {
    const s = await startService();
    const r = await send(s.port, 'GET', `/hello?nonce=${NONCE}`, { headers: { Host: `evil.example:${s.port}` } });
    expect(r.status).toBe(403);
    expect(r.text).not.toContain('proof');
  });
});

describe('replacing the token', () => {
  it('token --new makes the old token fail and the new one work without a restart', async () => {
    const s = await startService();
    await pair(s.home, ORIGIN);
    const old = await readOrCreateToken(s.home);
    expect((await behindToken(s.port, old)).status).toBe(404);

    const out: string[] = [];
    const err: string[] = [];
    const config = { port: s.port, home: s.home, packsDir: join(s.home, 'packs'), version: '9.9.9' };
    expect(await main(['token', '--new'], { out: (t) => out.push(t), err: (t) => err.push(t) }, { loadConfig: () => config })).toBe(0);
    expect(err).toEqual([]);
    const lines = out.join('').split('\n').filter((l) => l !== '');
    const fresh = lines.at(-1) as string;
    expect(fresh).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh).not.toBe(old);
    // Printed once, written whole, readable by this user only; the paired origin is kept.
    expect(out.join('').split(fresh)).toHaveLength(2);
    expect((await readFile(join(s.home, 'service', 'token'), 'utf8')).trim()).toBe(fresh);
    expect((await stat(join(s.home, 'service', 'token'))).mode & 0o777).toBe(0o600);
    expect(await pairedOrigin(s.home)).toBe(ORIGIN);

    s.clock.advance(1_000);
    expect((await behindToken(s.port, fresh)).status).toBe(404);
    expect((await behindToken(s.port, old)).status).toBe(401);
    s.clock.advance(5_000);
    expect((await behindToken(s.port, old)).status).toBe(401);
    expect((await behindToken(s.port, fresh)).status).toBe(404);
    // The proof is now made with the new token.
    expect((await send(s.port, 'GET', `/hello?nonce=${NONCE}`)).json).toMatchObject({ paired: true, proof: expected(fresh, NONCE) });
  });

  it('hello proves the token on disk once a second has passed, so a command reading the new file can check it', async () => {
    const s = await startService();
    const old = await readOrCreateToken(s.home);
    const fresh = await replaceToken(s.home);
    // Within the second after the last read the service still proves the token it holds.
    expect((await send(s.port, 'GET', `/hello?nonce=${NONCE}`)).json).toMatchObject({ proof: expected(old, NONCE) });
    s.clock.advance(1_000);
    expect((await send(s.port, 'GET', `/hello?nonce=${NONCE}`)).json).toMatchObject({ proof: expected(fresh, NONCE) });
  });

  it('replaceToken writes a new 0600 file through a temporary file, and leaves nothing else behind', async () => {
    const home = await mkdtemp(join(tmpdir(), 'airlock-proof-replace-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const first = await readOrCreateToken(home);
    await pair(home, ORIGIN);
    const second = await replaceToken(home);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    expect(await readOrCreateToken(home)).toBe(second);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(join(home, 'service'))).sort()).toEqual(['paired-origin', 'token']);
  });
});

describe('the token the service keeps', () => {
  function rig(onDisk: { value: string | null }) {
    let now = 1_000_000;
    let reads = 0;
    const keeper = keepToken('a'.repeat(64), async () => { reads += 1; return onDisk.value; }, () => now);
    return { keeper, reads: () => reads, advance: (ms: number) => { now += ms; } };
  }

  it('a flood of wrong tokens re-reads the file at most once a second', async () => {
    const disk = { value: 'a'.repeat(64) };
    const r = rig(disk);
    r.advance(1_000);
    const flood = await Promise.all(Array.from({ length: 200 }, () => r.keeper.matches('b'.repeat(64))));
    expect(flood.every((ok) => !ok)).toBe(true);
    expect(r.reads()).toBe(1);
    r.advance(999);
    for (let i = 0; i < 50; i += 1) expect(await r.keeper.matches('c'.repeat(64))).toBe(false);
    expect(r.reads()).toBe(1);
    r.advance(1);
    expect(await r.keeper.matches('c'.repeat(64))).toBe(false);
    expect(r.reads()).toBe(2);
  });

  it('never re-reads on a match, and a wrong token waits for the read already under way', async () => {
    const disk = { value: 'a'.repeat(64) as string | null };
    const r = rig(disk);
    r.advance(5_000);
    for (let i = 0; i < 20; i += 1) expect(await r.keeper.matches('a'.repeat(64))).toBe(true);
    expect(r.reads()).toBe(0);
    disk.value = 'd'.repeat(64);
    const [first, second] = await Promise.all([r.keeper.matches('d'.repeat(64)), r.keeper.matches('d'.repeat(64))]);
    expect([first, second]).toEqual([true, true]);
    expect(r.reads()).toBe(1);
    expect(await r.keeper.matches('a'.repeat(64))).toBe(false);
  });

  it('keeps the token it holds when the file is gone or holds anything else', async () => {
    const disk = { value: null as string | null };
    const r = rig(disk);
    r.advance(1_000);
    expect(await r.keeper.matches('b'.repeat(64))).toBe(false);
    expect(await r.keeper.matches('a'.repeat(64))).toBe(true);
  });
});
