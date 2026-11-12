import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NOT_PROVED, helloProof, newNonce } from '../../src/client/proof';
import { ServiceClient, ServiceError } from '../../src/client/service';
import { BASE, FakeService, OTHER_TOKEN, TOKEN, json } from '../helpers/fake-service';
import { FakeTimers } from '../helpers/fake-timers';

function setup(stored: { token: string | null } = { token: TOKEN }) {
  const svc = new FakeService();
  const client = new ServiceClient(BASE, async () => stored.token, svc.fetch, new FakeTimers());
  return { svc, client, stored };
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
const NOT_PROVED_WORDS = "Something else is answering on Airlock's port. The token was not sent.";

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

  it('says the sentence the brief gives', () => {
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
