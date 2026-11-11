import { describe, expect, it } from 'vitest';
import { minimalDocument, ServiceEventSchema, type ReviewDocument, type ReviewEvent, type ServiceEvent, type StartReviewBody } from '@airlock/shared';
import { DEFAULT_RUN_MINUTES, FINISHED_KEEP_MAX, FINISHED_KEEP_MS, LimitError, Runs } from '../src/runs.js';
import { FakeClock } from './helpers.js';

interface Launched {
  body: StartReviewBody;
  emit: (e: ReviewEvent) => void;
  resolve: (doc: ReviewDocument) => void;
  reject: (e: unknown) => void;
}

function rig(launch?: (body: StartReviewBody, emit: (e: ReviewEvent) => void) => Promise<ReviewDocument>, runMinutes?: number) {
  const clock = new FakeClock();
  const launched: Launched[] = [];
  const logged: string[] = [];
  const runs = new Runs({
    timers: clock.timers,
    ...(runMinutes === undefined ? {} : { runMinutes }),
    failure: (e) => `Airlock could not review this pull request: ${e instanceof Error ? e.message : String(e)}`,
    log: (line) => logged.push(line),
    launch: launch ?? ((body, emit) => new Promise<ReviewDocument>((resolve, reject) => {
      launched.push({ body, emit, resolve, reject });
    })),
  });
  return { clock, launched, runs, logged };
}

const doc = (id = 'r_0123456789'): ReviewDocument => ({ ...minimalDocument(), id });
const stage = (name: string): ReviewEvent => ({ type: 'stage', stage: name, status: 'start', detail: '' });
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const pr = (number: number): StartReviewBody => ({ repo: 'acme/widgets', number });

