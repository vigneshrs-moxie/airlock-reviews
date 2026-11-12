import { afterEach, describe, expect, it } from 'vitest';
import type { LatestReply, PostPreviewBody, PostRecord } from '@airlock/shared';
import { ServiceClient } from '../../src/client/service';
import {
  POST_NO_PREVIEW_RECHECKS, POST_NOT_LEARNED, POST_NOT_SENT_UNPROVEN, POST_RECHECKS, POST_RECHECK_MS, POST_UNKNOWN, startPanel,
} from '../../src/state/machine';
import { reduce, type PanelState, type PostReply } from '../../src/state/reduce';
import type { SettingsStore } from '../../src/state/settings';
import type { TabWatcher } from '../../src/state/tab';
import {
  BASE, CANNOT_ASK_GITHUB, FakeService, GITHUB_HAS_IT, OTHER_TOKEN, TOKEN, cannotAskGithub, githubHasIt, held, json, latestFor, prSummary, prUrl,
} from '../helpers/fake-service';
import { FakeTimers } from '../helpers/fake-timers';
import { UNKNOWN_SENTENCE, previewItem, previewOf, recordOf } from '../helpers/post-fixtures';
import { finding } from '../screens/review-fixtures';

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

type MovableTab = TabWatcher & { go(url: string): void };

function tab(url: string): MovableTab {
  const listeners = new Set<(url: string | undefined) => void>();
  return {
    current: async () => ({ tabId: 3, url }),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    go: (next) => { for (const fn of listeners) fn(next); },
  };
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
  // The client's clock for how long a proof lasts: moved only by a test, which then makes the next call prove again.
  const mono = { now: 0 };
  const client = new ServiceClient(BASE, async () => TOKEN, svc.fetch, new FakeTimers(), () => mono.now);
  const states: PanelState[] = [];
  const timers = new FakeTimers();
  const theTab = tab(prUrl('acme/widgets', 1));
  const panel = startPanel({ client, tab: theTab, settings: settings(), timers, onState: (s) => states.push(s) });
  panels.push(panel);
  return { svc, states, panel, latest, timers, tab: theTab, mono, last: () => states.at(-1) };
}

type Harness = ReturnType<typeof harness>;
type Review = Extract<PanelState, { kind: 'review' }>;

/**
 * Yields until the state is reached, for at most ten seconds of real time: the proof is checked with Web Crypto, whose
 * work runs on Node's thread pool, so how many turns it takes depends on how busy the machine is.
 */
async function until(h: Harness, more: (s: PanelState) => boolean): Promise<PanelState> {
  const end = Date.now() + 10_000;
  do {
    await new Promise((r) => setImmediate(r));
    const s = h.last();
    if (s !== undefined && more(s)) return s;
  } while (Date.now() < end);
  throw new Error(`never reached the state; last was ${JSON.stringify(h.last())}`);
}

const reviewWith = (h: Harness, ticket: number) => until(h, (s) => s.kind === 'review' && s.post?.ticket === ticket && s.busy !== true) as Promise<Review>;
const reviewShown = (h: Harness) => until(h, (s) => s.kind === 'review');

