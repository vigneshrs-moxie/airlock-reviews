import { describe, expect, it } from 'vitest';
import { limiter } from '../../src/util/limit.js';

describe('limiter', () => {
  it('never runs more than max at once', async () => {
    const limit = limiter(3);
    let running = 0;
    let high = 0;
    const task = async (): Promise<void> => {
      running++;
      high = Math.max(high, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    };
    await Promise.all(Array.from({ length: 10 }, () => limit(task)));
    expect(high).toBe(3);
  });

  it('keeps going after a task rejects', async () => {
    const limit = limiter(1);
    await expect(limit(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(limit(async () => 7)).resolves.toBe(7);
  });

  it('never exceeds max when a new call arrives as a slot is released', async () => {
    // Fresh calls are scheduled a few microtasks after a task ends, at every depth, so one lands
    // between the slot being released and the waiter claiming it.
    for (let depth = 0; depth < 8; depth++) {
      const limit = limiter(1);
      let running = 0;
      let high = 0;
      const task = async (): Promise<void> => {
        running++;
        high = Math.max(high, running);
        await new Promise((r) => setTimeout(r, 1));
        running--;
        const late = async (): Promise<void> => {
          running++;
          high = Math.max(high, running);
          await null;
          running--;
        };
        let p: Promise<void> = Promise.resolve();
        for (let i = 0; i < depth; i++) p = p.then(() => undefined);
        void p.then(() => limit(late));
      };
      await Promise.all([limit(task), limit(task), limit(task)]);
      await new Promise((r) => setTimeout(r, 20));
      expect(high, `depth ${depth}`).toBe(1);
    }
  });
});
