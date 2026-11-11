import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { abortOnExitSignals } from '../../src/util/stop.js';

describe('abortOnExitSignals', () => {
  it.each(['SIGINT', 'SIGTERM'])('aborts the signal on %s, once, and leaves a second one to the default', (name) => {
    const proc = new EventEmitter();
    const signal = abortOnExitSignals(proc);
    expect(signal.aborted).toBe(false);
    proc.emit(name);
    expect(signal.aborted).toBe(true);
    expect(proc.listenerCount('SIGINT') + proc.listenerCount('SIGTERM')).toBe(0);
  });
});