describe('Runs', () => {
  it('gives each run an id of run_ and 12 hex characters', () => {
    const { runs } = rig();
    const a = runs.start(pr(1));
    const b = runs.start(pr(2));
    expect(a.runId).toMatch(/^run_[0-9a-f]{12}$/);
    expect(b.runId).toMatch(/^run_[0-9a-f]{12}$/);
    expect(a.runId).not.toBe(b.runId);
    expect(a.reused).toBe(false);
  });

  it('reuses the run of a pull request that is running, and counts only active runs against the limit', async () => {
    const { runs, launched } = rig();
    const first = runs.start(pr(1));
    expect(runs.start(pr(1))).toEqual({ runId: first.runId, reused: true });
    runs.start(pr(2));
    expect(() => runs.start(pr(3))).toThrow(LimitError);
    expect(launched).toHaveLength(2);
    launched[0]!.emit({ type: 'done', document: doc() });
    expect(runs.running('acme/widgets', 1)).toBeNull();
    expect(runs.start(pr(3)).reused).toBe(false);
    // A finished pull request starts a new run, not the old one.
    await flush();
    expect(runs.active().map((r) => r.number).sort()).toEqual([2, 3]);
  });

  it('keeps every event in order and ends the run at the engine’s done', () => {
    const { runs, launched } = rig();
    const { runId } = runs.start(pr(1));
    const seen: ServiceEvent[] = [];
    runs.events(runId)!.subscribe((e) => seen.push(e));
    launched[0]!.emit(stage('intake'));
    launched[0]!.emit({ type: 'done', document: doc() });
    launched[0]!.emit(stage('late')); // after done: ignored
    const after = runs.events(runId)!;
    expect(after.finished).toBe(true);
    expect(after.past.map((e) => e.type)).toEqual(['stage', 'done']);
    expect(seen.map((e) => e.type)).toEqual(['stage', 'done']);
  });

  it('emits done itself when the review resolves without having sent it', async () => {
    const { runs, launched } = rig();
    const { runId } = runs.start(pr(1));
    launched[0]!.resolve(doc('r_aaaaaaaaaa'));
    await flush();
    const handle = runs.events(runId)!;
    expect(handle.finished).toBe(true);
    expect(handle.past).toEqual([{ type: 'done', document: doc('r_aaaaaaaaaa') }]);
  });

  it('ends a run whose review rejects, or throws before returning a promise, with a failed event', async () => {
    const { runs, launched } = rig();
    const { runId } = runs.start(pr(1));
    launched[0]!.reject(new Error('no such pull request'));
    await flush();
    expect(runs.events(runId)!.past).toEqual([{ type: 'failed', message: 'Airlock could not review this pull request: no such pull request' }]);
    expect(runs.active()).toEqual([]);

    const sync = rig(() => { throw new Error('thrown at once'); });
    const second = sync.runs.start(pr(1));
    await flush();
    expect(sync.runs.events(second.runId)!.past).toEqual([{ type: 'failed', message: 'Airlock could not review this pull request: thrown at once' }]);
  });

  it('a listener that throws does not stop the run or other listeners', () => {
    const { runs, launched } = rig();
    const { runId } = runs.start(pr(1));
    const handle = runs.events(runId)!;
    const seen: string[] = [];
    handle.subscribe(() => { throw new Error('listener broke'); });
    handle.subscribe((e) => seen.push(e.type));
    launched[0]!.emit(stage('intake'));
    launched[0]!.emit({ type: 'done', document: doc() });
    expect(seen).toEqual(['stage', 'done']);
  });

  it('does not keep or pass on an event that does not match the contract; a bad done fails the run', () => {
    const { runs, launched, logged } = rig();
    const { runId } = runs.start(pr(1));
    launched[0]!.emit({ type: 'stage', stage: 'intake' } as unknown as ReviewEvent);
    launched[0]!.emit({ type: 'done', document: { ...doc(), verdict: 'nope' } } as unknown as ReviewEvent);
    const handle = runs.events(runId)!;
    expect(handle.finished).toBe(true);
    expect(handle.past).toHaveLength(1);
    expect(handle.past[0]!.type).toBe('failed');
    expect(handle.past.every((e) => ServiceEventSchema.safeParse(e).success)).toBe(true);
    expect(logged.some((l) => l.includes('does not match'))).toBe(true);
  });

  it('drops a finished run after ten minutes', () => {
    const { runs, launched, clock } = rig();
    const { runId } = runs.start(pr(1));
    launched[0]!.emit({ type: 'done', document: doc() });
    clock.advance(FINISHED_KEEP_MS - 1);
    expect(runs.events(runId)).not.toBeNull();
    clock.advance(1);
    expect(runs.events(runId)).toBeNull();
    expect(clock.pending).toBe(0);
  });

  it('keeps at most 20 finished runs, dropping the oldest first', () => {
    const { runs, launched } = rig();
    const ids: string[] = [];
    for (let n = 1; n <= FINISHED_KEEP_MAX + 2; n += 1) {
      ids.push(runs.start(pr(n)).runId);
      launched[n - 1]!.emit({ type: 'done', document: doc() });
    }
    expect(runs.events(ids[0]!)).toBeNull();
    expect(runs.events(ids[1]!)).toBeNull();
    for (const id of ids.slice(2)) expect(runs.events(id)).not.toBeNull();
  });

  it('a subscription to a finished run receives nothing and an unsubscribe stops delivery', () => {
    const { runs, launched } = rig();
    const { runId } = runs.start(pr(1));
    const seen: string[] = [];
    const stop = runs.events(runId)!.subscribe((e) => seen.push(e.type));
    launched[0]!.emit(stage('intake'));
    stop();
    launched[0]!.emit(stage('packs'));
    expect(seen).toEqual(['stage']);
    launched[0]!.emit({ type: 'done', document: doc() });
    const late: string[] = [];
    runs.events(runId)!.subscribe((e) => late.push(e.type));
    expect(late).toEqual([]);
  });

  it('stops a review that never settles at the ceiling, frees its slot and ignores what it does afterwards', async () => {
    const { runs, launched, clock, logged } = rig(undefined, 5);
    const { runId } = runs.start(pr(1));
    runs.start(pr(2));
    launched[0]!.emit(stage('intake'));
    clock.advance(5 * 60_000 - 1);
    expect(runs.events(runId)!.finished).toBe(false);
    clock.advance(1);
    const ended = runs.events(runId)!;
    expect(ended.finished).toBe(true);
    expect(ended.past.at(-1)).toEqual({ type: 'failed', message: 'Airlock stopped this review because it ran for more than 5 minutes.' });
    expect(runs.running('acme/widgets', 1)).toBeNull();
    expect(runs.start(pr(3)).reused).toBe(false);
    // A done, a resolve and a late rejection after the ceiling change nothing.
    launched[0]!.emit({ type: 'done', document: doc() });
    launched[0]!.resolve(doc());
    launched[0]!.reject(new Error('late'));
    await flush();
    expect(runs.events(runId)!.past).toEqual(ended.past);
    expect(logged.some((l) => l.includes('Unhandled'))).toBe(false);
  });

  it('defaults the ceiling to 90 minutes and words the message with the real number', () => {
    expect(DEFAULT_RUN_MINUTES).toBe(90);
    const { runs, clock } = rig();
    const { runId } = runs.start(pr(1));
    clock.advance(90 * 60_000);
    expect(runs.events(runId)!.past).toEqual([{ type: 'failed', message: 'Airlock stopped this review because it ran for more than 90 minutes.' }]);
  });

  it('a review that finishes before the ceiling leaves no timer but its ten-minute one, and none after that', () => {
    const { runs, launched, clock } = rig(undefined, 5);
    runs.start(pr(1));
    expect(clock.pending).toBe(1);
    launched[0]!.emit({ type: 'done', document: doc() });
    expect(clock.pending).toBe(1);
    clock.advance(FINISHED_KEEP_MS);
    expect(clock.pending).toBe(0);
  });

  it('matches a running pull request whatever the letter case of the repository, and keeps the case first given', () => {
    const { runs, launched } = rig();
    const first = runs.start({ repo: 'Acme/Widgets', number: 1 });
    expect(runs.start({ repo: 'acme/widgets', number: 1 })).toEqual({ runId: first.runId, reused: true });
    expect(runs.running('ACME/WIDGETS', 1)).toBe(first.runId);
    expect(runs.active()).toEqual([{ runId: first.runId, repo: 'Acme/Widgets', number: 1 }]);
    expect(launched).toHaveLength(1);
  });

  it('close() clears every timer, refuses new starts, and sends later events nowhere', () => {
    const { runs, launched, clock } = rig();
    const done = runs.start(pr(1));
    launched[0]!.emit({ type: 'done', document: doc() });
    const live = runs.start(pr(2));
    const seen: string[] = [];
    runs.events(live.runId)!.subscribe((e) => seen.push(e.type));
    expect(clock.pending).toBe(2);
    runs.close();
    expect(clock.pending).toBe(0);
    expect(() => runs.start(pr(3))).toThrow();
    launched[1]!.emit(stage('intake'));
    launched[1]!.emit({ type: 'done', document: doc() });
    expect(seen).toEqual([]);
    expect(clock.pending).toBe(0);
    expect(done.runId).toMatch(/^run_/);
  });

  it('dropping keeps the finished order consistent even for a run already gone', () => {
    const { runs, launched, clock } = rig();
    const ids: string[] = [];
    for (let n = 1; n <= FINISHED_KEEP_MAX; n += 1) {
      ids.push(runs.start(pr(n)).runId);
      launched[n - 1]!.emit({ type: 'done', document: doc() });
    }
    clock.advance(FINISHED_KEEP_MS);
    for (const id of ids) expect(runs.events(id)).toBeNull();
    ids.push(runs.start(pr(99)).runId);
    launched.at(-1)!.emit({ type: 'done', document: doc() });
    expect(runs.events(ids.at(-1)!)).not.toBeNull();
  });
});
