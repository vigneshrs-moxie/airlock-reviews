# Claude Agent SDK notes for the review engine

Package `@anthropic-ai/claude-agent-sdk` **0.3.296**, checked on 2026-11-10 on macOS arm64 with Node 24.21.0. Runs used the Claude login on this machine; `ANTHROPIC_API_KEY` was not set.

Each statement is marked with where it comes from:

- **[run]** observed by running the probe.
- **[types]** read from the installed package: `sdk.d.ts`, `package.json`, or the `sdk.mjs` source.
- **[docs]** only stated in the official docs (code.claude.com/docs/en/agent-sdk); not checked here.

Probe folder, left in place: `/private/tmp/claude-502/-Users-moxie/b33907a2-d51f-4ff6-a10a-0909252af77e/scratchpad/sdk-probe`. `options.mjs` holds the options, `probe.mjs` the main run and its variants, `extras.mjs` the other experiments, and `runs/*.json` the full log of each run. Two logs, `variant-c-isolation.json` and `x-verbatim-context.json`, contain the account's email address.

## Recommended options object for a read-only review agent

This is the object the probe ran (`reviewOptions()` in `options.mjs`). The runner added `abortController` and `stderr`.

```js
import { query, AbortError } from '@anthropic-ai/claude-agent-sdk';

const options = {
  cwd: TARGET,                       // absolute path of the directory under review
  model: 'claude-haiku-5-5',
  tools: ['Read', 'Grep', 'Glob'],   // the only built-in tools that exist in the session
  permissionMode: 'dontAsk',         // never prompt; a call that needs approval is denied
  settingSources: [],                // no user, project or local settings, CLAUDE.md, skills, agents, plugins, hooks
  strictMcpConfig: true,             // no MCP servers at all, including the login's claude.ai connectors
  systemPrompt: SYSTEM_PROMPT,       // a string replaces the Claude Code preset prompt
  verbatimPrompts: true,             // prompt text is sent as written: no @path expansion, no /command dispatch
  persistSession: false,             // no transcript under ~/.claude/projects
  env: cleanEnv(),                   // replaces the child's environment; see below
  maxTurns: 8,
  outputFormat: { type: 'json_schema', schema: SCHEMA },
};

// `env` replaces the whole environment, so start from process.env (HOME and PATH are needed).
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_')) continue; // only because the probe was started inside a Claude Code session
    env[k] = v;
  }
  return { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_AGENT_SDK_CLIENT_APP: 'sdk-probe/0.0.1' };
}
```

Do not add `allowedTools: ['Read', 'Grep', 'Glob']`. It is not needed and it lets the agent read any path on the disk (section 4). The engine should not strip `CLAUDE_*` variables if it relies on one for sign-in, such as `CLAUDE_CODE_OAUTH_TOKEN`.

## 1. The `query()` call

- Signature **[types]**: `query({ prompt, options? }): Query`, with `prompt: string | AsyncIterable<SDKUserMessage>` and `options: Options`. `Query extends AsyncGenerator<SDKMessage, void>` and adds methods such as `close()`, `interrupt()` and `setPermissionMode()`.
- Iterate with `for await (const msg of query({ prompt, options }))`. A string prompt gives one turn, one `result` message, and then the process exits **[run]**.
- **The loop throws after an error result [run].** When a result has `is_error: true`, the loop yields it and then throws `Error('Claude Code returned an error result: <text>')`. Seen for max turns, max budget, an unknown model and a missing login. Keep the result in a variable and wrap the loop in `try/catch`.
- Cancel with `options.abortController` **[run]**. After `abort()` the loop throws an `AbortError`: `err instanceof AbortError` is true, `err.name` is `'Error'`, and the message was `Claude Code process aborted by user` or `Operation aborted`. No result follows an abort made part-way through. The loop ended about 2 s after `abort()`. A run that is nearly finished can still deliver its result before the throw.
- `q.close()` ends the loop with no throw, and so does `break`. No child process was left after either **[run]**.
- `q.interrupt()` is documented for streaming input only **[types]**.
- A start-up failure throws with no messages at all, for example `Claude Code process exited with code 1. stderr: Error: --json-schema is not a valid JSON Schema: …` **[run]**.

## 2. Read-only: what each tool option does

