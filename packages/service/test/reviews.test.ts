import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { saveReview, type EngineDeps, type ReviewRequest, type runReview } from '@airlock/engine';
import {
  ApiErrorSchema, LatestReplySchema, MESSAGE_MAX, minimalDocument, PrSummarySchema, ServiceEventSchema, ServiceStatusSchema,
  StartReviewReplySchema, type Dismissal, type ReviewDocument, type ReviewEvent,
} from '@airlock/shared';
import { pair, readOrCreateToken } from '../src/config.js';
import { CLOSE_WAIT_MS, FINISHED_KEEP_MS } from '../src/runs.js';
import { createServer, type ServiceDeps } from '../src/server.js';
import { RUN_GONE, runStream } from '../src/sse.js';
import { FakeClock, openStream, send, until, type Reply, type Stream } from './helpers.js';

type ExecResult = { stdout: string; stderr: string; code: number };

interface Launched {
  req: ReviewRequest;
  /** The signal the service gave the review. */
  signal: AbortSignal | undefined;
  emit: (e: ReviewEvent) => void;
  /** Saves the document through the engine's store, sends done, then resolves: what the engine does. */
  finish: (doc: ReviewDocument) => Promise<void>;
  reject: (e: unknown) => void;
}

const REPO = 'acme/widgets';
const savedEnv: Record<string, string | undefined> = {};
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  for (const key of ['AIRLOCK_HOME', 'AIRLOCK_CLAUDE_PATH', 'PATH']) savedEnv[key] = process.env[key];
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A file that exists and can be run, so the engine counts Claude as found (it checks the path is really there). */
async function fakeClaude(home: string): Promise<string> {
  const path = join(home, 'fake-claude');
  await writeFile(path, '#!/bin/sh\n', { mode: 0o755 });
  return path;
}

const pull = (over: Record<string, unknown> = {}): string => JSON.stringify({
  title: 'Add totals', body: 'Adds totals.', additions: 40, deletions: 10, changed_files: 3,
  html_url: `https://github.com/${REPO}/pull/7`, user: { login: 'alice' },
  base: { ref: 'main', sha: 'a'.repeat(40), repo: { full_name: REPO } },
  head: { ref: 'feature/totals', sha: 'b'.repeat(40), repo: { full_name: REPO } },
  ...over,
});

async function writePacks(dir: string): Promise<void> {
  const pack = async (name: string, yaml: string): Promise<void> => {
    await mkdir(join(dir, name, 'lenses'), { recursive: true });
    await writeFile(join(dir, name, 'pack.yaml'), yaml);
    await writeFile(join(dir, name, 'lenses', 'look.md'), 'Look closely.\n');
  };
  await pack('generic', 'id: generic\ntitle: Generic\nrepos: []\nlenses:\n  - { id: look, title: Look, file: lenses/look.md }\n');
  await pack('acme', [
    'id: acme', 'title: Acme pack', `repos: [${REPO}]`,
    'stageRules:', '  - { base: staging, stage: pr2 }', '  - { base: main, stage: pr3 }', '  - { default: true, stage: pr1 }',
    'lenses:', '  - { id: look, title: Look, file: lenses/look.md }', '',
  ].join('\n'));
  await pack('other', `id: other\ntitle: Other\nrepos: [someone/else]\nstageRules:\n  - { default: true, stage: pr2 }\nlenses:\n  - { id: look, title: Look, file: lenses/look.md }\n`);
}

interface Rig {
  port: number;
  home: string;
  clock: FakeClock;
  launched: Launched[];
  execCalls: string[];
  exec: Map<string, ExecResult>;
  log: string[];
  /** Every reply the tests received, to check against the contract. */
  replies: Array<{ route: string; reply: Reply }>;
  token: string;
  call(method: string, path: string, body?: unknown): Promise<Reply>;
  stream(runId: string): Promise<Stream>;
  close(): Promise<void>;
}

/**
 * `ignoresStop`: the fake review goes on when its signal is aborted, like a review stuck where the signal cannot reach;
 * otherwise it rejects as the engine does.
 */
