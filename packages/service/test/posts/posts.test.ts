import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveReview, type Exec } from '@airlock/engine';
import {
  COMMENT_MAX, commentBody, CUT_NOTE, LatestReplySchema, MESSAGE_MAX, PostPreviewReplySchema, PostRecordSchema, REVIEW_BODY_MAX, summaryBody,
  type PostPreviewReply, type PostRecord,
} from '@airlock/shared';
import { readOrCreateToken } from '../../src/config.js';
import { writeList } from '../../src/dismissals.js';
import { buildPreview, Previews, type StoredPreview } from '../../src/posts/preview.js';
import { post, type PostDeps } from '../../src/posts/records.js';
import {
  cleanUp, EXPIRED, FINDING_A, FINDING_B, FINDING_C, FP_A, FP_B, FP_C, FP_C_ALIAS, FP_D, HEAD, NUMBER, POST_ARGS, POSTED, pull, PULL_LINE,
  POST_LINE, REPO, REVIEW, REVIEWS_LINE, review, startService, USER_LINE, type ExecResult, type Rig,
} from './rig.js';
import { until } from '../helpers.js';

afterEach(cleanUp);

const MOVED = 'The pull request has new commits since this review. Review the push, then post.';
const UNKNOWN = 'Airlock could not tell whether GitHub accepted the comments. Look at the pull request before posting again.';
const NO_GH = 'Airlock could not run gh, or gh is not signed in. Nothing was posted.';
const FOUND = 'GitHub has this review: it was posted. Nothing was forgotten.';
const NOT_ASKED = 'Airlock could not ask GitHub whether this review exists, so the record was kept.';
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
/** The commands run besides the read of the signed-in account that every preview makes. */
const beyondAccount = (s: Rig): string[] => s.calls.map((c) => c.line).filter((line) => line !== USER_LINE);
const TIMED_OUT: ExecResult = { stdout: '', stderr: 'timed out after 60 s', code: 124 };
const REFUSED: ExecResult = {
  stdout: JSON.stringify({ message: 'Validation failed', errors: ['pull_request_review_thread.line must be part of the diff'], status: '422' }),
  stderr: 'gh: Validation failed (HTTP 422)\n', code: 1,
};

async function previewed(s: Rig, body: Record<string, unknown> = {}): Promise<PostPreviewReply> {
  const r = await s.preview(body);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return PostPreviewReplySchema.parse(r.json);
}

const latestPosts = async (s: Rig): Promise<PostRecord[]> => {
  const r = await s.call('GET', `/reviews/latest?repo=${REPO}&number=${NUMBER}`);
  expect(r.status).toBe(200);
  return LatestReplySchema.parse(r.json).posts;
};

const record = (over: Partial<PostRecord> = {}): PostRecord => ({
  id: 'post_0123456789ab', repo: REPO, number: NUMBER, reviewId: REVIEW, headSha: HEAD, postedAt: '2026-11-11T08:00:00.000Z',
  outcome: 'posted', githubReviewId: 9, url: `https://github.com/${REPO}/pull/${NUMBER}#pullrequestreview-9`,
  items: [{ fingerprint: FP_A, aliases: [], placement: 'inline' }], ...over,
});