| Option | Meaning | Observed **[run]** |
| --- | --- | --- |
| `tools: string[]` | The set of built-in tools that exist. A whitelist. `[]` means none. | `['Read','Grep','Glob']` gave init `tools` of `Glob, Grep, Read`, plus `StructuredOutput` when `outputFormat` is set. It does not remove MCP tools. |
| `allowedTools` | Pre-approves calls. It is not a restriction. | Used alone, 27 built-in tools stayed, including `Bash`, `Write`, `Edit`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Task`, `Skill` and `Workflow`. |
| `disallowedTools` | A bare name removes that tool. A blacklist. | `['Bash','Write','Edit']` removed those three; `NotebookEdit`, `WebFetch`, `Task` and the rest stayed. |
| `permissionMode: 'dontAsk'` | A call that would prompt is denied. Calls that need no approval still run. | With every tool present and only `Read`, `Grep`, `Glob` pre-approved, `Bash` ran `uname -a`, because read-only shell commands need no approval. In a separate run `Write` was denied. |
| `permissionMode: 'default'`, no `canUseTool` | A call that would prompt is denied, as nobody can answer. | A read outside `cwd` was denied. |
| `canUseTool` | Called only for calls no earlier step decided. Never called in `dontAsk`. | Worked with a string prompt in `default` mode. It received `Read` with `decisionReason: 'Path is outside allowed working directories'`, and its deny message became the tool result. |

What stops each thing under the recommended options **[run]**:

- `Bash`, `Write`, `Edit`, `NotebookEdit`, `WebFetch`, `WebSearch`, subagents, `Skill`, `ToolSearch` and `Workflow` are absent from the init `tools` list because of `tools`. Asked to create a file and to run a shell command, the agent answered that it has only `Glob`, `Grep` and `Read`; no file was created.
- The subagent tool is named `Task` in the init list of CLI 2.1.296. The docs call it `Agent`.
- MCP tools are removed by `strictMcpConfig: true`, not by `tools` (section 3).
- `dontAsk` keeps `Read`, `Grep` and `Glob` inside `cwd` and `additionalDirectories` (section 4).
- `disallowedTools` and `canUseTool` are not needed. Passing `disallowedTools` as well as `tools` was accepted and changed nothing.
- `Grep` and `Glob` exist only when named in `tools` or `allowedTools`. A default run on this machine had neither.

## 3. Isolation from the user's Claude Code set-up

A `query()` with default options on this machine loaded **[run]**: `permissionMode: 'auto'` from `~/.claude/settings.json`, 28 built-in tools, 112 MCP tools from 31 servers, 153 skills, 12 plugins and 28 agents. Two `SessionStart` hooks ran, and one injected text. The first request was 29,246 tokens.

With the recommended options **[run]**: three tools, no MCP servers, no hook messages, no user skills, plugins or agents, and a first request of 3,381 tokens. Asked what was in its context, the model listed three tools, no skills, no MCP, and no `CLAUDE.md`, memory, rules or hook output.

| Option | Removes | Does not remove |
| --- | --- | --- |
| `settingSources: []` | User, project and local `settings.json` (hooks, permissions, plugins, `defaultMode`), `CLAUDE.md`, skills, agents, `.mcp.json`, user MCP servers | The login's claude.ai connectors and auto memory |
| `strictMcpConfig: true` | Every MCP server: plugin, user, project and claude.ai connectors. None appeared in any of more than 50 runs. | Skills, plugins and hooks, when settings are loaded |
| `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'` | Auto memory from `~/.claude/projects/<cwd>/memory/` | |
| `verbatimPrompts: true` | `@path` expansion and `/command` dispatch in the prompt text | The account-email reminder below |
| `systemPrompt: '<string>'` | The Claude Code preset prompt | An environment block the CLI appends: `cwd`, platform, OS version, model, date, and short guidance on parallel tool calls and untrusted downloads |
| `mcpServers: {}`, `skills: []`, `plugins: []` | Nothing observable. The SDK passes no flag for an empty `mcpServers`. With and without all three, init was the same and the request hit the same 3,393-token cache. | |

Findings behind the table **[run]**:

- Without `strictMcpConfig`, seven claude.ai connectors (Gmail, Drive, Calendar, Docs, Sheets, Slides, Claude Docs) with 68 tools were in the init message in 6 of 8 runs, even with `settingSources: []` and `tools` set. The other 2 runs listed none, probably because init was emitted before they connected.
- Without the auto-memory variable, at a `cwd` that has a memory folder, the model reported a memory index of 28 entries despite `settingSources: []` and a custom prompt. With the variable it reported none.
- Without `verbatimPrompts`, `@notes.txt` in the prompt attached the file's content although `tools` was `[]`, and the prompt `/context` ran as a local command with no model call (`num_turns: 0`, cost 0). An `@` path outside `cwd` was not attached.
- A repository with its own `CLAUDE.md`, a `SessionStart` hook in `.claude/settings.json`, a skill and a `.mcp.json` loaded none of them, and the hook command did not run. With `settingSources: ['project']` the hook ran, the `CLAUDE.md` instruction was obeyed, and the skill and MCP server were listed. Never include `'project'` when reviewing code the engine does not trust.

