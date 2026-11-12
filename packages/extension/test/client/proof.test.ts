import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NOT_PROVED, helloProof, newNonce } from '../../src/client/proof';
import { ServiceClient, ServiceError } from '../../src/client/service';
import { BASE, FakeService, OTHER_TOKEN, TOKEN, held, json, type Request } from '../helpers/fake-service';
import { FakeTimers } from '../helpers/fake-timers';

/** `clock.now` is the client's monotonic clock, moved only by the test. */
function setup(stored: { token: string | null } = { token: TOKEN }) {
  const svc = new FakeService();
  const clock = { now: 0 };
  const client = new ServiceClient(BASE, async () => stored.token, svc.fetch, new FakeTimers(), () => clock.now);
  return { svc, client, stored, clock };
}

/** A hello as the service gives it, with the proof for the request's nonce made with `key`. */
function helloWith(req: Request, key: string): Response {
  const nonce = req.url.searchParams.get('nonce') ?? '';
  return json({ airlock: true, version: '0.1.0', paired: true, proof: createHmac('sha256', key).update(`airlock-hello:${nonce}`).digest('hex') });
}

async function failure(work: Promise<unknown>): Promise<ServiceError> {
  try {
    await work;
  } catch (e) {
    if (e instanceof ServiceError) return e;
    throw e;
  }
  throw new Error('expected a ServiceError');
}

const withToken = (svc: FakeService) => svc.requests.filter((r) => r.headers.has('authorization'));
const NOT_PROVED_WORDS = "The service could not show that it holds this panel's token, so the token was not sent. "
  + "If you replaced the token, paste the new one. If you did not, another program may be answering on Airlock's port.";

describe('the proof, in the panel', () => {
  it('is the service\'s HMAC-SHA256 of "airlock-hello:<nonce>" keyed with the token, in lower-case hex', async () => {
    const nonce = '0123456789abcdef'.repeat(2);
    expect(await helloProof(TOKEN, nonce)).toBe(createHmac('sha256', TOKEN).update(`airlock-hello:${nonce}`).digest('hex'));
  });

  it('asks with 16 random bytes as 32 hex characters, new each time', () => {
    const nonces = Array.from({ length: 20 }, () => newNonce());
    for (const n of nonces) expect(n).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(nonces).size).toBe(20);
  });

  it('says the sentence the fix brief gives', () => {
    expect(NOT_PROVED).toBe(NOT_PROVED_WORDS);
  });
});

