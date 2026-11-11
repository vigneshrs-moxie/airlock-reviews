import type { ModelConfig } from '@airlock/shared';
import type { z } from 'zod';
import { asMaterial } from './prompt.js';

export interface AgentRequest<T> {
  role: string;
  instructions: string;
  material: string;
  schema: z.ZodType<T>;
  cwd: string;
  extraDirs?: string[];
  model: string;
  effort: ModelConfig['effort'];
  maxTurns?: number;
  signal?: AbortSignal;
}

export interface AgentUsage {
  ms: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  turns: number;
}

export type AgentResult<T> =
  | { ok: true; output: T; usage: AgentUsage }
  | { ok: false; error: string; usage: AgentUsage };

export interface AgentRunner {
  run<T>(req: AgentRequest<T>): Promise<AgentResult<T>>;
}

const RETRY_SENTENCE = 'Your previous reply could not be used. Why is in the material block below. Reply again, following the output format exactly.';

const ZERO_USAGE: AgentUsage = { ms: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0 };

function addUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  return {
    ms: a.ms + b.ms,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd !== null && b.costUsd !== null ? a.costUsd + b.costUsd : null,
    turns: a.turns + b.turns,
  };
}

async function attempt<T>(inner: AgentRunner, req: AgentRequest<T>): Promise<AgentResult<T>> {
  try {
    return await inner.run(req);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), usage: { ...ZERO_USAGE } };
  }
}

/** Retries once when a result has ok: false, telling the model, inside a material block, why its last reply could not be used. */
export function withRetry(inner: AgentRunner, retries: 1): AgentRunner {
  void retries;
  return {
    async run<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
      const first = await attempt(inner, req);
      if (first.ok || req.signal?.aborted) return first;
      // The error can quote the model's own reply, so it goes in as material; the instructions stay as they were.
      const material = `${req.material}\n\n${RETRY_SENTENCE}\n\n${asMaterial('problems with your previous reply', first.error)}`;
      const second = await attempt(inner, { ...req, material });
      const usage = addUsage(first.usage, second.usage);
      return second.ok ? { ok: true, output: second.output, usage } : { ok: false, error: second.error, usage };
    },
  };
}
