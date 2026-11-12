import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { StageErrorKind } from '@airlock/shared';
import type { ModelUsage, Options, SDKRateLimitInfo, SDKResultMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { loadTemplate, PROMPT_BOUNDARY, splitInstructions } from './prompt.js';
import type { AgentRequest, AgentResult, AgentRunner, AgentUsage } from './runner.js';

/** Both are for tests. Defaults: the SDK's own query, and the `claude` that findClaude finds. */
export interface SdkRunnerDeps {
  query?: typeof sdkQuery;
  claudePath?: string | null;
}

const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const MINUTE = 60_000;

/**
 * How long a run of each role may take and how many turns it may use, by the role's name or the part before `:`. A
 * selection, a judgement or the summary needs no reading, a challenge reads around one finding, the brief and the mapper
 * read widely.
 */
const ROLE_LIMITS: Record<string, { timeoutMs: number; maxTurns: number }> = {
  lens: { timeoutMs: 10 * MINUTE, maxTurns: 40 },
  sweep: { timeoutMs: 10 * MINUTE, maxTurns: 40 },
  challenge: { timeoutMs: 10 * MINUTE, maxTurns: 20 },
  mapper: { timeoutMs: 15 * MINUTE, maxTurns: 25 },
  seams: { timeoutMs: 15 * MINUTE, maxTurns: 40 },
  brief: { timeoutMs: 5 * MINUTE, maxTurns: 25 },
  select: { timeoutMs: 5 * MINUTE, maxTurns: 15 },
  merge: { timeoutMs: 5 * MINUTE, maxTurns: 10 },
  judge: { timeoutMs: 5 * MINUTE, maxTurns: 6 },
  summary: { timeoutMs: 3 * MINUTE, maxTurns: 6 },
};
const OTHER_LIMITS = { timeoutMs: 10 * MINUTE, maxTurns: 40 };

/** The time and turn limits for a role such as `lens:core/boundary` or `select`. */
export function roleLimits(role: string): { timeoutMs: number; maxTurns: number } {
  return ROLE_LIMITS[role.split(':')[0]!] ?? OTHER_LIMITS;
}

const USAGE_LIMIT = "Claude's usage limit was reached";
const API_KEY_FOUND = 'Airlock runs on your Claude login, but an API key was found in the environment. Unset it and try again.';
/** The init message's apiKeySource values that mean no API key is used: the login (and a legacy name for it). */
const NO_API_KEY = new Set(['none', 'oauth']);
/** What the CLI says in a result when the plan's limit stops a run. */
const USAGE_LIMIT_TEXT = /usage limit|hit your (?:[a-z]+ )?limit/i;
const PLAIN_JSON = 'Reply with one JSON object and nothing else.';
const MAX_ERROR_DETAIL = 300;

/**
 * The SDK options for one read-only review run. The system prompt is three blocks: the shared template with the part of
 * the request's instructions that comes before their boundary line (the standards, the same for every request of a
 * review), the SDK's boundary marker, and the rest of the instructions. Everything before the marker can be cached
 * across requests. With no `jsonSchema` the last block also asks for plain JSON.
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
  const { standing, stage } = splitInstructions(req.instructions);
  const first = [systemPrompt.trimEnd(), standing].filter((s) => s !== '').join('\n\n');
  const last = [stage, ...(jsonSchema === null ? [PLAIN_JSON] : [])].join('\n\n');
  const prompt = [first, PROMPT_BOUNDARY, last];
  const options: Options = {
    cwd: req.cwd,
    model: req.model,
    effort: req.effort,
    maxTurns: req.maxTurns ?? roleLimits(req.role).maxTurns,
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
 * AIRLOCK_CLAUDE_PATH when set (it must name a file; otherwise this throws), else the first executable `claude` on PATH,
 * else null (the SDK's bundled CLI).
 * Relative paths are ignored: the CLI starts in the repository under review, so a relative path could pick
 * up an executable from the pull request.
 */
export async function findClaude(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const configured = env.AIRLOCK_CLAUDE_PATH;
  if (configured !== undefined && isAbsolute(configured)) {
    const found = await stat(configured).then((s) => s.isFile(), () => false);
    if (!found) throw new Error(`AIRLOCK_CLAUDE_PATH is ${configured}, which does not exist.`);
    return configured;
  }
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
      const timeoutMs = req.timeoutMs ?? roleLimits(req.role).timeoutMs;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

      const run: RunState = { result: undefined, thrown: undefined, rateLimit: undefined, apiKey: false };
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
          if (msg.type === 'result') run.result = msg;
          else if (msg.type === 'rate_limit_event') run.rateLimit = msg.rate_limit_info;
          else if (msg.type === 'system' && msg.subtype === 'init' && usesApiKey(msg.apiKeySource)) {
            // Stop before the first model call is paid for with a key.
            run.apiKey = true;
            controller.abort();
            break;
          }
        }
      } catch (err) {
        run.thrown = err;
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
      }

      const usage = usageOf(run.result, performance.now() - started);
      try {
        return settle(req.schema, run, { timedOut, timeoutMs }, schemaSent, usage);
      } catch (err) {
        // A zod refine or transform can throw out of safeParse, and a message can break the SDK's types.
        return { ok: false, error: messageOf(err), kind: 'invalid-output', usage };
      }
    },
  };
}

