import { performance } from 'node:perf_hooks';
import type { ReviewEvent, StageError, StageTiming } from '@airlock/shared';
import type { AgentUsage } from '../agent/runner.js';

/** Stage names in the order they run and are listed. `lenses-deep` runs only at deep depth. */
export const STAGES = [
  'intake', 'packs', 'shape', 'facts', 'map', 'brief', 'lenses', 'sweep', 'seams', 'anchor', 'challenge', 'lenses-deep',
  'select', 'store',
] as const;
export type StageName = (typeof STAGES)[number];

/** What a running stage reports: its model usage and its errors. */
export interface StageRecorder {
  usage(list: AgentUsage[]): void;
  error(...errors: StageError[]): void;
  /** Runs one step of the stage; when it throws, the error is recorded for this stage and `fallback` is returned. */
  attempt<T>(fn: () => Promise<T> | T, fallback: T): Promise<T>;
}

export interface StageLog {
  /** Every stage error recorded so far, in the order recorded. */
  readonly errors: StageError[];
  /**
   * Emits `start`, runs the stage and emits `done`, or `error` when the stage recorded an error. A stage that throws is
   * recorded as a stage error and gives undefined, unless `rethrow` is set. `extraMs` adds time spent on the stage's work
   * earlier.
   */
  run<T>(stage: StageName, fn: (rec: StageRecorder) => Promise<T>, opts?: { extraMs?: number; rethrow?: boolean }): Promise<T | undefined>;
  /** Emits `start` and `done` with `skipped: <why>` and records a zero timing. */
  skip(stage: StageName, why: string): void;
  emit(event: ReviewEvent): void;
  /** One timing per stage that has run or is running (a running stage's time so far), in stage order. */
  timings(): StageTiming[];
}

export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The timing of a stage from its wall-clock time and the usage of its model calls. */
function timingOf(stage: StageName, ms: number, usage: AgentUsage[]): StageTiming {
  return {
    stage, ms: Math.round(ms), agentRuns: usage.length,
    inputTokens: usage.reduce((n, u) => n + u.inputTokens, 0),
    outputTokens: usage.reduce((n, u) => n + u.outputTokens, 0),
    costUsd: usage.every((u) => u.costUsd !== null) ? usage.reduce((n, u) => n + (u.costUsd ?? 0), 0) : null,
  };
}

/** Records the stages of one review and reports them to `onEvent`; a listener that throws is ignored. */
export function createStageLog(onEvent?: (e: ReviewEvent) => void): StageLog {
  const errors: StageError[] = [];
  const done = new Map<StageName, StageTiming>();
  const open = new Map<StageName, () => StageTiming>();
  const emit = (event: ReviewEvent): void => {
    try {
      onEvent?.(event);
    } catch {
      // a broken listener must not stop the review
    }
  };

  async function run<T>(
    stage: StageName, fn: (rec: StageRecorder) => Promise<T>, opts: { extraMs?: number; rethrow?: boolean } = {},
  ): Promise<T | undefined> {
    emit({ type: 'stage', stage, status: 'start', detail: '' });
    const started = performance.now() - (opts.extraMs ?? 0);
    const usage: AgentUsage[] = [];
    const mine: StageError[] = [];
    const rec: StageRecorder = {
      usage: (list) => { usage.push(...list); },
      error: (...list) => { mine.push(...list); errors.push(...list); },
      async attempt(step, fallback) {
        try {
          return await step();
        } catch (err) {
          rec.error({ stage, cohortId: null, message: messageOf(err) });
          return fallback;
        }
      },
    };
    open.set(stage, () => timingOf(stage, performance.now() - started, usage));
    let thrown: { err: unknown } | null = null;
    let value: T | undefined;
    try {
      value = await fn(rec);
    } catch (err) {
      rec.error({ stage, cohortId: null, message: messageOf(err) });
      thrown = { err };
    }
    done.set(stage, open.get(stage)!());
    open.delete(stage);
    const more = mine.length > 1 ? ` (and ${mine.length - 1} more)` : '';
    emit(mine.length === 0
      ? { type: 'stage', stage, status: 'done', detail: '' }
      : { type: 'stage', stage, status: 'error', detail: `${mine[0]!.message}${more}` });
    if (thrown && opts.rethrow) throw thrown.err;
    return value;
  }

  return {
    errors,
    emit,
    run,
    skip(stage, why) {
      emit({ type: 'stage', stage, status: 'start', detail: '' });
      done.set(stage, timingOf(stage, 0, []));
      emit({ type: 'stage', stage, status: 'done', detail: `skipped: ${why}` });
    },
    timings() {
      return STAGES.flatMap((s) => {
        const t = done.get(s) ?? open.get(s)?.();
        return t ? [t] : [];
      });
    },
  };
}