/** Lets the panel's waits run, one round at a time, until the post's final answer under `ticket` is on screen. */
async function recheckUntil(h: Harness, ticket: number): Promise<Review> {
  for (let round = 0; round < 60; round++) {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const s = h.last();
    if (s?.kind === 'review' && s.post?.ticket === ticket && s.post.kind !== 'waiting' && s.busy !== true) return s;
    h.timers.fire();
  }
  throw new Error(`no final answer; last was ${JSON.stringify(h.last())}`);
}
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

  it('a refused post whose record the service could not clear: the records are read again, so the unknown one is on screen', async () => {
    const said = 'GitHub refused the comments: Validation Failed. Nothing was posted, but Airlock could not clear its own record: press "It was not posted" before trying again.';
    const stuck = recordOf([FP], { outcome: 'unknown' });
    const h = harness((svc, latest) => svc.on('POST /posts', () => {
      latest.posts = [stuck];
      return json({ error: said }, 502);
    }));
    await reviewShown(h);
    h.panel.dispatch({ type: 'post', ticket: 21, previewId: preview.previewId, fingerprints: [FP] });
    const s = await reviewWith(h, 21);
    expect(s.post).toEqual({ ticket: 21, kind: 'refused', message: said });
    expect(s.latest.posts).toEqual([stuck]);
    expect(h.svc.calls.filter((c) => c === 'GET /reviews/latest')).toHaveLength(2);
    // The records were on screen before the answer, which comes with the action's end.
    const answered = h.states.findIndex((st) => st.kind === 'review' && st.post?.ticket === 21);
    expect((h.states[answered - 1] as Review).latest.posts).toEqual([stuck]);
  });

  it('a refused preview reads the records again: a finding posted from another panel shows as posted', async () => {
    const elsewhere = recordOf([FP], { id: 'post_dddddddddddd' });
    const h = harness((svc, latest) => svc.on('POST /posts/preview', () => {
      latest.posts = [elsewhere];
      return json({ error: 'This finding is already posted on this pull request: Problem 1.' }, 409);
    }));
    await reviewShown(h);
    h.panel.dispatch({ type: 'preview-post', ticket: 22, body: previewBody });
    const s = await reviewWith(h, 22);
    expect(s.post).toEqual({ ticket: 22, kind: 'refused', message: 'This finding is already posted on this pull request: Problem 1.' });
    expect(s.latest.posts).toEqual([elsewhere]);
  });

  it('a preview that goes through does not read the records again', async () => {
    const h = harness((svc) => svc.on('POST /posts/preview', () => json(preview)));
    await reviewShown(h);
    h.panel.dispatch({ type: 'preview-post', ticket: 23, body: previewBody });
    await reviewWith(h, 23);
    expect(h.svc.calls.filter((c) => c === 'GET /reviews/latest')).toHaveLength(1);
  });

  it('a post whose proof got no answer was never sent: it says so at once, waits for no record, and stays on the review', async () => {
    const h = harness();
    await reviewShown(h);
    h.svc.on('GET /hello', () => Promise.reject(new TypeError('Failed to fetch')));
    // Past the second a proof lasts, so the post proves first.
    h.mono.now = 2_000;
    h.panel.dispatch({ type: 'post', ticket: 24, previewId: preview.previewId, fingerprints: [FP] });
    const s = await reviewWith(h, 24);
    expect(s.post).toEqual({ ticket: 24, kind: 'unsent', message: 'Airlock could not reach its service, so nothing was sent.' });
    expect(postsCalled(h)).toBe(0);
    expect(h.svc.calls.filter((c) => c === 'GET /reviews/latest')).toHaveLength(1);
    expect(h.states.some((x) => x.kind === 'review' && x.post?.kind === 'waiting')).toBe(false);
    expect(h.states.some((x) => x.kind === 'offline')).toBe(false);
  });

  it('a post whose proof failed goes to the Pair screen, and the sheet hears that nothing was sent when the review is back', async () => {
    const h = harness();
    await reviewShown(h);
    h.svc.proofKey = OTHER_TOKEN;
    h.mono.now = 2_000;
    h.panel.dispatch({ type: 'post', ticket: 25, previewId: preview.previewId, fingerprints: [FP] });
    await until(h, (s) => s.kind === 'unpaired');
    expect(postsCalled(h)).toBe(0);
    // The token is right again (pasted anew); the panel loads the review, with the answer for the sheet.
    h.svc.proofKey = undefined;
    h.tab.go(prUrl('acme/widgets', 2));
    h.tab.go(prUrl('acme/widgets', 1));
    const s = await until(h, (st) => st.kind === 'review' && st.pr.number === 1) as Review;
    expect(s.post).toEqual({ ticket: 25, kind: 'unsent', message: POST_NOT_SENT_UNPROVEN });
    expect(s.busy).toBeUndefined();
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

  it('no answer and no record yet: says it is waiting, reads every 5 seconds, and takes a record that appears later', async () => {
    const earlier = recordOf([FP2], { id: 'post_aaaaaaaaaaaa' });
    const record = recordOf([FP], { id: 'post_cccccccccccc' });
    let reads = 0;
    const h = harness((svc, latest) => {
      latest.posts = [earlier];
      svc.on('POST /posts', () => {
        // The service is still inside its call to GitHub: the record comes on the third read.
        svc.on('GET /reviews/latest', () => {
          reads += 1;
          return json({ ...latest, posts: reads >= 3 ? [earlier, record] : [earlier] });
        });
        return Promise.reject(new TypeError('Failed to fetch'));
      });
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'post', ticket: 7, previewId: preview.previewId, fingerprints: [FP] });
    const waiting = await until(h, (s) => s.kind === 'review' && s.post?.ticket === 7) as Review;
    expect(waiting.post).toEqual({ ticket: 7, kind: 'waiting' });
    // Still in flight: nothing else can be sent meanwhile.
    expect(waiting.busy).toBe(true);
    expect(h.timers.delays()).toContain(POST_RECHECK_MS);
    const s = await recheckUntil(h, 7);
    expect(s.post).toEqual({ ticket: 7, kind: 'posted', record });
    expect(s.latest.posts).toEqual([earlier, record]);
    expect(reads).toBe(3);
    expect(postsCalled(h)).toBe(1);
  });

  it('no record after 90 seconds of reads: says it could not learn what happened; the records on screen are the last read', async () => {
    const earlier = recordOf([FP2], { id: 'post_aaaaaaaaaaaa' });
    const other = recordOf([FP2], { id: 'post_bbbbbbbbbbbb' });
    let reads = 0;
    const h = harness((svc, latest) => {
      latest.posts = [earlier];
      svc.on('POST /posts', () => {
        svc.on('GET /reviews/latest', () => {
          reads += 1;
          return json({ ...latest, posts: [earlier, other] });
        });
        return json({ error: 'Airlock had a problem.' }, 500);
      });
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'post', ticket: 8, previewId: preview.previewId, fingerprints: [FP] });
    const s = await recheckUntil(h, 8);
    // The 500's own sentence is kept, before the panel's.
    expect(s.post).toEqual({ ticket: 8, kind: 'unclear', message: `Airlock had a problem. ${POST_NOT_LEARNED}` });
    // A first read, then one every 5 seconds for 90 seconds.
    expect(reads).toBe(1 + POST_RECHECKS);
    expect(POST_RECHECKS * POST_RECHECK_MS).toBe(90_000);
    expect(s.latest.posts).toEqual([earlier, other]);
    expect(postsCalled(h)).toBe(1);
  });

  describe('a 404 on a post: the browser may have sent it twice, and the first copy taken the preview', () => {
    const EXPIRED = 'This preview has expired. Open the preview again.';

    it('checks for the record at once and every 5 seconds, and the post the first copy made is the answer', async () => {
      const earlier = recordOf([FP2], { id: 'post_aaaaaaaaaaaa' });
      const record = recordOf([FP], { id: 'post_cccccccccccc' });
      let reads = 0;
      const h = harness((svc, latest) => {
        latest.posts = [earlier];
        svc.on('POST /posts', () => {
          // The first copy is still with GitHub: its record comes on the second read.
          svc.on('GET /reviews/latest', () => {
            reads += 1;
            return json({ ...latest, posts: reads >= 2 ? [earlier, record] : [earlier] });
          });
          return json({ error: EXPIRED }, 404);
        });
      });
      await reviewShown(h);
      h.panel.dispatch({ type: 'post', ticket: 30, previewId: preview.previewId, fingerprints: [FP] });
      const waiting = await until(h, (s) => s.kind === 'review' && s.post?.ticket === 30) as Review;
      expect(waiting.post).toEqual({ ticket: 30, kind: 'waiting', checking: true });
      expect(waiting.busy).toBe(true);
      const s = await recheckUntil(h, 30);
      expect(s.post).toEqual({ ticket: 30, kind: 'posted', record });
      expect(s.latest.posts).toEqual([earlier, record]);
      expect(reads).toBe(2);
      expect(postsCalled(h)).toBe(1);
    });

    it('a record whose outcome is not known is shown with the panel\'s sentence, never the expired one', async () => {
      const unknown = recordOf([FP], { outcome: 'unknown' });
      const h = harness((svc, latest) => {
        svc.on('POST /posts', () => {
          latest.posts = [unknown];
          return json({ error: EXPIRED }, 404);
        });
      });
      await reviewShown(h);
      h.panel.dispatch({ type: 'post', ticket: 31, previewId: preview.previewId, fingerprints: [FP] });
      const s = await reviewWith(h, 31);
      expect(s.post).toEqual({ ticket: 31, kind: 'unknown', message: POST_UNKNOWN, record: unknown });
      expect(postsCalled(h)).toBe(1);
    });

    it('no record after 20 seconds of checks: the preview expired, never the 90-second wait of a cut connection', async () => {
      const earlier = recordOf([FP2], { id: 'post_aaaaaaaaaaaa' });
      let reads = 0;
      const h = harness((svc, latest) => {
        latest.posts = [earlier];
        svc.on('POST /posts', () => {
          svc.on('GET /reviews/latest', () => {
            reads += 1;
            return json(latest);
          });
          return json({ error: EXPIRED }, 404);
        });
      });
      await reviewShown(h);
      h.panel.dispatch({ type: 'post', ticket: 32, previewId: preview.previewId, fingerprints: [FP] });
      const s = await recheckUntil(h, 32);
      expect(s.post).toEqual({ ticket: 32, kind: 'refused', message: EXPIRED });
      // A first read, then one every 5 seconds for 20 seconds.
      expect(reads).toBe(1 + POST_NO_PREVIEW_RECHECKS);
      expect(POST_NO_PREVIEW_RECHECKS * POST_RECHECK_MS).toBe(20_000);
      expect(s.latest.posts).toEqual([earlier]);
      expect(postsCalled(h)).toBe(1);
    });

    it('a 404 on a preview is refused at once: nothing was sent, so there is no record to wait for', async () => {
      const h = harness((svc) => svc.on('POST /posts/preview', () => json({ error: 'Airlock has no review r_0000000001 of this pull request.' }, 404)));
      await reviewShown(h);
      h.panel.dispatch({ type: 'preview-post', ticket: 33, body: previewBody });
      const s = await reviewWith(h, 33);
      expect(s.post).toEqual({ ticket: 33, kind: 'refused', message: 'Airlock has no review r_0000000001 of this pull request.' });
      expect(h.states.some((x) => x.kind === 'review' && x.post?.kind === 'waiting')).toBe(false);
    });
  });

  it.each([
    ['refuses to give them', (svc: FakeService) => svc.on('GET /reviews/latest', () => json({ error: 'Airlock had a problem.' }, 500))],
    ['does not answer', (svc: FakeService) => { svc.down = true; }],
  ])('no answer, and the service %s when asked for the records: keeps asking, never a refusal, never offline, nothing sent again', async (_name, cut) => {
    const h = harness((svc) => {
      svc.on('POST /posts', () => {
        cut(svc);
        return json({ error: UNKNOWN_SENTENCE }, 504);
      });
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'post', ticket: 13, previewId: preview.previewId, fingerprints: [FP] });
    const s = await recheckUntil(h, 13);
    expect(s.post).toEqual({ ticket: 13, kind: 'unclear', message: POST_NOT_LEARNED });
    expect(h.states.some((x) => x.kind === 'offline')).toBe(false);
    expect(postsCalled(h)).toBe(1);
  });

  it('the record found after an unclear answer holds the finding by the same rule as the marks: by an alias, either way round', async () => {
    const own = recordOf(['00000000000000aa'], { id: 'post_cccccccccccc' });
    const h = harness((svc, latest) => {
      latest.document.findings = [finding(1, { fingerprint: FP, aliases: ['00000000000000aa'] })];
      svc.on('POST /posts', () => {
        latest.posts = [own];
        return json({ error: 'Airlock had a problem.' }, 500);
      });
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'post', ticket: 15, previewId: preview.previewId, fingerprints: [FP] });
    const s = await recheckUntil(h, 15);
    expect(s.post).toEqual({ ticket: 15, kind: 'posted', record: own });

    const other = recordOf(['00000000000000bb'], { id: 'post_dddddddddddd', items: [{ fingerprint: '00000000000000bb', aliases: [FP2], placement: 'inline' }] });
    const h2 = harness((svc, latest) => {
      latest.document.findings = [finding(2, { fingerprint: FP2 })];
      svc.on('POST /posts', () => {
        latest.posts = [other];
        return Promise.reject(new TypeError('Failed to fetch'));
      });
    });
    await reviewShown(h2);
    h2.panel.dispatch({ type: 'post', ticket: 16, previewId: preview.previewId, fingerprints: [FP2] });
    expect((await recheckUntil(h2, 16)).post).toEqual({ ticket: 16, kind: 'posted', record: other });
  });

  it('a read that finds no stored review leaves the records on screen as they were', async () => {
    const earlier = recordOf([FP2], { id: 'post_aaaaaaaaaaaa' });
    const h = harness((svc, latest) => {
      latest.posts = [earlier];
      svc.on('POST /posts', () => {
        svc.on('GET /reviews/latest', () => json({ error: 'Airlock has no review of this pull request yet.' }, 404));
        return json({ error: UNKNOWN_SENTENCE }, 504);
      });
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'post', ticket: 17, previewId: preview.previewId, fingerprints: [FP] });
    const s = await recheckUntil(h, 17);
    expect(s.post).toEqual({ ticket: 17, kind: 'unclear', message: POST_NOT_LEARNED });
    expect(s.latest.posts).toEqual([earlier]);
  });

  it.each([
    ['the tab moves to another pull request', (h: Harness) => h.tab.go(prUrl('acme/widgets', 2))],
    ['the panel stops', (h: Harness) => h.panel.stop()],
  ])('the wait for a record ends when %s: no further read, and nothing set afterwards', async (_name, leave) => {
    const h = harness((svc) => {
      svc.addPr(prSummary({ number: 2 }));
      svc.on('POST /posts', () => Promise.reject(new TypeError('Failed to fetch')));
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'post', ticket: 18, previewId: preview.previewId, fingerprints: [FP] });
    await until(h, (s) => s.kind === 'review' && s.post?.ticket === 18);
    const readsOfOne = () => h.svc.requests.filter((r) => r.url.pathname === '/reviews/latest' && r.url.searchParams.get('number') === '1').length;
    const before = readsOfOne();
    leave(h);
    for (let round = 0; round < 5; round++) {
      h.timers.fire();
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    }
    expect(readsOfOne()).toBe(before);
    const afterLeaving = h.states.slice(h.states.findIndex((st) => st.kind === 'review' && st.post?.ticket === 18) + 1);
    expect(afterLeaving.some((st) => st.kind === 'review' && st.pr.number === 1)).toBe(false);
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

  it('forgetting an unknown record sends the pull request and the id, then reads the records again', async () => {
    const unknown = recordOf([FP], { outcome: 'unknown' });
    const elsewhere = recordOf([FP2], { id: 'post_dddddddddddd' });
    const h = harness((svc, latest) => {
      latest.posts = [unknown];
      svc.on('POST /posts/forget', () => {
        // Another panel posted meanwhile: the records read after the forget are the ones shown.
        latest.posts = [elsewhere];
        return json({ forgotten: true });
      });
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'forget-post', ticket: 11, id: unknown.id });
    await until(h, (s) => s.kind === 'review' && s.post?.ticket === 11 && s.busy !== true && s.latest.posts.length === 1);
    const s = h.last() as Review;
    expect(s.post).toEqual({ ticket: 11, kind: 'forgotten', id: unknown.id });
    expect(s.latest.posts).toEqual([elsewhere]);
    expect(h.svc.calls.filter((c) => c === 'GET /reviews/latest').length).toBe(2);
    expect(h.svc.requests.find((r) => r.url.pathname === '/posts/forget')?.body).toEqual({ repo: 'acme/widgets', number: 1, id: unknown.id });
  });

  it('a forget GitHub has the review for: nothing forgotten, the record is posted, and the records are read again', async () => {
    const unknown = recordOf([FP], { outcome: 'unknown' });
    const posted = recordOf([FP], { id: unknown.id });
    const h = harness((svc, latest) => {
      latest.posts = [unknown];
      svc.on('POST /posts/forget', () => {
        latest.posts = [posted];
        return githubHasIt(posted);
      });
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'forget-post', ticket: 26, id: unknown.id });
    const s = await reviewWith(h, 26);
    expect(s.post).toEqual({ ticket: 26, kind: 'found', message: GITHUB_HAS_IT, record: posted });
    expect(s.latest.posts).toEqual([posted]);
    expect(h.svc.calls.filter((c) => c === 'GET /reviews/latest')).toHaveLength(2);
  });

  it('a forget GitHub could not be asked about: the record was kept, said in the service words', async () => {
    const unknown = recordOf([FP], { outcome: 'unknown' });
    const h = harness((svc, latest) => {
      latest.posts = [unknown];
      svc.on('POST /posts/forget', () => cannotAskGithub());
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'forget-post', ticket: 27, id: unknown.id });
    const s = await reviewWith(h, 27);
    expect(s.post).toEqual({ ticket: 27, kind: 'refused', message: CANNOT_ASK_GITHUB });
    expect(s.latest.posts).toEqual([unknown]);
  });

  it('a forget stays in flight until the records read after it are on screen: a press meanwhile is not dropped', async () => {
    const unknown = recordOf([FP], { outcome: 'unknown' });
    const read = held();
    const h = harness((svc, latest) => {
      latest.posts = [unknown];
      svc.on('POST /posts/forget', () => {
        latest.posts = [];
        svc.on('GET /reviews/latest', () => read.reply());
        return json({ forgotten: true });
      });
      svc.on('POST /posts/preview', () => json(preview));
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'forget-post', ticket: 28, id: unknown.id });
    await until(h, () => read.asked());
    // The read after the forget is held: the review is still busy, so Post comment says to wait, and has no answer yet.
    expect(h.last()).toMatchObject({ kind: 'review', busy: true });
    expect((h.last() as Review).post).toBeUndefined();
    read.release(json({ ...h.latest, posts: [] }));
    const s = await reviewWith(h, 28);
    expect(s.post).toEqual({ ticket: 28, kind: 'forgotten', id: unknown.id });
    expect(s.latest.posts).toEqual([]);
    // The next press goes through.
    h.panel.dispatch({ type: 'preview-post', ticket: 29, body: previewBody });
    expect((await reviewWith(h, 29)).post).toEqual({ ticket: 29, kind: 'preview', preview });
  });

  it('a refused forget says why, and reads the records again', async () => {
    const unknown = recordOf([FP], { outcome: 'unknown' });
    const h = harness((svc, latest) => {
      latest.posts = [unknown];
      svc.on('POST /posts/forget', () => {
        // Already forgotten from another panel: the record is gone.
        latest.posts = [];
        return json({ error: 'Airlock cannot forget that record.' }, 409);
      });
    });
    await reviewShown(h);
    h.panel.dispatch({ type: 'forget-post', ticket: 12, id: unknown.id });
    await until(h, (s) => s.kind === 'review' && s.post?.ticket === 12 && s.busy !== true && s.latest.posts.length === 0);
    const s = h.last() as Review;
    expect(s.post).toEqual({ ticket: 12, kind: 'refused', message: 'Airlock cannot forget that record.' });
    expect(h.svc.calls.filter((c) => c === 'GET /reviews/latest').length).toBe(2);
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

describe('a review that finishes while its stored review cannot be read', () => {
  it('keeps the post records and dismissals that were on screen, never an empty list', async () => {
    const posted = recordOf([FP]);
    const dismissal = {
      fingerprint: FP2, findingId: 'c_00000002', reviewId: 'r_0000000001', reason: 'not-now' as const, text: '', at: '2026-11-11T10:00:00Z', learned: null,
    };
    const h = harness((svc, latest) => {
      latest.posts = [posted];
      latest.dismissals = [dismissal];
      svc.prs.set('acme/widgets#1', prSummary({ headSha: 'd'.repeat(40) }));
    });
    const before = await reviewShown(h) as Review;
    expect(before.latest.posts).toEqual([posted]);
    h.panel.dispatch({ type: 'start', depth: 'quick' });
    await until(h, (s) => s.kind === 'running');
    const run = h.svc.runs.get([...h.svc.runs.keys()].at(-1)!)!;
    h.svc.on('GET /reviews/latest', () => json({ error: 'The store is locked.' }, 500));
    const document = { ...latestFor(prSummary({ headSha: 'd'.repeat(40) })).document, id: 'r_0000000002' };
    run.emit({ type: 'done', document });
    const s = await until(h, (st) => st.kind === 'review' && st.latest.document.id === 'r_0000000002') as Review;
    expect(s.latest.posts).toEqual([posted]);
    expect(s.latest.dismissals).toEqual([dismissal]);
  });

  it('keeps none from another pull request', async () => {
    const h = harness((svc, latest) => { latest.posts = [recordOf([FP])]; svc.addPr(prSummary({ number: 2 })); });
    await reviewShown(h);
    const run = h.svc.startRun('acme/widgets', 2);
    h.tab.go(prUrl('acme/widgets', 2));
    await until(h, (s) => s.kind === 'running');
    h.svc.on('GET /reviews/latest', () => json({ error: 'The store is locked.' }, 500));
    run.emit({ type: 'done', document: latestFor(prSummary({ number: 2 })).document });
    const s = await until(h, (st) => st.kind === 'review') as Review;
    expect(s.pr.number).toBe(2);
    expect(s.latest.posts).toEqual([]);
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

  it('found replaces the unknown record with the posted one, which stays', () => {
    const unknown = recordOf([FP], { outcome: 'unknown' });
    const posted = recordOf([FP], { id: unknown.id });
    const s = apply(review([unknown]), { ticket: 1, kind: 'found', message: GITHUB_HAS_IT, record: posted }) as Review;
    expect(s.latest.posts).toEqual([posted]);
    expect(s.post).toEqual({ ticket: 1, kind: 'found', message: GITHUB_HAS_IT, record: posted });
    expect(s.busy).toBeUndefined();
  });

  it('a loaded review can carry an answer for the post sheet', () => {
    const reply: PostReply = { ticket: 4, kind: 'unsent', message: POST_NOT_SENT_UNPROVEN };
    const s = reduce({ kind: 'loading' }, { type: 'loaded', pr, latest: latestFor(pr), post: reply }) as Review;
    expect(s.post).toEqual(reply);
    expect(reduce({ kind: 'loading' }, { type: 'loaded', pr, latest: null, post: reply })).toEqual({ kind: 'ready', pr });
  });

  it('forgotten removes the record; the sentence of a refusal is cut to the notice length', () => {
    const unknown = recordOf([FP], { outcome: 'unknown' });
    const s = apply(review([unknown]), { ticket: 1, kind: 'forgotten', id: unknown.id }) as Review;
    expect(s.latest.posts).toEqual([]);
    const long = apply(review(), { ticket: 2, kind: 'refused', message: 'x'.repeat(400) }) as Review;
    expect(long.post?.kind === 'refused' && [...long.post.message].length).toBe(300);
  });

  it('waiting keeps the review busy; the records read replace the ones on screen', () => {
    const waiting = apply(review(), { ticket: 1, kind: 'waiting' }) as Review;
    expect(waiting.busy).toBe(true);
    expect(waiting.post).toEqual({ ticket: 1, kind: 'waiting' });
    const read = recordOf([FP2], { id: 'post_eeeeeeeeeeee' });
    const s = reduce(waiting, { type: 'posts', posts: [read] }) as Review;
    expect(s.latest.posts).toEqual([read]);
    expect(s.busy).toBe(true);
    expect(s.post).toEqual({ ticket: 1, kind: 'waiting' });
    const ready: PanelState = { kind: 'ready', pr };
    expect(reduce(ready, { type: 'posts', posts: [read] })).toBe(ready);
  });

  it('is ignored away from a review, and not kept when the service goes away', () => {
    const ready: PanelState = { kind: 'ready', pr };
    expect(apply(ready, { ticket: 1, kind: 'forgotten', id: 'post_0123456789ab' })).toBe(ready);
    const s = apply(review(), { ticket: 1, kind: 'forgotten', id: 'post_0123456789ab' });
    const offline = reduce(s, { type: 'offline' });
    expect(offline.kind === 'offline' && offline.review !== undefined && 'post' in offline.review).toBe(false);
  });
});
