import { describe, expect, it } from 'vitest';
import type { ServiceEvent } from '@airlock/shared';
import { NOT_UNDERSTOOD, ServiceClient, ServiceError } from '../../src/client/service';
import { BASE, FakeService, OTHER_TOKEN, TOKEN, json, latestFor, never, prSummary } from '../helpers/fake-service';
import { FakeTimers } from '../helpers/fake-timers';

function setup(token: string | null = TOKEN) {
  const svc = new FakeService();
  const timers = new FakeTimers();
  const client = new ServiceClient(BASE, async () => token, svc.fetch, timers);
  return { svc, client, timers };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function failure(work: Promise<unknown>): Promise<ServiceError> {
  try {
    await work;
  } catch (e) {
    if (e instanceof ServiceError) return e;
    throw e;
  }
  throw new Error('expected a ServiceError');
}

const stage = (name: string, status: 'start' | 'done' | 'error', detail = ''): ServiceEvent => ({
  type: 'stage', stage: name, status, detail,
});

describe('ServiceClient', () => {
  it('hello needs no token, answers offline when the service is down, and refuses a reply it does not understand', async () => {
    const { svc, client } = setup(null);
    expect(await client.hello()).toEqual({ airlock: true, version: '0.1.0', paired: true });
    expect(svc.requests[0]?.headers.has('authorization')).toBe(false);
    svc.down = true;
    expect(await client.hello()).toBe('offline');
    svc.down = false;
    svc.on('GET /hello', () => json({ airlock: 'yes' }));
    expect(await failure(client.hello())).toMatchObject({ kind: 'problem', message: NOT_UNDERSTOOD });
  });

  it('sends the stored token on every other call and JSON bodies with their content type', async () => {
    const { svc, client } = setup();
    await client.pr('acme/widgets', 1);
    await client.start({ repo: 'acme/widgets', number: 1, depth: 'quick' });
    for (const req of svc.requests) expect(req.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    const post = svc.requests[1];
    expect(post?.headers.get('content-type')).toBe('application/json');
    expect(post?.body).toEqual({ repo: 'acme/widgets', number: 1, depth: 'quick' });
    expect(svc.requests[0]?.url.href).toBe(`${BASE}/pr?repo=acme%2Fwidgets&number=1`);
  });

  it('without a stored token is unpaired and makes no request', async () => {
    const { svc, client } = setup(null);
    expect(await failure(client.pr('acme/widgets', 1))).toMatchObject({ kind: 'unpaired' });
    expect(svc.calls).toEqual([]);
  });

  it('maps statuses in one place: down is offline, 401 unpaired, 403 and others a problem in the service words', async () => {
    const { svc, client } = setup();
    svc.down = true;
    expect(await failure(client.pr('acme/widgets', 1))).toMatchObject({ kind: 'offline' });
    svc.down = false;
    svc.token = OTHER_TOKEN;
    expect(await failure(client.status())).toMatchObject({ kind: 'unpaired' });
    svc.token = TOKEN;
    svc.on('GET /pr', () => json({ error: 'That Origin is not the paired extension.' }, 403));
    expect(await failure(client.pr('acme/widgets', 1))).toMatchObject({
      kind: 'problem', message: 'That Origin is not the paired extension.',
    });
    svc.on('POST /reviews', () => json({ error: 'Two reviews are already running. Wait for one to finish.' }, 429));
    expect(await failure(client.start({ repo: 'acme/widgets', number: 1 }))).toMatchObject({
      kind: 'problem', message: 'Two reviews are already running. Wait for one to finish.',
    });
    svc.on('GET /status', () => new Response('<h1>Bad gateway</h1>', { status: 502 }));
    expect(await failure(client.status())).toMatchObject({ kind: 'problem', message: NOT_UNDERSTOOD });
  });

  it('a reply that does not match its schema is a problem, never returned', async () => {
    const { svc, client } = setup();
    svc.on('GET /pr', () => json({ ...prSummary(), headSha: 'not a sha' }));
    expect(await failure(client.pr('acme/widgets', 1))).toMatchObject({ kind: 'problem', message: NOT_UNDERSTOOD });
    svc.on('GET /pr', () => new Response('{"repo":', { status: 200 }));
    expect(await failure(client.pr('acme/widgets', 1))).toMatchObject({ kind: 'problem', message: NOT_UNDERSTOOD });
    svc.on('GET /reviews/running', () => json({ runId: '../../etc' }));
    expect(await failure(client.running('acme/widgets', 1))).toMatchObject({ kind: 'problem', message: NOT_UNDERSTOOD });
  });

  it('running and latest answer null on 404', async () => {
    const { svc, client } = setup();
    expect(await client.running('acme/widgets', 1)).toBeNull();
    expect(await client.latest('acme/widgets', 1)).toBeNull();
    svc.startRun('acme/widgets', 1, 'run_00000000000a');
    const latest = latestFor(prSummary());
    svc.latest.set('acme/widgets#1', latest);
    expect(await client.running('acme/widgets', 1)).toBe('run_00000000000a');
    expect(await client.latest('acme/widgets', 1)).toEqual(latest);
    expect(svc.requests.at(-1)?.url.href).toBe(`${BASE}/reviews/latest?repo=acme%2Fwidgets&number=1`);
  });

  it('pair sends the given token, not the stored one, and returns the service words when refused', async () => {
    const { svc, client } = setup(null);
    expect(await client.pair(TOKEN)).toEqual({ paired: true, extension: 'new' });
    expect(svc.requests[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(svc.requests[0]?.body).toBeUndefined();
    expect(await client.pair(OTHER_TOKEN)).toEqual({ error: 'Airlock needs the pairing token. Run "airlock-service token".' });
    svc.on('POST /pair', () => json({ error: 'Airlock is already paired with another copy of the extension.' }, 409));
    expect(await client.pair(TOKEN)).toEqual({ error: 'Airlock is already paired with another copy of the extension.' });
    svc.down = true;
    expect(await failure(client.pair(TOKEN))).toMatchObject({ kind: 'offline' });
  });

  it('dismiss and restore post their bodies and parse the replies', async () => {
    const { svc, client } = setup();
    const dismissal = {
      fingerprint: '0123456789abcdef', findingId: 'c_01234567', reviewId: 'r_0000000001', reason: 'not-now', text: '',
      at: '2026-11-11T10:00:00Z', learned: null,
    };
    svc.on('POST /dismissals', () => json(dismissal));
    svc.on('POST /dismissals/restore', () => json({ restored: true, note: null }));
    const body = { repo: 'acme/widgets', number: 1, reviewId: 'r_0000000001', findingId: 'c_01234567', reason: 'not-now' as const, text: '' };
    expect(await client.dismiss(body)).toEqual(dismissal);
    expect(svc.requests.at(-1)?.body).toEqual(body);
    expect(await client.restore({ repo: 'acme/widgets', number: 1, fingerprint: '0123456789abcdef' })).toEqual({ restored: true, note: null });
    expect(svc.calls).toEqual(['POST /dismissals', 'POST /dismissals/restore']);
  });

  it('gives up on hello after 5 seconds and on other calls after 60, through the given timers', async () => {
    const { svc, client, timers } = setup();
    svc.on('GET /hello', never);
    svc.on('GET /pr', never);
    const hello = client.hello();
    const pr = client.pr('acme/widgets', 1);
    await tick();
    expect(timers.delays().sort()).toEqual([5_000, 60_000]);
    timers.fire();
    expect(await hello).toBe('offline');
    expect(await failure(pr)).toMatchObject({ kind: 'offline' });
  });

  it('clears its timeout once a reply has been read', async () => {
    const { client, timers } = setup();
    await client.hello();
    await client.pr('acme/widgets', 1);
    expect(timers.delays()).toEqual([]);
  });

  it('aborts a call when the caller signal is aborted', async () => {
    const { svc, client } = setup();
    svc.on('GET /pr', never);
    svc.on('GET /reviews/running', never);
    svc.on('GET /reviews/latest', never);
    const abort = new AbortController();
    const calls = [
      client.hello(abort.signal), client.pr('acme/widgets', 1, abort.signal),
      client.running('acme/widgets', 1, abort.signal), client.latest('acme/widgets', 1, abort.signal),
    ];
    await tick();
    abort.abort();
    await Promise.allSettled(calls);
    expect(svc.requests.map((r) => r.signal?.aborted)).toEqual([true, true, true, true]);
  });

  describe('events', () => {
    it('delivers every event from the start and ends after done', async () => {
      const { svc, client } = setup();
      const run = svc.startRun('acme/widgets', 1, 'run_00000000000a');
      run.emit(stage('intake', 'start'));
      const seen: ServiceEvent[] = [];
      const ended = client.events('run_00000000000a', (e) => {
        seen.push(e);
        if (seen.length === 1) run.emit(stage('intake', 'done'));
        if (seen.length === 2) run.emit({ type: 'done', document: latestFor(prSummary()).document });
      }, new AbortController().signal);
      expect(await ended).toBe('ended');
      expect(seen.map((e) => e.type)).toEqual(['stage', 'stage', 'done']);
      expect(svc.requests[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    });

    it('ends after a failed event even when the stream stays open', async () => {
      const { svc, client } = setup();
      svc.on('GET /reviews/:runId/events', () => new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"type":"failed","message":"gh is not signed in."}\n\n'));
        },
      })));
      const seen: ServiceEvent[] = [];
      expect(await client.events('run_00000000000a', (e) => seen.push(e), new AbortController().signal)).toBe('ended');
      expect(seen).toEqual([{ type: 'failed', message: 'gh is not signed in.' }]);
    });

    it('is lost when the stream closes early or carries an event it does not understand', async () => {
      const { svc, client } = setup();
      const run = svc.startRun('acme/widgets', 1, 'run_00000000000a');
      run.emit(stage('intake', 'start'));
      const closed = client.events('run_00000000000a', () => queueMicrotask(() => run.close()), new AbortController().signal);
      expect(await closed).toBe('lost');

      svc.on('GET /reviews/:runId/events', () => new Response('data: {"type":"stage","stage":"intake","status":"start","detail":""}\n\n'));
      expect(await client.events('run_00000000000a', () => {}, new AbortController().signal)).toBe('lost');

      const odd: ServiceEvent[] = [];
      svc.on('GET /reviews/:runId/events', () => new Response(
        'data: {"type":"stage","stage":"intake","status":"start","detail":""}\n\ndata: {"type":"verdict","html":"<b>"}\n\n',
      ));
      expect(await client.events('run_00000000000a', (e) => odd.push(e), new AbortController().signal)).toBe('lost');
      expect(odd).toHaveLength(1);

      svc.on('GET /reviews/:runId/events', () => new Response('data: {not json\n\n'));
      expect(await client.events('run_00000000000a', () => {}, new AbortController().signal)).toBe('lost');
    });

    it('is offline when the request or the read fails at the network level', async () => {
      const { svc, client } = setup();
      const run = svc.startRun('acme/widgets', 1, 'run_00000000000a');
      run.emit(stage('intake', 'start'));
      const broken = client.events('run_00000000000a', () => queueMicrotask(() => run.lose()), new AbortController().signal);
      expect(await broken).toBe('offline');
      svc.down = true;
      expect(await client.events('run_00000000000a', () => {}, new AbortController().signal)).toBe('offline');
    });

    it('a listener that throws ends the stream, and its error is passed on rather than read as offline', async () => {
      const { svc, client, timers } = setup();
      const run = svc.startRun('acme/widgets', 1, 'run_00000000000a');
      run.emit(stage('intake', 'start'));
      const bug = new TypeError('Cannot read properties of undefined');
      await expect(client.events('run_00000000000a', () => { throw bug; }, new AbortController().signal)).rejects.toBe(bug);
      expect(run.listeners.size).toBe(0);
      expect(timers.delays()).toEqual([]);
    });

    it('stops when its signal is aborted', async () => {
      const { svc, client } = setup();
      svc.startRun('acme/widgets', 1, 'run_00000000000a');
      const abort = new AbortController();
      const result = client.events('run_00000000000a', () => {}, abort.signal);
      await tick();
      abort.abort();
      expect(await result).toBe('lost');
      expect(svc.runs.get('run_00000000000a')?.listeners.size).toBe(0);
    });

    it('is lost after 45 seconds with no bytes, counted by the given timers and reset by every chunk', async () => {
      const { svc, client, timers } = setup();
      const run = svc.startRun('acme/widgets', 1, 'run_00000000000a');
      const seen: ServiceEvent[] = [];
      const result = client.events('run_00000000000a', (e) => seen.push(e), new AbortController().signal);
      await tick();
      expect(timers.delays()).toEqual([45_000]);
      const armed = [...timers.pending.keys()];
      run.emit(stage('intake', 'start'));
      await tick();
      expect(seen).toHaveLength(1);
      expect(timers.delays()).toEqual([45_000]);
      expect([...timers.pending.keys()]).not.toEqual(armed);
      timers.fire();
      expect(await result).toBe('lost');
      expect(run.listeners.size).toBe(0);
      expect(timers.delays()).toEqual([]);
    });

    it('leaves no timer behind once the stream has ended', async () => {
      const { svc, client, timers } = setup();
      const run = svc.startRun('acme/widgets', 1, 'run_00000000000a');
      run.emit({ type: 'failed', message: 'Stopped.' });
      expect(await client.events('run_00000000000a', () => {}, new AbortController().signal)).toBe('ended');
      expect(timers.delays()).toEqual([]);
    });

    it('throws the mapped error for a refused stream', async () => {
      const { svc, client } = setup();
      svc.token = OTHER_TOKEN;
      expect(await failure(client.events('run_00000000000a', () => {}, new AbortController().signal))).toMatchObject({ kind: 'unpaired' });
      svc.token = TOKEN;
      expect(await failure(client.events('run_00000000000a', () => {}, new AbortController().signal))).toMatchObject({
        kind: 'problem', message: 'No such review run.',
      });
    });
  });
});
