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
});
