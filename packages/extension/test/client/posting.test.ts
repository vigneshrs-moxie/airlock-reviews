import { describe, expect, it } from 'vitest';
import type { PostPreviewBody } from '@airlock/shared';
import { NOT_UNDERSTOOD, POST_TIMEOUT_MS, ServiceClient, ServiceError } from '../../src/client/service';
import { BASE, FakeService, TOKEN, json, never } from '../helpers/fake-service';
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
    const req = svc.requests[0];
    expect(req?.url.pathname).toBe('/posts/preview');
    expect(req?.body).toEqual(previewBody);
    expect(req?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
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
    expect(svc.requests[0]?.body).toEqual({ previewId: preview.previewId });
  });

  it.each([
    [502, 'GitHub refused the comments: Validation Failed. Nothing was posted.'],
    [409, 'The pull request has new commits since this review. Review the push, then post.'],
    [404, 'This preview has expired. Open the preview again.'],
    [400, 'Bad.'],
  ])('post: a %i is refused, in the service words', async (status, error) => {
    const { svc, client } = setup();
    svc.on('POST /posts', () => json({ error }, status));
    expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'refused', message: error });
  });

  it('post: a 504 is unclear, with the service words', async () => {
    const { svc, client } = setup();
    const said = 'Airlock could not tell whether GitHub accepted the comments. Look at the pull request before posting again.';
    svc.on('POST /posts', () => json({ error: said }, 504));
    expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'unclear', message: said });
  });

  it('post: a 500, a dropped connection, and a reply off the contract are unclear, never refused', async () => {
    const { svc, client } = setup();
    svc.on('POST /posts', () => json({ error: 'Airlock had a problem.' }, 500));
    expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'unclear', message: 'Airlock had a problem.' });
    svc.on('POST /posts', () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'unclear' });
    svc.on('POST /posts', () => json({ ...posted, url: 'https://evil.example/' }));
    expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'unclear' });
    svc.on('POST /posts', () => json({ ...posted, outcome: 'unknown', url: null, githubReviewId: null }));
    expect(await client.post({ previewId: preview.previewId })).toEqual({ outcome: 'unclear' });
  });

  it('post: waits 75 seconds, then is unclear', async () => {
    const { svc, client, timers } = setup();
    svc.on('POST /posts', never);
    const result = client.post({ previewId: preview.previewId });
    await tick();
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
    expect(svc.requests[0]?.body).toEqual(body);
    svc.on('POST /posts/forget', () => json({ error: 'This review was posted, so Airlock keeps its record.' }, 409));
    expect(await failure(client.forgetPost(body))).toMatchObject({ kind: 'problem', message: 'This review was posted, so Airlock keeps its record.' });
    svc.on('POST /posts/forget', () => json({ forgotten: 'yes' }));
    expect(await failure(client.forgetPost(body))).toMatchObject({ kind: 'problem', message: NOT_UNDERSTOOD });
  });
});
