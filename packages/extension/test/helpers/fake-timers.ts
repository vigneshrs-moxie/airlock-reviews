import type { Timers } from '../../src/client/timers';

/** Timers that run only when a test fires them. */
export class FakeTimers implements Timers {
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

  /** Runs every timer that is pending now. */
  fire(): void {
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const p of due) p.fn();
  }
}
