import { afterEach, describe, expect, it } from 'vitest';
import type { Brief, ChangeMap, Dismissal, ServiceEvent } from '@airlock/shared';
import { NOT_UNDERSTOOD, ServiceClient } from '../../src/client/service';
import {
  LOST_MESSAGE, STAGE_WORDS, reduce, startPanel, stageWords, type PanelState, type Timers,
} from '../../src/state/machine';
import type { SettingsStore } from '../../src/state/settings';
import type { TabWatcher } from '../../src/state/tab';
import {
  BASE, FakeService, OTHER_TOKEN, TOKEN, json, latestFor, prSummary, prUrl, type FakeRun,
} from '../helpers/fake-service';

class FakeTimers implements Timers {
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  private next = 1;
  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  delays(): number[] {
    return [...this.pending.values()].map((p) => p.ms);
  }
  fire(): void {
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const p of due) p.fn();
  }
}

function memorySettings(token: string | null): SettingsStore & { token: string | null } {
  return {
    token,
    async getToken() { return this.token; },
    async setToken(t) { this.token = t; },
    async getDefaultDepth() { return null; },
    async setDefaultDepth() {},
  };
}

function fakeTab(url: string | undefined): TabWatcher & { go(url: string | undefined): void; listeners: Set<(url: string | undefined) => void> } {
  const listeners = new Set<(url: string | undefined) => void>();
  return {
    listeners,
    current: async () => ({ tabId: 3, url }),
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    go(next) {
      for (const fn of listeners) fn(next);
    },
  };
}

const running: { stop(): void }[] = [];
afterEach(() => {
  for (const p of running.splice(0)) p.stop();
});

function harness(opts: { url?: string; token?: string | null; prepare?: (svc: FakeService) => void } = {}) {
  const svc = new FakeService();
  opts.prepare?.(svc);
  const settings = memorySettings(opts.token === undefined ? TOKEN : opts.token);
  const client = new ServiceClient(BASE, () => settings.getToken(), svc.fetch);
  const tab = fakeTab('url' in opts ? opts.url : prUrl('acme/widgets', 1));
  const timers = new FakeTimers();
  const states: PanelState[] = [];
  const panel = startPanel({ client, tab, settings, timers, onState: (s) => states.push(s) });
  running.push(panel);
  const last = (): PanelState | undefined => states.at(-1);
  return { svc, settings, tab, timers, states, panel, last };
}

type Harness = ReturnType<typeof harness>;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

async function until<K extends PanelState['kind']>(h: Harness, kind: K, more: (s: Extract<PanelState, { kind: K }>) => boolean = () => true): Promise<Extract<PanelState, { kind: K }>> {
  for (let i = 0; i < 500; i++) {
    await new Promise((r) => setImmediate(r));
    const s = h.last();
    if (s?.kind === kind && more(s as Extract<PanelState, { kind: K }>)) return s as Extract<PanelState, { kind: K }>;
  }
  throw new Error(`waited for ${kind}; the state is ${JSON.stringify(h.last())}`);
}

const stage = (name: string, status: 'start' | 'done' | 'error', detail = ''): ServiceEvent => ({
  type: 'stage', stage: name, status, detail,
});
const brief: Brief = { whatItDoes: ['Adds totals.'], claims: [{ text: 'Rounds to cents', verdict: 'not-supported', evidence: 'No rounding.' }] };
const map: ChangeMap = { cohorts: [], standalone: ['src/total.ts'], links: [] };

