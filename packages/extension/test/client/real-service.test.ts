// The panel's real client against the service's real server. It lives with the extension's tests, which are typed with
// bundler resolution and so can import the service's source by path: a test-only import, so neither package depends on
// the other when it runs. It runs in Node, as the service does, with a fetch that adds the Origin Chrome adds.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveReview, type EngineDeps, type runReview } from '@airlock/engine';
import {
  candidate, minimalDocument, type Finding, type ReviewDocument, type ReviewEvent, type ServiceEvent,
} from '@airlock/shared';
import { NOT_PROVED } from '../../src/client/proof';
import { ServiceClient, ServiceError } from '../../src/client/service';
import { createServer, type Service } from '../../../service/src/server';
import { pairedOrigin, readOrCreateToken, replaceToken } from '../../../service/src/config';

const REPO = 'acme/widgets';
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const OTHER_EXTENSION = `chrome-extension://${'b'.repeat(32)}`;

const pull = JSON.stringify({
  title: 'Add totals', body: 'Adds totals.', additions: 40, deletions: 10, changed_files: 3,
  html_url: `https://github.com/${REPO}/pull/7`, user: { login: 'alice' },
  base: { ref: 'main', sha: 'a'.repeat(40), repo: { full_name: REPO } },
  head: { ref: 'feature/totals', sha: 'b'.repeat(40), repo: { full_name: REPO } },
});

const finding: Finding = {
  ...candidate(), id: 'c_01234567', anchor: { status: 'in-diff', startLine: 12, endLine: 12 },
  fingerprint: '0123456789abcdef', checked: '', bucket: 'top', rank: 1, status: 'new',
};
function reviewOf(number: number): ReviewDocument {
  const base = minimalDocument();
  return { ...base, id: 'r_0123456789', pr: { ...base.pr, repo: REPO, number }, findings: [finding] };
}

interface Launched { emit: (e: ReviewEvent) => void; finish: (doc: ReviewDocument) => Promise<void> }

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * What Chrome does for an extension page: an Origin header on a POST or DELETE (and none on a GET). `origin` is the
 * extension the request comes from.
 */
const chromeFetch = (origin: string): typeof fetch => (input, init) => {
  const method = init?.method ?? 'GET';
  const headers = new Headers(init?.headers);
  if (method === 'POST' || method === 'DELETE') headers.set('Origin', origin);
  return fetch(input, { ...init, headers });
};

/** Records every request a fetch makes: the address and the Authorization header. */
function recorded(inner: typeof fetch): { fetch: typeof fetch; seen: Array<{ url: string; auth: string | null }> } {
  const seen: Array<{ url: string; auth: string | null }> = [];
  return {
    seen,
    fetch: (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return inner(input, init);
    },
  };
}

async function startService(
  now: () => Date = () => new Date(),
): Promise<{ service: Service; base: string; token: string; home: string; launched: Launched[] }> {
  const home = await mkdtemp(join(tmpdir(), 'airlock-panel-client-'));
  const saved = process.env['AIRLOCK_HOME'];
  process.env['AIRLOCK_HOME'] = home;
  const launched: Launched[] = [];
  const review: typeof runReview = (_req, given, onEvent) => new Promise<ReviewDocument>((resolve, reject) => {
    given.signal?.addEventListener('abort', () => reject(new Error('The review was stopped.')), { once: true });
    const emit = (e: ReviewEvent): void => onEvent?.(e);
    launched.push({ emit, finish: async (doc) => { await saveReview(doc); emit({ type: 'done', document: doc }); resolve(doc); } });
  });
  const answers = new Map([
    [`gh api repos/${REPO}/pulls/7`, { stdout: pull, stderr: '', code: 0 }],
    [`gh api repos/${REPO}/pulls/8`, { stdout: pull.replaceAll('/pull/7', '/pull/8'), stderr: '', code: 0 }],
    ['gh api user --jq .login', { stdout: 'bob\n', stderr: '', code: 0 }],
  ]);
  const engine: EngineDeps = {
    exec: async (cmd, args) => {
      const answer = answers.get([cmd, ...args].join(' '));
      if (answer === undefined) return { stdout: '', stderr: 'gh: Not Found (HTTP 404)', code: 1 };
      return answer;
    },
    runner: { run: () => { throw new Error('no model is asked in these tests'); } },
    now: () => new Date(),
  };
  const service = createServer({
    config: { port: 0, home, packsDir: join(home, 'packs'), version: '1.2.3' }, engine, review, now, log: () => undefined,
  });
  const { port } = await service.listen();
  cleanups.push(async () => {
    await service.close();
    if (saved === undefined) delete process.env['AIRLOCK_HOME'];
    else process.env['AIRLOCK_HOME'] = saved;
    await rm(home, { recursive: true, force: true });
  });
  return { service, base: `http://127.0.0.1:${port}`, token: await readOrCreateToken(home), home, launched };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
  if (!check()) throw new Error(`waited for ${what}`);
}

