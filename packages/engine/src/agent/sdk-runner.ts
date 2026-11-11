import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { ModelUsage, Options, SDKResultMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { loadTemplate } from './prompt.js';
import type { AgentRequest, AgentResult, AgentRunner, AgentUsage } from './runner.js';

/** Both are for tests. Defaults: the SDK's own query, and the `claude` that findClaude finds. */
export interface SdkRunnerDeps {
  query?: typeof sdkQuery;
  claudePath?: string | null;
}

const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const DEFAULT_MAX_TURNS = 40;
const PLAIN_JSON = 'Reply with one JSON object and nothing else.';
const MAX_ERROR_DETAIL = 300;

/**
 * The SDK options for one read-only review run. `systemPrompt` is the shared template; the request's
 * instructions follow it after a blank line. With no `jsonSchema` the prompt asks for plain JSON instead.
 * Never add `allowedTools`: it pre-approves reads anywhere on the disk.
 */
export function buildOptions(
  req: AgentRequest<unknown>,
  systemPrompt: string,
  claudePath: string | null,
  jsonSchema: object | null,
): Record<string, unknown> {
  return { ...reviewOptions(req, systemPrompt, claudePath, jsonSchema) };
}

/** buildOptions with the SDK's own Options type, so every key and value is checked by the compiler. */
function reviewOptions(
  req: AgentRequest<unknown>,
  systemPrompt: string,
  claudePath: string | null,
  jsonSchema: object | null,
): Options {
  const prompt = [systemPrompt, req.instructions, ...(jsonSchema === null ? [PLAIN_JSON] : [])].join('\n\n');
  const options: Options = {
    cwd: req.cwd,
    model: req.model,
    effort: req.effort,
    maxTurns: req.maxTurns ?? DEFAULT_MAX_TURNS,
    tools: [...READ_TOOLS],
    permissionMode: 'dontAsk',
    settingSources: [],
    strictMcpConfig: true,
    verbatimPrompts: true,
    persistSession: false,
    env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    systemPrompt: prompt,
  };
  if (req.extraDirs !== undefined && req.extraDirs.length > 0) options.additionalDirectories = [...req.extraDirs];
  if (claudePath !== null) options.pathToClaudeCodeExecutable = claudePath;
  if (jsonSchema !== null) options.outputFormat = { type: 'json_schema', schema: jsonSchema as Record<string, unknown> };
  return options;
}

/**
 * AIRLOCK_CLAUDE_PATH when set, else the first executable `claude` on PATH, else null (the SDK's bundled CLI).
 * Relative paths are ignored: the CLI starts in the repository under review, so a relative path could pick
 * up an executable from the pull request.
 */
export async function findClaude(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const configured = env.AIRLOCK_CLAUDE_PATH;
  if (configured !== undefined && isAbsolute(configured)) return configured;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, 'claude');
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here; try the next directory
    }
  }
  return null;
}

/** An AgentRunner on the Claude Agent SDK. It never throws: every failure is an ok: false result. */
export function createSdkRunner(deps: SdkRunnerDeps = {}): AgentRunner {
  let claudePath: Promise<string | null> | undefined =
    deps.claudePath === undefined ? undefined : Promise.resolve(deps.claudePath);
  const resolveClaude = (): Promise<string | null> => (claudePath ??= findClaude());
  const loadQuery = async (): Promise<typeof sdkQuery> =>
    deps.query ?? (await import('@anthropic-ai/claude-agent-sdk')).query;

  return {
    async run<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
      const started = performance.now();
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      if (req.signal?.aborted) controller.abort();
      else req.signal?.addEventListener('abort', onAbort, { once: true });

      let result: SDKResultMessage | undefined;
      let thrown: unknown;
      let schemaSent = false;
      try {
        const [shared, path, query] = await Promise.all([loadTemplate('_shared'), resolveClaude(), loadQuery()]);
        const jsonSchema = toJsonSchema(req.schema);
        schemaSent = jsonSchema !== null;
        const options: Options = {
          ...reviewOptions(req as AgentRequest<unknown>, shared, path, jsonSchema),
          abortController: controller,
        };
        const prompt = req.material.trim() === '' ? 'Begin.' : req.material;
        // The loop throws after yielding an error result, so the result is kept outside it.
        for await (const msg of query({ prompt, options })) {
          if (msg.type === 'result') result = msg;
        }
      } catch (err) {
        thrown = err;
      } finally {
        req.signal?.removeEventListener('abort', onAbort);
      }

      const usage = usageOf(result, performance.now() - started);
      try {
        return settle(req.schema, result, thrown, schemaSent, usage);
      } catch (err) {
        // A zod refine or transform can throw out of safeParse, and a message can break the SDK's types.
        return { ok: false, error: messageOf(err), usage };
      }
    },
  };
}