describe('startPanel', () => {
  it('goes offline when hello fails and recovers when it answers', async () => {
    const h = harness({ prepare: (svc) => { svc.down = true; } });
    await until(h, 'offline');
    expect(h.timers.delays()).toEqual([5000]);
    h.timers.fire();
    await settle();
    expect(h.last()).toEqual({ kind: 'offline' });
    expect(h.timers.delays()).toEqual([5000]);
    h.svc.down = false;
    h.timers.fire();
    const ready = await until(h, 'ready');
    expect(ready).toEqual({ kind: 'ready', pr: prSummary(), earlier: null });
    expect(h.timers.delays()).toEqual([]);
    // The automatic checks never flash a loading state between two offline ones.
    expect(h.states.map((s) => s.kind)).toEqual(['loading', 'offline', 'ready']);
  });

  it('stops checking again when the panel stops', async () => {
    const h = harness({ prepare: (svc) => { svc.down = true; } });
    await until(h, 'offline');
    h.panel.stop();
    expect(h.timers.delays()).toEqual([]);
    expect(h.tab.listeners.size).toBe(0);
    h.svc.down = false;
    h.tab.go(prUrl('acme/widgets', 2));
    await settle();
    expect(h.last()).toEqual({ kind: 'offline' });
  });

  it('goes unpaired on 401 and ready after pairing', async () => {
    const h = harness({ token: OTHER_TOKEN });
    expect(await until(h, 'unpaired')).toEqual({ kind: 'unpaired' });

    h.panel.dispatch({ type: 'pair', token: '  not a token ' });
    const odd = await until(h, 'unpaired', (s) => s.message !== undefined);
    expect(odd.message).toMatch(/airlock-service token/);
    expect(h.svc.calls).not.toContain('POST /pair');

    const refused = 'c'.repeat(64);
    h.panel.dispatch({ type: 'pair', token: refused });
    const words = await until(h, 'unpaired', (s) => s.message === 'Airlock needs the pairing token. Run "airlock-service token".');
    expect(words.kind).toBe('unpaired');
    expect(h.settings.token).toBe(OTHER_TOKEN);

    h.panel.dispatch({ type: 'pair', token: `${TOKEN}\n` });
    await until(h, 'ready');
    expect(h.settings.token).toBe(TOKEN);
  });

  it('is unpaired without asking for the pull request when the service has no paired extension or no token is stored', async () => {
    const notPaired = harness({ prepare: (svc) => { svc.paired = false; } });
    await until(notPaired, 'unpaired');
    expect(notPaired.svc.calls).toEqual(['GET /hello']);
    const noToken = harness({ token: null });
    await until(noToken, 'unpaired');
    expect(noToken.svc.calls).toEqual(['GET /hello']);
  });

  it('attaches to a running review and replays its events', async () => {
    let run!: FakeRun;
    const h = harness({
      prepare: (svc) => {
        run = svc.startRun('acme/widgets', 1);
        run.emit(stage('intake', 'start'));
        run.emit(stage('intake', 'done', '3 files'));
        run.emit(stage('shape', 'done', 'skipped: not a sync merge'));
        run.emit({ type: 'brief', brief });
        run.emit(stage('lenses', 'start'));
      },
    });
    const first = await until(h, 'running', (s) => s.stages.length === 3);
    expect(first.stages).toEqual([
      { stage: 'intake', words: 'Reading the pull request', status: 'done', detail: '3 files' },
      { stage: 'shape', words: STAGE_WORDS.shape, status: 'skipped', detail: 'not a sync merge' },
      { stage: 'lenses', words: STAGE_WORDS.lenses, status: 'working', detail: '' },
    ]);
    expect(first.brief).toEqual(brief);
    expect(first.map).toBeNull();
    expect(h.svc.calls).not.toContain('GET /reviews/latest');

    run.emit({ type: 'map', map });
    run.emit(stage('lenses', 'error', 'boundary lens timed out'));
    run.emit(stage('mystery', 'start'));
    const later = await until(h, 'running', (s) => s.stages.length === 4);
    expect(later.map).toEqual(map);
    expect(later.stages.slice(2)).toEqual([
      { stage: 'lenses', words: STAGE_WORDS.lenses, status: 'failed', detail: 'boundary lens timed out' },
      { stage: 'mystery', words: 'mystery', status: 'working', detail: '' },
    ]);

    const latest = latestFor(prSummary());
    latest.dismissals = [dismissal('0123456789abcdef')];
    h.svc.latest.set('acme/widgets#1', latest);
    run.emit({ type: 'done', document: latestFor(prSummary()).document });
    const review = await until(h, 'review');
    expect(review).toEqual({ kind: 'review', pr: prSummary(), latest, stale: false });
    expect(h.svc.calls.filter((c) => c === 'POST /reviews')).toEqual([]);
  });

  it('after done uses the event document with no dismissals when latest cannot be read', async () => {
    let run!: FakeRun;
    const h = harness({ prepare: (svc) => { run = svc.startRun('acme/widgets', 1); } });
    await until(h, 'running');
    h.svc.on('GET /reviews/latest', () => json({ error: 'The store is locked.' }, 500));
    const doc = latestFor(prSummary(), 'e'.repeat(40)).document;
    run.emit({ type: 'done', document: doc });
    expect(await until(h, 'review')).toEqual({
      kind: 'review', pr: prSummary(), latest: { document: doc, dismissals: [] }, stale: true,
    });
  });

  it('shows the latest stored review, marked stale when the head moved', async () => {
    const current = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', latestFor(prSummary())) });
    expect(await until(current, 'review')).toMatchObject({ stale: false });

    const moved = latestFor(prSummary(), 'd'.repeat(40));
    const old = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', moved) });
    expect(await until(old, 'review')).toEqual({ kind: 'review', pr: prSummary(), latest: moved, stale: true });
  });

  it('moves to another pull request when the tab address changes and drops the old stream', async () => {
    let run!: FakeRun;
    const pr2 = prSummary({ number: 2, title: 'Second' });
    const pr3 = prSummary({ number: 3, title: 'Third' });
    let releaseLatest3!: () => void;
    const h = harness({
      prepare: (svc) => {
        run = svc.startRun('acme/widgets', 1);
        run.emit(stage('intake', 'start'));
        svc.addPr(pr2);
        svc.addPr(pr3);
      },
    });
    await until(h, 'running', (s) => s.stages.length === 1);

    // Another page of the same pull request changes nothing.
    const callsBefore = h.svc.calls.length;
    h.tab.go(prUrl('acme/widgets', 1, '/files'));
    await settle();
    expect(h.svc.calls.length).toBe(callsBefore);
    expect(run.listeners.size).toBe(1);

    h.tab.go(prUrl('acme/widgets', 2));
    expect(await until(h, 'ready')).toEqual({ kind: 'ready', pr: pr2, earlier: null });
    expect(run.listeners.size).toBe(0);
    run.emit(stage('packs', 'start'));
    run.emit({ type: 'done', document: latestFor(prSummary()).document });
    await settle();
    expect(h.last()).toEqual({ kind: 'ready', pr: pr2, earlier: null });

    // A late reply for a pull request the tab has left is dropped.
    h.svc.on('GET /reviews/latest', (req) => {
      if (req.url.searchParams.get('number') !== '3') return json({ error: 'No stored review.' }, 404);
      return new Promise<Response>((resolve) => {
        releaseLatest3 = () => resolve(json(latestFor(pr3)));
      });
    });
    h.tab.go(prUrl('acme/widgets', 3));
    await settle();
    expect(h.last()).toEqual({ kind: 'loading' });
    h.tab.go(prUrl('acme/widgets', 2));
    await until(h, 'ready');
    releaseLatest3();
    await settle();
    expect(h.last()).toEqual({ kind: 'ready', pr: pr2, earlier: null });

    h.tab.go('https://github.com/acme/widgets');
    expect(await until(h, 'no-pr')).toEqual({ kind: 'no-pr' });
    h.tab.go(undefined);
    await settle();
    expect(h.last()).toEqual({ kind: 'no-pr' });
  });

  it('starts on a tab that is not a pull request with no request at all', async () => {
    const h = harness({ url: 'https://example.com/' });
    await until(h, 'no-pr');
    expect(h.svc.calls).toEqual([]);
  });

  it('a response that does not match the schema becomes a problem, not a screen', async () => {
    const h = harness({ prepare: (svc) => svc.on('GET /pr', () => json({ ...prSummary(), title: 7, extra: '<img src=x>' })) });
    expect(await until(h, 'problem')).toEqual({ kind: 'problem', pr: null, message: NOT_UNDERSTOOD });
    expect(h.states.map((s) => s.kind)).toEqual(['loading', 'problem']);

    const bad = harness({ prepare: (svc) => svc.on('GET /reviews/latest', () => json({ document: { id: 'x' }, dismissals: [] })) });
    expect(await until(bad, 'problem')).toEqual({ kind: 'problem', pr: prSummary(), message: NOT_UNDERSTOOD });

    bad.svc.on('GET /reviews/latest', () => json({ error: 'No stored review.' }, 404));
    bad.panel.dispatch({ type: 'retry' });
    await until(bad, 'ready');
  });

  it('re-attaches a lost stream and does not double the stage list', async () => {
    let run!: FakeRun;
    const h = harness({
      prepare: (svc) => {
        run = svc.startRun('acme/widgets', 1);
        run.emit(stage('intake', 'start'));
        run.emit(stage('intake', 'done'));
        run.emit({ type: 'brief', brief });
        run.emit(stage('packs', 'start'));
      },
    });
    const before = await until(h, 'running', (s) => s.stages.length === 2);
    run.lose();
    await settle();
    expect(h.timers.delays()).toEqual([1000]);
    expect(h.last()).toEqual(before);
    run.emit(stage('packs', 'done'));
    run.emit(stage('facts', 'start'));
    h.timers.fire();
    const after = await until(h, 'running', (s) => s.stages.length === 3);
    expect(after.stages.map((l) => `${l.stage}:${l.status}`)).toEqual(['intake:done', 'packs:done', 'facts:working']);
    expect(after.brief).toEqual(brief);
    expect(run.attaches).toBe(2);
  });

  it('gives up after five re-attaches that bring nothing new, and Retry looks again', async () => {
    let run!: FakeRun;
    const h = harness({ prepare: (svc) => { run = svc.startRun('acme/widgets', 1); run.emit(stage('intake', 'start')); } });
    await until(h, 'running', (s) => s.stages.length === 1);
    h.svc.on('GET /reviews/:runId/events', () => { throw new TypeError('Failed to fetch'); });
    run.lose();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await settle();
      expect(h.timers.delays()).toEqual([1000]);
      h.timers.fire();
    }
    const problem = await until(h, 'problem');
    expect(problem).toEqual({ kind: 'problem', pr: prSummary(), message: LOST_MESSAGE, brief: undefined, map: undefined });
    expect(h.timers.delays()).toEqual([]);
    expect(h.svc.calls.filter((c) => c === 'GET /reviews/:runId/events')).toHaveLength(6);
  });

  it('a failed event becomes a problem that keeps the brief already shown', async () => {
    let run!: FakeRun;
    const h = harness({ prepare: (svc) => { run = svc.startRun('acme/widgets', 1); } });
    await until(h, 'running');
    run.emit({ type: 'brief', brief });
    run.emit({ type: 'map', map });
    run.emit({ type: 'failed', message: 'The review stopped: gh is not signed in.' });
    expect(await until(h, 'problem')).toEqual({
      kind: 'problem', pr: prSummary(), message: 'The review stopped: gh is not signed in.', brief, map,
    });
  });

  it('starts a review and follows it; a refusal at the limit is a problem in the service words', async () => {
    const h = harness();
    await until(h, 'ready');
    h.panel.dispatch({ type: 'start', depth: 'standard' });
    h.panel.dispatch({ type: 'start', depth: 'standard' });
    await until(h, 'running');
    expect(h.svc.calls.filter((c) => c === 'POST /reviews')).toHaveLength(1);
    expect(h.svc.requests.find((r) => r.method === 'POST')?.body).toEqual({ repo: 'acme/widgets', number: 1, depth: 'standard' });

    const busy = harness();
    await until(busy, 'ready');
    busy.svc.on('POST /reviews', () => json({ error: 'Two reviews are already running. Wait for one to finish.' }, 429));
    busy.panel.dispatch({ type: 'start', depth: 'deep', packIds: ['generic'] });
    expect(await until(busy, 'problem')).toEqual({
      kind: 'problem', pr: prSummary(), message: 'Two reviews are already running. Wait for one to finish.',
    });
    expect(busy.svc.requests.find((r) => r.method === 'POST')?.body).toEqual({
      repo: 'acme/widgets', number: 1, depth: 'deep', packIds: ['generic'],
    });
  });

  it('a stale review can start a new one, which is attached like any run', async () => {
    const h = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', latestFor(prSummary(), 'd'.repeat(40))) });
    await until(h, 'review');
    h.panel.dispatch({ type: 'start', depth: 'quick' });
    expect(await until(h, 'running')).toEqual({ kind: 'running', pr: prSummary(), stages: [], brief: null, map: null });
  });

  it('dismiss and restore update the dismissals in place and pass on the restore note', async () => {
    const latest = latestFor(prSummary());
    latest.dismissals = [dismissal('0123456789abcdef'), dismissal('1111111111111111')];
    const h = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', latest) });
    await until(h, 'review');
    const replaced = { ...dismissal('0123456789abcdef'), reason: 'wrong' as const, text: 'The rounding happens in the caller.' };
    h.svc.on('POST /dismissals', () => json(replaced));
    h.panel.dispatch({
      type: 'dismiss',
      body: { repo: 'acme/widgets', number: 1, reviewId: 'r_0000000001', findingId: 'c_01234567', reason: 'wrong', text: replaced.text },
    });
    const one = await until(h, 'review', (s) => s.latest.dismissals[0]?.reason === 'wrong');
    expect(one.latest.dismissals.map((d) => d.fingerprint)).toEqual(['0123456789abcdef', '1111111111111111']);

    h.svc.on('POST /dismissals/restore', () => json({ restored: true, note: 'The learned line was edited by hand; it was left as it is.' }));
    h.panel.dispatch({ type: 'restore', fingerprint: '1111111111111111' });
    const two = await until(h, 'review', (s) => s.latest.dismissals.length === 1);
    expect(two.notice).toBe('The learned line was edited by hand; it was left as it is.');
    expect(h.svc.requests.at(-1)?.body).toEqual({ repo: 'acme/widgets', number: 1, fingerprint: '1111111111111111' });

    // A dismissal for a different pull request than the one on screen is not sent.
    h.panel.dispatch({
      type: 'dismiss',
      body: { repo: 'acme/widgets', number: 9, reviewId: 'r_0000000001', findingId: 'c_01234567', reason: 'not-now', text: '' },
    });
    await settle();
    expect(h.svc.calls.filter((c) => c === 'POST /dismissals')).toHaveLength(1);
  });

  it('keeps the review readable when the service goes away during a dismissal, and comes back by itself', async () => {
    const latest = latestFor(prSummary());
    const h = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', latest) });
    const review = await until(h, 'review');
    h.svc.down = true;
    h.panel.dispatch({ type: 'restore', fingerprint: '0123456789abcdef' });
    const offline = await until(h, 'offline');
    expect(offline.review).toEqual({ pr: review.pr, latest: review.latest, stale: review.stale });
    h.timers.fire();
    await settle();
    expect(h.last()).toEqual(offline);
    h.svc.down = false;
    h.timers.fire();
    await until(h, 'review');
  });

  it('ignores an action that does not apply to the current state', async () => {
    const h = harness();
    const ready = await until(h, 'ready');
    const calls = h.svc.calls.length;
    h.panel.dispatch({ type: 'pair', token: TOKEN });
    h.panel.dispatch({ type: 'restore', fingerprint: '0123456789abcdef' });
    h.panel.dispatch({ type: 'show-earlier' });
    h.panel.dispatch({ type: 'retry' });
    await settle();
    expect(h.svc.calls.length).toBe(calls);
    expect(h.last()).toBe(ready);
  });

  it('makes no request to any address but the service', async () => {
    const h = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', latestFor(prSummary())) });
    await until(h, 'review');
    for (const req of h.svc.requests) expect(req.url.origin).toBe(BASE);
  });
});