async function startService(extra: Partial<ServiceDeps> = {}, { ignoresStop = false } = {}): Promise<Rig> {
  const home = await mkdtemp(join(tmpdir(), 'airlock-service-reviews-'));
  process.env.AIRLOCK_HOME = home;
  const packsDir = join(home, 'packs');
  await writePacks(packsDir);
  const clock = new FakeClock();
  const launched: Launched[] = [];
  const execCalls: string[] = [];
  const exec = new Map<string, ExecResult>([
    [`gh api repos/${REPO}/pulls/7`, { stdout: pull(), stderr: '', code: 0 }],
    ['gh api user --jq .login', { stdout: 'bob\n', stderr: '', code: 0 }],
    ['gh auth status', { stdout: '', stderr: 'Logged in to github.com', code: 0 }],
  ]);
  const log: string[] = [];
  const review: typeof runReview = (req, given, onEvent) => new Promise<ReviewDocument>((resolve, reject) => {
    const emit = (e: ReviewEvent): void => onEvent?.(e);
    const { signal } = given;
    if (!ignoresStop) signal?.addEventListener('abort', () => reject(new Error('The review was stopped.')), { once: true });
    launched.push({
      req, signal, emit, reject,
      finish: async (doc) => { await saveReview(doc); emit({ type: 'done', document: doc }); resolve(doc); },
    });
  });
  const engine: EngineDeps = {
    exec: async (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      execCalls.push(key);
      const answer = exec.get(key);
      if (answer === undefined) throw new Error(`unexpected command: ${key}`);
      return answer;
    },
    runner: { run: () => { throw new Error('the runner is not used in these tests'); } },
    now: clock.date,
  };
  const service = createServer({
    config: { port: 0, home, packsDir, version: '1.2.3' },
    engine, review, now: clock.date, log: (l) => log.push(l), timers: clock.timers,
    ...extra,
  });
  const { port } = await service.listen();
  const token = await readOrCreateToken(home);
  cleanups.push(async () => {
    // A review that ignores its stop is waited for at most CLOSE_WAIT_MS, on the fake clock.
    const closing = service.close();
    clock.advance(CLOSE_WAIT_MS);
    await closing;
    await rm(home, { recursive: true, force: true });
  });
  const auth = { Authorization: `Bearer ${token}` };
  const replies: Rig['replies'] = [];
  return {
    port, home, clock, launched, execCalls, exec, log, replies, token,
    close: () => service.close(),
    async call(method, path, body) {
      const reply = await send(port, method, path, body === undefined
        ? { headers: auth }
        : { headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      replies.push({ route: `${method} ${path.replace(/\?.*$/, '')}`, reply });
      return reply;
    },
    stream: (runId) => openStream(port, `/reviews/${runId}/events`, auth),
  };
}

const doc = (id = 'r_0123456789', number = 7): ReviewDocument => {
  const base = minimalDocument();
  return { ...base, id, pr: { ...base.pr, repo: REPO, number } };
};
const stage = (name: string, status: 'start' | 'done' = 'start'): ReviewEvent => ({ type: 'stage', stage: name, status, detail: '' });
const runIdOf = (r: Reply): string => (r.json as { runId: string }).runId;
const start = (s: Rig, number = 7, extra: Record<string, unknown> = {}): Promise<Reply> =>
  s.call('POST', '/reviews', { repo: REPO, number, ...extra });

describe('POST /reviews and the event stream', () => {
  it('starts a review and streams its events in order, ending after done', async () => {
    const s = await startService();
    const started = await start(s);
    expect(started.status).toBe(200);
    expect(started.json).toEqual({ runId: expect.stringMatching(/^run_[0-9a-f]{12}$/), reused: false });
    // The reply came while the review is still running.
    expect(s.launched).toHaveLength(1);
    expect(s.launched[0]!.req).toEqual({ repo: REPO, number: 7, packsDir: join(s.home, 'packs') });

    const stream = await s.stream(runIdOf(started));
    expect(stream.status).toBe(200);
    expect(stream.contentType).toBe('text/event-stream');
    const run = s.launched[0]!;
    run.emit(stage('intake'));
    run.emit(stage('intake', 'done'));
    run.emit({ type: 'map', map: { cohorts: [], standalone: [], links: [] } });
    run.emit({ type: 'brief', brief: { whatItDoes: ['Adds totals.'], claims: [] } });
    await until(() => stream.events.length === 4, 'four events');
    expect(stream.ended).toBe(false);
    await run.finish(doc());
    await stream.end;
    expect(stream.events.map((e) => e.type)).toEqual(['stage', 'stage', 'map', 'brief', 'done']);
    for (const e of stream.events) expect(ServiceEventSchema.safeParse(e).success).toBe(true);
  });

  it('passes depth and pack ids to the engine only when the body has them', async () => {
    const s = await startService();
    await start(s, 7, { depth: 'deep', packIds: ['acme'] });
    expect(s.launched[0]!.req).toEqual({ repo: REPO, number: 7, depth: 'deep', packIds: ['acme'], packsDir: join(s.home, 'packs') });
    const bad = await start(s, 8, { depth: 'huge' });
    expect(bad.status).toBe(400);
  });

  it('a second start for the same pull request reuses the run', async () => {
    const s = await startService();
    const first = await start(s);
    const second = await start(s, 7, { depth: 'quick' });
    expect(second.status).toBe(200);
    expect(second.json).toEqual({ runId: runIdOf(first), reused: true });
    expect(s.launched).toHaveLength(1);
  });

  it('a listener that attaches late gets every earlier event first', async () => {
    const s = await startService();
    const runId = runIdOf(await start(s));
    const run = s.launched[0]!;
    run.emit(stage('intake'));
    run.emit(stage('intake', 'done'));
    run.emit(stage('packs'));
    const late = await s.stream(runId);
    await until(() => late.events.length === 3, 'the earlier events');
    run.emit(stage('packs', 'done'));
    await run.finish(doc());
    await late.end;
    expect(late.events.map((e) => (e.type === 'stage' ? `${e.stage}:${e.status}` : e.type)))
      .toEqual(['intake:start', 'intake:done', 'packs:start', 'packs:done', 'done']);
  });

  it('two listeners both get every event', async () => {
    const s = await startService();
    const runId = runIdOf(await start(s));
    const one = await s.stream(runId);
    const two = await s.stream(runId);
    const run = s.launched[0]!;
    run.emit(stage('intake'));
    run.emit(stage('packs'));
    await run.finish(doc());
    await Promise.all([one.end, two.end]);
    expect(one.events).toEqual(two.events);
    expect(one.events.map((e) => e.type)).toEqual(['stage', 'stage', 'done']);
  });

  it('a review that rejects ends the stream with a failed event and frees the slot', async () => {
    const s = await startService();
    const runId = runIdOf(await start(s));
    const second = runIdOf(await start(s, 8));
    expect(second).not.toBe(runId);
    const stream = await s.stream(runId);
    s.launched[0]!.emit(stage('intake'));
    s.launched[0]!.reject(new Error(`gh api pulls/7: could not read ${join(s.home, 'reviews', 'x.json')}`));
    await stream.end;
    expect(stream.events.at(-1)).toEqual({ type: 'failed', message: 'Airlock could not review this pull request: gh api pulls/7: could not read <path>' });
    // One of the two slots is free again.
    const third = await start(s, 9);
    expect(third.status).toBe(200);
    expect((third.json as { reused: boolean }).reused).toBe(false);
  });

  it('the run that rejects never causes an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const s = await startService();
      const runId = runIdOf(await start(s));
      s.launched[0]!.reject(new Error('boom'));
      await new Promise((r) => setTimeout(r, 50));
      const stream = await s.stream(runId);
      await stream.end;
      expect(stream.events).toEqual([{ type: 'failed', message: 'Airlock could not review this pull request: boom' }]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('refuses a third review with 429 and accepts it after one finishes', async () => {
    const s = await startService();
    await start(s, 7);
    await start(s, 8);
    const refused = await start(s, 9);
    expect(refused.status).toBe(429);
    expect(refused.json).toEqual({ error: 'Two reviews are already running. Wait for one to finish.' });
    expect(s.launched).toHaveLength(2);
    await s.launched[0]!.finish(doc());
    const accepted = await start(s, 9);
    expect(accepted.status).toBe(200);
    expect(s.launched).toHaveLength(3);
  });

  it('a listener that disconnects does not stop the review', async () => {
    const s = await startService();
    const runId = runIdOf(await start(s));
    const leaving = await s.stream(runId);
    s.launched[0]!.emit(stage('intake'));
    await until(() => leaving.events.length === 1, 'the first event');
    leaving.close();
    await new Promise((r) => setTimeout(r, 30));
    s.launched[0]!.emit(stage('packs'));
    await s.launched[0]!.finish(doc());
    const later = await s.stream(runId);
    await later.end;
    expect(later.events.map((e) => e.type)).toEqual(['stage', 'stage', 'done']);
    // The disconnected listener's keep-alive timer is gone too: only the run's ten-minute timer is left.
    expect(s.clock.pending).toBe(1);
  });

  it('the stream of a finished run replays every event and ends', async () => {
    const s = await startService();
    const runId = runIdOf(await start(s));
    s.launched[0]!.emit(stage('intake'));
    await s.launched[0]!.finish(doc());
    const stream = await s.stream(runId);
    await stream.end;
    expect(stream.events.map((e) => e.type)).toEqual(['stage', 'done']);
  });

  it('writes a keep-alive comment every 15 seconds while the stream is open', async () => {
    const s = await startService();
    const runId = runIdOf(await start(s));
    const stream = await s.stream(runId);
    s.clock.advance(14_999);
    await new Promise((r) => setTimeout(r, 20));
    expect(stream.comments).toEqual([]);
    s.clock.advance(1);
    await until(() => stream.comments.length === 1, 'one keep-alive');
    s.clock.advance(30_000);
    await until(() => stream.comments.length === 3, 'three keep-alives');
    expect(stream.comments).toEqual(['keep-alive', 'keep-alive', 'keep-alive']);
    await s.launched[0]!.finish(doc());
    await stream.end;
    // The ended stream's keep-alive is stopped: only the run's ten-minute timer is left.
    expect(s.clock.pending).toBe(1);
  });

  it('drops a finished run after ten minutes', async () => {
    const s = await startService();
    const runId = runIdOf(await start(s));
    await s.launched[0]!.finish(doc());
    s.clock.advance(FINISHED_KEEP_MS - 1);
    const kept = await s.stream(runId);
    await kept.end;
    expect(kept.events.map((e) => e.type)).toEqual(['done']);
    s.clock.advance(1);
    const gone = await s.call('GET', `/reviews/${runId}/events`);
    expect(gone.status).toBe(404);
    expect(gone.json).toEqual({ error: 'Airlock no longer has that review run. Open the latest review instead.' });
  });

  it('answers 404 for a run id it never had and for a malformed run id', async () => {
    const s = await startService();
    const unknown = await s.call('GET', '/reviews/run_000000000000/events');
    expect(unknown.status).toBe(404);
    expect(unknown.json).toEqual({ error: 'Airlock no longer has that review run. Open the latest review instead.' });
    for (const bad of ['run_xyz', 'run_0123456789AB', 'run_0000000000000', 'r_0123456789']) {
      expect((await s.call('GET', `/reviews/${bad}/events`)).status, bad).toBe(404);
    }
  });
});

describe('GET /reviews/running', () => {
  it('running returns the run id while it runs and 404 after', async () => {
    const s = await startService();
    expect((await s.call('GET', `/reviews/running?repo=${REPO}&number=7`)).status).toBe(404);
    const runId = runIdOf(await start(s));
    const running = await s.call('GET', `/reviews/running?repo=${REPO}&number=7`);
    expect(running.status).toBe(200);
    expect(running.json).toEqual({ runId });
    expect((await s.call('GET', `/reviews/running?repo=${REPO}&number=8`)).status).toBe(404);
    await s.launched[0]!.finish(doc());
    const after = await s.call('GET', `/reviews/running?repo=${REPO}&number=7`);
    expect(after.status).toBe(404);
    expect(ApiErrorSchema.safeParse(after.json).success).toBe(true);
  });

  it('refuses a query that is not a repository and a number', async () => {
    const s = await startService();
    for (const query of ['repo=acme&number=7', `repo=${REPO}&number=0`, `repo=${REPO}&number=1.5`, `repo=${REPO}`, `repo=${REPO}&number=abc`]) {
      expect((await s.call('GET', `/reviews/running?${query}`)).status, query).toBe(400);
    }
  });
});

describe('GET /reviews/latest', () => {
  it('latest returns the stored document with its dismissals, and 404 when there is none', async () => {
    const dismissal: Dismissal = {
      fingerprint: '0123456789abcdef', findingId: 'c_01234567', reviewId: 'r_0123456789', reason: 'not-now',
      text: '', at: '2026-11-11T09:00:00.000Z', learned: null,
    };
    const asked: string[] = [];
    const s = await startService({ dismissals: async (repo, number) => { asked.push(`${repo}#${number}`); return [dismissal]; } });
    const none = await s.call('GET', `/reviews/latest?repo=${REPO}&number=7`);
    expect(none.status).toBe(404);
    expect(none.json).toEqual({ error: 'Airlock has no review of this pull request yet.' });
    await saveReview(doc('r_0123456789'));
    const found = await s.call('GET', `/reviews/latest?repo=${REPO}&number=7`);
    expect(found.status).toBe(200);
    expect(found.json).toEqual({ document: doc('r_0123456789'), dismissals: [dismissal] });
    expect(asked).toContain(`${REPO}#7`);
  });

  it('answers with no dismissals when none are given', async () => {
    const s = await startService();
    await saveReview(doc('r_0123456789'));
    const found = await s.call('GET', `/reviews/latest?repo=${REPO}&number=7`);
    expect((found.json as { dismissals: unknown[] }).dismissals).toEqual([]);
  });

  it('the done document from the stream and the one from latest have the same id', async () => {
    const s = await startService();
    const runId = runIdOf(await start(s));
    const stream = await s.stream(runId);
    await s.launched[0]!.finish(doc('r_fedcba9876'));
    await stream.end;
    const last = stream.events.at(-1)!;
    expect(last.type).toBe('done');
    const latest = await s.call('GET', `/reviews/latest?repo=${REPO}&number=7`);
    expect((latest.json as { document: { id: string } }).document.id).toBe(last.type === 'done' ? last.document.id : null);
  });
});

describe('GET /pr', () => {
  it('pr returns the stage, the packs that will run and quick for a small pull request', async () => {
    const s = await startService();
    const r = await s.call('GET', `/pr?repo=${REPO}&number=7`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      repo: REPO, number: 7, title: 'Add totals', author: 'alice', viewer: 'bob', isOwn: false, stage: 'pr3',
      baseRef: 'main', headRef: 'feature/totals', headSha: 'b'.repeat(40), additions: 40, deletions: 10, changedFiles: 3,
      packs: [{ id: 'acme', title: 'Acme pack' }, { id: 'generic', title: 'Generic' }], suggestedDepth: 'quick',
    });
  });

  it('says standard for a large pull request, isOwn for the author, and the default stage for another base', async () => {
    const s = await startService();
    s.exec.set(`gh api repos/${REPO}/pulls/7`, {
      stdout: pull({ additions: 140, deletions: 11, user: { login: 'bob' }, base: { ref: 'dev', sha: 'a'.repeat(40), repo: { full_name: REPO } } }),
      stderr: '', code: 0,
    });
    const r = await s.call('GET', `/pr?repo=${REPO}&number=7`);
    expect(r.json).toMatchObject({ suggestedDepth: 'standard', isOwn: true, stage: 'pr1' });
  });

  it('answers 404 when GitHub has no such pull request and 502 when GitHub fails otherwise, with paths hidden', async () => {
    const s = await startService();
    s.exec.set(`gh api repos/${REPO}/pulls/8`, { stdout: '', stderr: 'gh: Not Found (HTTP 404)', code: 1 });
    const missing = await s.call('GET', `/pr?repo=${REPO}&number=8`);
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ error: 'GitHub has no such pull request, or you cannot see it.' });

    s.exec.set(`gh api repos/${REPO}/pulls/9`, { stdout: '', stderr: `error connecting to api.github.com; see ${join(s.home, 'gh.log')}`, code: 1 });
    const down = await s.call('GET', `/pr?repo=${REPO}&number=9`);
    expect(down.status).toBe(502);
    expect(down.json).toEqual({ error: 'GitHub did not answer: gh api pulls/9: error connecting to api.github.com; see <path>' });
  });

  it('makes only read calls to gh', async () => {
    const s = await startService();
    await s.call('GET', `/pr?repo=${REPO}&number=7`);
    await s.call('GET', '/status');
    expect([...new Set(s.execCalls)].sort()).toEqual(['gh api repos/acme/widgets/pulls/7', 'gh api user --jq .login', 'gh auth status']);
  });
});

describe('GET /status', () => {
  it('status reports whether claude and gh were found', async () => {
    const s = await startService();
    process.env.AIRLOCK_CLAUDE_PATH = await fakeClaude(s.home);
    const runId = runIdOf(await start(s));
    const found = await s.call('GET', '/status');
    expect(found.status).toBe(200);
    expect(found.json).toEqual({
      version: '1.2.3', claude: true, gh: true, packsDir: join(s.home, 'packs'), running: [{ runId, repo: REPO, number: 7 }],
    });

    // Both answers are kept for 60 seconds.
    delete process.env.AIRLOCK_CLAUDE_PATH;
    process.env.PATH = '';
    s.exec.set('gh auth status', { stdout: '', stderr: 'You are not logged into any GitHub hosts.', code: 1 });
    s.clock.advance(59_999);
    expect((await s.call('GET', '/status')).json).toMatchObject({ claude: true, gh: true });
    s.clock.advance(1);
    await s.launched[0]!.finish(doc());
    expect((await s.call('GET', '/status')).json).toMatchObject({ claude: false, gh: false, running: [] });
  });

  it('says gh is missing when the gh command cannot start', async () => {
    const s = await startService();
    s.exec.delete('gh auth status');
    expect((await s.call('GET', '/status')).json).toMatchObject({ gh: false });
  });
});

describe('the contract', () => {
  it('every reply parses with its shared schema', async () => {
    const s = await startService();
    process.env.AIRLOCK_CLAUDE_PATH = await fakeClaude(s.home);
    await s.call('GET', '/status');
    await s.call('GET', `/pr?repo=${REPO}&number=7`);
    const runId = runIdOf(await start(s));
    await start(s);
    await start(s, 8);
    await start(s, 9);
    await s.call('GET', `/reviews/running?repo=${REPO}&number=7`);
    await s.call('GET', `/reviews/latest?repo=${REPO}&number=7`);
    await s.launched[0]!.finish(doc());
    await s.call('GET', `/reviews/running?repo=${REPO}&number=7`);
    await s.call('GET', `/reviews/latest?repo=${REPO}&number=7`);
    await s.call('GET', '/reviews/run_000000000000/events');

    const schemas: Record<string, ZodType> = {
      'GET /status': ServiceStatusSchema,
      'GET /pr': PrSummarySchema,
      'POST /reviews': StartReviewReplySchema,
      'GET /reviews/running': StartReviewReplySchema.pick({ runId: true }),
      'GET /reviews/latest': LatestReplySchema,
    };
    expect(s.replies.length).toBeGreaterThan(10);
    for (const { route, reply } of s.replies) {
      const schema = reply.status === 200 ? schemas[route] : ApiErrorSchema;
      expect(schema, route).toBeDefined();
      expect(schema!.safeParse(reply.json).success, `${route} ${reply.status}`).toBe(true);
    }
    expect(s.replies.map((r) => r.reply.status)).toEqual([200, 200, 200, 200, 200, 429, 200, 404, 404, 200, 404]);
    expect(runId).toMatch(/^run_/);
  });
});

describe('fix round 1', () => {
  const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
  const FOREIGN = `chrome-extension://${'b'.repeat(32)}`;

  it('a review that never settles ends as failed at the ceiling, and a new start is then accepted', async () => {
    const s = await startService({ limits: { runMinutes: 5 } }, { ignoresStop: true });
    const runId = runIdOf(await start(s, 7));
    await start(s, 8);
    expect((await start(s, 9)).status).toBe(429);
    const stream = await s.stream(runId);
    expect(s.launched[0]!.signal?.aborted).toBe(false);
    s.clock.advance(5 * 60_000);
    expect(s.launched[0]!.signal?.aborted).toBe(true);
    await stream.end;
    expect(stream.events.at(-1)).toEqual({ type: 'failed', message: 'Airlock stopped this review because it ran for more than 5 minutes.' });
    expect((await s.call('GET', `/reviews/running?repo=${REPO}&number=7`)).status).toBe(404);
    const accepted = await start(s, 9);
    expect(accepted.status).toBe(200);
    // What the stopped review sends afterwards changes nothing.
    await s.launched[0]!.finish(doc());
    const replay = await s.stream(runId);
    await replay.end;
    expect(replay.events).toEqual(stream.events);
  });

  it('a review that resolves after its ceiling leaves no stored document', async () => {
    const s = await startService({ limits: { runMinutes: 5 } }, { ignoresStop: true });
    await start(s, 7);
    s.clock.advance(5 * 60_000);
    const late = doc('r_bbbbbbbbbb');
    await s.launched[0]!.finish(late);
    const file = join(s.home, 'reviews', 'acme__widgets', '7', `${late.pr.headSha}-${late.id}.json`);
    await until(() => !existsSync(file) && s.log.some((l) => l.includes('r_bbbbbbbbbb was discarded')), 'the late document removed');
    expect((await s.call('GET', `/reviews/latest?repo=${REPO}&number=7`)).status).toBe(404);
  });

  it('gives each review the signal that stops it, and close() stops every running review', async () => {
    const s = await startService();
    await start(s, 7);
    await start(s, 8);
    const [a, b] = s.launched;
    expect(a!.signal).toBeInstanceOf(AbortSignal);
    expect(a!.signal).not.toBe(b!.signal);
    await s.close();
    expect(a!.signal?.aborted).toBe(true);
    expect(b!.signal?.aborted).toBe(true);
  });

  it('refuses a run ceiling that is not a positive number', async () => {
    const home = await mkdtemp(join(tmpdir(), 'airlock-service-limits-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    for (const runMinutes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createServer({
        config: { port: 0, home, packsDir: home, version: '0' }, engine: {} as unknown as EngineDeps, now: () => new Date(),
        log: () => undefined, limits: { runMinutes },
      }), String(runMinutes)).toThrow(RangeError);
    }
  });

  it('one pull request has one run whatever the letter case of the repository', async () => {
    const s = await startService();
    const first = await s.call('POST', '/reviews', { repo: 'Acme/Widgets', number: 7 });
    const second = await s.call('POST', '/reviews', { repo: 'acme/widgets', number: 7 });
    expect(second.json).toEqual({ runId: runIdOf(first), reused: true });
    expect((await s.call('GET', '/reviews/running?repo=ACME/widgets&number=7')).json).toEqual({ runId: runIdOf(first) });
    expect(s.launched).toHaveLength(1);
  });

  it('bounds error text: line breaks collapse and the whole sentence is cut once, to what the panel shows', async () => {
    const s = await startService();
    const long = `first line\n${'😀'.repeat(300)}\r\nlast line HTTP 500`;
    s.exec.set(`gh api repos/${REPO}/pulls/9`, { stdout: '', stderr: long, code: 1 });
    const down = await s.call('GET', `/pr?repo=${REPO}&number=9`);
    expect(down.status).toBe(502);
    const error = (down.json as { error: string }).error;
    expect(error.startsWith('GitHub did not answer: gh api pulls/9: first line 😀')).toBe(true);
    expect([...error]).toHaveLength(MESSAGE_MAX);
    expect(error.endsWith('…')).toBe(true);
    expect(error).not.toMatch(/[\r\n]/);

    const runId = runIdOf(await start(s));
    s.launched[0]!.reject(new Error(long));
    const stream = await s.stream(runId);
    await stream.end;
    const failed = stream.events.at(-1) as { type: string; message: string };
    expect(failed.message.startsWith('Airlock could not review this pull request: first line')).toBe(true);
    expect([...failed.message]).toHaveLength(MESSAGE_MAX);
    expect(failed.message).not.toMatch(/[\r\n]/);
  });

  it('still answers 404 for a GitHub 404 whose text is long', async () => {
    const s = await startService();
    s.exec.set(`gh api repos/${REPO}/pulls/8`, { stdout: '', stderr: `${'x'.repeat(400)}\ngh: Not Found (HTTP 404)`, code: 1 });
    expect((await s.call('GET', `/pr?repo=${REPO}&number=8`)).status).toBe(404);
  });

  it('a run that is gone when its stream starts gets one failed event with the run-gone sentence', async () => {
    const clock = new FakeClock();
    const res = runStream(() => null, clock.timers);
    if (!('stream' in res)) throw new Error('expected a stream');
    const sent: unknown[] = [];
    await res.stream((e) => sent.push(e), new AbortController().signal, () => undefined);
    expect(sent).toEqual([{ type: 'failed', message: RUN_GONE }]);
    expect(RUN_GONE).toBe('Airlock no longer has that review run. Open the latest review instead.');
    expect(clock.pending).toBe(0);
  });

  it('close() leaves no timer pending', async () => {
    const s = await startService();
    await start(s, 7);
    await s.launched[0]!.finish(doc());
    const runId = runIdOf(await start(s, 8));
    const stream = await s.stream(runId);
    await until(() => s.clock.pending === 3, 'expiry, ceiling and keep-alive timers');
    // The running review is stopped and rejects, as the engine does, so close() does not wait.
    await s.close();
    await stream.end;
    expect(s.launched[1]!.signal?.aborted).toBe(true);
    expect(s.clock.pending).toBe(0);
  });

  it('the event stream needs the token and refuses a foreign Origin', async () => {
    const s = await startService();
    const runId = runIdOf(await start(s));
    const anonymous = await send(s.port, 'GET', `/reviews/${runId}/events`);
    expect(anonymous.status).toBe(401);
    await pair(s.home, ORIGIN);
    const foreign = await send(s.port, 'GET', `/reviews/${runId}/events`, { headers: { Authorization: `Bearer ${s.token}`, Origin: FOREIGN } });
    expect(foreign.status).toBe(403);
    const web = await send(s.port, 'GET', `/reviews/${runId}/events`, { headers: { Authorization: `Bearer ${s.token}`, Origin: 'https://evil.example' } });
    expect(web.status).toBe(403);
  });

  it('two starts for the same pull request sent together give one run and one reused', async () => {
    const s = await startService();
    const [a, b] = await Promise.all([start(s), start(s)]);
    expect(runIdOf(a)).toBe(runIdOf(b));
    expect([(a.json as { reused: boolean }).reused, (b.json as { reused: boolean }).reused].sort()).toEqual([false, true]);
    expect(s.launched).toHaveLength(1);
  });

  it('a review that sends done and then rejects ends the stream once with done', async () => {
    const s = await startService();
    const runId = runIdOf(await start(s));
    const stream = await s.stream(runId);
    s.launched[0]!.emit({ type: 'done', document: doc() });
    s.launched[0]!.reject(new Error('after done'));
    await stream.end;
    await new Promise((r) => setTimeout(r, 20));
    expect(stream.events.map((e) => e.type)).toEqual(['done']);
    const replay = await s.stream(runId);
    await replay.end;
    expect(replay.events.map((e) => e.type)).toEqual(['done']);
  });

  it('a review that sends done twice ends the stream once with done', async () => {
    const s = await startService();
    const runId = runIdOf(await start(s));
    const stream = await s.stream(runId);
    s.launched[0]!.emit({ type: 'done', document: doc('r_0000000001') });
    s.launched[0]!.emit({ type: 'done', document: doc('r_0000000002') });
    await stream.end;
    expect(stream.events).toEqual([{ type: 'done', document: doc('r_0000000001') }]);
  });
});

