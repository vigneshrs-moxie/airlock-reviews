import { afterEach, describe, expect, it } from 'vitest';
import type { LatestReply, PostPreviewBody, PostRecord } from '@airlock/shared';
import { ServiceClient } from '../../src/client/service';
import { NO_POST_RECORD, startPanel } from '../../src/state/machine';
import { reduce, type PanelState, type PostReply } from '../../src/state/reduce';
import type { SettingsStore } from '../../src/state/settings';
import type { TabWatcher } from '../../src/state/tab';
import { BASE, FakeService, TOKEN, held, json, latestFor, prSummary, prUrl } from '../helpers/fake-service';
import { FakeTimers } from '../helpers/fake-timers';
import { UNKNOWN_SENTENCE, previewItem, previewOf, recordOf } from '../helpers/post-fixtures';

const FP = '0000000000000001';
const FP2 = '0000000000000002';
const preview = previewOf([previewItem({ fingerprint: FP, title: 'Problem 1', path: 'src/file1.ts', lineHint: 10 })]);
const previewBody: PostPreviewBody = { repo: 'acme/widgets', number: 1, reviewId: 'r_0000000001', items: [{ fingerprint: FP }] };

function settings(): SettingsStore {
  return {
    async getToken() { return TOKEN; },
    async setToken() {},
    async getDefaultDepth() { return null; },
    async setDefaultDepth() {},
  };
}

function tab(url: string): TabWatcher {
  return { current: async () => ({ tabId: 3, url }), onChange: () => () => undefined };
}

const panels: { stop(): void }[] = [];
afterEach(() => {
  for (const p of panels.splice(0)) p.stop();
});

function harness(prepare?: (svc: FakeService, latest: LatestReply) => void) {
  const svc = new FakeService();
  const latest = latestFor(prSummary());
  svc.latest.set('acme/widgets#1', latest);
  prepare?.(svc, latest);
  const client = new ServiceClient(BASE, async () => TOKEN, svc.fetch, new FakeTimers());
  const states: PanelState[] = [];
  const panel = startPanel({ client, tab: tab(prUrl('acme/widgets', 1)), settings: settings(), timers: new FakeTimers(), onState: (s) => states.push(s) });
  panels.push(panel);
  return { svc, states, panel, latest, last: () => states.at(-1) };
}

type Harness = ReturnType<typeof harness>;
type Review = Extract<PanelState, { kind: 'review' }>;

async function until(h: Harness, more: (s: PanelState) => boolean): Promise<PanelState> {
  for (let i = 0; i < 500; i++) {
    await new Promise((r) => setImmediate(r));
    const s = h.last();
    if (s !== undefined && more(s)) return s;
  }
  throw new Error(`never reached the state; last was ${JSON.stringify(h.last())}`);
}

const reviewWith = (h: Harness, ticket: number) => until(h, (s) => s.kind === 'review' && s.post?.ticket === ticket && s.busy !== true) as Promise<Review>;
const reviewShown = (h: Harness) => until(h, (s) => s.kind === 'review');
const postsCalled = (h: Harness) => h.svc.calls.filter((c) => c === 'POST /posts').length;

