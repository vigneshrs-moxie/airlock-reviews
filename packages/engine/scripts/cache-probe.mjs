// Checks that the first part of Airlock's system prompt is read from the prompt cache across requests. It sends two
// small requests whose system prompts share the same first part (the shared rules and every standard and rule text in
// packs/), then the SDK's boundary marker, then a different last part each, and prints each one's cache-read and
// cache-write token counts. The second request should read most of the first part from the cache.
// It CALLS A MODEL on your Claude login (two tiny requests). Run it by hand only:
//   node packages/engine/scripts/cache-probe.mjs [model]        (default claude-opus-5-5)
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const model = process.argv[2] ?? 'claude-opus-5-5';

/** Every .md file in each pack's standards and rules folders, in a fixed order, as one block of text. */
async function standingText() {
  const parts = [];
  for (const pack of (await readdir(join(root, 'packs'))).sort()) {
    for (const folder of ['standards', 'rules']) {
      const dir = join(root, 'packs', pack, folder);
      const names = await readdir(dir).catch(() => []);
      for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
        parts.push(`## ${pack}: ${name}\n\n${(await readFile(join(dir, name), 'utf8')).trim()}`);
      }
    }
  }
  return `# The team's standards\n\n${parts.join('\n\n')}`;
}

const shared = (await readFile(join(root, 'packages/engine/prompts/_shared.md'), 'utf8')).trimEnd();
const first = `${shared}\n\n${await standingText()}`;
const cwd = await mkdtemp(join(tmpdir(), 'airlock-cache-probe-'));
const count = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

try {
  console.log(`Model ${model}. First part: ${first.length.toLocaleString('en-US')} characters, the same for both requests.`);
  for (const [i, last] of ['Reply with the single word one.', 'Reply with the single word two, in capitals.'].entries()) {
    let result;
    for await (const msg of query({
      prompt: 'Begin.',
      options: {
        cwd, model, effort: 'low', maxTurns: 1, tools: ['Read', 'Grep', 'Glob'], permissionMode: 'dontAsk', settingSources: [],
        strictMcpConfig: true, verbatimPrompts: true, persistSession: false,
        env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
        systemPrompt: [first, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, last],
      },
    })) {
      if (msg.type === 'system' && msg.subtype === 'init' && msg.apiKeySource !== undefined && !['none', 'oauth'].includes(msg.apiKeySource)) {
        throw new Error(`An API key would be used (${msg.apiKeySource}). Unset it and run again.`);
      }
      if (msg.type === 'result') result = msg;
    }
    let read = 0;
    let written = 0;
    let input = 0;
    for (const m of Object.values(result?.modelUsage ?? {})) {
      read += count(m?.cacheReadInputTokens);
      written += count(m?.cacheCreationInputTokens);
      input += count(m?.inputTokens);
    }
    console.log(`Request ${i + 1}: cache read ${read.toLocaleString('en-US')}, cache write ${written.toLocaleString('en-US')}, `
      + `other input ${input.toLocaleString('en-US')} tokens; ${result?.subtype ?? 'no result'}.`);
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
