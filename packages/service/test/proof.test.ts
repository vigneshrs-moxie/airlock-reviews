import { createHmac } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineDeps } from '@airlock/engine';
import { main } from '../src/cli.js';
import { pair, pairedOrigin, readOrCreateToken, replaceToken, tokenFile } from '../src/config.js';
import { helloProof, keepToken, type TokenFile } from '../src/proof.js';
import { createServer } from '../src/server.js';
import { FakeClock, send } from './helpers.js';

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const NONCE = '0123456789abcdef'.repeat(2);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * The real server on a free port, in a temporary home, on clocks the test moves: the wall clock, and the monotonic one
 * the token keeper's limit is counted on (moved with `clock.advance` too).
 */
async function startService(): Promise<{ port: number; home: string; clock: FakeClock; log: string[] }> {
  const home = await mkdtemp(join(tmpdir(), 'airlock-proof-'));
  const clock = new FakeClock();
  const log: string[] = [];
  const service = createServer({
    monotonic: () => clock.now,
    config: { port: 0, home, packsDir: join(home, 'packs'), version: '9.9.9' },
    engine: {
      exec: async () => ({ stdout: '', stderr: 'gh: Not Found (HTTP 404)', code: 1 }),
      runner: { run: () => { throw new Error('no model is asked in these tests'); } },
      now: clock.date,
    } as EngineDeps,
    now: clock.date,
    log: (line) => log.push(line),
  });
  const { port } = await service.listen();
  cleanups.push(async () => { await service.close(); await rm(home, { recursive: true, force: true }); });
  return { port, home, clock, log };
}

const expected = (token: string, port: number, nonce: string): string =>
  createHmac('sha256', token).update(`airlock-hello:${port}:${nonce}`).digest('hex');

/** A route behind the token that answers 404 once the token is accepted, and 401 before. */
const behindToken = (port: number, token: string) =>
  send(port, 'GET', '/reviews/running?repo=acme/widgets&number=1', { headers: { Authorization: `Bearer ${token}` } });

