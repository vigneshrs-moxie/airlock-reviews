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
export const DEFAULT_RUN_MINUTES = 90;
/** The longest ceiling a review can be given: one day. */
export const MAX_RUN_MINUTES = 1_440;
/** How long `close` waits for the stopped reviews to settle. */
export const CLOSE_WAIT_MS = 5_000;

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
  /**
   * Runs the review; every event it emits is kept and passed on, and its own `done` ends the run. `signal` is aborted when
   * the review is to stop: at the ceiling, or when the registry closes.
   */
  launch: (body: StartReviewBody, emit: (e: ReviewEvent) => void, signal: AbortSignal) => Promise<ReviewDocument>;
  /** Removes what a review stopped at the ceiling stored when it settled anyway. */
  discard?: (document: ReviewDocument) => Promise<void>;
  /** The message of the `failed` event for an error the review ended with. */
  failure: (e: unknown) => string;
  timers: Timers;
  log?: (line: string) => void;
  /** The most a review may run before it is stopped; 90 minutes by default, and never more than a day. */
  runMinutes?: number;
}

interface Run {
  id: string;
  /** As first given; `key` is what runs are matched on. */
  repo: string;
  key: string;
  number: number;
  events: ServiceEvent[];
  listeners: Set<(e: ServiceEvent) => void>;
  finished: boolean;
  /** Cancels the ceiling while the run is active, then the ten-minute expiry once it has ended. */
  cancelTimer: () => void;
  /** Aborted to stop the review. */
  stop: AbortController;
  /** The run was ended at the ceiling: whatever its review produces afterwards is discarded. */
  timedOut: boolean;
  /** Settles when the review itself has settled, whatever the run's state. */
  settled: Promise<void>;
  reviewSettled: boolean;
}

/** The two events that end a run. */
export const isLast = (e: ServiceEvent): boolean => e.type === 'done' || e.type === 'failed';

/** GitHub treats repository names without regard to letter case, so runs are matched that way too. */
const repoKey = (repo: string): string => repo.toLowerCase();

/** The reviews the service is running or has just finished, in memory only. */
export class Runs {
  private readonly runs = new Map<string, Run>();
  /** Finished run ids, oldest first. */
  private readonly finishedOrder: string[] = [];
  private readonly runMinutes: number;
  private closed = false;

  constructor(private readonly opts: RunsOptions) {
    const minutes = opts.runMinutes ?? DEFAULT_RUN_MINUTES;
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new RangeError(`runMinutes must be a positive number, got ${minutes}`);
    }
    // A timer longer than about 24.8 days fires at once, so the ceiling is held to a day.
    this.runMinutes = Math.min(minutes, MAX_RUN_MINUTES);
  }

  /** Starts a review, or hands back the run of that pull request when one is running. Throws LimitError at the limit. */
  start(body: StartReviewBody): { runId: string; reused: boolean } {
    if (this.closed) throw new Error('Airlock is shutting down and does not start reviews now.');
    const existing = this.running(body.repo, body.number);
    if (existing !== null) return { runId: existing, reused: true };
    if (this.active().length >= MAX_ACTIVE) throw new LimitError();

    let id: string;
    do id = `run_${randomBytes(6).toString('hex')}`; while (this.runs.has(id));
    const run: Run = {
      id, repo: body.repo, key: repoKey(body.repo), number: body.number, events: [], listeners: new Set(), finished: false,
      cancelTimer: () => undefined, stop: new AbortController(), timedOut: false, settled: Promise.resolve(), reviewSettled: false,
    };
    this.runs.set(id, run);
    // A git, gh or model call can stall for ever; the ceiling stops the review and frees the slot.
    run.cancelTimer = this.opts.timers.setTimeout(() => {
      this.opts.log?.(`review ${id} of ${run.repo}#${run.number} ran past ${this.runMinutes} minutes and was stopped`);
      run.timedOut = true;
      run.stop.abort();
      this.finish(run, { type: 'failed', message: `Airlock stopped this review because it ran for more than ${this.runMinutes} minutes.` });
    }, this.runMinutes * 60_000);

    let review: Promise<ReviewDocument>;
    try {
      review = this.opts.launch(body, (e) => this.append(run, e), run.stop.signal);
    } catch (e) {
      review = Promise.reject(e);
    }
    run.settled = review.then(
      async (document) => {
        if (run.timedOut) {
          this.opts.log?.(`review ${id} of ${run.repo}#${run.number} finished after it was stopped; its review ${document.id} was discarded`);
          await this.opts.discard?.(document);
          return;
        }
        // The engine sends done itself; this covers a review that returned without it.
        if (!run.finished) this.append(run, { type: 'done', document });
      },
      (e: unknown) => {
        this.opts.log?.(`review ${id} of ${run.repo}#${run.number} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        if (!run.finished) this.finish(run, { type: 'failed', message: this.opts.failure(e) });
      },
    ).catch((e: unknown) => {
      this.opts.log?.(`review ${id} could not be ended: ${e instanceof Error ? e.message : String(e)}`);
    }).finally(() => { run.reviewSettled = true; });
    return { runId: id, reused: false };
  }

  /** The id of the run reviewing this pull request now, or null. */
  running(repo: string, number: number): string | null {
    const key = repoKey(repo);
    for (const run of this.runs.values()) {
      if (!run.finished && run.key === key && run.number === number) return run.id;
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

  /**
   * Stops the registry when the server closes: every timer is cleared, no review starts, and every review still running
   * is stopped; what they send afterwards goes nowhere. Resolves when those reviews have settled (so their workspaces
   * are disposed), or after CLOSE_WAIT_MS, whichever is first.
   */
  async close(): Promise<void> {
    this.closed = true;
    const waiting: Promise<void>[] = [];
    for (const run of this.runs.values()) {
      run.cancelTimer();
      run.listeners.clear();
      if (!run.reviewSettled) {
        run.stop.abort();
        waiting.push(run.settled);
      }
    }
    if (waiting.length === 0) return;
    let cancelBound = (): void => undefined;
    const bound = new Promise<void>((resolve) => { cancelBound = this.opts.timers.setTimeout(resolve, CLOSE_WAIT_MS); });
    await Promise.race([Promise.all(waiting).then(() => undefined), bound]);
    cancelBound();
  }

  /** Keeps an event that matches the contract and passes it on; the engine's `done` ends the run. */
  private append(run: Run, e: ReviewEvent): void {
    if (run.finished || this.closed) return;
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

  /** Ends the run once: the last event, then the ten-minute expiry in place of the ceiling. */
  private finish(run: Run, last: ServiceEvent): void {
    if (run.finished || this.closed) return;
    run.finished = true;
    run.cancelTimer();
    this.deliver(run, last);
    run.listeners.clear();
    run.cancelTimer = this.opts.timers.setTimeout(() => this.drop(run.id), FINISHED_KEEP_MS);
    this.finishedOrder.push(run.id);
    while (this.finishedOrder.length > FINISHED_KEEP_MAX) this.drop(this.finishedOrder[0] as string);
  }

  private drop(runId: string): void {
    // Out of the order first, so the cap loop always shortens it.
    const at = this.finishedOrder.indexOf(runId);
    if (at !== -1) this.finishedOrder.splice(at, 1);
    const run = this.runs.get(runId);
    if (run === undefined) return;
    run.cancelTimer();
    this.runs.delete(runId);
  }
}
