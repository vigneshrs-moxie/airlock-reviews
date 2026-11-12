import type { ServiceEvent } from '@airlock/shared';
import type { Res } from './http.js';
import { isLast, type RunEvents, type Timers } from './runs.js';

export const KEEP_ALIVE_MS = 15_000;
export const RUN_GONE = 'Airlock no longer has that review run. Open the latest review instead.';

/**
 * A run's events as an event stream: every past event, then live ones, ending after `done` or `failed`. A `: keep-alive`
 * comment is written every 15 seconds while it is open. A listener that goes away is removed; the run goes on.
 * `follow` is called once the response has started, so no event can fall between the replay and the subscription. A run
 * dropped in between gets one `failed` event saying so, so the panel does not take the empty stream for a lost one.
 */
export function runStream(follow: () => RunEvents | null, timers: Timers): Res {
  return {
    status: 200,
    stream: (send, closed, comment) => new Promise<void>((resolve) => {
      const run = follow();
      if (run === null) {
        const gone: ServiceEvent = { type: 'failed', message: RUN_GONE };
        send(gone);
        resolve();
        return;
      }
      for (const e of run.past) send(e);
      if (run.finished || closed.aborted) { resolve(); return; }

      let unsubscribe: () => void = () => undefined;
      const stopKeepAlive = timers.setInterval(() => comment('keep-alive'), KEEP_ALIVE_MS);
      const end = (): void => {
        stopKeepAlive();
        unsubscribe();
        closed.removeEventListener('abort', end);
        resolve();
      };
      closed.addEventListener('abort', end, { once: true });
      unsubscribe = run.subscribe((e) => {
        send(e);
        if (isLast(e)) end();
      });
    }),
  };
}
