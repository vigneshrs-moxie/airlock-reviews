import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadTemplate } from '../../src/agent/prompt.js';
import type { AgentRequest } from '../../src/agent/runner.js';
import { createSdkRunner, findClaude } from '../../src/agent/sdk-runner.js';
import type { SdkRunnerDeps } from '../../src/agent/sdk-runner.js';

type Opts = Record<string, unknown>;
interface Call { prompt: unknown; options: Opts }

/** A stand-in for the SDK's query(): records each call and yields the scripted messages, then optionally throws. */
function fakeQuery(script: (options: Opts) => AsyncGenerator<unknown, void>) {
  const calls: Call[] = [];
  const query = (params: { prompt: unknown; options?: Opts }) => {
    const options = params.options ?? {};
    calls.push({ prompt: params.prompt, options });
    return script(options);
  };
  return { query: query as unknown as NonNullable<SdkRunnerDeps['query']>, calls };
}

const yielding = (messages: unknown[], thenThrow?: Error) =>
  fakeQuery(async function* () {
    for (const m of messages) yield m;
    if (thenThrow) throw thenThrow;
  });

const modelUsage = (inputTokens: number, outputTokens: number, cacheRead = 0, cacheCreation = 0) => ({
  inputTokens, outputTokens, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation,
  webSearchRequests: 0, costUSD: 0.001, contextWindow: 200000, maxOutputTokens: 32000,
});

const resultMsg = (over: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 3, total_cost_usd: 0.002,
  modelUsage: { 'claude-haiku-5-5': modelUsage(100, 20) }, ...over,
});

const schema = z.object({ files: z.array(z.string()) });
/** Cannot be turned into JSON Schema, so the runner omits outputFormat and reads JSON from the text. */
const textSchema = z.custom<{ files: string[] }>((v) => schema.safeParse(v).success);
const req = (over: Partial<AgentRequest<{ files: string[] }>> = {}): AgentRequest<{ files: string[] }> => ({
  role: 'lens', instructions: 'List the files.', material: '<material label="x">\nstuff\n</material>', schema,
  cwd: '/repo/base', model: 'claude-haiku-5-5', effort: 'high', ...over,
});

async function optionsFor(r: AgentRequest<{ files: string[] }> = req(), claudePath: string | null = null): Promise<Call> {
  const fake = yielding([resultMsg({ structured_output: { files: [] } })]);
  await createSdkRunner({ query: fake.query, claudePath }).run(r);
  return fake.calls[0]!;
}