describe('POST /posts/preview', () => {
  it('the preview places a finding inline at its comment line and one without a comment line in the summary, saying why', async () => {
    const s = await startService();
    const p = await previewed(s, { items: [{ fingerprint: FP_A }, { fingerprint: FP_B }, { fingerprint: FP_C }] });
    expect(p.previewId).toMatch(/^pv_[0-9a-f]{16}$/);
    expect(p.headSha).toBe(HEAD);
    expect(p.viewer).toBe('bob');
    expect(p.expiresAt).toBe(new Date(s.clock.now + 10 * 60_000).toISOString());
    expect(p.items).toEqual([
      { fingerprint: FP_A, title: FINDING_A.title, path: FINDING_A.path, line: 12, startLine: null, placement: 'inline', whySummary: null, body: commentBody(FINDING_A), mentions: [] },
      { fingerprint: FP_B, title: FINDING_B.title, path: FINDING_B.path, line: 40, startLine: null, placement: 'summary', whySummary: 'The line is not part of the diff GitHub shows.', body: commentBody(FINDING_B), mentions: [] },
      { fingerprint: FP_C, title: FINDING_C.title, path: FINDING_C.path, line: 20, startLine: 18, placement: 'inline', whySummary: null, body: commentBody(FINDING_C), mentions: [] },
    ]);
    // A name from the pull request's text is broken with a space, so it notifies no one.
    expect(commentBody(FINDING_A)).toContain('@ carol');
    expect(commentBody(FINDING_A)).not.toContain('@carol');
    expect(p.summary).toBe('Review notes from Airlock: 3 comments.');
    // The route carries the review body's names too: none here, all of it is Airlock's own text.
    expect((await s.preview({ items: [{ fingerprint: FP_A }] })).json).toMatchObject({ reviewBodyMentions: [] });
    const edited = await s.preview({ items: [{ fingerprint: FP_B }], summary: 'For @hana.' });
    expect((edited.json as { reviewBodyMentions: string[] }).reviewBodyMentions).toEqual(['@hana']);
    expect(p.reviewBody).toBe(summaryBody([{ path: FINDING_B.path, line: 40, body: commentBody(FINDING_B) }], p.summary));

    const chosen = await previewed(s, { items: [{ fingerprint: FP_A, placement: 'summary' }, { fingerprint: FP_B, placement: 'inline' }] });
    expect(chosen.items.map((i) => [i.placement, i.whySummary])).toEqual([
      ['summary', 'You chose the summary.'], ['summary', 'The line is not part of the diff GitHub shows.'],
    ]);
    expect(chosen.summary).toBe('Review notes from Airlock: 2 comments.');
  });

  it('the preview uses the edited text and refuses hidden characters, empty text and 4,001 characters', async () => {
    const s = await startService();
    const p = await previewed(s, { items: [{ fingerprint: FP_A, body: 'My own words for @dave.' }], summary: 'Two things to look at.' });
    expect(p.items[0]).toMatchObject({ body: 'My own words for @dave.', mentions: ['@dave'] });
    expect(p.summary).toBe('Two things to look at.');
    expect(p.reviewBody).toBe('Two things to look at.');
    expect((await s.preview({ items: [{ fingerprint: FP_A, body: 'x'.repeat(4000) }] })).status).toBe(200);
    expect((await s.preview({ items: [{ fingerprint: FP_A }], summary: 'y'.repeat(4000) })).status).toBe(200);

    // A refusal about a comment's text names the finding it belongs to.
    const refused: Array<[Record<string, unknown>, string]> = [
      [{ items: [{ fingerprint: FP_A, body: 'Hidden​ here.' }] }, 'The text has a hidden character; remove it: Total is not rounded.'],
      [{ items: [{ fingerprint: FP_A, body: '' }] }, 'The text is empty: Total is not rounded.'],
      [{ items: [{ fingerprint: FP_A }, { fingerprint: FP_B, body: '  \n ' }] }, 'The text is empty: The cache is never cleared.'],
      [{ items: [{ fingerprint: FP_A, body: 'x'.repeat(4001) }] }, 'The text is 1 character longer than the 4000 allowed: Total is not rounded.'],
      [{ items: [{ fingerprint: FP_A }], summary: 'Sum‮mary' }, 'The text has a hidden character; remove it.'],
      [{ items: [{ fingerprint: FP_A }], summary: '' }, 'The text is empty.'],
      [{ items: [{ fingerprint: FP_A }], summary: 'y'.repeat(4001) }, 'The text is 1 character longer than the 4000 allowed.'],
    ];
    for (const [body, error] of refused) {
      const r = await s.preview(body);
      expect([r.status, r.json], JSON.stringify(body).slice(0, 80)).toEqual([400, { error }]);
    }
  });

  it('the preview refuses a finding that is dismissed, fixed, unknown to the review, or already posted under an alias', async () => {
    const s = await startService();
    const fixed = await s.preview({ items: [{ fingerprint: FP_A }, { fingerprint: FP_D }] });
    expect(fixed.status).toBe(404);
    expect((fixed.json as { error: string }).error).toContain('An old problem now fixed');
    const unknown = await s.preview({ items: [{ fingerprint: '9999999999999999' }] });
    expect([unknown.status, unknown.json]).toEqual([404, { error: 'Airlock cannot find that finding in the stored review.' }]);
    const otherReview = await s.preview({ reviewId: 'r_9999999999' });
    expect(otherReview.status).toBe(404);
    const otherPull = await s.preview({ number: 8 });
    expect(otherPull.status).toBe(404);

    // A finding is found under an alias, and it is the finding that is posted.
    const byAlias = await previewed(s, { items: [{ fingerprint: FP_C_ALIAS }] });
    expect(byAlias.items[0]?.title).toBe(FINDING_C.title);
    const same = await s.preview({ items: [{ fingerprint: FP_C }, { fingerprint: FP_C_ALIAS }] });
    expect(same.status).toBe(400);

    await s.writeDismissals([{ fingerprint: FP_C_ALIAS, findingId: 'c_cccccccc', reviewId: REVIEW, reason: 'not-now', text: '', at: '2026-11-11T08:00:00.000Z', learned: null }]);
    const dismissed = await s.preview({ items: [{ fingerprint: FP_C }] });
    expect(dismissed.status).toBe(409);
    expect((dismissed.json as { error: string }).error).toContain(FINDING_C.title);
    await s.writeDismissals([]);

    // An earlier post recorded the finding under its alias only.
    await s.writeRecords([record({ items: [{ fingerprint: FP_C_ALIAS, aliases: [], placement: 'inline' }] })]);
    const posted = await s.preview({ items: [{ fingerprint: FP_C }] });
    expect(posted.status).toBe(409);
    expect((posted.json as { error: string }).error).toContain(FINDING_C.title);
    // ... and one whose aliases hold the finding's fingerprint, with an unknown outcome.
    await s.writeRecords([record({ outcome: 'unknown', githubReviewId: null, url: null, items: [{ fingerprint: 'abcdefabcdefabcd', aliases: [FP_A], placement: 'inline' }] })]);
    const unknownOutcome = await s.preview({ items: [{ fingerprint: FP_A }] });
    expect(unknownOutcome.status).toBe(409);
    expect((unknownOutcome.json as { error: string }).error).toContain(FINDING_A.title);
    expect(beyondAccount(s)).toEqual([]);
  });

  it('a finding whose drafted comment is over 4,000 characters is previewed cut to fit, saying so', async () => {
    const s = await startService();
    const change = Array.from({ length: 600 }, (_, i) => `const row${i} = total(${i});`).join('\n');
    const long = { ...FINDING_A, suggestedChange: change };
    await saveReview({ ...review(), id: 'r_3333333333', findings: [long, FINDING_B] });
    expect([...commentBody(long)].length).toBeLessThanOrEqual(COMMENT_MAX);
    const p = await previewed(s, { reviewId: 'r_3333333333', items: [{ fingerprint: FP_A }, { fingerprint: FP_B }] });
    expect(p.items[0]?.body).toBe(commentBody(long));
    expect(p.items[0]?.body.endsWith(`\n\n${CUT_NOTE}`)).toBe(true);
    expect(p.items[0]?.mentions).toEqual([]);
  });

  it('refuses a review text longer than REVIEW_BODY_MAX', async () => {
    const s = await startService();
    const many = Array.from({ length: 16 }, (_, i) => ({ ...FINDING_B, id: `c_0000000${i.toString(16)}`, fingerprint: `${'6'.repeat(15)}${i.toString(16)}` }));
    await saveReview({ ...review(), id: 'r_1111111111', findings: many });
    const items = many.map((f) => ({ fingerprint: f.fingerprint, body: 'z'.repeat(COMMENT_MAX) }));
    const r = await s.preview({ reviewId: 'r_1111111111', items });
    expect(r.status).toBe(400);
    expect((r.json as { error: string }).error).toContain(String(REVIEW_BODY_MAX));
    expect((await s.preview({ reviewId: 'r_1111111111', items: items.slice(0, 14) })).status).toBe(200);
  });
});

