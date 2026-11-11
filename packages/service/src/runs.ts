import { randomBytes } from 'node:crypto';
import {
  ServiceEventSchema, type ReviewDocument, type ReviewEvent, type ServiceEvent, type StartReviewBody,
} from '@airlock/shared';

/** Timers the service schedules with, injected so tests move a fake clock. Each call returns its own cancel. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): () => void;
  setInterval(fn: () => void, ms: number): () => void;
}

/** Real timers that never keep the process alive on their own. */
export const realTimers: Timers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return () => clearTimeout(handle);
  },
  setInterval(fn, ms) {
    const handle = setInterval(fn, ms);
    handle.unref();
    return () => clearInterval(handle);
  },
};

export const MAX_ACTIVE = 2;
export const FINISHED_KEEP_MS = 10 * 60_000;
export const FINISHED_KEEP_MAX = 20;

/** Thrown by `start` when two other reviews are already running. */
export class LimitError extends Error {
  constructor() {
    super('Two reviews are already running. Wait for one to finish.');
    this.name = 'LimitError';
  }
}

export interface RunEvents {
  /** Every event of the run so far, in order. */
  past: ServiceEvent[];
  /** Live events after `past`; nothing for a finished run. Returns the unsubscribe. */
  subscribe(fn: (e: ServiceEvent) => void): () => void;
  finished: boolean;
}

export interface RunsOptions {
  /** Runs the review; every event it emits is kept and passed on, and its own `done` ends the run. */
  launch: (body: StartReviewBody, emit: (e: ReviewEvent) => void) => Promise<ReviewDocument>;
  /** The message of the `failed` event for an error the review ended with. */
  failure: (e: unknown) => string;
  timers: Timers;
  log?: (line: string) => void;
}

interface Run {
  id: string;
  repo: string;
  number: number;
  events: ServiceEvent[];
  listeners: Set<(e: ServiceEvent) => void>;
  finished: boolean;
  cancelExpiry: () => void;
}

const isLast = (e: ServiceEvent): boolean => e.type === 'done' || e.type === 'failed';

/** The reviews the service is running or has just finished, in memory only. */
export class Runs {
  private readonly runs = new Map<string, Run>();
  /** Finished run ids, oldest first. */
  private readonly finishedOrder: string[] = [];

  constructor(private readonly opts: RunsOptions) {}

  /** Starts a review, or hands back the run of that pull request when one is running. Throws LimitError at the limit. */
  start(body: StartReviewBody): { runId: string; reused: boolean } {
    const existing = this.running(body.repo, body.number);
    if (existing !== null) return { runId: existing, reused: true };
    if (this.active().length >= MAX_ACTIVE) throw new LimitError();

    let id: string;
    do id = `run_${randomBytes(6).toString('hex')}`; while (this.runs.has(id));
    const run: Run = {
      id, repo: body.repo, number: body.number, events: [], listeners: new Set(), finished: false, cancelExpiry: () => undefined,
    };
    this.runs.set(id, run);

    let review: Promise<ReviewDocument>;
    try {
      review = this.opts.launch(body, (e) => this.append(run, e));
    } catch (e) {
      review = Promise.reject(e);
    }
    review.then(
      // The engine sends done itself; this covers a review that returned without it.
      (document) => { if (!run.finished) this.append(run, { type: 'done', document }); },
      (e: unknown) => {
        this.opts.log?.(`review ${id} of ${run.repo}#${run.number} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        if (!run.finished) this.finish(run, { type: 'failed', message: this.opts.failure(e) });
      },
    ).catch((e: unknown) => {
      this.opts.log?.(`review ${id} could not be ended: ${e instanceof Error ? e.message : String(e)}`);
    });
    return { runId: id, reused: false };
  }

  /** The id of the run reviewing this pull request now, or null. */
  running(repo: string, number: number): string | null {
    for (const run of this.runs.values()) {
      if (!run.finished && run.repo === repo && run.number === number) return run.id;
    }
    return null;
  }

  /** The runs that have not ended, in the order they started. */
  active(): Array<{ runId: string; repo: string; number: number }> {
    return [...this.runs.values()].filter((r) => !r.finished).map((r) => ({ runId: r.id, repo: r.repo, number: r.number }));
  }

  /** The run's events so far and a way to follow the rest, or null for a run Airlock does not have (or no longer has). */
  events(runId: string): RunEvents | null {
    const run = this.runs.get(runId);
    if (run === undefined) return null;
    return {
      past: [...run.events],
      finished: run.finished,
      subscribe: (fn) => {
        if (run.finished) return () => undefined;
        run.listeners.add(fn);
        return () => { run.listeners.delete(fn); };
      },
    };
  }

  /** Keeps an event that matches the contract and passes it on; the engine's `done` ends the run. */
  private append(run: Run, e: ReviewEvent): void {
    if (run.finished) return;
    const parsed = ServiceEventSchema.safeParse(e);
    if (!parsed.success) {
      const type = typeof (e as { type?: unknown }).type === 'string' ? (e as { type: string }).type : 'unknown';
      this.opts.log?.(`review ${run.id}: a ${type} event does not match the contract and was not sent: ${parsed.error.message}`);
      if (type === 'done') {
        this.finish(run, { type: 'failed', message: this.opts.failure(new Error('the review it produced does not match the panel’s contract')) });
      }
      return;
    }
    if (isLast(parsed.data)) this.finish(run, parsed.data);
    else this.deliver(run, parsed.data);
  }

  private deliver(run: Run, e: ServiceEvent): void {
    run.events.push(e);
    for (const listener of [...run.listeners]) {
      try {
        listener(e);
      } catch (error) {
        this.opts.log?.(`review ${run.id}: a listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private finish(run: Run, last: ServiceEvent): void {
    run.finished = true;
    this.deliver(run, last);
    run.listeners.clear();
    run.cancelExpiry = this.opts.timers.setTimeout(() => this.drop(run.id), FINISHED_KEEP_MS);
    this.finishedOrder.push(run.id);
    while (this.finishedOrder.length > FINISHED_KEEP_MAX) this.drop(this.finishedOrder[0] as string);
  }

  private drop(runId: string): void {
    const run = this.runs.get(runId);
    if (run === undefined) return;
    run.cancelExpiry();
    this.runs.delete(runId);
    const at = this.finishedOrder.indexOf(runId);
    if (at !== -1) this.finishedOrder.splice(at, 1);
  }
}
