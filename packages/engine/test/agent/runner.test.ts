import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFakeRunner } from '../../src/agent/fake-runner.js';
import { withRetry } from '../../src/agent/runner.js';
import type { AgentRequest, AgentResult, AgentRunner } from '../../src/agent/runner.js';

const schema = z.object({ n: z.number() });
const req = (over: Partial<AgentRequest<{ n: number }>> = {}): AgentRequest<{ n: number }> => ({
  role: 'lens', instructions: 'Do it.', material: 'm', schema, cwd: '/tmp', model: 'claude-opus-5-5', effort: 'high', ...over,
});
const u = (ms: number, costUsd: number | null = null) => ({ ms, inputTokens: ms * 10, outputTokens: ms, costUsd, turns: ms });

describe('withRetry', () => {
  it('returns the first success without a second call', async () => {
    const fake = createFakeRunner(() => ({ n: 1 }));
    const r = await withRetry(fake, 1).run(req());
    expect(r).toMatchObject({ ok: true, output: { n: 1 } });
    expect(fake.calls).toHaveLength(1);
  });

  it('calls again once after a failure and passes the error into the instructions', async () => {
    let i = 0;
    const fake = createFakeRunner(() => (i++ === 0 ? { n: 'bad' } : { n: 2 }));
    const r = await withRetry(fake, 1).run(req());
    expect(r).toMatchObject({ ok: true, output: { n: 2 } });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.instructions).toBe('Do it.');
    const second = fake.calls[1]!;
    expect(second.instructions).toMatch(/^Do it\.\n\nYour previous reply could not be used: .+\. Reply again, following the output format exactly\.$/s);
    expect(second.material).toBe('m');
    expect(second.model).toBe('claude-opus-5-5');
  });

  it('returns the failure after the second failure', async () => {
    const fake = createFakeRunner(() => new Error('nope'));
    const r = await withRetry(fake, 1).run(req());
    expect(r).toMatchObject({ ok: false, error: 'nope' });
    expect(fake.calls).toHaveLength(2);
  });

  it('sums usage over both attempts', async () => {
    const results: AgentResult<unknown>[] = [
      { ok: false, error: 'e', usage: u(1, 0.5) },
      { ok: true, output: { n: 1 }, usage: u(2, 0.25) },
    ];
    const inner: AgentRunner = { run: async <T>() => results.shift() as AgentResult<T> };
    const r = await withRetry(inner, 1).run(req());
    expect(r.usage).toEqual({ ms: 3, inputTokens: 30, outputTokens: 3, costUsd: 0.75, turns: 3 });
  });

  it('gives a null cost when either attempt has none', async () => {
    const results: AgentResult<unknown>[] = [
      { ok: false, error: 'e', usage: u(1, 0.5) },
      { ok: true, output: { n: 1 }, usage: u(1, null) },
    ];
    const inner: AgentRunner = { run: async <T>() => results.shift() as AgentResult<T> };
    expect((await withRetry(inner, 1).run(req())).usage.costUsd).toBeNull();
  });

  it('treats a thrown error as a failure with zero usage and retries', async () => {
    let i = 0;
    const calls: string[] = [];
    const inner: AgentRunner = {
      run: async <T>(r: AgentRequest<T>) => {
        calls.push(r.instructions);
        if (i++ === 0) throw new Error('boom');
        return { ok: true, output: { n: 3 } as T, usage: u(2) };
      },
    };
    const r = await withRetry(inner, 1).run(req());
    expect(r).toMatchObject({ ok: true, output: { n: 3 } });
    expect(calls[1]).toMatch(/could not be used: boom\./);
    expect(r.usage).toEqual(u(2));
  });
});

describe('createFakeRunner', () => {
  it('records every request', async () => {
    const fake = createFakeRunner(() => ({ n: 1 }));
    const a = req({ role: 'a' });
    const b = req({ role: 'b' });
    await fake.run(a);
    await fake.run(b);
    expect(fake.calls).toEqual([a, b]);
  });

  it('turns an Error into a failure and validates output against the schema', async () => {
    const usage = { ms: 1, inputTokens: 10, outputTokens: 5, costUsd: null, turns: 1 };
    expect(await createFakeRunner(() => new Error('x')).run(req())).toEqual({ ok: false, error: 'x', usage });
    expect(await createFakeRunner(() => ({ n: 4 })).run(req())).toEqual({ ok: true, output: { n: 4 }, usage });
    const bad = await createFakeRunner(() => ({ n: 'no' })).run(req());
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/number/i);
  });
});