describe('POST /posts', () => {
  it('post sends exactly the stored preview: commit, COMMENT, body and comments, as JSON on standard input', async () => {
    const s = await startService();
    const p = await previewed(s, { items: [{ fingerprint: FP_A }, { fingerprint: FP_B }, { fingerprint: FP_C }] });
    // The request carries the preview id and nothing else: anything more is refused, and nothing is read or sent.
    for (const extra of [{ summary: 'Something else' }, { items: [] }, { repo: 'someone/else' }]) {
      const refused = await s.call('POST', '/posts', { previewId: p.previewId, ...extra });
      expect(refused.status, JSON.stringify(extra)).toBe(400);
    }
    // The preview read only the account it names.
    expect(s.calls.map((c) => [c.line, c.timeoutMs])).toEqual([[USER_LINE, 10_000]]);
    s.calls.splice(0);
    const r = await s.post(p.previewId);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const posted = PostRecordSchema.parse(r.json);
    expect(posted).toMatchObject({
      repo: REPO, number: NUMBER, reviewId: REVIEW, headSha: HEAD, outcome: 'posted', githubReviewId: 555,
      url: `https://github.com/${REPO}/pull/${NUMBER}#pullrequestreview-555`, postedAt: s.clock.date().toISOString(),
      items: [
        { fingerprint: FP_A, aliases: [], placement: 'inline' },
        { fingerprint: FP_B, aliases: [], placement: 'summary' },
        { fingerprint: FP_C, aliases: [FP_C_ALIAS], placement: 'inline' },
      ],
    });
    // The pull request and the signed-in account are read first, each within ten seconds, then the one write.
    expect(s.calls.map((c) => [c.line, c.timeoutMs])).toEqual([[PULL_LINE, 10_000], [USER_LINE, 10_000], [POST_LINE, 45_000]]);
    // The record keeps the account it was posted as and the hash of the review's text, not the text.
    expect(posted).toMatchObject({ postedAs: 'bob', bodyHash: sha256(p.reviewBody) });
    const [write] = s.writes();
    expect(write?.args).toEqual(POST_ARGS);
    expect(write?.input).toBe(JSON.stringify({
      commit_id: HEAD, event: 'COMMENT', body: p.reviewBody,
      comments: [
        { path: FINDING_A.path, line: 12, side: 'RIGHT', body: p.items[0]?.body },
        { path: FINDING_C.path, line: 20, side: 'RIGHT', start_line: 18, start_side: 'RIGHT', body: p.items[2]?.body },
      ],
    }));
    expect(await s.readRecords()).toEqual([posted]);
    expect(await latestPosts(s)).toEqual([posted]);
    // A posted finding cannot be previewed again, and the preview is spent.
    expect((await s.preview({ items: [{ fingerprint: FP_B }] })).status).toBe(409);
    expect((await s.post(p.previewId)).json).toEqual({ error: EXPIRED });
    expect(s.writes()).toHaveLength(1);
  });

  it('post is refused when the head moved, and when the pull request is closed or merged, without calling GitHub', async () => {
    const s = await startService();
    const p = await previewed(s);
    const cases: Array<[string, number, string]> = [
      [pull({ head: { ref: 'feature/totals', sha: 'c'.repeat(40), repo: { full_name: REPO } } }), 409, MOVED],
      [pull({ state: 'closed' }), 409, 'The pull request is closed. Nothing was posted.'],
      [pull({ state: 'closed', merged: true }), 409, 'The pull request has been merged. Nothing was posted.'],
      [pull({ state: undefined }), 502, 'Airlock could not read whether the pull request is open. Nothing was posted.'],
    ];
    for (const [answer, status, error] of cases) {
      s.answers.set(PULL_LINE, { stdout: answer, stderr: '', code: 0 });
      const r = await s.post(p.previewId);
      expect([r.status, r.json]).toEqual([status, { error }]);
    }
    const reads: Array<[ExecResult, string]> = [
      [{ stdout: '{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)', code: 1 }, `GitHub has no pull request ${NUMBER} in ${REPO}.`],
      [{ stdout: '{"message":"Resource not accessible"}', stderr: 'gh: Resource not accessible (HTTP 403)', code: 1 },
        'GitHub refused to show the pull request: Resource not accessible. Nothing was posted.'],
      [{ stdout: '', stderr: 'timed out after 10 s', code: 124 }, 'GitHub did not answer when Airlock read the pull request. Nothing was posted.'],
      [{ stdout: '', stderr: 'error connecting to api.github.com', code: 1 }, 'GitHub did not answer when Airlock read the pull request. Nothing was posted.'],
      [{ stdout: 'not json', stderr: '', code: 0 }, 'Airlock could not read whether the pull request is open. Nothing was posted.'],
      [{ stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login', code: 4 },
        'Airlock could not run gh, or gh is not signed in. Nothing was posted.'],
      [{ stdout: '{"message":"Server Error"}', stderr: 'gh: Server Error (HTTP 500)', code: 1 },
        'GitHub had an error (HTTP 500) when Airlock read the pull request. Nothing was posted.'],
      [{ stdout: '{"message":"Bad Gateway"}', stderr: 'gh: Bad Gateway (HTTP 502)', code: 1 },
        'GitHub had an error (HTTP 502) when Airlock read the pull request. Nothing was posted.'],
    ];
    s.answers.set(PULL_LINE, async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); });
    const missingGh = await s.post(p.previewId);
    expect([missingGh.status, missingGh.json]).toEqual([502, { error: 'Airlock could not run gh, or gh is not signed in. Nothing was posted.' }]);
    for (const [answer, error] of reads) {
      s.answers.set(PULL_LINE, answer);
      const r = await s.post(p.previewId);
      expect([r.status, r.json], error).toEqual([502, { error }]);
    }
    expect(s.writes()).toEqual([]);
    expect(await latestPosts(s)).toEqual([]);
    // Nothing was sent, so the preview still stands.
    s.answers.set(PULL_LINE, { stdout: pull(), stderr: '', code: 0 });
    expect((await s.post(p.previewId)).status).toBe(200);
  });

  it('the account is read beside the pull request, and a post as another account than the preview named is refused', async () => {
    const s = await startService();
    const p = await previewed(s);
    expect(p.viewer).toBe('bob');
    // Both reads are under way at once: the pull request answers only once the account was asked for.
    s.answers.set(PULL_LINE, async () => {
      await until(() => s.calls.some((c) => c.line === USER_LINE), 'the account read');
      return { stdout: pull(), stderr: '', code: 0 };
    });
    s.answers.set(USER_LINE, { stdout: 'alice\n', stderr: '', code: 0 });
    const r = await s.post(p.previewId);
    expect([r.status, r.json]).toEqual([409, { error: 'gh is now signed in as alice, but this preview was made to post as bob. Open the preview again.' }]);
    expect(s.writes()).toEqual([]);
    expect(await latestPosts(s)).toEqual([]);
    expect(await s.readRecords().catch(() => 'no file')).toBe('no file');

    // The same account in another letter case is the same account: posted, and the record says as whom.
    s.answers.set(USER_LINE, { stdout: 'Bob\n', stderr: '', code: 0 });
    const ok = await s.post(p.previewId);
    expect(ok.status).toBe(200);
    expect(PostRecordSchema.parse(ok.json).postedAs).toBe('Bob');
    expect(s.writes()).toHaveLength(1);
  });

  it('a post is refused with the could-not-run-gh sentence when the signed-in account cannot be read', async () => {
    const s = await startService();
    const p = await previewed(s);
    const answers: Array<ExecResult | (() => Promise<ExecResult>)> = [
      { stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login', code: 4 },
      { stdout: '{"message":"Bad credentials"}', stderr: 'gh: Bad credentials (HTTP 401)', code: 1 },
      { stdout: '', stderr: 'timed out after 10 s', code: 124 },
      { stdout: '\n', stderr: '', code: 0 },
      { stdout: 'bob smith\n', stderr: '', code: 0 },
      async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); },
    ];
    for (const answer of answers) {
      s.answers.set(USER_LINE, answer);
      const r = await s.post(p.previewId);
      expect([r.status, r.json]).toEqual([502, { error: NO_GH }]);
    }
    expect(s.writes()).toEqual([]);
    expect(await latestPosts(s)).toEqual([]);
  });

  it('the preview names the account gh is signed in as now, read within ten seconds, and its post goes out as that account', async () => {
    const s = await startService();
    // The stored review was made as bob; gh is now signed in as carol.
    s.answers.set(USER_LINE, { stdout: 'carol\n', stderr: '', code: 0 });
    const p = await previewed(s);
    expect(p.viewer).toBe('carol');
    expect(s.calls.map((c) => [c.line, c.timeoutMs])).toEqual([[USER_LINE, 10_000]]);
    const r = await s.post(p.previewId);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(PostRecordSchema.parse(r.json).postedAs).toBe('carol');
    expect(s.writes()).toHaveLength(1);
  });

  it('after a switch of account, a preview made before it is refused at post, and a new preview names and posts as the new account', async () => {
    const s = await startService();
    const before = await previewed(s);
    expect(before.viewer).toBe('bob');
    s.answers.set(USER_LINE, { stdout: 'alice\n', stderr: '', code: 0 });
    const refused = await s.post(before.previewId);
    expect([refused.status, refused.json]).toEqual([409, { error: 'gh is now signed in as alice, but this preview was made to post as bob. Open the preview again.' }]);
    expect(s.writes()).toEqual([]);
    const after = await previewed(s);
    expect(after.viewer).toBe('alice');
    const posted = await s.post(after.previewId);
    expect(posted.status, JSON.stringify(posted.json)).toBe(200);
    expect(PostRecordSchema.parse(posted.json).postedAs).toBe('alice');
    expect(s.writes()).toHaveLength(1);
  });

  it('a preview is refused with the could-not-run-gh sentence when the account cannot be read, and nothing is stored', async () => {
    const s = await startService();
    class Counting extends Previews {
      added = 0;
      override add(preview: StoredPreview): void { this.added += 1; super.add(preview); }
    }
    const answers: Array<ExecResult | (() => Promise<ExecResult>)> = [
      { stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login', code: 4 },
      { stdout: '', stderr: 'timed out after 10 s', code: 124 },
      { stdout: 'bob smith\n', stderr: '', code: 0 },
      async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); },
    ];
    for (const answer of answers) {
      s.answers.set(USER_LINE, answer);
      const r = await s.preview();
      expect([r.status, r.json]).toEqual([502, { error: NO_GH }]);
      // Called directly, nothing is added to the previews.
      const previews = new Counting();
      const exec: Exec = async (cmd, args) => {
        const line = [cmd, ...args].join(' ');
        const found = s.answers.get(line);
        if (found === undefined) throw new Error(`no fake answer for ${line}`);
        return typeof found === 'function' ? found() : found;
      };
      await expect(buildPreview(
        { home: s.home, now: s.clock.date, previews, dismissals: async () => [], exec },
        { repo: REPO, number: NUMBER, reviewId: REVIEW, items: [{ fingerprint: FP_A }] },
      )).rejects.toThrow(NO_GH);
      expect(previews.added).toBe(0);
    }
    expect(s.writes()).toEqual([]);
  });

  it('a finding dismissed since the preview is refused, and nothing is sent', async () => {
    const s = await startService();
    const p = await previewed(s, { items: [{ fingerprint: FP_A }, { fingerprint: FP_C }] });
    // Dismissed in another panel, under the finding's alias.
    await s.writeDismissals([{ fingerprint: FP_C_ALIAS, findingId: 'c_cccccccc', reviewId: REVIEW, reason: 'not-now', text: '', at: '2026-11-11T08:00:00.000Z', learned: null }]);
    const r = await s.post(p.previewId);
    expect(r.status).toBe(409);
    expect((r.json as { error: string }).error).toContain(FINDING_C.title);
    expect(s.writes()).toEqual([]);
    expect(await latestPosts(s)).toEqual([]);
  });

  it('a refusal whose record cannot be cleared says so and does not keep the preview', async () => {
    const s = await startService();
    const p = await previewed(s);
    const folder = dirname(s.recordsFile());
    // The record is written; then, while GitHub answers, its folder stops taking writes.
    s.answers.set(POST_LINE, async () => { await chmod(folder, 0o500); return REFUSED; });
    try {
      const r = await s.post(p.previewId);
      expect([r.status, r.json]).toEqual([502, {
        error: 'GitHub refused the comments: Validation failed: pull_request_review_thread.line must be part of the diff. Nothing was posted, '
          + 'but Airlock could not clear its own record: press "It was not posted" before trying again.',
      }]);
    } finally {
      await chmod(folder, 0o700);
    }
    expect((await latestPosts(s)).map((x) => x.outcome)).toEqual(['unknown']);
    expect((await s.post(p.previewId)).json).toEqual({ error: EXPIRED });
    expect(s.writes()).toHaveLength(1);
    // The log names the posts file by its place in the Airlock home, never by an absolute path.
    expect(s.log.join('\n')).not.toContain(s.home);
    expect(s.log.some((l) => l.includes('could not be removed') && l.includes('posts/acme__widgets/'))).toBe(true);
  });

  it('two posts of one preview at once send one review', async () => {
    const s = await startService();
    const p = await previewed(s);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    s.answers.set(POST_LINE, async () => { await held; return POSTED; });
    const both = Promise.all([s.post(p.previewId), s.post(p.previewId)]);
    await until(() => s.writes().length === 1, 'the first write');
    release();
    const replies = await both;
    expect(replies.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(s.writes()).toHaveLength(1);
    expect(await s.readRecords()).toHaveLength(1);

    // Two previews of the same finding, posted at once from two panels: one review.
    const s2 = await startService();
    const [one, two] = [await previewed(s2), await previewed(s2)];
    const again = await Promise.all([s2.post(one.previewId), s2.post(two.previewId)]);
    expect(again.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(s2.writes()).toHaveLength(1);

    // A second press while the first is in flight is not a second try, even when GitHub refuses the first.
    const s3 = await startService();
    const p3 = await previewed(s3);
    let refuse!: () => void;
    const refusing = new Promise<void>((r) => { refuse = r; });
    s3.answers.set(POST_LINE, async () => { await refusing; return REFUSED; });
    const pressed = Promise.all([s3.post(p3.previewId), s3.post(p3.previewId)]);
    await until(() => s3.writes().length === 1, 'the first write');
    refuse();
    expect((await pressed).map((r) => r.status).sort()).toEqual([404, 502]);
    expect(s3.writes()).toHaveLength(1);
    // The refused preview can still be posted on purpose.
    s3.answers.set(POST_LINE, POSTED);
    expect((await s3.post(p3.previewId)).status).toBe(200);
  });

  it('a refusal by GitHub removes the record, keeps the preview and says nothing was posted', async () => {
    const s = await startService();
    const p = await previewed(s);
    s.clock.advance(9 * 60_000);
    s.answers.set(POST_LINE, REFUSED);
    const r = await s.post(p.previewId);
    expect([r.status, r.json]).toEqual([502, {
      error: 'GitHub refused the comments: Validation failed: pull_request_review_thread.line must be part of the diff. Nothing was posted.',
    }]);
    expect(await s.readRecords()).toEqual([]);
    expect(await latestPosts(s)).toEqual([]);
    // Kept for another ten minutes from the refusal, not from the preview.
    s.clock.advance(9 * 60_000);
    s.answers.set(POST_LINE, POSTED);
    expect((await s.post(p.previewId)).status).toBe(200);
    expect(s.writes()).toHaveLength(2);

    // A long refusal is cut so the whole sentence fits, and still ends by saying nothing was posted.
    const s2 = await startService();
    const p2 = await previewed(s2);
    s2.answers.set(POST_LINE, { stdout: JSON.stringify({ message: `No ${'very '.repeat(200)}long.` }), stderr: 'gh: No (HTTP 403)', code: 1 });
    const long = await s2.post(p2.previewId);
    const error = (long.json as { error: string }).error;
    expect(long.status).toBe(502);
    expect([...error].length).toBeLessThanOrEqual(MESSAGE_MAX);
    expect(error).toMatch(/^GitHub refused the comments: No very .*…\. Nothing was posted\.$/);
  });

  it('only a 4xx answer is a refusal: 403, 404 and 422 keep nothing, 500, 502 and 503 leave an unknown record', async () => {
    for (const status of [403, 404, 422]) {
      const s = await startService();
      const p = await previewed(s);
      s.answers.set(POST_LINE, { stdout: '{"message":"No"}', stderr: `gh: No (HTTP ${status})`, code: 1 });
      const r = await s.post(p.previewId);
      expect([r.status, r.json], String(status)).toEqual([502, { error: 'GitHub refused the comments: No. Nothing was posted.' }]);
      expect(await latestPosts(s)).toEqual([]);
      s.answers.set(POST_LINE, POSTED);
      expect((await s.post(p.previewId)).status, String(status)).toBe(200);
    }
    for (const status of [500, 502, 503]) {
      const s = await startService();
      const p = await previewed(s);
      s.answers.set(POST_LINE, { stdout: '{"message":"Server trouble"}', stderr: `gh: Server trouble (HTTP ${status})`, code: 1 });
      const r = await s.post(p.previewId);
      expect([r.status, r.json], String(status)).toEqual([504, { error: UNKNOWN }]);
      expect((await latestPosts(s)).map((x) => x.outcome)).toEqual(['unknown']);
      expect((await s.preview()).status).toBe(409);
      expect((await s.post(p.previewId)).json).toEqual({ error: EXPIRED });
      expect(s.writes()).toHaveLength(1);
    }
  });

  it("the record's address is built from the id, and a reply without a usable id leaves an unknown record", async () => {
    const s = await startService();
    const p = await previewed(s);
    s.answers.set(POST_LINE, { stdout: JSON.stringify({ id: 81, html_url: 'https://evil.example/acme/widgets/pull/7#pullrequestreview-81' }), stderr: '', code: 0 });
    const r = await s.post(p.previewId);
    expect(PostRecordSchema.parse(r.json)).toMatchObject({
      outcome: 'posted', githubReviewId: 81, url: `https://github.com/${REPO}/pull/${NUMBER}#pullrequestreview-81`,
    });

    for (const stdout of ['{"html_url":"https://github.com/acme/widgets/pull/7#pullrequestreview-9"}', '{"id":"9"}', '{"id":-1}', 'Created']) {
      const t = await startService();
      const q = await previewed(t);
      t.answers.set(POST_LINE, { stdout, stderr: '', code: 0 });
      const reply = await t.post(q.previewId);
      expect([reply.status, reply.json], stdout).toEqual([504, { error: UNKNOWN }]);
      expect(await latestPosts(t)).toMatchObject([{ outcome: 'unknown', githubReviewId: null, url: null }]);
    }
  });

  it('a timeout leaves an unknown record, blocks those findings, and is never retried', async () => {
    const s = await startService();
    const p = await previewed(s);
    s.answers.set(POST_LINE, TIMED_OUT);
    const r = await s.post(p.previewId);
    expect([r.status, r.json]).toEqual([504, { error: UNKNOWN }]);
    const [unknown] = await latestPosts(s);
    expect(unknown).toMatchObject({ outcome: 'unknown', githubReviewId: null, url: null });
    expect(unknown?.items.map((i) => i.fingerprint)).toEqual([FP_A, FP_B]);
    // The same preview cannot be sent again, a new preview of those findings is refused, and time passing sends nothing.
    expect((await s.post(p.previewId)).json).toEqual({ error: EXPIRED });
    const blocked = await s.preview({ items: [{ fingerprint: FP_B }] });
    expect(blocked.status).toBe(409);
    expect((blocked.json as { error: string }).error).toContain(FINDING_B.title);
    s.clock.advance(60 * 60_000);
    expect(s.writes()).toHaveLength(1);

    // A command that could not be run or was cut off is not known either.
    const s2 = await startService();
    const p2 = await previewed(s2);
    s2.answers.set(POST_LINE, async () => { throw new Error('spawn gh ENOENT'); });
    expect((await s2.post(p2.previewId)).status).toBe(504);
    const s3 = await startService();
    const p3 = await previewed(s3);
    s3.answers.set(POST_LINE, { stdout: '', stderr: 'error connecting to api.github.com', code: 1 });
    expect((await s3.post(p3.previewId)).status).toBe(504);
    expect((await latestPosts(s3))[0]?.outcome).toBe('unknown');
  });

  it('forget removes an unknown record and refuses a posted one', async () => {
    const s = await startService();
    const p = await previewed(s);
    s.answers.set(POST_LINE, TIMED_OUT);
    await s.post(p.previewId);
    const [unknown] = await latestPosts(s);
    const forget = (id: string) => s.call('POST', '/posts/forget', { repo: REPO, number: NUMBER, id });
    expect((await forget('post_000000000000')).json).toEqual({ forgotten: false });
    expect((await forget(unknown!.id)).json).toEqual({ forgotten: true });
    expect(await latestPosts(s)).toEqual([]);

    s.answers.set(POST_LINE, POSTED);
    const again = await previewed(s);
    const posted = PostRecordSchema.parse((await s.post(again.previewId)).json);
    const refused = await forget(posted.id);
    expect(refused.status).toBe(409);
    expect(await latestPosts(s)).toEqual([posted]);
    // Another pull request's forget does not reach this one's records.
    expect((await s.call('POST', '/posts/forget', { repo: REPO, number: 8, id: posted.id })).json).toEqual({ forgotten: false });
  });

  it('"It was not posted" asks GitHub first: a review by the account, at the commit, with the same text, makes the record posted', async () => {
    const s = await startService();
    const p = await previewed(s);
    s.answers.set(POST_LINE, TIMED_OUT);
    await s.post(p.previewId);
    const [unknown] = await latestPosts(s);
    expect(unknown).toMatchObject({ outcome: 'unknown', postedAs: 'bob', bodyHash: sha256(p.reviewBody) });
    const theirs = (id: number, over: Record<string, unknown> = {}) =>
      ({ id, user: { login: 'bob' }, commit_id: HEAD, body: p.reviewBody, state: 'COMMENTED', ...over });
    // Two pages, as gh prints them; only the last review is this post.
    s.answers.set(REVIEWS_LINE, {
      stdout: `${JSON.stringify([theirs(11, { user: { login: 'alice' } }), theirs(12, { commit_id: 'c'.repeat(40) }), theirs(13, { body: 'Another text.' }), theirs(14, { user: null })])}${JSON.stringify([theirs(901, { user: { login: 'BOB' } })])}`,
      stderr: '', code: 0,
    });
    const r = await s.call('POST', '/posts/forget', { repo: REPO, number: NUMBER, id: unknown!.id });
    expect(r.status).toBe(409);
    const reply = r.json as { error: string; record: PostRecord };
    expect(reply.error).toBe(FOUND);
    const posted = { ...unknown!, outcome: 'posted', githubReviewId: 901, url: `https://github.com/${REPO}/pull/${NUMBER}#pullrequestreview-901` };
    expect(PostRecordSchema.parse(reply.record)).toEqual(posted);
    expect(await latestPosts(s)).toEqual([posted]);
    expect(s.calls.filter((c) => c.line === REVIEWS_LINE).map((c) => c.timeoutMs)).toEqual([30_000]);
    // Nothing more was sent, and the findings are now refused as posted.
    expect(s.writes()).toHaveLength(1);
    const again = await s.preview();
    expect(again.status).toBe(409);
    expect((again.json as { error: string }).error).toContain('already posted');
    // A posted record is kept, and GitHub is not asked again.
    expect((await s.call('POST', '/posts/forget', { repo: REPO, number: NUMBER, id: unknown!.id })).status).toBe(409);
    expect(s.calls.filter((c) => c.line === REVIEWS_LINE)).toHaveLength(1);
  });

  it('"It was not posted" forgets the record when GitHub has no such review, and keeps it when GitHub cannot be asked', async () => {
    const s = await startService();
    const p = await previewed(s);
    s.answers.set(POST_LINE, TIMED_OUT);
    await s.post(p.previewId);
    const [unknown] = await latestPosts(s);
    const forget = () => s.call('POST', '/posts/forget', { repo: REPO, number: NUMBER, id: unknown!.id });
    const unreadable: Array<ExecResult | (() => Promise<ExecResult>)> = [
      { stdout: '{"message":"Server Error"}', stderr: 'gh: Server Error (HTTP 500)', code: 1 },
      { stdout: '', stderr: 'timed out after 30 s', code: 124 },
      { stdout: 'not json', stderr: '', code: 0 },
      async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); },
    ];
    for (const answer of unreadable) {
      s.answers.set(REVIEWS_LINE, answer);
      const r = await forget();
      expect([r.status, r.json]).toEqual([502, { error: NOT_ASKED }]);
      expect(await latestPosts(s)).toEqual([unknown]);
    }
    s.answers.set(REVIEWS_LINE, {
      stdout: JSON.stringify([{ id: 5, user: { login: 'bob' }, commit_id: HEAD, body: `${p.reviewBody} `, state: 'COMMENTED' }]), stderr: '', code: 0,
    });
    expect((await forget()).json).toEqual({ forgotten: true });
    expect(await latestPosts(s)).toEqual([]);
    expect(s.writes()).toHaveLength(1);
  });

  it('a record kept before the hash and account were (no bodyHash) is forgotten as before, without asking GitHub', async () => {
    const s = await startService();
    await s.writeRecords([record({ outcome: 'unknown', githubReviewId: null, url: null })]);
    const r = await s.call('POST', '/posts/forget', { repo: REPO, number: NUMBER, id: 'post_0123456789ab' });
    expect(r.json).toEqual({ forgotten: true });
    expect(s.calls).toEqual([]);
  });

  it('an expired preview and an unknown preview id are refused', async () => {
    const s = await startService();
    const p = await previewed(s);
    s.clock.advance(10 * 60_000);
    expect([(await s.post(p.previewId)).status, (await s.post(p.previewId)).json]).toEqual([404, { error: EXPIRED }]);
    const unknown = await s.post('pv_0000000000000000');
    expect([unknown.status, unknown.json]).toEqual([404, { error: EXPIRED }]);
    // At most twenty are kept: the oldest goes first.
    const first = await previewed(s);
    for (let i = 0; i < 20; i += 1) await previewed(s);
    expect((await s.post(first.previewId)).json).toEqual({ error: EXPIRED });
    expect(beyondAccount(s)).toEqual([]);
  });

  it('a broken record file stops a preview and a post rather than being read as empty', async () => {
    const s = await startService();
    const p = await previewed(s);
    await s.writeRecords([{ not: 'a record' }]);
    expect((await s.preview()).status).toBe(500);
    expect((await s.post(p.previewId)).status).toBe(500);
    expect(s.writes()).toEqual([]);
  });

  it('a stored record that does not parse is left out of the list and logged, and the rest are returned', async () => {
    const s = await startService();
    const good = record();
    await s.writeRecords([{ ...record(), id: 'post_bad', outcome: 'maybe' }, good, 'not a record']);
    expect(await latestPosts(s)).toEqual([good]);
    const lines = s.log.filter((l) => l.includes('posts'));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.includes(`${NUMBER}.json`) && /\b0\b/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes(`${NUMBER}.json`) && /\b2\b/.test(l))).toBe(true);
    expect(s.log.join('\n')).not.toContain('maybe');
    expect(s.log.join('\n')).not.toContain('not a record');
    // By its place in the Airlock home, never an absolute path.
    expect(lines.every((l) => l.includes(`posts/acme__widgets/${NUMBER}.json`))).toBe(true);
    expect(s.log.join('\n')).not.toContain(s.home);

    // The panel reads the latest review on every check: the same lines are not logged again, and a change is logged once.
    const said = (): string[] => s.log.filter((l) => l.includes('posts file'));
    const first = said();
    for (let i = 0; i < 3; i += 1) expect(await latestPosts(s)).toEqual([good]);
    expect(said()).toEqual(first);
    await s.writeRecords([good, { not: 'a record' }]);
    for (let i = 0; i < 3; i += 1) await latestPosts(s);
    expect(said().slice(first.length)).toEqual([`the posts file posts/acme__widgets/${NUMBER}.json: record 1 does not match the contract and was left out`]);
    // Once the file is good again, a later problem is logged again.
    await s.writeRecords([good]);
    await latestPosts(s);
    await s.writeRecords([good, 'x']);
    await latestPosts(s);
    expect(said()).toHaveLength(first.length + 2);
  });

  it('the preview route takes a full-size body; other routes keep the 64 KB limit', async () => {
    const s = await startService();
    const many = Array.from({ length: 30 }, (_, i) => ({ ...FINDING_A, id: `c_000000${i.toString(16).padStart(2, '0')}`, fingerprint: `${'7'.repeat(14)}${i.toString(16).padStart(2, '0')}` }));
    await saveReview({ ...review(), id: 'r_2222222222', findings: many });
    // Each comment and the summary at 4,000 characters, each character three bytes in UTF-8.
    const items = many.map((f) => ({ fingerprint: f.fingerprint, body: '€'.repeat(COMMENT_MAX) }));
    const full = { repo: REPO, number: NUMBER, reviewId: 'r_2222222222', items, summary: '€'.repeat(4000) };
    expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(300 * 1024);
    const r = await s.call('POST', '/posts/preview', full);
    expect(r.status, JSON.stringify(r.json).slice(0, 200)).toBe(200);
    expect(PostPreviewReplySchema.parse(r.json).items).toHaveLength(30);

    const huge = await s.call('POST', '/posts/preview', { ...full, summary: 'x'.repeat(600 * 1024) });
    expect([huge.status, huge.json]).toEqual([413, { error: 'The request body is too large.' }]);
    const other = await s.call('POST', '/dismissals', {
      repo: REPO, number: NUMBER, reviewId: REVIEW, findingId: 'c_aaaaaaaa', reason: 'not-now', text: 'x'.repeat(100 * 1024),
    });
    expect([other.status, other.json]).toEqual([413, { error: 'The request body is too large.' }]);
  });

  it('the post routes refuse a request without an Origin header even with the token', async () => {
    const s = await startService();
    const p = await previewed(s);
    const bare = { Authorization: `Bearer ${await readOrCreateToken(s.home)}` };
    const bodies: Array<[string, unknown]> = [
      ['/posts/preview', { repo: REPO, number: NUMBER, reviewId: REVIEW, items: [{ fingerprint: FP_A }] }],
      ['/posts', { previewId: p.previewId }],
      ['/posts/forget', { repo: REPO, number: NUMBER, id: 'post_000000000000' }],
    ];
    for (const [path, body] of bodies) {
      const r = await s.call('POST', path, body, bare);
      expect([r.status, r.json], path).toEqual([403, { error: 'Airlock does not accept requests from this page.' }]);
    }
    expect(beyondAccount(s)).toEqual([]);
    // The other routes still answer a local command without an Origin.
    expect((await s.call('GET', `/reviews/latest?repo=${REPO}&number=${NUMBER}`, undefined, bare)).status).toBe(200);
  });

  it('the log line of a post holds no comment text', async () => {
    const s = await startService();
    const marker = 'Marker words seven f three a';
    const body = { items: [{ fingerprint: FP_A, body: `${marker} inline.` }, { fingerprint: FP_B, body: `${marker} summary.` }], summary: `${marker} summary text.` };
    await s.post((await previewed(s, body)).previewId);
    await s.writeRecords([]);
    s.answers.set(POST_LINE, REFUSED);
    await s.post((await previewed(s, body)).previewId);
    s.answers.set(POST_LINE, TIMED_OUT);
    await s.post((await previewed(s, body)).previewId);
    const lines = s.log.filter((l) => l.startsWith('post '));
    expect(lines).toEqual([
      `post ${REPO}#${NUMBER}: 2 comments, posted`,
      `post ${REPO}#${NUMBER}: 2 comments, refused (HTTP 422)`,
      `post ${REPO}#${NUMBER}: 2 comments, outcome unknown`,
    ]);
    expect(s.log.join('\n')).not.toContain('Marker');
    expect(s.log.join('\n')).not.toContain('pull_request_review_thread');
  });
});