describe('the proof that the service holds the token', () => {
  it('is the HMAC-SHA256 of "airlock-hello:<port>:<nonce>" keyed with the token, in lower-case hex', () => {
    const token = 'ab'.repeat(32);
    expect(helloProof(token, 4611, NONCE)).toBe(expected(token, 4611, NONCE));
    expect(helloProof(token, 4611, NONCE)).toMatch(/^[0-9a-f]{64}$/);
    // Made for another port, it is another proof.
    expect(helloProof(token, 4612, NONCE)).not.toBe(helloProof(token, 4611, NONCE));
  });

  it('names the port the service really listens on, so a proof asked for through another port does not match', async () => {
    const s = await startService();
    const token = await readOrCreateToken(s.home);
    const proved = (await send(s.port, 'GET', `/hello?nonce=${NONCE}`)).json as { proof: string };
    expect(proved.proof).toBe(expected(token, s.port, NONCE));
    expect(proved.proof).not.toBe(expected(token, 4611, NONCE));
  });

  it('hello with a nonce returns the proof for the token and without one returns none', async () => {
    const s = await startService();
    const token = await readOrCreateToken(s.home);
    const proved = await send(s.port, 'GET', `/hello?nonce=${NONCE}`);
    expect(proved.status).toBe(200);
    expect(proved.json).toEqual({ airlock: true, version: '9.9.9', paired: false, proof: expected(token, s.port, NONCE) });
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
    expect((await send(s.port, 'GET', `/hello?nonce=${NONCE}`)).json).toMatchObject({ paired: true, proof: expected(fresh, s.port, NONCE) });
  });

  it('only the old token, after a replacement: refused from the first request a second later, with nothing else sent', async () => {
    const s = await startService();
    const old = await readOrCreateToken(s.home);
    expect((await behindToken(s.port, old)).status).toBe(404);
    await replaceToken(s.home);
    s.clock.advance(1_000);
    expect((await behindToken(s.port, old)).status).toBe(401);
    for (let i = 0; i < 4; i += 1) {
      s.clock.advance(2_000);
      expect((await behindToken(s.port, old)).status).toBe(401);
    }
    expect(s.log.filter((l) => l.includes('token file'))).toEqual(['The token file changed; the new token is in use.']);
  });

  it('hello proves the token on disk once a second has passed, so a command reading the new file can check it', async () => {
    const s = await startService();
    const old = await readOrCreateToken(s.home);
    const fresh = await replaceToken(s.home);
    // Within the second after the last look the service still proves the token it holds.
    expect((await send(s.port, 'GET', `/hello?nonce=${NONCE}`)).json).toMatchObject({ proof: expected(old, s.port, NONCE) });
    s.clock.advance(1_000);
    expect((await send(s.port, 'GET', `/hello?nonce=${NONCE}`)).json).toMatchObject({ proof: expected(fresh, s.port, NONCE) });
  });

  it('a token file made readable by others is set back to 0600 and said in the log; the token is still taken', async () => {
    const s = await startService();
    const file = join(s.home, 'service', 'token');
    const fresh = 'cd'.repeat(32);
    await writeFile(file, `${fresh}\n`, { mode: 0o644 });
    await chmod(file, 0o644);
    s.clock.advance(1_000);
    expect((await behindToken(s.port, fresh)).status).toBe(404);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(s.log).toContain('The token file could be read by other users; its permissions were set back to 0600.');
  });

  it('a token file that becomes a symbolic link, empty or malformed is not taken, and each change is logged once', async () => {
    const s = await startService();
    const old = await readOrCreateToken(s.home);
    const file = join(s.home, 'service', 'token');
    const target = join(s.home, 'elsewhere');
    await writeFile(target, `${'ef'.repeat(32)}\n`, { mode: 0o600 });
    const cases: Array<[string, () => Promise<void>]> = [
      ['it is a symbolic link', async () => { await rm(file); await symlink(target, file); }],
      ['it is empty', async () => { await rm(file); await writeFile(file, '', { mode: 0o600 }); }],
      ['it does not hold a token', async () => { await rm(file); await writeFile(file, 'not a token\n', { mode: 0o600 }); }],
    ];
    for (const [why, change] of cases) {
      await change();
      s.clock.advance(1_000);
      // The token in memory stays; asked again later, the same file is not logged again.
      expect((await behindToken(s.port, old)).status, why).toBe(404);
      s.clock.advance(1_000);
      expect((await behindToken(s.port, old)).status, why).toBe(404);
      expect(s.log.filter((l) => l.includes(why)), why).toEqual([
        `The token file changed but was not taken (${why}); the token in use is unchanged.`,
      ]);
    }
    expect((await behindToken(s.port, 'ef'.repeat(32))).status).toBe(401);
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
    expect((await readdir(join(home, 'service'))).sort()).toEqual(['paired-origin', 'token']);
  });

  it('the token file\'s look changes with a replacement and not without one', async () => {
    const home = await mkdtemp(join(tmpdir(), 'airlock-proof-look-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    await readOrCreateToken(home);
    const file = tokenFile(home);
    const before = await file.look();
    expect(await file.look()).toBe(before);
    const fresh = await replaceToken(home);
    expect(await file.look()).not.toBe(before);
    expect(await file.read()).toEqual({ token: fresh, tightened: false });
  });
});

describe('the token the service keeps', () => {
  /** A token file in memory that counts how often it is looked at and read. */
  function rig(start = 'a'.repeat(64)) {
    let now = 1_000_000;
    const disk = { token: start, version: 1 };
    const counts = { looks: 0, reads: 0 };
    const file: TokenFile = {
      look: async () => { counts.looks += 1; return `v${disk.version}`; },
      read: async () => { counts.reads += 1; return { token: disk.token, tightened: false }; },
    };
    const log: string[] = [];
    const keeper = keepToken({ token: start, signature: 'v1' }, file, () => now, (l) => log.push(l));
    const replace = (token: string): void => { disk.token = token; disk.version += 1; };
    return { keeper, counts, replace, log, advance: (ms: number) => { now += ms; } };
  }

  it('a flood of tokens, right or wrong, looks at the file at most once a second, and reads it only when it changed', async () => {
    const r = rig();
    r.advance(1_000);
    const flood = await Promise.all(Array.from({ length: 200 }, (_, i) => r.keeper.matches(i % 2 === 0 ? 'a'.repeat(64) : 'b'.repeat(64))));
    expect(flood.filter((ok) => ok)).toHaveLength(100);
    expect(r.counts).toEqual({ looks: 1, reads: 0 });
    r.advance(999);
    for (let i = 0; i < 50; i += 1) await r.keeper.matches('c'.repeat(64));
    expect(r.counts).toEqual({ looks: 1, reads: 0 });
    r.advance(1);
    await r.keeper.matches('c'.repeat(64));
    expect(r.counts).toEqual({ looks: 2, reads: 0 });
  });

  it('five requests with the old token over ten seconds after a replacement: refused from the first one a second later, one look a second at most', async () => {
    const r = rig();
    r.replace('d'.repeat(64));
    const results: boolean[] = [];
    for (let i = 0; i < 5; i += 1) {
      r.advance(i === 0 ? 1_000 : 2_250);
      results.push(await r.keeper.matches('a'.repeat(64)));
    }
    expect(results).toEqual([false, false, false, false, false]);
    expect(r.counts.looks).toBeLessThanOrEqual(5);
    expect(r.counts.reads).toBe(1);
    expect(await r.keeper.matches('d'.repeat(64))).toBe(true);
    expect(r.log).toEqual(['The token file changed; the new token is in use.']);
  });

  it('within the second after the last look the token held is used, so a replacement shows within a second', async () => {
    const r = rig();
    r.advance(1_500);
    expect(await r.keeper.matches('a'.repeat(64))).toBe(true);
    r.replace('d'.repeat(64));
    r.advance(999);
    expect(await r.keeper.matches('a'.repeat(64))).toBe(true);
    r.advance(1);
    expect(await r.keeper.matches('a'.repeat(64))).toBe(false);
    expect(await r.keeper.forProof()).toBe('d'.repeat(64));
  });

  it('a look under way is shared: requests during it wait for it and none starts another', async () => {
    const r = rig();
    r.replace('d'.repeat(64));
    r.advance(1_000);
    const [first, second] = await Promise.all([r.keeper.matches('d'.repeat(64)), r.keeper.matches('d'.repeat(64))]);
    expect([first, second]).toEqual([true, true]);
    expect(r.counts).toEqual({ looks: 1, reads: 1 });
  });

  it('keeps the token it holds when the file cannot be looked at or read, and says so once', async () => {
    let now = 0;
    const log: string[] = [];
    const file: TokenFile = { look: async () => { throw new Error('EACCES'); }, read: async () => ({ refused: 'never' }) };
    const keeper = keepToken({ token: 'a'.repeat(64), signature: 's' }, file, () => now, (l) => log.push(l));
    for (let i = 0; i < 3; i += 1) {
      now += 1_000;
      expect(await keeper.matches('a'.repeat(64))).toBe(true);
    }
    expect(log).toEqual(['The token file could not be checked (EACCES); the token in use is unchanged.']);
  });
});