describe('reduce', () => {
  const pr = prSummary();
  const runningState: PanelState = { kind: 'running', pr, stages: [], brief: null, map: null };

  it('names every stage the engine emits in words, with the raw name as the fallback', () => {
    const engineStages = ['intake', 'packs', 'shape', 'facts', 'map', 'brief', 'lenses', 'sweep', 'seams', 'anchor', 'challenge', 'lenses-deep', 'select', 'store'];
    expect(Object.keys(STAGE_WORDS).sort()).toEqual([...engineStages].sort());
    for (const name of engineStages) {
      expect(stageWords(name)).not.toBe(name);
      expect(stageWords(name)).toMatch(/^[A-Z][a-z]/);
    }
    expect(stageWords('intake')).toBe('Reading the pull request');
    expect(stageWords('challenge')).toBe('Challenging every finding');
    expect(stageWords('select')).toBe('Ranking and picking the top five');
    expect(stageWords('toString')).toBe('toString');
  });

  it('the first event of an attach starts the lists again, so a replay never doubles them', () => {
    let s = reduce(runningState, { type: 'event', event: stage('intake', 'start'), first: true });
    s = reduce(s, { type: 'event', event: stage('intake', 'done'), first: false });
    s = reduce(s, { type: 'event', event: stage('packs', 'start'), first: false });
    const replay = [stage('intake', 'start'), stage('intake', 'done'), stage('packs', 'start')];
    let again = s;
    replay.forEach((event, i) => { again = reduce(again, { type: 'event', event, first: i === 0 }); });
    expect(again).toEqual(s);
    // Even a repeated start within one attach does not add a second line.
    expect(reduce(s, { type: 'event', event: stage('intake', 'start'), first: false })).toMatchObject({
      stages: [{ stage: 'intake', status: 'working' }, { stage: 'packs', status: 'working' }],
    });
  });

  it('shows an earlier review from ready, marked stale against the head', () => {
    const earlier = latestFor(pr, 'd'.repeat(40));
    expect(reduce({ kind: 'ready', pr, earlier }, { type: 'show-earlier' })).toEqual({ kind: 'review', pr, latest: earlier, stale: true });
    const none: PanelState = { kind: 'ready', pr, earlier: null };
    expect(reduce(none, { type: 'show-earlier' })).toBe(none);
  });

  it('ignores service events outside a running review', () => {
    const ready: PanelState = { kind: 'ready', pr, earlier: null };
    expect(reduce(ready, { type: 'event', event: { type: 'brief', brief }, first: true })).toBe(ready);
    expect(reduce({ kind: 'no-pr' }, { type: 'dismissed', dismissal: dismissal('0123456789abcdef') })).toEqual({ kind: 'no-pr' });
  });
});

function dismissal(fingerprint: string): Dismissal {
  return {
    fingerprint, findingId: 'c_01234567', reviewId: 'r_0000000001', reason: 'not-now', text: '',
    at: '2026-11-11T10:00:00Z', learned: null,
  };
}