Still present with the recommended options **[run]**:

- The init message lists 19 built-in `skills`, 3 built-in `plugins` (`cc-plugin-*`), 5 built-in `agents` and 55 `slash_commands`. The model sees none of them and has no tool to use them.
- A system reminder carrying the signed-in account's email address is attached to the first user message. `verbatimPrompts` does not remove it, and no option was found that does.

`env.CLAUDE_CONFIG_DIR` set to an empty folder isolates everything but also loses the login **[run]**: the result is `is_error: true` with `result: 'Not logged in · Please run /login'`.

There is no separate switch for hooks or plugins: both come from settings files, so `settingSources: []` removes them. The `hooks` and `plugins` options only add to a session **[types]**.

`~/.claude.json` and managed policy settings are read whatever `settingSources` says **[docs]**.

## 4. Working directory and extra directories

- `cwd` is the session's working directory. The init message echoes it and the model is told it **[run]**.
- `Read`, `Grep` and `Glob` inside `cwd` need no approval and ran in `dontAsk` with no allow rule **[run]**.
- Outside `cwd`, under the recommended options, all of these were denied **[run]**: `Read` of an absolute path, `Glob` and `Grep` with an outside `path`, `Grep` with `path: '..'`, and `Read` of a symlink inside `cwd` that points outside.
- A denial shows up in three places **[run]**: the tool result has `is_error: true` and begins `Permission to use Read has been denied because Claude Code is running in don't ask mode`; a `system` message with subtype `permission_denied` is emitted; and `result.permission_denials` gets an entry. The result subtype stays `success`.
- `additionalDirectories: ['/abs/dir']` allowed reads in that directory; `/etc/hosts` was still denied **[run]**.
- With `allowedTools: ['Read','Grep','Glob']`, `Read` and `Glob` outside `cwd` succeeded **[run]**. A bare tool name in `allowedTools` approves every call to that tool.

## 5. Structured output

- The option exists **[types]**: `outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> }`.
- The CLI adds a tool named `StructuredOutput`. The model calls it with the object and the CLI validates it **[run]**. Skip this tool when showing tool calls.
- On success the parsed object is in `result.structured_output`. `result.result` holds the same object as a JSON string, and `stop_reason` is `'tool_use'` **[run]**.
- On a mismatch **[run]**: the tool result is `is_error: true` with text such as `Output does not match required schema: /secret_word: must NOT be valid`, and the model tries again. With a schema nothing could satisfy, the model tried twice, then answered in prose. The result was `subtype: 'success'`, `is_error: false`, with **no** `structured_output`. Accept an answer only when `subtype === 'success' && !is_error && structured_output !== undefined`.
- `subtype: 'error_max_structured_output_retries'` is in the types but did not occur.
- A schema that is not valid JSON Schema fails at start-up with a throw and no messages **[run]**.
- Schemas are validated as JSON Schema draft-07. From Zod use `z.toJSONSchema(schema, { target: 'draft-7' })`. The `format` keyword is not enforced **[docs]**.

## 6. Model, effort and limits

| `model` | Result **[run]** |
| --- | --- |
| `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` | Work as given. Init `model` is the same string. |
| `claude-fable-5-2` | Works, but the bundled CLI 2.1.296 does not know it: stderr prints `[claude-code:unrecognized_model]`, `modelUsage` shows `contextWindow: 200000` and `costBasis: 'unknown'`, and the reported cost is a guess ($0.0063 against $0.0103 for the same one-word run). With CLI 2.1.322 through `pathToClaudeCodeExecutable` it is recognised: `contextWindow: 1000000`, `costBasis: 'list'`. |
| Aliases | `haiku`, `sonnet` and `opus` resolve to the 5.5 ids. `fable` resolves to `claude-fable-5-1` on the bundled CLI. Use full ids. |
| Unknown id | Result `subtype: 'success'`, `is_error: true`, `api_error_status: 404`, `terminal_reason: 'api_error'`, cost 0, then the loop throws. |