describe('post, called directly', () => {
  const NOW = Date.parse('2026-11-11T09:00:00.000Z');
  const homes: string[] = [];
  afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });

  const stored = (comments: number): StoredPreview => ({
    previewId: 'pv_0123456789abcdef', repo: REPO, number: NUMBER, reviewId: REVIEW, headSha: HEAD, viewer: 'bob',
    payload: {
      commit_id: HEAD, event: 'COMMENT', body: 'Review notes from Airlock.',
      comments: Array.from({ length: comments }, (_, i) => ({ path: 'src/a.ts', line: i + 1, side: 'RIGHT' as const, body: `Comment ${i}.` })),
    },
    items: [{ fingerprint: FP_A, aliases: [], placement: 'inline', title: FINDING_A.title }],
    expiresAt: NOW + 60_000,
  });

  async function rig(write?: PostDeps['write']) {
    const home = await mkdtemp(join(tmpdir(), 'airlock-post-direct-'));
    homes.push(home);
    const calls: string[] = [];
    const log: string[] = [];
    const answers = new Map<string, ExecResult>([
      [PULL_LINE, { stdout: pull(), stderr: '', code: 0 }], [USER_LINE, { stdout: 'bob\n', stderr: '', code: 0 }], [POST_LINE, POSTED],
    ]);
    const exec: Exec = async (cmd, args) => {
      const line = [cmd, ...args].join(' ');
      calls.push(line);
      const answer = answers.get(line);
      if (answer === undefined) throw new Error(`no fake answer for ${line}`);
      return answer;
    };
    const previews = new Previews();
    const deps: PostDeps = {
      home, now: () => new Date(NOW), previews, dismissals: async () => [], exec, log: (l) => log.push(l), ...(write === undefined ? {} : { write }),
    };
    const file = join(home, 'posts', 'acme__widgets', `${NUMBER}.json`);
    return { home, calls, log, previews, deps, file };
  }

  it("a payload that fails sendReview's checks is refused before the record is written, so it leaves no record and nothing runs", async () => {
    const r = await rig();
    r.previews.add(stored(31));
    await expect(post(r.deps, 'pv_0123456789abcdef')).rejects.toThrow('A post holds at most 30 comments.');
    expect(r.calls).toEqual([PULL_LINE, USER_LINE]);
    await expect(readFile(r.file, 'utf8')).rejects.toThrow();
    // Nothing was sent, so the preview still stands.
    expect(r.previews.get('pv_0123456789abcdef', new Date(NOW))).not.toBeNull();
  });

  it('when GitHub accepted the post, writing the posted record is tried three times and the answer is still the posted record', async () => {
    let writes = 0;
    const failOn = new Set<number>();
    const write: NonNullable<PostDeps['write']> = async (path, list) => {
      writes += 1;
      if (failOn.has(writes)) throw new Error(`EACCES: permission denied, open '${path}.tmp'`);
      await writeList(path, list);
    };
    // The first try fails, the second is written.
    let r = await rig(write);
    failOn.clear(); [2].forEach((n) => failOn.add(n));
    r.previews.add(stored(1));
    const once = await post(r.deps, 'pv_0123456789abcdef');
    expect(once).toMatchObject({ outcome: 'posted', githubReviewId: 555 });
    expect(writes).toBe(3);
    expect(JSON.parse(await readFile(r.file, 'utf8'))).toEqual([once]);
    expect(r.log.filter((l) => l.includes('could not'))).toEqual([]);

    // Every try fails: three tries, the reply is still the posted record, the record on disk stays unknown and the log says so.
    writes = 0;
    r = await rig(write);
    failOn.clear(); [2, 3, 4, 5].forEach((n) => failOn.add(n));
    r.previews.add(stored(1));
    const never = await post(r.deps, 'pv_0123456789abcdef');
    expect(never).toMatchObject({ outcome: 'posted', githubReviewId: 555 });
    expect(writes).toBe(4);
    expect(JSON.parse(await readFile(r.file, 'utf8'))).toMatchObject([{ outcome: 'unknown' }]);
    expect(r.calls.filter((c) => c === POST_LINE)).toHaveLength(1);
    const said = r.log.filter((l) => l.includes('could not be updated'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('three tries');
    expect(said[0]).not.toContain(r.home);
  });
});
