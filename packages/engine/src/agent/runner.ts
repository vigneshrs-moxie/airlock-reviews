import type { ModelConfig, StageErrorKind } from '@airlock/shared';
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
  /** How long the run may take; the runner picks a default by role when not given. */
  timeoutMs?: number;
  /** Sent once by withRetry even when the answer is unusable (the mapper's own retry is already one). */
  noRetry?: boolean;
  signal?: AbortSignal;
}

export interface AgentUsage {
  ms: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  turns: number;
}

/** A failed request says why: an unusable answer, the turn limit, the usage limit, the time limit, or anything else. */
export type AgentResult<T> =
  | { ok: true; output: T; usage: AgentUsage }
  | { ok: false; error: string; kind: StageErrorKind; usage: AgentUsage };

export interface AgentRunner {
  run<T>(req: AgentRequest<T>): Promise<AgentResult<T>>;
}

const RETRY_SENTENCE = 'Your previous reply could not be used. Why is in the material block below. Reply again, following the output format exactly.';

/** The usage of a request that failed without a result: nothing is known about its cost, so it is null, never 0. */
export const UNKNOWN_USAGE: AgentUsage = { ms: 0, inputTokens: 0, outputTokens: 0, costUsd: null, turns: 0 };

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
    return { ok: false, error: err instanceof Error ? err.message : String(err), kind: 'other', usage: { ...UNKNOWN_USAGE } };
  }
}

/**
 * Retries once when the answer was unusable (kind `invalid-output`), telling the model, inside a material block, why its
 * last reply could not be used. A turn limit, a usage limit, a timeout or any other failure would only fail again, so it
 * is returned as it is; so is a request marked `noRetry` or one whose signal was aborted.
 */
export function withRetry(inner: AgentRunner, retries: 1): AgentRunner {
  void retries;
  return {
    async run<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
      const first = await attempt(inner, req);
      if (first.ok || first.kind !== 'invalid-output' || req.noRetry === true || req.signal?.aborted) return first;
      // The error can quote the model's own reply, so it goes in as material; the instructions stay as they were.
      const material = `${req.material}\n\n${RETRY_SENTENCE}\n\n${asMaterial('problems with your previous reply', first.error)}`;
      const second = await attempt(inner, { ...req, material });
      const usage = addUsage(first.usage, second.usage);
      return second.ok ? { ok: true, output: second.output, usage } : { ok: false, error: second.error, kind: second.kind, usage };
    },
  };
}
