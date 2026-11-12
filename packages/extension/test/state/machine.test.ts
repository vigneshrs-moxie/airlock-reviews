import { afterEach, describe, expect, it } from 'vitest';
import type { Brief, ChangeMap, Dismissal, ServiceEvent } from '@airlock/shared';
import { NOT_UNDERSTOOD, ServiceClient } from '../../src/client/service';
import { LOST_MESSAGE, NOT_A_TOKEN, OFFLINE_RETRY_MS, RUN_STOPPED, SHOWING_PROBLEM, TAB_UNREADABLE, WATCH_MS, startPanel } from '../../src/state/machine';
import type { PanelState } from '../../src/state/reduce';
import { STAGE_WORDS } from '../../src/state/stage-words';
import type { SettingsStore } from '../../src/state/settings';
import type { TabWatcher } from '../../src/state/tab';
import {
  BASE, FakeService, OTHER_TOKEN, TOKEN, held, json, latestFor, never, prSummary, prUrl, type FakeRun,
} from '../helpers/fake-service';
import { FakeTimers } from '../helpers/fake-timers';

function memorySettings(token: string | null): SettingsStore & { token: string | null } {
  return {
    token,
    async getToken() { return this.token; },
    async setToken(t) { this.token = t; },
    async getDefaultDepth() { return null; },
    async setDefaultDepth() {},
  };
}

type FakeTab = TabWatcher & { go(url: string | undefined): void; listeners: Set<(url: string | undefined) => void>; reads: number };