describe('the panel posts through the service', () => {
  it('a preview is asked for with the body as given, and comes back with its ticket', async () => {
    const h = harness((svc) => svc.on('POST /posts/preview', () => json(preview)));
    await reviewShown(h);
    h.panel.dispatch({ type: 'preview-post', ticket: 1, body: previewBody });
    expect(h.last()).toMatchObject({ kind: 'review', busy: true });
    const s = await reviewWith(h, 1);
    expect(s.post).toEqual({ ticket: 1, kind: 'preview', preview });
    expect(h.svc.requests.find((r) => r.url.pathname === '/posts/preview')?.body).toEqual(previewBody);
  });

  it('a refused preview is the sheet\'s to show, not the review\'s notice', async () => {
    const h = harness((svc) => svc.on('POST /posts/preview', () => json({ error: 'The text is empty.' }, 400)));
    await reviewShown(h);
    h.panel.dispatch({ type: 'preview-post', ticket: 2, body: previewBody });
    const s = await reviewWith(h, 2);
    expect(s.post).toEqual({ ticket: 2, kind: 'refused', message: 'The text is empty.' });
    expect(s.notice).toBeUndefined();
  });

  it('a preview for another pull request is not sent', async () => {
    const h = harness();
    await reviewShown(h);
    h.panel.dispatch({ type: 'preview-post', ticket: 1, body: { ...previewBody, number: 2 } });
    await new Promise((r) => setImmediate(r));
    expect(h.svc.calls).not.toContain('POST /posts/preview');
  });

  it('a posted post adds its record to the review', async () => {
    const record = recordOf([FP]);
    const h = harness((svc) => svc.on('POST /posts', () => json(record)));
    await reviewShown(h);
    h.panel.dispatch({ type: 'post', ticket: 3, previewId: preview.previewId, fingerprints: [FP] });
    const s = await reviewWith(h, 3);
    expect(s.post).toEqual({ ticket: 3, kind: 'posted', record });
    expect(s.latest.posts).toEqual([record]);
    expect(h.svc.requests.find((r) => r.url.pathname === '/posts')?.body).toEqual({ previewId: preview.previewId });
  });

  it('a posted record for another pull request is not taken as the answer: the records are read instead', async () => {
    const elsewhere = recordOf([FP], { number: 2, url: 'https://github.com/acme/widgets/pull/2#pullrequestreview-77' });
    const own = recordOf([FP], { id: 'post_cccccccccccc', repo: 'Acme/Widgets', url: 'https://github.com/Acme/Widgets/pull/1#pullrequestreview-78', githubReviewId: 78 });
    const h = harness((svc, latest) => {
      svc.on('POST /posts', () => {
        latest.posts = [own];
        return json(elsewhere);
      });
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'post', ticket: 14, previewId: preview.previewId, fingerprints: [FP] });
    const s = await reviewWith(h, 14);
    expect(s.post).toEqual({ ticket: 14, kind: 'posted', record: own });
    // The repository's letter case does not matter, as on GitHub.
    expect(s.latest.posts).toEqual([own]);
  });

  it('a refused post says why and adds nothing', async () => {
    const said = 'GitHub refused the comments: Validation Failed. Nothing was posted.';
    const h = harness((svc) => svc.on('POST /posts', () => json({ error: said }, 502)));
    await reviewShown(h);
    h.panel.dispatch({ type: 'post', ticket: 4, previewId: preview.previewId, fingerprints: [FP] });
    const s = await reviewWith(h, 4);
    expect(s.post).toEqual({ ticket: 4, kind: 'refused', message: said });
    expect(s.latest.posts).toEqual([]);
  });

  it('a 504 reads the records again and gives the unknown record with the service words', async () => {
    const unknown = recordOf([FP], { outcome: 'unknown' });
    const h = harness((svc, latest) => {
      svc.on('POST /posts', () => {
        latest.posts = [unknown];
        return json({ error: UNKNOWN_SENTENCE }, 504);
      });
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'post', ticket: 5, previewId: preview.previewId, fingerprints: [FP] });
    const s = await reviewWith(h, 5);
    expect(s.post).toEqual({ ticket: 5, kind: 'unknown', message: UNKNOWN_SENTENCE, record: unknown });
    expect(s.latest.posts).toEqual([unknown]);
    expect(postsCalled(h)).toBe(1);
  });

  it('no answer reads the records again: a posted record there is the outcome, and nothing is sent twice', async () => {
    const record = recordOf([FP]);
    const h = harness((svc, latest) => {
      svc.on('POST /posts', () => {
        latest.posts = [record];
        return Promise.reject(new TypeError('Failed to fetch'));
      });
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'post', ticket: 6, previewId: preview.previewId, fingerprints: [FP] });
    const s = await reviewWith(h, 6);
    expect(s.post).toEqual({ ticket: 6, kind: 'posted', record });
    expect(postsCalled(h)).toBe(1);
  });

  it('no answer and no new record for these findings: says so, and does not take an earlier record for this one', async () => {
    const earlier = recordOf([FP2], { id: 'post_aaaaaaaaaaaa' });
    const other = recordOf([FP2], { id: 'post_bbbbbbbbbbbb' });
    const h = harness((svc, latest) => {
      latest.posts = [earlier];
      svc.on('POST /posts', () => {
        latest.posts = [earlier, other];
        return json({ error: 'Airlock had a problem.' }, 500);
      });
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'post', ticket: 7, previewId: preview.previewId, fingerprints: [FP] });
    const s = await reviewWith(h, 7);
    expect(s.post).toEqual({ ticket: 7, kind: 'unclear', message: NO_POST_RECORD });
  });

  it('no answer and records the service will not give: still not known, never a refusal', async () => {
    const h = harness((svc) => {
      svc.on('POST /posts', () => {
        svc.on('GET /reviews/latest', () => json({ error: 'Airlock had a problem.' }, 500));
        return json({ error: UNKNOWN_SENTENCE }, 504);
      });
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'post', ticket: 13, previewId: preview.previewId, fingerprints: [FP] });
    const s = await reviewWith(h, 13);
    expect(s.post).toEqual({ ticket: 13, kind: 'unclear', message: UNKNOWN_SENTENCE });
  });

  it('no answer and the records cannot be read either: the panel goes offline and nothing is sent again', async () => {
    const h = harness((svc) => {
      svc.on('POST /posts', () => {
        svc.down = true;
        return Promise.reject(new TypeError('Failed to fetch'));
      });
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'post', ticket: 8, previewId: preview.previewId, fingerprints: [FP] });
    await until(h, (s) => s.kind === 'offline');
    expect(postsCalled(h)).toBe(1);
  });

  it('a second post while one is in flight sends nothing', async () => {
    const pending = held();
    const h = harness((svc) => svc.on('POST /posts', pending.reply));
    await reviewShown(h);
    h.panel.dispatch({ type: 'post', ticket: 9, previewId: preview.previewId, fingerprints: [FP] });
    h.panel.dispatch({ type: 'post', ticket: 10, previewId: preview.previewId, fingerprints: [FP] });
    await new Promise((r) => setImmediate(r));
    expect(postsCalled(h)).toBe(1);
    pending.release(json(recordOf([FP])));
    await reviewWith(h, 9);
    expect(postsCalled(h)).toBe(1);
  });

  it('forgetting an unknown record sends the pull request and the id, and removes it from the review', async () => {
    const unknown = recordOf([FP], { outcome: 'unknown' });
    const h = harness((svc, latest) => {
      latest.posts = [unknown];
      svc.on('POST /posts/forget', () => json({ forgotten: true }));
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'forget-post', ticket: 11, id: unknown.id });
    const s = await reviewWith(h, 11);
    expect(s.post).toEqual({ ticket: 11, kind: 'forgotten', id: unknown.id });
    expect(s.latest.posts).toEqual([]);
    expect(h.svc.requests.find((r) => r.url.pathname === '/posts/forget')?.body).toEqual({ repo: 'acme/widgets', number: 1, id: unknown.id });
  });

  it('a refused forget says why and keeps the record', async () => {
    const unknown = recordOf([FP], { outcome: 'unknown' });
    const h = harness((svc, latest) => {
      latest.posts = [unknown];
      svc.on('POST /posts/forget', () => json({ error: 'This review was posted, so Airlock keeps its record.' }, 409));
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'forget-post', ticket: 12, id: unknown.id });
    const s = await reviewWith(h, 12);
    expect(s.post).toEqual({ ticket: 12, kind: 'refused', message: 'This review was posted, so Airlock keeps its record.' });
    expect(s.latest.posts).toEqual([unknown]);
  });

  it('nothing is sent for posting while the panel is not on a review', async () => {
    const h = harness((svc) => svc.latest.clear());
    await until(h, (s) => s.kind === 'ready');
    h.panel.dispatch({ type: 'preview-post', ticket: 1, body: previewBody });
    h.panel.dispatch({ type: 'post', ticket: 2, previewId: preview.previewId, fingerprints: [FP] });
    h.panel.dispatch({ type: 'forget-post', ticket: 3, id: 'post_0123456789ab' });
    await new Promise((r) => setImmediate(r));
    expect(h.svc.calls.filter((c) => c.startsWith('POST /posts'))).toEqual([]);
  });
});