/** What a run left behind: its last result message, what the loop threw, and the last rate-limit report. */
interface RunState {
  result: SDKResultMessage | undefined;
  thrown: unknown;
  rateLimit: SDKRateLimitInfo | undefined;
  /** The init message said an API key is being used. */
  apiKey: boolean;
}

/** True when the init message names an API key as the credential; a missing value is not taken as one. */
const usesApiKey = (source: unknown): boolean => typeof source === 'string' && !NO_API_KEY.has(source);

/** `Claude's usage limit was reached`, with `; it resets at <local time>` when the report gives a reset time. */
function usageLimitMessage(info: SDKRateLimitInfo | undefined): string {
  const at = info?.resetsAt;
  if (typeof at !== 'number' || !Number.isFinite(at)) return USAGE_LIMIT;
  const ms = at < 1e12 ? at * 1000 : at; // seconds since 1970, or milliseconds
  return `${USAGE_LIMIT}; it resets at ${new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

function toJsonSchema(schema: z.ZodType): object | null {
  try {
    return z.toJSONSchema(schema, { target: 'draft-7' });
  } catch {
    return null;
  }
}

/**
 * Turns what the run left into an AgentResult. With a JSON schema sent, only structured_output counts: the CLI has
 * already rejected any object that did not match. A success result that arrived before an abort or a timeout still
 * counts. A failure says its kind: a rejected rate-limit report or a result that says so is the usage limit; a run with
 * no result after its timer fired is a timeout; the turn limit, an unusable answer, and anything else.
 */
function settle<T>(
  schema: z.ZodType<T>,
  run: RunState,
  clock: { timedOut: boolean; timeoutMs: number },
  schemaSent: boolean,
  usage: AgentUsage,
): AgentResult<T> {
  const fail = (error: string, kind: StageErrorKind): AgentResult<T> => ({ ok: false, error, kind, usage });
  const { result, thrown, rateLimit } = run;
  if (run.apiKey) return fail(API_KEY_FOUND, 'other');
  // A message can break the SDK's types, so its text is read loosely.
  const loose = result as { result?: unknown; errors?: unknown } | undefined;
  const said = [
    typeof loose?.result === 'string' ? loose.result : '',
    ...(Array.isArray(loose?.errors) ? loose.errors.filter((e): e is string => typeof e === 'string') : []),
  ].join(' ');
  const succeeded = result?.subtype === 'success' && !result.is_error;
  if (!succeeded && (rateLimit?.status === 'rejected' || USAGE_LIMIT_TEXT.test(said))) {
    return fail(usageLimitMessage(rateLimit?.status === 'rejected' ? rateLimit : undefined), 'usage-limit');
  }
  if (result === undefined) {
    if (clock.timedOut) return fail(`timed out after ${clock.timeoutMs / 1000} s`, 'timeout');
    return fail(thrown === undefined ? 'no result' : messageOf(thrown), 'other');
  }
  if (result.subtype !== 'success') {
    const detail = Array.isArray(result.errors) ? result.errors.join('; ') : '';
    const kind: StageErrorKind = result.subtype === 'error_max_turns' ? 'turn-limit'
      : result.subtype === 'error_max_structured_output_retries' ? 'invalid-output' : 'other';
    return fail(detail === '' ? String(result.subtype) : `${result.subtype}: ${clip(detail)}`, kind);
  }
  const text = typeof result.result === 'string' ? result.result : '';
  if (result.is_error) return fail(`error result: ${clip(text)}`, 'other');
  const output = result.structured_output !== undefined || schemaSent ? result.structured_output : lastJsonObject(text);
  if (output === undefined) return fail('no output', 'invalid-output');
  const parsed = schema.safeParse(output);
  return parsed.success ? { ok: true, output: parsed.data, usage } : fail(parsed.error.message, 'invalid-output');
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