describe('the client and the proof', () => {
  it('the client sends no Authorization header until a proof has matched', async () => {
    const { svc, client } = setup();
    await client.pr('acme/widgets', 1);
    expect(svc.calls).toEqual(['GET /hello', 'GET /pr']);
    const [hello, pr] = svc.requests;
    expect(hello?.headers.has('authorization')).toBe(false);
    expect(hello?.url.searchParams.get('nonce')).toMatch(/^[0-9a-f]{32}$/);
    expect(pr?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    // Once proved, the next calls go straight to the service.
    await client.latest('acme/widgets', 1);
    await client.start({ repo: 'acme/widgets', number: 1 });
    expect(svc.calls).toEqual(['GET /hello', 'GET /pr', 'GET /reviews/latest', 'POST /reviews']);
  });

  it('a wrong or missing proof is refused with the sentence, and no call ever carries the token', async () => {
    for (const key of [OTHER_TOKEN, null]) {
      const { svc, client } = setup();
      svc.proofKey = key;
      const run = svc.startRun('acme/widgets', 1, 'run_00000000000a');
      run.emit({ type: 'stage', stage: 'intake', status: 'start', detail: '' });
      const calls: Array<() => Promise<unknown>> = [
        () => client.pr('acme/widgets', 1), () => client.status(), () => client.running('acme/widgets', 1),
        () => client.latest('acme/widgets', 1), () => client.start({ repo: 'acme/widgets', number: 1 }),
        () => client.dismiss({ repo: 'acme/widgets', number: 1, reviewId: 'r_0000000001', findingId: 'c_01234567', reason: 'not-now', text: '' }),
        () => client.restore({ repo: 'acme/widgets', number: 1, fingerprint: '0123456789abcdef' }),
        () => client.events('run_00000000000a', () => undefined, new AbortController().signal),
        () => client.hello(),
      ];
      for (const call of calls) expect(await failure(call())).toMatchObject({ kind: 'unproven', message: NOT_PROVED_WORDS });
      expect(withToken(svc)).toEqual([]);
      expect(new Set(svc.calls)).toEqual(new Set(['GET /hello']));
      // A new nonce for every ask.
      const nonces = svc.requests.map((r) => r.url.searchParams.get('nonce'));
      expect(new Set(nonces).size).toBe(nonces.length);
    }
  });

  it('a proof that is not 64 hexadecimal characters is a failed proof, not a reply it does not understand', async () => {
    for (const proof of ['', 'xyz', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      const { svc, client } = setup();
      svc.on('GET /hello', () => json({ airlock: true, version: '0.1.0', paired: true, proof }));
      expect(await failure(client.pr('acme/widgets', 1)), proof).toMatchObject({ kind: 'unproven', message: NOT_PROVED_WORDS });
      expect(await failure(client.hello()), proof).toMatchObject({ kind: 'unproven', message: NOT_PROVED_WORDS });
      expect(withToken(svc)).toEqual([]);
    }
  });

  it('a burst of requests within a second shares one proof, and any request after that second proves again', async () => {
    const { svc, client, clock } = setup();
    await client.pr('acme/widgets', 1);
    clock.now = 999;
    await client.latest('acme/widgets', 1);
    await client.running('acme/widgets', 1);
    expect(svc.calls).toEqual(['GET /hello', 'GET /pr', 'GET /reviews/latest', 'GET /reviews/running']);
    clock.now = 1_000;
    await client.latest('acme/widgets', 1);
    expect(svc.calls.slice(-2)).toEqual(['GET /hello', 'GET /reviews/latest']);
  });

  it('after a matched proof the service stops and another listener takes the port: the next action a second later sends no Authorization header', async () => {
    const { svc, client, clock } = setup();
    await client.pr('acme/widgets', 1);
    const sent = withToken(svc).length;
    // Nothing failed in between: no network error, no 401, no failed check.
    svc.proofKey = OTHER_TOKEN;
    clock.now = 1_001;
    for (const call of [
      () => client.start({ repo: 'acme/widgets', number: 1 }),
      () => client.dismiss({ repo: 'acme/widgets', number: 1, reviewId: 'r_0000000001', findingId: 'c_01234567', reason: 'not-now', text: '' }),
    ]) {
      expect(await failure(call())).toMatchObject({ kind: 'unproven', message: NOT_PROVED_WORDS });
    }
    expect(withToken(svc)).toHaveLength(sent);
    expect(svc.calls).not.toContain('POST /reviews');
  });

  it('a late success from an older check does not re-arm the proof after a newer check failed', async () => {
    const { svc, client } = setup();
    const late = held();
    let asked = 0;
    svc.on('GET /hello', (req) => {
      asked += 1;
      // The first check is held back and will prove the token; the second is answered at once with a wrong proof.
      if (asked === 1) return late.reply().then(() => helloWith(req, TOKEN));
      return helloWith(req, OTHER_TOKEN);
    });
    const older = client.hello();
    await new Promise((r) => setTimeout(r, 0));
    expect((await failure(client.hello())).kind).toBe('unproven');
    late.release(new Response());
    expect(await older).toMatchObject({ airlock: true });
    // The older success counts for nothing: the next call asks again, and that answer cannot prove the token.
    expect((await failure(client.pr('acme/widgets', 1))).kind).toBe('unproven');
    expect(asked).toBe(3);
    expect(withToken(svc)).toEqual([]);
  });

  it('pairing proves the pasted token even when it is the stored one and was proved a moment ago', async () => {
    const { svc, client } = setup();
    await client.pr('acme/widgets', 1);
    svc.proofKey = OTHER_TOKEN;
    expect(await client.pair(TOKEN)).toEqual({ error: NOT_PROVED_WORDS });
    expect(svc.calls).not.toContain('POST /pair');
  });

  it('every attach to a review\'s event stream proves first, after any kind of cut', async () => {
    const { svc, client } = setup();
    const run = svc.startRun('acme/widgets', 1, 'run_00000000000a');
    run.emit({ type: 'stage', stage: 'intake', status: 'start', detail: '' });
    // Closed cleanly without a last event: 'lost', not a network failure.
    expect(await client.events('run_00000000000a', () => queueMicrotask(() => run.close()), new AbortController().signal)).toBe('lost');
    svc.proofKey = OTHER_TOKEN;
    const before = withToken(svc).length;
    expect((await failure(client.events('run_00000000000a', () => undefined, new AbortController().signal))).kind).toBe('unproven');
    expect(withToken(svc)).toHaveLength(before);
    expect(svc.calls).toEqual(['GET /hello', 'GET /reviews/:runId/events', 'GET /hello']);
  });

  it('the unit fake checks the nonce as the real service does', async () => {
    const { svc } = setup();
    const status = async (query: string) => (await svc.fetch(`${BASE}/hello${query}`)).status;
    expect(await status('')).toBe(200);
    expect(await status(`?nonce=${'0'.repeat(32)}`)).toBe(200);
    for (const query of ['?nonce=', '?nonce=abc', `?nonce=${'A'.repeat(32)}`, `?nonce=${'0'.repeat(32)}&nonce=${'0'.repeat(32)}`]) {
      expect(await status(query), query).toBe(400);
    }
  });

  it('a hello that is not understood sends nothing either', async () => {
    const { svc, client } = setup();
    svc.on('GET /hello', () => json({ hello: 'world' }));
    expect((await failure(client.pr('acme/widgets', 1))).kind).toBe('problem');
    expect(withToken(svc)).toEqual([]);
  });

  it('asks again after a network failure and after a 401, and a wrong proof then keeps the token in the panel', async () => {
    const { svc, client } = setup();
    await client.pr('acme/widgets', 1);
    svc.down = true;
    expect((await failure(client.pr('acme/widgets', 1))).kind).toBe('offline');
    svc.down = false;
    svc.proofKey = OTHER_TOKEN;
    const before = withToken(svc).length;
    expect((await failure(client.pr('acme/widgets', 1))).kind).toBe('unproven');
    expect(withToken(svc)).toHaveLength(before);

    svc.proofKey = undefined;
    await client.pr('acme/widgets', 1);
    // The service stops accepting the token: a 401, then a fresh proof before the token is sent again.
    svc.on('GET /pr', () => json({ error: 'Airlock needs its pairing token.' }, 401));
    expect((await failure(client.pr('acme/widgets', 1))).kind).toBe('unpaired');
    svc.proofKey = OTHER_TOKEN;
    const after = withToken(svc).length;
    expect((await failure(client.latest('acme/widgets', 1))).kind).toBe('unproven');
    expect(withToken(svc)).toHaveLength(after);
  });

  it('a stream cut at the network level is proved again before the next attach', async () => {
    const { svc, client } = setup();
    const run = svc.startRun('acme/widgets', 1, 'run_00000000000a');
    run.emit({ type: 'stage', stage: 'intake', status: 'start', detail: '' });
    const cut = client.events('run_00000000000a', () => queueMicrotask(() => run.lose()), new AbortController().signal);
    expect(await cut).toBe('offline');
    svc.proofKey = OTHER_TOKEN;
    const before = withToken(svc).length;
    expect((await failure(client.events('run_00000000000a', () => undefined, new AbortController().signal))).kind).toBe('unproven');
    expect(withToken(svc)).toHaveLength(before);
  });

  it('hello sends a fresh nonce on every check while a token is stored, and none when there is none', async () => {
    const stored = { token: null as string | null };
    const { svc, client } = setup(stored);
    expect(await client.hello()).toEqual({ airlock: true, version: '0.1.0', paired: true });
    expect(svc.requests[0]?.url.search).toBe('');
    stored.token = TOKEN;
    await client.hello();
    await client.hello();
    const nonces = svc.requests.slice(1).map((r) => r.url.searchParams.get('nonce'));
    expect(nonces).toHaveLength(2);
    for (const n of nonces) expect(n).toMatch(/^[0-9a-f]{32}$/);
    expect(nonces[0]).not.toBe(nonces[1]);
    // A matched check counts as the proof: the next call sends the token without asking again.
    await client.pr('acme/widgets', 1);
    expect(svc.calls.slice(-2)).toEqual(['GET /hello', 'GET /pr']);
    // A check that fails takes the proof back.
    svc.proofKey = OTHER_TOKEN;
    expect((await failure(client.hello())).kind).toBe('unproven');
    svc.proofKey = undefined;
    svc.token = OTHER_TOKEN;
    expect((await failure(client.pr('acme/widgets', 1))).kind).toBe('unproven');
    expect(svc.calls.slice(-2)).toEqual(['GET /hello', 'GET /hello']);
  });

  it('pairing checks the pasted token against the proof before calling pair', async () => {
    const { svc, client } = setup({ token: null });
    expect(await client.pair(OTHER_TOKEN)).toEqual({ error: NOT_PROVED_WORDS });
    expect(svc.calls).toEqual(['GET /hello']);
    expect(withToken(svc)).toEqual([]);

    svc.proofKey = null;
    expect(await client.pair(TOKEN)).toEqual({ error: NOT_PROVED_WORDS });
    expect(withToken(svc)).toEqual([]);

    svc.proofKey = undefined;
    expect(await client.pair(TOKEN)).toEqual({ paired: true, extension: 'new' });
    expect(svc.calls.slice(-2)).toEqual(['GET /hello', 'POST /pair']);
    expect(withToken(svc).map((r) => r.headers.get('authorization'))).toEqual([`Bearer ${TOKEN}`]);
  });
});
