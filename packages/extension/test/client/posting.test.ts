import { describe, expect, it } from 'vitest';
import type { PostPreviewBody } from '@airlock/shared';
import { NOT_PROVED } from '../../src/client/proof';
import { NOT_UNDERSTOOD, POST_NOT_SENT, POST_TIMEOUT_MS, ServiceClient, ServiceError } from '../../src/client/service';
import { BASE, CANNOT_ASK_GITHUB, FakeService, GITHUB_HAS_IT, OTHER_TOKEN, TOKEN, cannotAskGithub, githubHasIt, json, never } from '../helpers/fake-service';
import { FakeTimers } from '../helpers/fake-timers';
import { previewItem, previewOf, recordOf } from '../helpers/post-fixtures';

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

const FP = '0000000000000001';
const previewBody: PostPreviewBody = { repo: 'acme/widgets', number: 1, reviewId: 'r_0000000001', items: [{ fingerprint: FP }] };
const preview = previewOf([previewItem({ fingerprint: FP, title: 'Problem 1', path: 'src/file1.ts', lineHint: 10 })]);
const posted = recordOf([FP]);

describe('posting through the client', () => {
  it('previewPost sends the body to /posts/preview and returns the checked preview', async () => {
    const { svc, client } = setup();
    svc.on('POST /posts/preview', () => json(preview));
    expect(await client.previewPost(previewBody)).toEqual(preview);
    // The token goes only after the service proved it holds it.
    expect(svc.calls).toEqual(['GET /hello', 'POST /posts/preview']);
    const [hello, req] = svc.requests;
    expect(hello?.headers.has('authorization')).toBe(false);
    expect(req?.body).toEqual(previewBody);
    expect(req?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('previewPost, post and forgetPost send nothing with the token to something that cannot prove it holds it', async () => {
    for (const key of [OTHER_TOKEN, null]) {
      const { svc, client } = setup();
      svc.proofKey = key;
      expect(await failure(client.previewPost(previewBody))).toMatchObject({ kind: 'unproven', message: NOT_PROVED });
      // A post whose proof fails was never sent: it says so, and is not a post whose outcome is unknown.
      expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'unsent', why: 'unproven', message: NOT_PROVED });
      expect(await failure(client.forgetPost({ repo: 'acme/widgets', number: 1, id: posted.id }))).toMatchObject({ kind: 'unproven', message: NOT_PROVED });
      expect(svc.requests.filter((r) => r.headers.has('authorization'))).toEqual([]);
      expect(new Set(svc.calls)).toEqual(new Set(['GET /hello']));
    }
  });

  it('previewPost: a refusal is a problem in the service words; a reply off the contract is not understood', async () => {
    const { svc, client } = setup();
    svc.on('POST /posts/preview', () => json({ error: 'The text is empty.' }, 400));
    expect(await failure(client.previewPost(previewBody))).toMatchObject({ kind: 'problem', message: 'The text is empty.' });
    svc.on('POST /posts/preview', () => json({ ...preview, previewId: 'pv_nope' }));
    expect(await failure(client.previewPost(previewBody))).toMatchObject({ kind: 'problem', message: NOT_UNDERSTOOD });
  });

  it('post sends only the preview id and returns the posted record', async () => {
    const { svc, client } = setup();
    svc.on('POST /posts', () => json(posted));
    expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'posted', record: posted });
    expect(svc.calls).toEqual(['GET /hello', 'POST /posts']);
    expect(svc.requests[1]?.body).toEqual({ previewId: preview.previewId });
    expect(svc.requests[1]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    [502, 'GitHub refused the comments: Validation Failed. Nothing was posted.'],
    [409, 'The pull request has new commits since this review. Review the push, then post.'],
    [400, 'Bad.'],
  ])('post: a %i is refused, in the service words', async (status, error) => {
    const { svc, client } = setup();
    svc.on('POST /posts', () => json({ error }, status));
    expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'refused', message: error });
  });

  it('post: a 404 is no preview, with the service words, never a refusal: a copy the browser sent again gets it too', async () => {
    const { svc, client } = setup();
    const expired = 'This preview has expired. Open the preview again.';
    svc.on('POST /posts', () => json({ error: expired }, 404));
    expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'no-preview', message: expired });
    // A 404 whose body is off the contract still says nothing was found; the panel's own sentence stands in.
    svc.on('POST /posts', () => json({ nope: true }, 404));
    expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'no-preview', message: NOT_UNDERSTOOD });
    expect(svc.calls.filter((c) => c === 'POST /posts')).toHaveLength(2);
  });

  it('post: a 504 is unclear, with the service words', async () => {
    const { svc, client } = setup();
    const said = 'Airlock could not tell whether GitHub accepted the comments. Look at the pull request before posting again.';
    svc.on('POST /posts', () => json({ error: said }, 504));
    expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'unclear', message: said, status: 504 });
  });

  it('post: a 500, a dropped connection, and a reply off the contract are unclear, never refused', async () => {
    const { svc, client } = setup();
    svc.on('POST /posts', () => json({ error: 'Airlock had a problem.' }, 500));
    expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'unclear', message: 'Airlock had a problem.', status: 500 });
    svc.on('POST /posts', () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'unclear' });
    svc.on('POST /posts', () => json({ ...posted, url: 'https://evil.example/' }));
    expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'unclear' });
    svc.on('POST /posts', () => json({ ...posted, outcome: 'unknown', url: null, githubReviewId: null }));
    expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'unclear' });
  });

  it('post: when the proof gets no answer, nothing was sent, and it says so', async () => {
    const { svc, client } = setup();
    svc.on('GET /hello', () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'unsent', why: 'offline', message: POST_NOT_SENT });
    expect(POST_NOT_SENT).toBe('Airlock could not reach its service, so nothing was sent.');
    expect(svc.calls).toEqual(['GET /hello']);
  });

  it('post: a connection cut after the proof is unclear, as the post may have been sent', async () => {
    const { svc, client } = setup();
    svc.on('POST /posts', () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'unclear' });
    expect(svc.calls).toEqual(['GET /hello', 'POST /posts']);
  });

  it('post: waits 75 seconds, then is unclear', async () => {
    const { svc, client, timers } = setup();
    svc.on('POST /posts', never);
    const result = client.post({ previewId: preview.previewId });
    // The proof comes first (its HMAC is asynchronous), then the post is asked.
    for (let i = 0; i < 100 && !svc.calls.includes('POST /posts'); i += 1) await tick();
    expect(svc.calls).toEqual(['GET /hello', 'POST /posts']);
    expect(timers.delays()).toEqual([POST_TIMEOUT_MS]);
    expect(POST_TIMEOUT_MS).toBe(75_000);
    timers.fire();
    expect(await result).toEqual({ outcome: 'unclear' });
  });

  it('post: a refused token is unpaired; no token sends nothing', async () => {
    const { svc, client } = setup();
    svc.on('POST /posts', () => json({ error: 'Airlock needs its pairing token.' }, 401));
    expect(await failure(client.post({ previewId: preview.previewId }))).toMatchObject({ kind: 'unpaired' });
    const none = setup(null);
    expect(await failure(none.client.post({ previewId: preview.previewId }))).toMatchObject({ kind: 'unpaired' });
    expect(none.svc.calls).toEqual([]);
  });

  it('forgetPost sends the body to /posts/forget and returns whether it forgot', async () => {
    const { svc, client } = setup();
    svc.on('POST /posts/forget', () => json({ forgotten: true }));
    const body = { repo: 'acme/widgets', number: 1, id: posted.id };
    expect(await client.forgetPost(body)).toEqual({ forgotten: true });
    expect(svc.calls).toEqual(['GET /hello', 'POST /posts/forget']);
    expect(svc.requests[1]?.body).toEqual(body);
    svc.on('POST /posts/forget', () => json({ error: 'This review was posted, so Airlock keeps its record.' }, 409));
    expect(await failure(client.forgetPost(body))).toMatchObject({ kind: 'problem', message: 'This review was posted, so Airlock keeps its record.' });
    svc.on('POST /posts/forget', () => json({ forgotten: 'yes' }));
    expect(await failure(client.forgetPost(body))).toMatchObject({ kind: 'problem', message: NOT_UNDERSTOOD });
  });

  it('forgetPost: GitHub has the review, so nothing was forgotten, and the record comes back posted', async () => {
    const { svc, client } = setup();
    const body = { repo: 'acme/widgets', number: 1, id: posted.id };
    svc.on('POST /posts/forget', () => githubHasIt(posted));
    expect(await client.forgetPost(body)).toEqual({ forgotten: false, found: { record: posted, message: GITHUB_HAS_IT } });
    expect(GITHUB_HAS_IT).toBe('GitHub has this review: it was posted. Nothing was forgotten.');
  });

  it('forgetPost: a found record that is not the one asked about, or not posted, is a refusal in the service words', async () => {
    const { svc, client } = setup();
    const body = { repo: 'acme/widgets', number: 1, id: posted.id };
    for (const record of [
      recordOf([FP], { id: 'post_bbbbbbbbbbbb' }),
      recordOf([FP], { number: 2, url: 'https://github.com/acme/widgets/pull/2#pullrequestreview-77' }),
      recordOf([FP], { outcome: 'unknown' }),
    ]) {
      svc.on('POST /posts/forget', () => githubHasIt(record));
      expect(await failure(client.forgetPost(body))).toMatchObject({ kind: 'problem', message: GITHUB_HAS_IT });
    }
    // The record's repository may be spelt in another letter case, as on GitHub.
    const spelt = recordOf([FP], { repo: 'Acme/Widgets', url: 'https://github.com/Acme/Widgets/pull/1#pullrequestreview-77' });
    svc.on('POST /posts/forget', () => githubHasIt(spelt));
    expect(await client.forgetPost(body)).toEqual({ forgotten: false, found: { record: spelt, message: GITHUB_HAS_IT } });
  });

  it('forgetPost: GitHub could not be asked, so the record was kept: a refusal in the service words', async () => {
    const { svc, client } = setup();
    svc.on('POST /posts/forget', () => cannotAskGithub());
    expect(await failure(client.forgetPost({ repo: 'acme/widgets', number: 1, id: posted.id }))).toMatchObject({ kind: 'problem', message: CANNOT_ASK_GITHUB });
    expect(CANNOT_ASK_GITHUB).toBe('Airlock could not ask GitHub whether this review exists, so the record was kept.');
  });
});