function fakeTab(url: string | undefined, failReads = 0): FakeTab {
  const listeners = new Set<(url: string | undefined) => void>();
  const tab: FakeTab = {
    listeners,
    reads: 0,
    current: async () => {
      tab.reads += 1;
      if (tab.reads <= failReads) throw new Error('No tab with id 3');
      return { tabId: 3, url };
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    go(next) {
      for (const fn of listeners) fn(next);
    },
  };
  return tab;
}

const panels: { stop(): void }[] = [];
afterEach(() => {
  for (const p of panels.splice(0)) p.stop();
});

const T0 = Date.parse('2026-11-11T10:00:00.000Z');

function harness(opts: {
  url?: string; token?: string | null; failTabReads?: number; prepare?: (svc: FakeService) => void;
  /** Called before each state is recorded; a throw here is the panel's own listener failing. */
  onState?: (s: PanelState) => void;
} = {}) {
  const svc = new FakeService();
  opts.prepare?.(svc);
  const settings = memorySettings(opts.token === undefined ? TOKEN : opts.token);
  // The client's own timeouts run on separate timers, so these hold only the panel's retries and waits.
  const client = new ServiceClient(BASE, () => settings.getToken(), svc.fetch, new FakeTimers());
  const tab = fakeTab('url' in opts ? opts.url : prUrl('acme/widgets', 1), opts.failTabReads);
  const timers = new FakeTimers();
  const states: PanelState[] = [];
  const clock = { now: T0 };
  const panel = startPanel({
    client, tab, settings, timers, now: () => clock.now,
    onState: (s) => {
      states.push(s);
      opts.onState?.(s);
    },
  });
  panels.push(panel);
  const last = (): PanelState | undefined => states.at(-1);
  return { svc, settings, tab, timers, states, panel, last, clock };
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
const dismissBody = (number = 1, reason: 'not-now' | 'wrong' = 'not-now', text = '') => ({
  repo: 'acme/widgets', number, reviewId: 'r_0000000001', findingId: 'c_01234567', reason, text,
});

function dismissal(fingerprint: string): Dismissal {
  return {
    fingerprint, findingId: 'c_01234567', reviewId: 'r_0000000001', reason: 'not-now', text: '',
    at: '2026-11-11T10:00:00Z', learned: null,
  };
}

describe('startPanel: loading', () => {
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
    expect(await until(h, 'ready')).toEqual({ kind: 'ready', pr: prSummary() });
    // The offline retry is done; what is left is the check that the service still answers.
    expect(h.timers.delays()).toEqual([WATCH_MS]);
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
    expect(odd.message).toMatch(/npm run service -- token/);
    expect(h.svc.calls).not.toContain('POST /pair');

    h.panel.dispatch({ type: 'pair', token: 'c'.repeat(64) });
    await until(h, 'unpaired', (s) => s.message === 'Airlock needs the pairing token. Run "npm run service -- token".');
    expect(h.settings.token).toBe(OTHER_TOKEN);

    h.panel.dispatch({ type: 'pair', token: `${TOKEN}\n` });
    await until(h, 'ready');
    expect(h.settings.token).toBe(TOKEN);
  });

  it('takes the one run of 64 hexadecimal characters out of whatever was pasted', async () => {
    const h = harness({ token: OTHER_TOKEN });
    await until(h, 'unpaired');
    const npm = `\n> airlock@0.0.0 service\n> node packages/service/dist/cli.js token\n\n${TOKEN}\n`;
    h.panel.dispatch({ type: 'pair', token: npm });
    await until(h, 'ready');
    expect(h.settings.token).toBe(TOKEN);
    expect(h.svc.requests.find((r) => r.url.pathname === '/pair')?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    ['two runs', `${'a'.repeat(64)} ${'b'.repeat(64)}`],
    ['a run inside a longer one', `x${'a'.repeat(65)}`],
    ['a run that is too short', 'a'.repeat(63)],
    ['no run at all', 'token please'],
    ['an upper-case run', 'A'.repeat(64)],
    ['a run with an upper-case letter', `${'a'.repeat(63)}F`],
  ])('refuses %s with the same sentence and sends nothing', async (_name, pasted) => {
    const h = harness({ token: OTHER_TOKEN });
    await until(h, 'unpaired');
    h.panel.dispatch({ type: 'pair', token: pasted });
    const refused = await until(h, 'unpaired', (s) => s.message !== undefined);
    expect(refused.message).toBe(NOT_A_TOKEN);
    expect(h.svc.calls).not.toContain('POST /pair');
  });

  it('is unpaired without asking for the pull request when the service has no paired extension or no token is stored', async () => {
    const notPaired = harness({ prepare: (svc) => { svc.paired = false; } });
    await until(notPaired, 'unpaired');
    expect(notPaired.svc.calls).toEqual(['GET /hello']);
    const noToken = harness({ token: null });
    await until(noToken, 'unpaired');
    expect(noToken.svc.calls).toEqual(['GET /hello']);
  });

  it('shows the latest stored review, marked stale when the head moved', async () => {
    const current = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', latestFor(prSummary())) });
    expect(await until(current, 'review')).toMatchObject({ stale: false });

    const moved = latestFor(prSummary(), 'd'.repeat(40));
    const old = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', moved) });
    expect(await until(old, 'review')).toEqual({ kind: 'review', pr: prSummary(), latest: moved, stale: true });
  });

  it('starts on a tab that is not a pull request with no request at all', async () => {
    const h = harness({ url: 'https://example.com/' });
    await until(h, 'no-pr');
    expect(h.svc.calls).toEqual([]);
  });

  it('a tab it cannot read is a problem, and Retry reads the tab again', async () => {
    const h = harness({ failTabReads: 1 });
    expect(await until(h, 'problem')).toEqual({ kind: 'problem', pr: null, message: TAB_UNREADABLE });
    h.panel.dispatch({ type: 'retry' });
    await until(h, 'ready');
    expect(h.tab.reads).toBe(2);
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

});

describe('startPanel: noticing the service stop while nothing is running (Task 13a)', () => {
  it('checks every few seconds while a review is on screen; when the service stops it goes offline with the review kept, and comes back by itself', async () => {
    const h = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', latestFor(prSummary())) });
    const shown = await until(h, 'review');
    expect(WATCH_MS).toBe(OFFLINE_RETRY_MS);
    expect(h.timers.delays()).toEqual([WATCH_MS]);
    // While the service answers, each check is one hello and nothing on screen changes.
    h.timers.fire();
    await settle();
    expect(h.svc.calls.filter((c) => c === 'GET /hello')).toHaveLength(2);
    expect(h.last()).toBe(shown);
    expect(h.timers.delays()).toEqual([WATCH_MS]);

    h.svc.down = true;
    // One unanswered check changes nothing; the second in a row goes offline.
    h.timers.fire();
    await settle();
    expect(h.last()).toBe(shown);
    h.timers.fire();
    expect(await until(h, 'offline')).toEqual({ kind: 'offline', review: { pr: shown.pr, latest: shown.latest, stale: false } });
    expect(h.timers.delays()).toEqual([OFFLINE_RETRY_MS]);

    h.svc.down = false;
    h.timers.fire();
    expect(await until(h, 'review')).toEqual(shown);
    expect(h.timers.delays()).toEqual([WATCH_MS]);
    expect(h.states.map((s) => s.kind)).toEqual(['loading', 'review', 'offline', 'review']);
  });

  it('checks on Ready too, and keeps the pull request Ready showed', async () => {
    const h = harness();
    const ready = await until(h, 'ready');
    h.svc.down = true;
    h.timers.fire();
    await settle();
    h.timers.fire();
    expect(await until(h, 'offline')).toEqual({ kind: 'offline', ready: ready.pr });
    h.svc.down = false;
    h.timers.fire();
    expect(await until(h, 'ready')).toEqual(ready);
  });

  it('goes offline only after two unanswered checks in a row: an answered one starts the count again', async () => {
    const h = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', latestFor(prSummary())) });
    const shown = await until(h, 'review');
    for (const down of [true, false, true, false, true]) {
      h.svc.down = down;
      h.timers.fire();
      await settle();
      expect(h.last()).toBe(shown);
      expect(h.timers.delays()).toEqual([WATCH_MS]);
    }
    h.svc.down = true;
    h.timers.fire();
    await until(h, 'offline');
    expect(h.states.map((s) => s.kind)).toEqual(['loading', 'review', 'offline']);
  });

  it('goes to the Pair screen when a check says the service is not paired', async () => {
    const h = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', latestFor(prSummary())) });
    await until(h, 'review');
    h.svc.paired = false;
    h.timers.fire();
    expect(await until(h, 'unpaired')).toEqual({ kind: 'unpaired' });
    expect(h.timers.delays()).toEqual([]);
  });

  it('checks once at a time, after a review that was started finishes too', async () => {
    const h = harness();
    await until(h, 'ready');
    h.panel.dispatch({ type: 'start', depth: 'quick' });
    await until(h, 'running');
    const run = [...h.svc.runs.values()][0]!;
    run.emit({ type: 'done', document: latestFor(prSummary()).document });
    await until(h, 'review');
    // The check set while Ready, and the one set when the review finished, make one check, not two.
    h.timers.fire();
    await settle();
    expect(h.timers.delays()).toEqual([WATCH_MS]);
    const hellos = h.svc.calls.filter((c) => c === 'GET /hello').length;
    h.timers.fire();
    await settle();
    expect(h.svc.calls.filter((c) => c === 'GET /hello')).toHaveLength(hellos + 1);
  });

  it('does not check while running, unpaired or with no pull request, and stops checking when the panel stops', async () => {
    const running = harness({ prepare: (svc) => { const run = svc.startRun('acme/widgets', 1); run.emit(stage('intake', 'start')); } });
    await until(running, 'running');
    expect(running.timers.delays()).toEqual([]);
    const unpaired = harness({ token: null });
    await until(unpaired, 'unpaired');
    expect(unpaired.timers.delays()).toEqual([]);
    const none = harness({ url: 'https://example.com/' });
    await until(none, 'no-pr');
    expect(none.timers.delays()).toEqual([]);
    const ready = harness();
    await until(ready, 'ready');
    ready.panel.stop();
    expect(ready.timers.delays()).toEqual([]);
  });
});

describe('startPanel: following a review', () => {
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
    expect(await until(h, 'review')).toEqual({ kind: 'review', pr: prSummary(), latest, stale: false });
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
      kind: 'review', pr: prSummary(), latest: { document: doc, dismissals: [], posts: [] }, stale: true,
    });
  });

  it('re-attaches a stream that closed early without doubling or flickering the stage list', async () => {
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
    run.close();
    await settle();
    expect(h.timers.delays()).toEqual([1000]);
    expect(h.last()).toEqual(before);
    run.emit(stage('packs', 'done'));
    run.emit(stage('facts', 'start'));
    const seenBefore = h.states.length;
    h.timers.fire();
    const after = await until(h, 'running', (s) => s.stages.length === 3);
    expect(after.stages.map((l) => `${l.stage}:${l.status}`)).toEqual(['intake:done', 'packs:done', 'facts:working']);
    expect(after.brief).toEqual(brief);
    expect(run.attaches).toBe(2);
    // While the replay catches up, the old list stays: no state shows fewer lines, or intake working again.
    for (const s of h.states.slice(seenBefore)) {
      if (s.kind !== 'running') continue;
      expect(s.stages.length).toBeGreaterThanOrEqual(2);
      expect(s.stages[0]).toMatchObject({ stage: 'intake', status: 'done' });
    }
  });

  it('when the stream breaks but hello answers, re-attaches', async () => {
    let run!: FakeRun;
    const h = harness({ prepare: (svc) => { run = svc.startRun('acme/widgets', 1); run.emit(stage('intake', 'start')); } });
    await until(h, 'running', (s) => s.stages.length === 1);
    run.lose();
    await settle();
    expect(h.svc.calls.at(-1)).toBe('GET /hello');
    expect(h.timers.delays()).toEqual([1000]);
    h.timers.fire();
    await settle();
    expect(run.attaches).toBe(2);
    expect(h.last()?.kind).toBe('running');
  });

  it('the service stopping during a review ends at offline with the brief and map kept, and recovers by itself', async () => {
    let run!: FakeRun;
    const h = harness({ prepare: (svc) => { run = svc.startRun('acme/widgets', 1); run.emit(stage('intake', 'start')); } });
    await until(h, 'running', (s) => s.stages.length === 1);
    run.emit({ type: 'brief', brief });
    run.emit({ type: 'map', map });
    await until(h, 'running', (s) => s.map !== null);
    h.svc.down = true;
    run.lose();
    expect(await until(h, 'offline')).toEqual({ kind: 'offline', progress: { pr: prSummary(), brief, map, startedAt: T0 } });
    expect(h.timers.delays()).toEqual([5000]);
    h.timers.fire();
    await settle();
    expect(h.last()?.kind).toBe('offline');
    h.svc.down = false;
    run.emit(stage('packs', 'start'));
    h.timers.fire();
    const back = await until(h, 'running', (s) => s.stages.length === 2);
    expect(back.brief).toEqual(brief);
    expect(back.map).toEqual(map);
  });

  it('gives up after five re-attaches in a row that bring nothing new, and Retry looks again', async () => {
    let run!: FakeRun;
    const h = harness({ prepare: (svc) => { run = svc.startRun('acme/widgets', 1); run.emit(stage('intake', 'start')); } });
    await until(h, 'running', (s) => s.stages.length === 1);
    h.svc.on('GET /reviews/:runId/events', () => new Response(''));
    run.close();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await settle();
      expect(h.timers.delays()).toEqual([1000]);
      h.timers.fire();
    }
    const problem = await until(h, 'problem');
    expect(problem).toEqual({ kind: 'problem', pr: prSummary(), message: LOST_MESSAGE });
    expect('brief' in problem || 'map' in problem).toBe(false);
    expect(h.timers.delays()).toEqual([]);
    expect(h.svc.calls.filter((c) => c === 'GET /reviews/:runId/events')).toHaveLength(6);
  });

  it('gives up after twenty re-attaches in all, even when each brings something new', async () => {
    let n = 0;
    const h = harness({
      prepare: (svc) => {
        svc.startRun('acme/widgets', 1);
        svc.on('GET /reviews/:runId/events', () => {
          n += 1;
          const lines = Array.from({ length: n }, (_, i) => `data: ${JSON.stringify(stage(`s${i}`, 'start'))}\n\n`);
          return new Response(lines.join(''));
        });
      },
    });
    for (let reattach = 1; reattach <= 20; reattach++) {
      await settle();
      expect(h.timers.delays()).toEqual([1000]);
      h.timers.fire();
    }
    expect(await until(h, 'problem')).toEqual({ kind: 'problem', pr: prSummary(), message: LOST_MESSAGE });
    expect(n).toBe(21);
  });

  it('the panel failing to show an event is a problem of its own, not the service going away', async () => {
    let run!: FakeRun;
    const h = harness({
      prepare: (svc) => { run = svc.startRun('acme/widgets', 1); run.emit(stage('intake', 'start')); },
      onState: (s) => {
        if (s.kind === 'running' && s.brief !== null) throw new TypeError('Cannot read properties of undefined');
      },
    });
    await until(h, 'running', (s) => s.stages.length === 1);
    run.emit({ type: 'brief', brief });
    expect(await until(h, 'problem')).toEqual({ kind: 'problem', pr: prSummary(), message: SHOWING_PROBLEM, brief });
    await settle();
    expect(h.timers.delays()).toEqual([]);
    expect(run.attaches).toBe(1);
    expect(run.listeners.size).toBe(0);
    expect(h.svc.calls.filter((c) => c === 'GET /hello')).toHaveLength(1);
  });

  it('network breaks where hello answers each time run to the re-attach limit and end at the lost-connection problem', async () => {
    let run!: FakeRun;
    const h = harness({ prepare: (svc) => { run = svc.startRun('acme/widgets', 1); run.emit(stage('intake', 'start')); } });
    await until(h, 'running', (s) => s.stages.length === 1);
    h.svc.on('GET /reviews/:runId/events', () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.error(new TypeError('network error')); },
    })));
    run.lose();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await settle();
      expect(h.timers.delays()).toEqual([1000]);
      h.timers.fire();
    }
    expect(await until(h, 'problem')).toEqual({ kind: 'problem', pr: prSummary(), message: LOST_MESSAGE });
    expect(h.svc.calls.filter((c) => c === 'GET /reviews/:runId/events')).toHaveLength(6);
    // One hello after each of the six breaks, besides the first load's.
    expect(h.svc.calls.filter((c) => c === 'GET /hello')).toHaveLength(7);
    expect(h.timers.delays()).toEqual([]);
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
});