- `effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'` **[types]**. `low` and `high` were accepted with Haiku: 235 against 501 output tokens and 0 against 101 thinking tokens for the same task **[run]**.
- `thinking?: { type: 'adaptive' } | { type: 'enabled', budgetTokens? } | { type: 'disabled' }` **[types]**. Only `adaptive` was run. `maxThinkingTokens` is deprecated.
- `maxTurns` reached **[run]**: `subtype: 'error_max_turns'`, `is_error: true`, `errors: ['Reached maximum number of turns (1)']`, `terminal_reason: 'max_turns'`, no `result` field, then the loop throws. The tool calls of the last allowed turn did run.
- `maxBudgetUsd` reached **[run]**: `subtype: 'error_max_budget_usd'`, `errors: ['Reached maximum budget ($0.0001)']`, `terminal_reason: 'budget_exhausted'`, then the loop throws. It is checked between model calls, so spend can pass the limit ($0.000128 against $0.0001).
- `taskBudget: { total }` (alpha) and `fallbackModel` exist **[types]**.

## 7. Messages

Init message, `type: 'system'` and `subtype: 'init'` **[types, run]**: `apiKeySource` (`'none'` with the Claude login), `model`, `tools: string[]`, `cwd`, `permissionMode`, `session_id`, `claude_code_version`, `mcp_servers: { name, status, source? }[]`, `skills`, `plugins`, `agents`, `slash_commands`, `output_style`, `uuid`.

Result message, `type: 'result'` **[types, run]**:

- Success: `subtype: 'success'`, `result: string` (the final text), `structured_output?: unknown`, `is_error`, `api_error_status?`.
- Error: `subtype` is `'error_max_turns'`, `'error_max_budget_usd'`, `'error_during_execution'` or `'error_max_structured_output_retries'`, with `errors: string[]` and no `result`.
- Both: `num_turns`, `duration_ms`, `duration_api_ms`, `total_cost_usd`, `session_id`, `stop_reason`, `terminal_reason`, `permission_denials: { tool_name, tool_use_id, tool_input }[]`, `usage`, `modelUsage`, `uuid`.
- `usage` uses snake case and covers the main loop only: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`.
- `modelUsage[modelId]` uses camel case and covers every call: `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `thinkingTokens?`, `costUSD`, `contextWindow`, `maxOutputTokens`, `canonicalModel?`, `costBasis?`. Use this for accounting.

Points to code for **[run]**:

- `is_error: true` can come with `subtype: 'success'` (API error, unknown model, not logged in). Test `is_error` before `subtype`.
- The two usage fields differ. In the main run `usage.input_tokens` was 4 and `modelUsage` gave 1,202. Most runs include a small extra Haiku call of about 1,200 input tokens that only `modelUsage` and `total_cost_usd` count. With another main model it has its own `claude-haiku-5-5` key. In the budget test this call alone used up the budget before the main model answered.
- `total_cost_usd` is an estimate at list prices. On the Claude login nothing is billed per token; runs draw on the plan's usage.
- Other messages seen: `assistant`, `user` (tool results), `rate_limit_event` (one per run, with `rate_limit_info.status`), and `system` with subtype `thinking_tokens`, `permission_denied`, `hook_started`, `hook_response` or `commands_changed`. The last three appeared only when settings were loaded.
- Sequence of the main run: `system/init`, `rate_limit_event`, `assistant`, `user`, `assistant`, `user`, `system/thinking_tokens` ×2, `assistant` ×2, `user`, `result/success`.

## 8. Probe runs

All with the recommended options, `claude-haiku-5-5` and the bundled CLI 2.1.296. Cost is `total_cost_usd`.

| Run | Outcome | Wall clock | Cost |
| --- | --- | --- | --- |
| Main: list the files, report the word | `structured_output` was `{ files: ['notes.txt','colors.txt'], secret_word: 'quillfeather' }`; 4 turns; tools used were `Glob`, `Grep`, `StructuredOutput` | 4.2 s (11.3 s on the first, cold run) | $0.0005 |
| (a) Create a file | Not possible: only `Glob`, `Grep`, `Read` exist; no file was created | 2.4 s | $0.0003 |
| (b) Run a shell command | Not possible: no shell tool | 2.2 s | $0.0002 |
| (c) What can you see | Three tools, no skills, no MCP, no `CLAUDE.md`, memory or hook output; one reminder with the account email | 5.9 s | $0.0007 |
| Two runs with `Promise.all` | Both succeeded with different `session_id` values | 4.2 s for both | $0.0005 and $0.0004 |

