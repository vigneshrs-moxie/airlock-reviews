import type { ServiceEvent } from '@airlock/shared';
import type { Res } from './http.js';
import type { RunEvents, Timers } from './runs.js';

export const KEEP_ALIVE_MS = 15_000;

const isLast = (e: ServiceEvent): boolean => e.type === 'done' || e.type === 'failed';

/**
 * A run's events as an event stream: every past event, then live ones, ending after `done` or `failed`. A `: keep-alive`
 * comment is written every 15 seconds while it is open. A listener that goes away is removed; the run goes on.
 * `follow` is called once the response has started, so no event can fall between the replay and the subscription.
 */
export function runStream(follow: () => RunEvents | null, timers: Timers): Res {
  return {
    status: 200,
    stream: (send, closed, comment) => new Promise<void>((resolve) => {
      const run = follow();
      if (run === null) { resolve(); return; }
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