describe('createSdkRunner options', () => {
  it('sends exactly the three read tools and no allowedTools key', async () => {
    const { options } = await optionsFor();
    expect(options.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect('allowedTools' in options).toBe(false);
  });

  it('turns off settings, MCP, session files and auto memory', async () => {
    const { options } = await optionsFor();
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.verbatimPrompts).toBe(true);
    expect(options.persistSession).toBe(false);
    const env = options.env as Record<string, string>;
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('passes cwd and only the listed extra directories', async () => {
    const { options } = await optionsFor(req({ extraDirs: ['/repo/head'] }));
    expect(options.cwd).toBe('/repo/base');
    expect(options.additionalDirectories).toEqual(['/repo/head']);
  });

  it('omits additionalDirectories when there are none', async () => {
    expect('additionalDirectories' in (await optionsFor()).options).toBe(false);
    expect('additionalDirectories' in (await optionsFor(req({ extraDirs: [] }))).options).toBe(false);
  });

  it('puts the shared instructions before the request instructions and sends the material as the prompt', async () => {
    const shared = await loadTemplate('_shared');
    const call = await optionsFor();
    expect(call.options.systemPrompt).toBe(`${shared}\n\nList the files.`);
    expect(call.prompt).toBe('<material label="x">\nstuff\n</material>');
    expect((await optionsFor(req({ material: '' }))).prompt).toBe('Begin.');
  });

  it('sends the schema as a JSON schema output format', async () => {
    const { options } = await optionsFor();
    expect(options.outputFormat).toEqual({ type: 'json_schema', schema: z.toJSONSchema(schema, { target: 'draft-7' }) });
  });

  it('asks for plain JSON in the prompt when the schema cannot be converted', async () => {
    const custom = z.custom<{ files: string[] }>(() => true);
    const { options } = await optionsFor(req({ schema: custom }));
    expect('outputFormat' in options).toBe(false);
    expect(options.systemPrompt).toMatch(/List the files\.\n\nReply with one JSON object and nothing else\.$/);
  });

  it('sends the model, effort and turn limit', async () => {
    const first = await optionsFor();
    expect(first.options).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high', maxTurns: 40 });
    expect((await optionsFor(req({ maxTurns: 5, effort: 'low' }))).options).toMatchObject({ effort: 'low', maxTurns: 5 });
  });

  it('uses the given claude executable only when there is one', async () => {
    expect('pathToClaudeCodeExecutable' in (await optionsFor(req(), null)).options).toBe(false);
    expect((await optionsFor(req(), '/opt/bin/claude')).options.pathToClaudeCodeExecutable).toBe('/opt/bin/claude');
  });
});

describe('createSdkRunner results', () => {
  it('returns the structured output after validating it', async () => {
    const fake = yielding([{ type: 'system', subtype: 'init' }, resultMsg({ structured_output: { files: ['a.ts'] }, result: '{"files":["a.ts"]}' })]);
    const r = await createSdkRunner({ query: fake.query, claudePath: null }).run(req());
    expect(r).toMatchObject({ ok: true, output: { files: ['a.ts'] } });
    expect(r.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, costUsd: 0.002, turns: 3 });
    expect(r.usage.ms).toBeGreaterThanOrEqual(0);
  });

  it('rejects structured output that does not match the schema', async () => {
    const fake = yielding([resultMsg({ structured_output: { files: 'a.ts' } })]);
    const r = await createSdkRunner({ query: fake.query, claudePath: null }).run(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/files/);
    expect(r.usage.turns).toBe(3);
  });

  it('falls back to the last JSON object in the text when the schema could not be sent', async () => {
    const text = 'First try {"files":["old"]}. Note the "}" in prose.\n```json\n{"files":["a {b}.ts","c\\"}.ts"],"x":{"y":1}}\n```\nDone.';
    const fake = yielding([resultMsg({ result: text })]);
    const r = await createSdkRunner({ query: fake.query, claudePath: null }).run(req({ schema: textSchema }));
    expect('outputFormat' in fake.calls[0]!.options).toBe(false);
    expect(r).toMatchObject({ ok: true, output: { files: ['a {b}.ts', 'c"}.ts'] } });
  });

  it('ignores JSON in the text when a JSON schema was sent', async () => {
    const fake = yielding([resultMsg({ result: 'Here it is: {"files":["a.ts"]}' })]);
    const r = await createSdkRunner({ query: fake.query, claudePath: null }).run(req());
    expect('outputFormat' in fake.calls[0]!.options).toBe(true);
    expect(r).toMatchObject({ ok: false, error: 'no output' });
  });

  it('does not take an object nested inside a malformed one', async () => {
    const fake = yielding([resultMsg({ result: '{"files":["a"], "x": {"files":["b"]} oops}' })]);
    const r = await createSdkRunner({ query: fake.query, claudePath: null }).run(req({ schema: textSchema }));
    expect(r).toMatchObject({ ok: false, error: 'no output' });
  });

  it('reports no output when the text holds no JSON object', async () => {
    const fake = yielding([resultMsg({ result: 'I could not finish { the task.' })]);
    const r = await createSdkRunner({ query: fake.query, claudePath: null }).run(req({ schema: textSchema }));
    expect(r).toMatchObject({ ok: false, error: 'no output' });
  });

  it('returns a failure with the usage when the schema throws while parsing', async () => {
    const throwing = schema.refine(() => { throw new Error('boom'); });
    const fake = yielding([resultMsg({ structured_output: { files: [] } })]);
    const r = await createSdkRunner({ query: fake.query, claudePath: null }).run(req({ schema: throwing }));
    expect(r).toMatchObject({ ok: false, error: 'boom' });
    expect(r.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, costUsd: 0.002, turns: 3 });
  });

  it('survives a result message missing errors and modelUsage', async () => {
    const fake = yielding([resultMsg({ subtype: 'error_max_turns', is_error: true, num_turns: 7, errors: undefined, modelUsage: undefined })]);
    const r = await createSdkRunner({ query: fake.query, claudePath: null }).run(req());
    expect(r).toMatchObject({ ok: false, error: 'error_max_turns' });
    expect(r.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, turns: 7, costUsd: 0.002 });
  });

  it('keeps the error result when the loop throws after it', async () => {
    const fake = yielding(
      [resultMsg({ subtype: 'error_max_turns', is_error: true, num_turns: 40, errors: ['Reached maximum number of turns (40)'] })],
      new Error('Claude Code returned an error result: Reached maximum number of turns (40)'),
    );
    const r = await createSdkRunner({ query: fake.query, claudePath: null }).run(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('error_max_turns');
    expect(r.usage).toMatchObject({ turns: 40, inputTokens: 100, outputTokens: 20, costUsd: 0.002 });
  });

  it('reports a thrown error when no result arrived', async () => {
    const fake = yielding([{ type: 'system', subtype: 'init' }], new Error('Claude Code process exited with code 1'));
    const r = await createSdkRunner({ query: fake.query, claudePath: null }).run(req());
    expect(r).toMatchObject({ ok: false, error: 'Claude Code process exited with code 1' });
    expect(r.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: null, turns: 0 });
  });

  it('treats is_error true with subtype success as a failure', async () => {
    const fake = yielding([resultMsg({ is_error: true, result: 'Not logged in · Please run /login', structured_output: { files: [] } })]);
    const r = await createSdkRunner({ query: fake.query, claudePath: null }).run(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Not logged in');
  });

  it('aborts the run when the request signal aborts', async () => {
    let seen: AbortSignal | undefined;
    const fake = fakeQuery(async function* (options) {
      const signal = (options.abortController as AbortController).signal;
      seen = signal;
      yield { type: 'system', subtype: 'init' };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('Claude Code process aborted by user');
    });
    const outer = new AbortController();
    const running = createSdkRunner({ query: fake.query, claudePath: null }).run(req({ signal: outer.signal }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    outer.abort();
    const r = await running;
    expect(seen?.aborted).toBe(true);
    expect(r).toMatchObject({ ok: false, error: 'Claude Code process aborted by user' });
  });

  it('sums tokens over modelUsage', async () => {
    const fake = yielding([resultMsg({
      structured_output: { files: [] },
      usage: { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: { 'claude-opus-5-5': modelUsage(10, 200, 3000, 400), 'claude-haiku-5-5': modelUsage(1200, 30, 0, 5) },
    })]);
    const r = await createSdkRunner({ query: fake.query, claudePath: null }).run(req());
    expect(r.usage).toMatchObject({ inputTokens: 10 + 3000 + 400 + 1200 + 5, outputTokens: 230 });
  });
});

describe('findClaude', () => {
  const dirs: string[] = [];
  afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

  it('findClaude prefers AIRLOCK_CLAUDE_PATH and returns null when nothing is found', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'airlock-claude-a-'));
    const exec = await mkdtemp(join(tmpdir(), 'airlock-claude-b-'));
    const empty = await mkdtemp(join(tmpdir(), 'airlock-claude-c-'));
    dirs.push(plain, exec, empty);
    await writeFile(join(plain, 'claude'), '#!/bin/sh\n');
    await chmod(join(plain, 'claude'), 0o644);
    await writeFile(join(exec, 'claude'), '#!/bin/sh\n');
    await chmod(join(exec, 'claude'), 0o755);
    const path = [empty, plain, exec].join(delimiter);

    expect(await findClaude({ AIRLOCK_CLAUDE_PATH: '/custom/claude', PATH: path })).toBe('/custom/claude');
    expect(await findClaude({ PATH: path })).toBe(join(exec, 'claude'));
    expect(await findClaude({ PATH: [empty, plain].join(delimiter) })).toBeNull();
    expect(await findClaude({})).toBeNull();
  });

  it('findClaude ignores relative paths', async () => {
    const exec = await mkdtemp(join(tmpdir(), 'airlock-claude-d-'));
    dirs.push(exec);
    await writeFile(join(exec, 'claude'), '#!/bin/sh\n');
    await chmod(join(exec, 'claude'), 0o755);
    const rel = relative(process.cwd(), exec);
    expect(isAbsolute(rel)).toBe(false);

    expect(await findClaude({ PATH: rel })).toBeNull();
    expect(await findClaude({ AIRLOCK_CLAUDE_PATH: join(rel, 'claude'), PATH: '' })).toBeNull();
    expect(await findClaude({ AIRLOCK_CLAUDE_PATH: join(rel, 'claude'), PATH: [rel, exec].join(delimiter) })).toBe(join(exec, 'claude'));
  });
});