In total about 75 small runs were made, with about $0.09 of reported cost.

## 9. Surprises and practical points

- **The SDK runs its own CLI, not the one on PATH [run].** It spawns a 240 MB native binary from the optional dependency `@anthropic-ai/claude-agent-sdk-darwin-arm64`, version 2.1.296 (init `claude_code_version`). The `claude` 2.1.322 on PATH is used only through `pathToClaudeCodeExecutable`; the main run passed on it too. The existing caller in `feature-workshop` sets that option only when `STARBASE_CLAUDE_PATH` is set.
- Installing with `--omit=optional` leaves no binary, and `query()` then needs `pathToClaudeCodeExecutable` **[types]**.
- Node: `engines.node` is `>=18.0.0`; the package is ESM only **[types]**.
- Peer dependencies, all required **[types]**: `zod ^4.0.0`, `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`. npm 11 installed zod 4.6.7 by itself **[run]**. The root entry does not import them at run time, but `sdk.d.ts` imports types from all three, so TypeScript needs them.
- No environment variable is needed with the Claude login **[run]**. `env` replaces the child's environment, so spread `process.env`.
- Transcripts **[run]**: with `persistSession` left at its default, a file was written to `~/.claude/projects/<cwd with each / replaced by ->/<session_id>.jsonl`. With `persistSession: false` none was written. The one test transcript is still there, under `~/.claude/projects/-private-tmp-claude-502--Users-moxie-b33907a2-d51f-4ff6-a10a-0909252af77e-scratchpad-sdk-probe-target/`.
- Other writes **[run]**: a run pointed at an empty `CLAUDE_CONFIG_DIR` created `.claude.json`, `backups/` and `sessions/` there, so expect the same in `~/.claude` even with `persistSession: false`. Runs where hooks or `Bash` ran left a folder in `~/.claude/session-env/`; isolated runs did not. Init reports a socket at `/tmp/cc-socks/<pid>.sock`.
- To move transcripts elsewhere there is `sessionStore` (alpha) **[types]**. `CLAUDE_CONFIG_DIR` moves everything but loses the login **[run]**.
- Started from inside a Claude Code session with its `CLAUDE_*` variables inherited, the run behaved the same **[run]**.
- Timing **[run]**: init arrived 0.4 to 0.8 s after `query()`, and the process took about 0.5 s to exit after the result. Some runs took 6 to 14 s longer than `duration_ms`; the cause was not found.
- No Node process warning was printed in any run **[run]**.
- The docs say Anthropic does not allow third-party products to offer claude.ai login, and tell SDK applications to use API-key authentication **[docs]**. Check this before the engine runs anywhere but the owner's machine.

## Verified by running

- The `query()` call, message order, `structured_output`, and the init and result fields named in section 7.
- `tools` is the only option that limits built-in tools; `allowedTools` does not; `disallowedTools` removes only what it names.
- Writing and shell commands are impossible under the recommended options.
- Reads outside `cwd` are denied, including through a symlink; `additionalDirectories` opens a directory; a bare `allowedTools` entry opens the whole disk.
- `settingSources: []` with `strictMcpConfig: true` loads no user or repository configuration; each option's share is in section 3.
- Auto memory needs `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`; `@path` and `/command` handling needs `verbatimPrompts: true`.
- The four model ids, the aliases, an unknown model, `effort` `low` and `high`.
- `maxTurns` and `maxBudgetUsd` results, and the throw after an error result.
- Abort, `close()` and `break`.
- Two parallel runs.
- Bundled CLI against `pathToClaudeCodeExecutable`; transcript location and `persistSession: false`; `CLAUDE_CONFIG_DIR` losing the login.

## Not verified

- `error_max_structured_output_retries` and `error_during_execution` results. Neither occurred.
- Whether the account-email reminder can be turned off.
- Managed policy settings, and what else `~/.claude.json` contributes.
- `effort` `medium`, `xhigh` and `max`; `effort` on models other than Haiku; `thinking` `disabled` and `enabled`.
- `taskBudget`, `fallbackModel`, `sessionStore`, `sandbox`, `hooks` callbacks, `agents`, `interrupt()`, streaming input.
- Sign-in with `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.
- Long runs, large contexts, compaction, API errors such as 429 or 529, and behaviour at the plan's usage limit.
- More than two runs at once.
- The isolation variants on CLI 2.1.322. Only the main run and a one-word Fable run were made on it. The main run's init showed the same four tools and no MCP servers.
- Linux and Windows.