function toJsonSchema(schema: z.ZodType): object | null {
  try {
    return z.toJSONSchema(schema, { target: 'draft-7' });
  } catch {
    return null;
  }
}

/**
 * Turns the last result message into an AgentResult. With a JSON schema sent, only structured_output counts:
 * the CLI has already rejected any object that did not match. A success result followed by a throw (an abort
 * landing as the run finishes) still counts as a success.
 */
function settle<T>(
  schema: z.ZodType<T>,
  result: SDKResultMessage | undefined,
  thrown: unknown,
  schemaSent: boolean,
  usage: AgentUsage,
): AgentResult<T> {
  const fail = (error: string): AgentResult<T> => ({ ok: false, error, usage });
  if (result === undefined) return fail(thrown === undefined ? 'no result' : messageOf(thrown));
  if (result.subtype !== 'success') {
    const detail = Array.isArray(result.errors) ? result.errors.join('; ') : '';
    return fail(detail === '' ? String(result.subtype) : `${result.subtype}: ${clip(detail)}`);
  }
  const text = typeof result.result === 'string' ? result.result : '';
  if (result.is_error) return fail(`error result: ${clip(text)}`);
  const output = result.structured_output !== undefined || schemaSent ? result.structured_output : lastJsonObject(text);
  if (output === undefined) return fail('no output');
  const parsed = schema.safeParse(output);
  return parsed.success ? { ok: true, output: parsed.data, usage } : fail(parsed.error.message);
}

/** modelUsage counts every model call; input includes cache reads and writes. Missing or odd fields count as 0. */
function usageOf(result: SDKResultMessage | undefined, ms: number): AgentUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  const perModel: unknown = result?.modelUsage;
  if (typeof perModel === 'object' && perModel !== null) {
    for (const m of Object.values(perModel as Record<string, Partial<ModelUsage> | null>)) {
      inputTokens += count(m?.inputTokens) + count(m?.cacheReadInputTokens) + count(m?.cacheCreationInputTokens);
      outputTokens += count(m?.outputTokens);
    }
  }
  const cost: unknown = result?.total_cost_usd;
  return {
    ms: Math.round(ms),
    inputTokens,
    outputTokens,
    costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
    turns: count(result?.num_turns),
  };
}

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

/** The last top-level JSON object in the text, or undefined. Braces inside JSON strings are skipped. */
function lastJsonObject(text: string): unknown {
  let found: unknown;
  let i = text.indexOf('{');
  while (i !== -1) {
    const end = closingBrace(text, i);
    let next = i + 1;
    if (end !== -1) {
      // Past this balanced span either way: an object nested inside it is not top-level, even when the span is not JSON.
      next = end + 1;
      try {
        found = JSON.parse(text.slice(i, end + 1));
      } catch {
        // not JSON
      }
    }
    i = text.indexOf('{', next);
  }
  return found;
}

/** Index of the brace that closes the one at `start`, or -1. */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (inString) {
      if (c === '\\') j++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j;
  }
  return -1;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const clip = (text: string): string => (text.length > MAX_ERROR_DETAIL ? `${text.slice(0, MAX_ERROR_DETAIL)}…` : text);