describe('startPanel: the service restarting during a review', () => {
  /** A review is running and showing its brief when the service stops; it is then started again, as set up by `restart`. */
  async function cutOff(restart: (svc: FakeService) => void) {
    let run!: FakeRun;
    const h = harness({ prepare: (svc) => { run = svc.startRun('acme/widgets', 1); run.emit(stage('intake', 'start')); } });
    await until(h, 'running', (s) => s.stages.length === 1);
    run.emit({ type: 'brief', brief });
    await until(h, 'running', (s) => s.brief !== null);
    h.clock.now = T0 + 60_000;
    h.svc.down = true;
    run.lose();
    const offline = await until(h, 'offline');
    expect(offline.progress).toEqual({ pr: prSummary(), brief, map: null, startedAt: T0 });
    h.svc.down = false;
    restart(h.svc);
    h.timers.fire();
    return { h, run };
  }

  const stored = (createdAt: string) => {
    const latest = latestFor(prSummary());
    return { ...latest, document: { ...latest.document, createdAt } };
  };

  it('the run is gone and nothing is stored: ready, saying the review stopped', async () => {
    const { h } = await cutOff((svc) => svc.running.clear());
    expect(await until(h, 'ready')).toEqual({ kind: 'ready', pr: prSummary(), notice: RUN_STOPPED });
  });

  it('the run is gone and only an older review is stored: that review, saying the running one stopped', async () => {
    const older = stored('2026-11-11T09:00:00.000Z');
    const { h } = await cutOff((svc) => { svc.running.clear(); svc.latest.set('acme/widgets#1', older); });
    expect(await until(h, 'review')).toEqual({ kind: 'review', pr: prSummary(), latest: older, stale: false, notice: RUN_STOPPED });
  });

  it('the run finished while the panel was cut off: its review, with no notice', async () => {
    const result = stored('2026-11-11T10:00:30.000Z');
    const { h } = await cutOff((svc) => { svc.running.clear(); svc.latest.set('acme/widgets#1', result); });
    expect(await until(h, 'review')).toEqual({ kind: 'review', pr: prSummary(), latest: result, stale: false });
  });

  it('the run is still there: running again, with no notice', async () => {
    const { h, run } = await cutOff(() => {});
    run.emit(stage('packs', 'start'));
    const back = await until(h, 'running', (s) => s.stages.length === 2);
    expect(back.brief).toEqual(brief);
    expect(h.states.some((s) => 'notice' in s)).toBe(false);
  });

  it('a run this panel started counts from just before it asked for it', async () => {
    const h = harness();
    await until(h, 'ready');
    h.panel.dispatch({ type: 'start', depth: 'quick' });
    await until(h, 'running');
    h.clock.now = T0 + 60_000;
    h.svc.down = true;
    for (const run of h.svc.runs.values()) run.lose();
    expect((await until(h, 'offline')).progress?.startedAt).toBe(T0);
  });
});