/** The ServiceError a call ends with. */
async function refusal(call: Promise<unknown>): Promise<{ kind: string; message: string }> {
  try {
    await call;
  } catch (e) {
    if (e instanceof ServiceError) return { kind: e.kind, message: e.message };
    throw e;
  }
  throw new Error('the call was not refused');
}

describe('the panel\'s client and the real service', () => {
  it('pairs, reads the pull request, starts a review, follows it to done, then reads, dismisses and restores', async () => {
    const s = await startService();
    let stored: string | null = null;
    const client = new ServiceClient(s.base, async () => stored, chromeFetch(ORIGIN));

    expect(await client.hello()).toEqual({ airlock: true, version: '1.2.3', paired: false });
    expect(await client.pair(s.token)).toEqual({ paired: true, extension: 'new' });
    stored = s.token;
    expect(await client.hello()).toMatchObject({ paired: true });

    const pr = await client.pr(REPO, 7);
    expect(pr).toMatchObject({ repo: REPO, number: 7, title: 'Add totals', author: 'alice', viewer: 'bob', isOwn: false });
    expect(await client.running(REPO, 7)).toBeNull();
    expect(await client.latest(REPO, 7)).toBeNull();

    const { runId, reused } = await client.start({ repo: REPO, number: 7, depth: 'quick' });
    expect(reused).toBe(false);
    expect(await client.running(REPO, 7)).toBe(runId);
    const seen: ServiceEvent[] = [];
    const following = client.events(runId, (e) => seen.push(e), new AbortController().signal);
    await until(() => s.launched.length === 1, 'the review launched');
    s.launched[0]!.emit({ type: 'stage', stage: 'intake', status: 'start', detail: '' });
    await s.launched[0]!.finish(reviewOf(7));
    expect(await following).toBe('ended');
    expect(seen.map((e) => e.type)).toEqual(['stage', 'done']);

    const latest = await client.latest(REPO, 7);
    expect(latest?.document.id).toBe('r_0123456789');
    expect(latest?.dismissals).toEqual([]);

    const dismissal = await client.dismiss({
      repo: REPO, number: 7, reviewId: 'r_0123456789', findingId: finding.id, reason: 'not-now', text: '',
    });
    expect(dismissal).toMatchObject({ fingerprint: finding.fingerprint, reason: 'not-now', learned: null });
    expect((await client.latest(REPO, 7))?.dismissals).toHaveLength(1);
    expect(await client.restore({ repo: REPO, number: 7, fingerprint: finding.fingerprint })).toEqual({ restored: true, note: null });
    expect((await client.latest(REPO, 7))?.dismissals).toEqual([]);
  });

  it('the real service proves the token to the real client before it is sent, and a token it does not hold is never sent', async () => {
    const s = await startService();
    const paired = recorded(chromeFetch(ORIGIN));
    let stored: string | null = null;
    const client = new ServiceClient(s.base, async () => stored, paired.fetch);
    expect(await client.pair(s.token)).toEqual({ paired: true, extension: 'new' });
    stored = s.token;
    await client.pr(REPO, 7);
    expect(paired.seen.map((r) => [new URL(r.url).pathname, r.auth])).toEqual([
      ['/hello', null], ['/pair', `Bearer ${s.token}`], ['/pr', `Bearer ${s.token}`],
    ]);
    expect(new URL(paired.seen[0]!.url).searchParams.get('nonce')).toMatch(/^[0-9a-f]{32}$/);
    // The periodic check asks with a new nonce each time, and the real proof matches.
    expect(await client.hello()).toMatchObject({ airlock: true, paired: true, proof: expect.stringMatching(/^[0-9a-f]{64}$/) });

    const other = recorded(chromeFetch(ORIGIN));
    const pasting = new ServiceClient(s.base, async () => null, other.fetch);
    expect(await pasting.pair('e'.repeat(64))).toEqual({ error: NOT_PROVED });
    const holding = new ServiceClient(s.base, async () => 'e'.repeat(64), other.fetch);
    expect(await refusal(holding.start({ repo: REPO, number: 7 }))).toEqual({ kind: 'unproven', message: NOT_PROVED });
    expect(await refusal(holding.hello())).toEqual({ kind: 'unproven', message: NOT_PROVED });
    expect(other.seen.map((r) => new URL(r.url).pathname)).toEqual(['/hello', '/hello', '/hello']);
    expect(other.seen.every((r) => r.auth === null)).toBe(true);
  });

  it('after the token is replaced, the old one is neither proved nor accepted, and the new one pairs again', async () => {
    let at = Date.parse('2026-11-11T09:00:00.000Z');
    const s = await startService(() => new Date(at));
    let stored: string | null = s.token;
    const client = new ServiceClient(s.base, async () => stored, chromeFetch(ORIGIN));
    expect(await client.pair(s.token)).toEqual({ paired: true, extension: 'new' });
    await client.pr(REPO, 7);

    const fresh = await replaceToken(s.home);
    at += 1_000;
    // The periodic check: the service now proves the new token, so the old one is not sent again.
    expect(await refusal(client.hello())).toEqual({ kind: 'unproven', message: NOT_PROVED });
    expect(await refusal(client.pr(REPO, 7))).toEqual({ kind: 'unproven', message: NOT_PROVED });
    // The Pair screen, with the new token: the paired origin was kept.
    expect(await client.pair(fresh)).toEqual({ paired: true, extension: 'same' });
    stored = fresh;
    expect((await client.pr(REPO, 7)).number).toBe(7);
    expect(await pairedOrigin(s.home)).toBe(ORIGIN);
  });

  it('maps each refusal to what the panel shows: Pair, a notice in the service\'s words, or Not running', async () => {
    const s = await startService();
    const client = new ServiceClient(s.base, async () => s.token, chromeFetch(ORIGIN));
    expect(await client.pair(s.token)).toEqual({ paired: true, extension: 'new' });

    // A token the service does not use: it cannot prove it, so the token is never sent. None stored: the Pair screen.
    const wrong = new ServiceClient(s.base, async () => 'f'.repeat(64), chromeFetch(ORIGIN));
    expect(await refusal(wrong.pr(REPO, 7))).toEqual({ kind: 'unproven', message: NOT_PROVED });
    const none = new ServiceClient(s.base, async () => null, chromeFetch(ORIGIN));
    expect((await refusal(none.latest(REPO, 7))).kind).toBe('unpaired');

    // Another copy of the extension: its pairing is refused in the service's words, and so is its review.
    const other = new ServiceClient(s.base, async () => s.token, chromeFetch(OTHER_EXTENSION));
    const elsewhere = await other.pair(s.token);
    expect(elsewhere).toEqual({ error: expect.stringContaining('already paired with another copy of the extension') });
    expect(await refusal(other.start({ repo: REPO, number: 7 }))).toEqual({
      kind: 'problem', message: 'Airlock does not accept requests from this page.',
    });

    // GitHub has no such pull request: a problem in the service's words.
    expect(await refusal(client.pr(REPO, 9))).toEqual({ kind: 'problem', message: 'GitHub has no such pull request, or you cannot see it.' });

    // Two reviews running: the third start is refused with the service's sentence.
    await client.start({ repo: REPO, number: 7 });
    await client.start({ repo: REPO, number: 8 });
    expect(await refusal(client.start({ repo: REPO, number: 9 }))).toEqual({
      kind: 'problem', message: 'Two reviews are already running. Wait for one to finish.',
    });

    // A run the service does not have.
    const gone = await client.events('run_000000000000', () => undefined, new AbortController().signal).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(ServiceError);
    expect((gone as ServiceError).kind).toBe('problem');

    // The service stops: Not running.
    await s.service.close();
    expect(await client.hello()).toBe('offline');
    expect((await refusal(client.pr(REPO, 7))).kind).toBe('offline');
  });
});