describe('the post reply in the state', () => {
  const pr = prSummary();
  const review = (posts: PostRecord[] = []): PanelState => ({ kind: 'review', pr, latest: { ...latestFor(pr), posts }, stale: false, busy: true, notice: 'Old.' });
  const apply = (state: PanelState, reply: PostReply) => reduce(state, { type: 'post-reply', reply });

  it('a posted or unknown record is added, or replaces the one with its id', () => {
    const unknown = recordOf([FP], { outcome: 'unknown' });
    const posted = recordOf([FP]);
    const once = apply(review(), { ticket: 1, kind: 'unknown', message: UNKNOWN_SENTENCE, record: unknown }) as Review;
    expect(once.latest.posts).toEqual([unknown]);
    expect(once.busy).toBeUndefined();
    expect(once.notice).toBeUndefined();
    const twice = apply(once, { ticket: 2, kind: 'posted', record: posted }) as Review;
    expect(twice.latest.posts).toEqual([posted]);
  });

  it('a record for another pull request is not added', () => {
    const elsewhere = recordOf([FP], { number: 2, url: 'https://github.com/acme/widgets/pull/2#pullrequestreview-77' });
    const s = apply(review(), { ticket: 1, kind: 'posted', record: elsewhere }) as Review;
    expect(s.latest.posts).toEqual([]);
  });

  it('forgotten removes the record; the sentence of a refusal is cut to the notice length', () => {
    const unknown = recordOf([FP], { outcome: 'unknown' });
    const s = apply(review([unknown]), { ticket: 1, kind: 'forgotten', id: unknown.id }) as Review;
    expect(s.latest.posts).toEqual([]);
    const long = apply(review(), { ticket: 2, kind: 'refused', message: 'x'.repeat(400) }) as Review;
    expect(long.post?.kind === 'refused' && [...long.post.message].length).toBe(300);
  });

  it('is ignored away from a review, and not kept when the service goes away', () => {
    const ready: PanelState = { kind: 'ready', pr };
    expect(apply(ready, { ticket: 1, kind: 'forgotten', id: 'post_0123456789ab' })).toBe(ready);
    const s = apply(review(), { ticket: 1, kind: 'forgotten', id: 'post_0123456789ab' });
    const offline = reduce(s, { type: 'offline' });
    expect(offline.kind === 'offline' && offline.review !== undefined && 'post' in offline.review).toBe(false);
  });
});
