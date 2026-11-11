import type { AgentRequest, AgentResult, AgentRunner, AgentUsage } from './runner.js';

const FAKE_USAGE: AgentUsage = { ms: 1, inputTokens: 10, outputTokens: 5, costUsd: null, turns: 1 };

/** A runner for tests. The script's return value is checked against the request's schema, so a fixture that does not match fails the test. */
export function createFakeRunner(
  script: (req: AgentRequest<unknown>) => unknown | Error,
): AgentRunner & { calls: AgentRequest<unknown>[] } {
  const calls: AgentRequest<unknown>[] = [];
  return {
    calls,
    async run<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
      calls.push(req as AgentRequest<unknown>);
      const value = script(req as AgentRequest<unknown>);
      if (value instanceof Error) return { ok: false, error: value.message, usage: { ...FAKE_USAGE } };
      const parsed = req.schema.safeParse(value);
      if (!parsed.success) return { ok: false, error: parsed.error.message, usage: { ...FAKE_USAGE } };
      return { ok: true, output: parsed.data, usage: { ...FAKE_USAGE } };
    },
  };
}