describe('startPanel: the tab moving', () => {
  it('moves to another pull request when the tab address changes and drops the old stream', async () => {
    let run!: FakeRun;
    const pr2 = prSummary({ number: 2, title: 'Second' });
    const h = harness({
      prepare: (svc) => {
        run = svc.startRun('acme/widgets', 1);
        run.emit(stage('intake', 'start'));
        svc.addPr(pr2);
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
    expect(await until(h, 'ready')).toEqual({ kind: 'ready', pr: pr2 });
    expect(run.listeners.size).toBe(0);
    run.emit(stage('packs', 'start'));
    run.emit({ type: 'done', document: latestFor(prSummary()).document });
    await settle();
    expect(h.last()).toEqual({ kind: 'ready', pr: pr2 });

    h.tab.go('https://github.com/acme/widgets');
    expect(await until(h, 'no-pr')).toEqual({ kind: 'no-pr' });
    h.tab.go(undefined);
    await settle();
    expect(h.last()).toEqual({ kind: 'no-pr' });
  });

  it('aborts the old pull request’s pr, running and latest requests and drops their late replies', async () => {
    const pr2 = prSummary({ number: 2 });
    const pr3 = prSummary({ number: 3 });
    const h = harness({ prepare: (svc) => { svc.addPr(pr2); svc.addPr(pr3); svc.on('GET /pr', never); } });
    await until(h, 'loading');
    await settle();
    h.svc.on('GET /pr', (req) => json(req.url.searchParams.get('number') === '2' ? pr2 : pr3));
    h.svc.on('GET /reviews/running', (req) => (req.url.searchParams.get('number') === '3' ? never(req) : json({ error: 'none' }, 404)));
    h.tab.go(prUrl('acme/widgets', 3));
    await settle();
    h.svc.on('GET /reviews/latest', (req) => (req.url.searchParams.get('number') === '2' ? never(req) : json({ error: 'none' }, 404)));
    h.tab.go(prUrl('acme/widgets', 2));
    await settle();
    h.svc.on('GET /reviews/latest', () => json({ error: 'none' }, 404));
    h.tab.go(prUrl('acme/widgets', 3));
    await settle();
    h.svc.on('GET /reviews/running', () => json({ error: 'none' }, 404));
    h.tab.go(prUrl('acme/widgets', 2));
    expect(await until(h, 'ready')).toEqual({ kind: 'ready', pr: pr2 });

    const abortedFor = (path: string, number: string) =>
      h.svc.requests.filter((r) => r.url.pathname === path && r.url.searchParams.get('number') === number).map((r) => r.signal?.aborted);
    expect(abortedFor('/pr', '1')).toEqual([true]);
    expect(abortedFor('/reviews/running', '3')[0]).toBe(true);
    expect(abortedFor('/reviews/latest', '2')[0]).toBe(true);
  });

  it('a late latest reply for a pull request the tab has left is dropped', async () => {
    const pr2 = prSummary({ number: 2 });
    const pr3 = prSummary({ number: 3 });
    const late = held();
    const h = harness({ prepare: (svc) => { svc.addPr(pr2); svc.addPr(pr3); } });
    await until(h, 'ready');
    h.svc.on('GET /reviews/latest', (req) => (req.url.searchParams.get('number') === '3' ? late.reply() : json({ error: 'none' }, 404)));
    h.tab.go(prUrl('acme/widgets', 3));
    await settle();
    expect(h.last()).toEqual({ kind: 'loading' });
    h.tab.go(prUrl('acme/widgets', 2));
    await until(h, 'ready', (s) => s.pr.number === 2);
    late.release(json(latestFor(pr3)));
    await settle();
    expect(h.last()).toEqual({ kind: 'ready', pr: pr2 });
  });

  it('done, then a slow latest, then the tab moves: the old review never shows', async () => {
    let run!: FakeRun;
    const pr2 = prSummary({ number: 2 });
    const slow = held();
    const h = harness({ prepare: (svc) => { run = svc.startRun('acme/widgets', 1); svc.addPr(pr2); } });
    await until(h, 'running');
    h.svc.on('GET /reviews/latest', (req) => (req.url.searchParams.get('number') === '1' ? slow.reply() : json({ error: 'none' }, 404)));
    run.emit({ type: 'done', document: latestFor(prSummary()).document });
    await settle();
    expect(slow.asked()).toBe(true);
    h.tab.go(prUrl('acme/widgets', 2));
    await until(h, 'ready');
    slow.release(json(latestFor(prSummary())));
    await settle();
    expect(h.last()).toEqual({ kind: 'ready', pr: pr2 });
  });

  it('a dismissal in flight when the tab moves is still recorded, and the new pull request is untouched', async () => {
    const pr2 = prSummary({ number: 2 });
    const pending = held();
    const h = harness({ prepare: (svc) => { svc.latest.set('acme/widgets#1', latestFor(prSummary())); svc.addPr(pr2); } });
    await until(h, 'review');
    h.svc.on('POST /dismissals', pending.reply);
    h.panel.dispatch({ type: 'dismiss', body: dismissBody() });
    await settle();
    expect(pending.asked()).toBe(true);
    h.tab.go(prUrl('acme/widgets', 2));
    await until(h, 'ready');
    pending.release(json(dismissal('0123456789abcdef')));
    await settle();
    const dismissRequest = h.svc.requests.find((r) => r.url.pathname === '/dismissals');
    expect(dismissRequest?.signal?.aborted).not.toBe(true);
    expect(h.last()).toEqual({ kind: 'ready', pr: pr2 });
  });
});

describe('startPanel: stopping', () => {
  it('stop() while a request is in flight: its reply changes nothing', async () => {
    const late = held();
    const h = harness({ prepare: (svc) => svc.on('GET /pr', late.reply) });
    await settle();
    expect(late.asked()).toBe(true);
    h.panel.stop();
    const count = h.states.length;
    late.release(json(prSummary()));
    await settle();
    expect(h.states.length).toBe(count);
    expect(h.svc.calls).not.toContain('GET /reviews/running');
  });

  it('stop() during a re-attach wait: no timer is left and no attach follows', async () => {
    let run!: FakeRun;
    const h = harness({ prepare: (svc) => { run = svc.startRun('acme/widgets', 1); run.emit(stage('intake', 'start')); } });
    await until(h, 'running', (s) => s.stages.length === 1);
    run.close();
    await settle();
    expect(h.timers.delays()).toEqual([1000]);
    h.panel.stop();
    expect(h.timers.delays()).toEqual([]);
    const count = h.states.length;
    await settle();
    expect(run.attaches).toBe(1);
    expect(h.states.length).toBe(count);
  });
});

describe('startPanel: actions', () => {
  it('starts a review and follows it, busy while the request is in flight', async () => {
    const h = harness();
    await until(h, 'ready');
    h.panel.dispatch({ type: 'start', depth: 'standard' });
    h.panel.dispatch({ type: 'start', depth: 'standard' });
    await until(h, 'running');
    expect(h.svc.calls.filter((c) => c === 'POST /reviews')).toHaveLength(1);
    expect(h.svc.requests.find((r) => r.method === 'POST')?.body).toEqual({ repo: 'acme/widgets', number: 1, depth: 'standard' });
    expect(h.states.map((s) => s.kind)).toEqual(['loading', 'ready', 'ready', 'running']);
    expect(h.states[2]).toEqual({ kind: 'ready', pr: prSummary(), busy: true });
  });

  it('a 429 from ready stays on ready with the service words as a notice', async () => {
    const h = harness();
    await until(h, 'ready');
    h.svc.on('POST /reviews', () => json({ error: 'Two reviews are already running. Wait for one to finish.' }, 429));
    h.panel.dispatch({ type: 'start', depth: 'deep', packIds: ['generic'] });
    expect(await until(h, 'ready', (s) => s.notice !== undefined)).toEqual({
      kind: 'ready', pr: prSummary(), notice: 'Two reviews are already running. Wait for one to finish.',
    });
    expect(h.svc.requests.find((r) => r.method === 'POST')?.body).toEqual({
      repo: 'acme/widgets', number: 1, depth: 'deep', packIds: ['generic'],
    });
  });

  it('a stale review can start a new one, which is attached like any run', async () => {
    const h = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', latestFor(prSummary(), 'd'.repeat(40))) });
    await until(h, 'review');
    h.panel.dispatch({ type: 'start', depth: 'quick' });
    expect(await until(h, 'running')).toEqual({ kind: 'running', pr: prSummary(), stages: [], brief: null, map: null });
  });

  it('a refused start, dismiss or restore keeps the review on screen with the service words, and a success clears them', async () => {
    const latest = latestFor(prSummary());
    latest.dismissals = [dismissal('1111111111111111')];
    const h = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', latest) });
    await until(h, 'review');
    const noticed = (text: string) => until(h, 'review', (s) => s.notice === text);

    h.svc.on('POST /reviews', () => json({ error: 'Two reviews are already running. Wait for one to finish.' }, 429));
    h.panel.dispatch({ type: 'start', depth: 'quick' });
    const afterStart = await noticed('Two reviews are already running. Wait for one to finish.');
    expect(afterStart).toEqual({ kind: 'review', pr: prSummary(), latest, stale: false, notice: 'Two reviews are already running. Wait for one to finish.' });

    h.svc.on('POST /dismissals', () => json({ error: 'That finding is not in the stored review.' }, 404));
    h.panel.dispatch({ type: 'dismiss', body: dismissBody() });
    await noticed('That finding is not in the stored review.');

    h.svc.on('POST /dismissals', () => json({ error: 'The text needs at least 10 characters.' }, 400));
    h.panel.dispatch({ type: 'dismiss', body: dismissBody(1, 'wrong', 'Too short.') });
    await noticed('The text needs at least 10 characters.');

    h.svc.on('POST /dismissals/restore', () => json({ restored: 'maybe' }));
    h.panel.dispatch({ type: 'restore', fingerprint: '1111111111111111' });
    const unparsed = await noticed(NOT_UNDERSTOOD);
    expect(unparsed.latest).toEqual(latest);

    h.svc.on('POST /dismissals/restore', () => json({ error: 'Airlock is already paired with another copy of the extension.' }, 409));
    h.panel.dispatch({ type: 'restore', fingerprint: '1111111111111111' });
    await noticed('Airlock is already paired with another copy of the extension.');

    h.svc.on('POST /dismissals', () => json(dismissal('0123456789abcdef')));
    h.panel.dispatch({ type: 'dismiss', body: dismissBody() });
    const cleared = await until(h, 'review', (s) => s.latest.dismissals.length === 2);
    expect(cleared.notice).toBeUndefined();
    expect(cleared.busy).toBeUndefined();
    expect(h.states.some((s) => s.kind === 'review' && s.busy === true)).toBe(true);
  });

  it('a start for the push alone sends since last, and a refusal of it is shown where a refused start is', async () => {
    const h = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', latestFor(prSummary())) });
    await until(h, 'review');
    const sent: unknown[] = [];
    h.svc.on('POST /reviews', (req) => { sent.push(req.body); return json({ error: 'Nothing was pushed since the last review.' }, 409); });
    h.panel.dispatch({ type: 'start', depth: 'deep', since: 'last' });
    const refused = await until(h, 'review', (s) => s.notice === 'Nothing was pushed since the last review.');
    expect(sent).toEqual([{ repo: 'acme/widgets', number: 1, depth: 'deep', since: 'last' }]);
    expect(refused.busy).toBeUndefined();
    h.svc.on('POST /reviews', (req) => { sent.push(req.body); return json({ error: 'There is no earlier review of this pull request.' }, 409); });
    h.panel.dispatch({ type: 'start', depth: 'quick' });
    await until(h, 'review', (s) => s.notice === 'There is no earlier review of this pull request.');
    expect(sent[1]).toEqual({ repo: 'acme/widgets', number: 1, depth: 'quick' });
  });

  it('a refused action that means not paired still goes to unpaired', async () => {
    const h = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', latestFor(prSummary())) });
    await until(h, 'review');
    h.svc.token = OTHER_TOKEN;
    h.panel.dispatch({ type: 'dismiss', body: dismissBody() });
    expect(await until(h, 'unpaired')).toEqual({ kind: 'unpaired' });
  });

  it('a second action while one is in flight is ignored', async () => {
    const pending = held();
    const h = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', latestFor(prSummary())) });
    await until(h, 'review');
    h.svc.on('POST /dismissals', pending.reply);
    h.panel.dispatch({ type: 'dismiss', body: dismissBody() });
    await until(h, 'review', (s) => s.busy === true);
    h.panel.dispatch({ type: 'restore', fingerprint: '0123456789abcdef' });
    h.panel.dispatch({ type: 'start', depth: 'quick' });
    await settle();
    expect(h.svc.calls.filter((c) => c.startsWith('POST'))).toEqual(['POST /dismissals']);
    pending.release(json(dismissal('0123456789abcdef')));
    const done = await until(h, 'review', (s) => s.busy === undefined);
    expect(done.latest.dismissals).toHaveLength(1);
  });

  it('dismiss and restore update the dismissals in place and pass on the restore note', async () => {
    const latest = latestFor(prSummary());
    latest.dismissals = [dismissal('0123456789abcdef'), dismissal('1111111111111111')];
    const h = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', latest) });
    await until(h, 'review');
    const replaced = { ...dismissal('0123456789abcdef'), reason: 'wrong' as const, text: 'The rounding happens in the caller.' };
    h.svc.on('POST /dismissals', () => json(replaced));
    h.panel.dispatch({ type: 'dismiss', body: dismissBody(1, 'wrong', replaced.text) });
    const one = await until(h, 'review', (s) => s.latest.dismissals[0]?.reason === 'wrong');
    expect(one.latest.dismissals.map((d) => d.fingerprint)).toEqual(['0123456789abcdef', '1111111111111111']);

    h.svc.on('POST /dismissals/restore', () => json({ restored: true, note: 'The learned line was edited by hand; it was left as it is.' }));
    h.panel.dispatch({ type: 'restore', fingerprint: '1111111111111111' });
    const two = await until(h, 'review', (s) => s.latest.dismissals.length === 1);
    expect(two.notice).toBe('The learned line was edited by hand; it was left as it is.');
    expect(h.svc.requests.at(-1)?.body).toEqual({ repo: 'acme/widgets', number: 1, fingerprint: '1111111111111111' });

    // A dismissal for a different pull request than the one on screen is not sent.
    h.panel.dispatch({ type: 'dismiss', body: dismissBody(9) });
    await settle();
    expect(h.svc.calls.filter((c) => c === 'POST /dismissals')).toHaveLength(1);
  });

  it('keeps the review readable when the service goes away during a dismissal, and comes back by itself', async () => {
    const h = harness({ prepare: (svc) => svc.latest.set('acme/widgets#1', latestFor(prSummary())) });
    const review = await until(h, 'review');
    h.svc.down = true;
    h.panel.dispatch({ type: 'restore', fingerprint: '0123456789abcdef' });
    const offline = await until(h, 'offline');
    expect(offline).toEqual({ kind: 'offline', review: { pr: review.pr, latest: review.latest, stale: review.stale } });
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
    h.panel.dispatch({ type: 'dismiss', body: dismissBody() });
    h.panel.dispatch({ type: 'retry' });
    await settle();
    expect(h.svc.calls.length).toBe(calls);
    expect(h.last()).toBe(ready);
  });
});
