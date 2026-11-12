// The panel's real client against the service's real server. It lives with the extension's tests, which are typed with
// bundler resolution and so can import the service's source by path: a test-only import, so neither package depends on
// the other when it runs. It runs in Node, as the service does, with a fetch that adds the Origin Chrome adds.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveReview, type EngineDeps, type ReviewRequest, type runReview } from '@airlock/engine';
import {
  candidate, minimalDocument, type Finding, type ReviewDocument, type ReviewEvent, type ServiceEvent,
} from '@airlock/shared';
import { NOT_PROVED } from '../../src/client/proof';
import { ServiceClient, ServiceError } from '../../src/client/service';
import { pushReviewable } from '../../src/state/reduce';
import { createServer, type Service } from '../../../service/src/server';
import { pairedOrigin, readOrCreateToken, replaceToken } from '../../../service/src/config';

const REPO = 'acme/widgets';
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const OTHER_EXTENSION = `chrome-extension://${'b'.repeat(32)}`;

const pull = JSON.stringify({
  title: 'Add totals', body: 'Adds totals.', additions: 40, deletions: 10, changed_files: 3,
  html_url: `https://github.com/${REPO}/pull/7`, user: { login: 'alice' }, state: 'open', merged: false,
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

/** The one GitHub write, as the service's `sendReview` makes it, for pull request 7. */
const POST_LINE = `gh api --method POST repos/${REPO}/pulls/7/reviews --input -`;
const POSTED = JSON.stringify({ id: 555, html_url: `https://github.com/${REPO}/pull/7#pullrequestreview-555`, state: 'COMMENTED' });

/** A review of pull request 7 at the pull request's head: one finding on a line of the diff, one on no line GitHub shows. */
function postable(): ReviewDocument {
  const base = minimalDocument();
  const inline: Finding = {
    ...finding, id: 'c_aaaaaaaa', fingerprint: '1111111111111111', title: 'Total is not rounded',
    anchor: { status: 'in-diff', startLine: 12, endLine: 12, comment: { line: 12, startLine: null } },
  };
  const outside: Finding = {
    ...finding, id: 'c_bbbbbbbb', fingerprint: '2222222222222222', title: 'The cache is never cleared', path: 'src/cache.ts',
    anchor: { status: 'outside-diff', startLine: 40, endLine: 41, comment: null },
  };
  return { ...base, id: 'r_0123456789', pr: { ...base.pr, repo: REPO, number: 7, headSha: 'b'.repeat(40) }, findings: [inline, outside] };
}

/** One pack chosen for the repository, with two learned lines in its wrong.md. */
async function writePack(packsDir: string): Promise<string> {
  const dir = join(packsDir, 'acme');
  await mkdir(join(dir, 'lenses'), { recursive: true });
  await mkdir(join(dir, 'learned'), { recursive: true });
  await writeFile(join(dir, 'lenses', 'look.md'), 'Look closely.\n');
  await writeFile(join(dir, 'pack.yaml'), `id: acme\ntitle: Acme pack\nrepos: [${REPO}]\nlenses:\n  - { id: look, title: Look, file: lenses/look.md }\n`);
  const file = join(dir, 'learned', 'wrong.md');
  await writeFile(file, `2026-11-01 · ${REPO} · Rounding is done by the caller.\n2026-11-05 · ${REPO} · The cache is cleared on deploy.\n`);
  return file;
}

interface Launched { req: ReviewRequest; emit: (e: ReviewEvent) => void; finish: (doc: ReviewDocument) => Promise<void> }

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
  now: () => Date = () => new Date(), monotonic: () => number = () => performance.now(),
): Promise<{
  service: Service; base: string; token: string; home: string; launched: Launched[];
  /** What the fake `gh` answers, by command line; a test may change an answer (the pull request's head, say). */
  answers: Map<string, { stdout: string; stderr: string; code: number }>;
  /** Every command the fake `gh` was asked to run, with what it was given on standard input. */
  gh: Array<{ line: string; input: string | undefined }>;
}> {
  const home = await mkdtemp(join(tmpdir(), 'airlock-panel-client-'));
  const saved = process.env['AIRLOCK_HOME'];
  process.env['AIRLOCK_HOME'] = home;
  const launched: Launched[] = [];
  const review: typeof runReview = (req, given, onEvent) => new Promise<ReviewDocument>((resolve, reject) => {
    given.signal?.addEventListener('abort', () => reject(new Error('The review was stopped.')), { once: true });
    const emit = (e: ReviewEvent): void => onEvent?.(e);
    launched.push({ req, emit, finish: async (doc) => { await saveReview(doc); emit({ type: 'done', document: doc }); resolve(doc); } });
  });
  const answers = new Map([
    [`gh api repos/${REPO}/pulls/7`, { stdout: pull, stderr: '', code: 0 }],
    [`gh api repos/${REPO}/pulls/8`, { stdout: pull.replaceAll('/pull/7', '/pull/8'), stderr: '', code: 0 }],
    ['gh api user --jq .login', { stdout: 'bob\n', stderr: '', code: 0 }],
    [POST_LINE, { stdout: POSTED, stderr: '', code: 0 }],
  ]);
  const gh: Array<{ line: string; input: string | undefined }> = [];
  const engine: EngineDeps = {
    exec: async (cmd, args, opts) => {
      const line = [cmd, ...args].join(' ');
      gh.push({ line, input: opts?.input });
      const answer = answers.get(line);
      if (answer === undefined) return { stdout: '', stderr: 'gh: Not Found (HTTP 404)', code: 1 };
      return answer;
    },
    runner: { run: () => { throw new Error('no model is asked in these tests'); } },
    now: () => new Date(),
  };
  const service = createServer({
    config: { port: 0, home, packsDir: join(home, 'packs'), version: '1.2.3' }, engine, review, now, monotonic, log: () => undefined,
  });
  const { port } = await service.listen();
  cleanups.push(async () => {
    await service.close();
    if (saved === undefined) delete process.env['AIRLOCK_HOME'];
    else process.env['AIRLOCK_HOME'] = saved;
    await rm(home, { recursive: true, force: true });
  });
  return { service, base: `http://127.0.0.1:${port}`, token: await readOrCreateToken(home), home, launched, answers, gh };
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
    const s = await startService(() => new Date(at), () => at);
    let stored: string | null = s.token;
    const client = new ServiceClient(s.base, async () => stored, chromeFetch(ORIGIN));
    expect(await client.pair(s.token)).toEqual({ paired: true, extension: 'new' });
    await client.pr(REPO, 7);

    const fresh = await replaceToken(s.home);
    at += 1_000;
    // Whoever holds only the old token is refused a second after the replacement, with nothing else asked first.
    const old = await fetch(`${s.base}/reviews/running?repo=${REPO}&number=7`, { headers: { Authorization: `Bearer ${s.token}` } });
    expect(old.status).toBe(401);
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

  it('previews, posts once through the Origin rule and the proof gate, names the people an edited summary would notify, and forgets only an unknown record', async () => {
    const s = await startService();
    await saveReview(postable());
    const pairing = new ServiceClient(s.base, async () => null, chromeFetch(ORIGIN));
    expect(await pairing.pair(s.token)).toEqual({ paired: true, extension: 'new' });
    const asked = recorded(chromeFetch(ORIGIN));
    const client = new ServiceClient(s.base, async () => s.token, asked.fetch);
    const items = [{ fingerprint: '1111111111111111' }, { fingerprint: '2222222222222222' }];

    // The preview: one comment on its line, one in the summary because GitHub shows no line for it. Airlock's own text
    // names no one.
    const preview = await client.previewPost({ repo: REPO, number: 7, reviewId: 'r_0123456789', items });
    expect(preview.items.map((i) => [i.placement, i.line, i.whySummary, i.mentions])).toEqual([
      ['inline', 12, null, []], ['summary', 40, 'The line is not part of the diff GitHub shows.', []],
    ]);
    expect(preview.reviewBodyMentions).toEqual([]);
    // The token went only after the real service proved it holds it, and nothing has reached GitHub's write yet.
    expect(asked.seen.map((r) => [new URL(r.url).pathname, r.auth])).toEqual([
      ['/hello', null], ['/posts/preview', `Bearer ${s.token}`],
    ]);
    expect(s.gh.filter((c) => c.line === POST_LINE)).toEqual([]);

    // The same request without the extension's Origin, token and all, is refused before anything is read.
    const bare = await fetch(`${s.base}/posts/preview`, {
      method: 'POST', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: REPO, number: 7, reviewId: 'r_0123456789', items }),
    });
    expect(bare.status).toBe(403);
    expect(await bare.json()).toEqual({ error: 'Airlock does not accept requests from this page.' });

    // A summary the person typed: the names it would notify come back, so the panel can warn before the post.
    const edited = await client.previewPost({
      repo: REPO, number: 7, reviewId: 'r_0123456789', items, summary: 'Two notes, @alice. Ask @bob about the cache.',
    });
    expect(edited.summary).toBe('Two notes, @alice. Ask @bob about the cache.');
    expect(edited.reviewBodyMentions).toEqual(['@alice', '@bob']);

    // The post: the stored preview is sent once, exactly as previewed, as a COMMENT review, and its record comes back.
    const outcome = await client.post({ previewId: preview.previewId });
    expect(outcome).toEqual({ outcome: 'posted', record: expect.objectContaining({
      repo: REPO, number: 7, reviewId: 'r_0123456789', outcome: 'posted', githubReviewId: 555,
      url: `https://github.com/${REPO}/pull/7#pullrequestreview-555`,
    }) });
    const writes = s.gh.filter((c) => c.line === POST_LINE);
    expect(writes).toHaveLength(1);
    const sent = JSON.parse(writes[0]!.input ?? '') as { event: string; commit_id: string; body: string; comments: unknown[] };
    expect(sent).toMatchObject({ event: 'COMMENT', commit_id: 'b'.repeat(40), body: preview.reviewBody });
    expect(sent.comments).toEqual([{ path: 'src/total.ts', line: 12, side: 'RIGHT', body: preview.items[0]!.body }]);
    if (outcome.outcome !== 'posted') throw new Error('not posted');
    expect((await client.latest(REPO, 7))?.posts).toEqual([outcome.record]);

    // Posting twice: the spent preview is gone, and a new preview of the same findings is refused.
    expect(await client.post({ previewId: preview.previewId })).toEqual({
      outcome: 'refused', message: 'This preview has expired. Open the preview again.',
    });
    expect(await refusal(client.previewPost({ repo: REPO, number: 7, reviewId: 'r_0123456789', items }))).toEqual({
      kind: 'problem', message: 'This finding is already posted on this pull request: Total is not rounded.',
    });
    expect(s.gh.filter((c) => c.line === POST_LINE)).toHaveLength(1);

    // Forget: a record the service does not have is not forgotten; a posted one is kept.
    expect(await client.forgetPost({ repo: REPO, number: 7, id: 'post_000000000000' })).toEqual({ forgotten: false });
    expect(await refusal(client.forgetPost({ repo: REPO, number: 7, id: outcome.record.id }))).toEqual({
      kind: 'problem', message: 'This review was posted, so Airlock keeps its record.',
    });
    // Every request that carried the token came after a hello the real service proved.
    expect(asked.seen.filter((r) => r.auth !== null).every((r) => r.auth === `Bearer ${s.token}`)).toBe(true);
    expect(asked.seen[0]).toEqual({ url: expect.stringContaining('/hello?nonce='), auth: null });
  });

  it('after a push, /pr gives the last review and the moved head, the panel offers the push, and since last reaches the review with that review', async () => {
    const s = await startService();
    const client = new ServiceClient(s.base, async () => s.token, chromeFetch(ORIGIN));
    expect(await client.pair(s.token)).toEqual({ paired: true, extension: 'new' });

    // No stored review: nothing to review the push from.
    const first = await client.pr(REPO, 7);
    expect(first).toMatchObject({ state: 'open', lastReview: null });
    expect(pushReviewable(first)).toBe(false);

    // A stored review of the pull request's head: nothing pushed since, and the service agrees.
    const earlier: ReviewDocument = { ...reviewOf(7), depth: 'deep', pr: { ...reviewOf(7).pr, headSha: 'b'.repeat(40) } };
    await saveReview(earlier);
    const same = await client.pr(REPO, 7);
    expect(same.lastReview).toEqual({ reviewId: 'r_0123456789', headSha: 'b'.repeat(40), createdAt: earlier.createdAt, depth: 'deep' });
    expect(pushReviewable(same)).toBe(false);
    expect(await refusal(client.start({ repo: REPO, number: 7, since: 'last' }))).toEqual({
      kind: 'problem', message: 'Nothing was pushed since the last review.',
    });
    expect(s.launched).toHaveLength(0);

    // A push: GitHub now answers another head.
    s.answers.set(`gh api repos/${REPO}/pulls/7`, { stdout: pull.replaceAll('b'.repeat(40), 'd'.repeat(40)), stderr: '', code: 0 });
    const moved = await client.pr(REPO, 7);
    expect(moved).toMatchObject({ state: 'open', headSha: 'd'.repeat(40), lastReview: { reviewId: 'r_0123456789', headSha: 'b'.repeat(40) } });
    expect(pushReviewable(moved)).toBe(true);

    // What the panel sends for Review the push reaches the review function with that review, its depth and packs.
    const { reused } = await client.start({ repo: REPO, number: 7, depth: earlier.depth, since: 'last' });
    expect(reused).toBe(false);
    await until(() => s.launched.length === 1, 'the review launched');
    expect(s.launched[0]!.req).toEqual({
      repo: REPO, number: 7, depth: 'deep', packIds: earlier.packs.map((p) => p.id), since: { reviewId: 'r_0123456789' },
      packsDir: join(s.home, 'packs'),
    });
  });

  it('lists the learned lines of the packs chosen for the repository, newest first, and removes one', async () => {
    const s = await startService();
    const file = await writePack(join(s.home, 'packs'));
    const client = new ServiceClient(s.base, async () => s.token, chromeFetch(ORIGIN));
    expect(await client.pair(s.token)).toEqual({ paired: true, extension: 'new' });

    const listed = await client.learned(REPO);
    expect(listed.cap).toBe(300);
    expect(listed.lines.map((l) => [l.pack, l.packTitle, l.kind, l.date, l.repo, l.text, l.appliesHere, l.removable])).toEqual([
      ['acme', 'Acme pack', 'wrong', '2026-11-05', REPO, 'The cache is cleared on deploy.', true, true],
      ['acme', 'Acme pack', 'wrong', '2026-11-01', REPO, 'Rounding is done by the caller.', true, true],
    ]);
    const newest = listed.lines[0]!;

    expect(await client.removeLearned({ repo: REPO, pack: newest.pack, kind: newest.kind, key: newest.key })).toEqual({
      removed: true, note: null,
    });
    expect(await readFile(file, 'utf8')).toBe(`2026-11-01 · ${REPO} · Rounding is done by the caller.\n`);
    expect((await client.learned(REPO)).lines.map((l) => l.text)).toEqual(['Rounding is done by the caller.']);
    // Asked again, the line is no longer there: nothing is removed, and the note says so.
    expect(await client.removeLearned({ repo: REPO, pack: newest.pack, kind: newest.kind, key: newest.key })).toEqual({
      removed: false, note: "That line was no longer in Acme pack's wrong.md; nothing was removed.",
    });
  });
});
