import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { realExec, type Exec } from '@airlock/engine';
import { sendReview, type ReviewPayload } from '../../src/posts/github.js';

const WRITE_SUBCOMMANDS = 'pr|issue|repo|release|workflow|label|gist|secret';

/**
 * What in a source file could make `gh` write, in order of appearance. A second net under the run-time guard in
 * `realExec`; it reads text, so it errs towards finding too much.
 * - the `gh api` flags `--method`, `--input`, `--field`, `--raw-field` and `-X`, anywhere;
 * - `-f` and `-F`, anywhere except on a line that runs git's `grep` (where `-F` means fixed strings) and names no `gh`;
 * - an argument list that starts with a write subcommand (`['pr', …]`), and a `gh` call whose first argument is not
 *   `api` or `auth`;
 * - `gh pr …` and the other write subcommands, and `gh api graphql`, written out in a string; a `graphql` argument;
 * - `--approve` and `--request-changes` in any letter case, and the events APPROVE, REQUEST_CHANGES and PENDING.
 */
function ghWritesIn(text: string): string[] {
  const found: Array<{ at: number; what: string }> = [];
  const look = (pattern: RegExp, what = (m: RegExpMatchArray): string => m[0]): void => {
    for (const match of text.matchAll(pattern)) found.push({ at: match.index ?? 0, what: what(match) });
  };
  look(/(?<![\w-])--(?:method|input|field|raw-field)(?![\w-])/g);
  look(/(?<![\w-])-X/g);
  let offset = 0;
  for (const line of text.split('\n')) {
    const gitGrep = /['"`]grep['"`]/.test(line) && !/\bgh\b/.test(line);
    if (!gitGrep) for (const m of line.matchAll(/(?<![\w-])-[fF](?![-\w])|(?<![\w-])-[fF](?=[A-Za-z_[\]]+=)/g)) found.push({ at: offset + (m.index ?? 0), what: m[0] });
    offset += line.length + 1;
  }
  look(new RegExp(`\\[\\s*(['"\`])(?:${WRITE_SUBCOMMANDS})\\1\\s*[,\\]]`, 'g'), (m) => `subcommand ${m[0]}`);
  look(/['"`]gh['"`]\s*,\s*\[\s*['"`](?!api['"`]|auth['"`])\w*/g, (m) => `gh call ${m[0]}`);
  look(new RegExp(`\\bgh\\s+(?:${WRITE_SUBCOMMANDS}|api\\s+graphql)\\b`, 'g'));
  look(/(['"`])graphql\1/g);
  look(/--approve|--request-changes/gi);
  look(/APPROVE|REQUEST_CHANGES|PENDING/g);
  return found.sort((a, b) => a.at - b.at).map((f) => f.what);
}

/** Every source file the guard reads: each package's src and scripts, the extension's entrypoints, and config files. */
async function guardedSources(): Promise<string[]> {
  const sources: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (SOURCE.test(entry.name)) sources.push(path);
    }
  };
  for (const pkg of await readdir(join(ROOT, 'packages'))) {
    for (const folder of ['src', 'scripts', 'entrypoints']) await walk(join(ROOT, 'packages', pkg, folder));
  }
  // Config files at the root, in each package and one level below it (such as the extension's e2e folder).
  const configs = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && depth > 0 && !['node_modules', 'dist', '.output', '.wxt', '.git'].includes(entry.name)) {
        await configs(join(dir, entry.name), depth - 1);
      } else if (entry.isFile() && /\.config\.(ts|js|mjs|cjs|mts|cts)$/.test(entry.name)) {
        sources.push(join(dir, entry.name));
      }
    }
  };
  await configs(ROOT, 0);
  for (const pkg of await readdir(join(ROOT, 'packages'))) await configs(join(ROOT, 'packages', pkg), 1);
  return [...new Set(sources)];
}

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ONLY_WRITER = 'packages/service/src/posts/github.ts';
/** The engine file that defines `allowGhWrite` and enforces it. */
const GUARD = 'packages/engine/src/util/exec.ts';
/**
 * The one exception: a script run by hand that reads pull request descriptions with one GraphQL query per case. `gh api
 * graphql` needs `-f query=…`; the test below checks that its query is a query and that it is the file's only gh call.
 */
const REPLAY_READER = 'packages/replay/scripts/capture-descriptions.mjs';
// A repository that does not exist, so even a mistake could not touch a real pull request.
const REPO = 'airlock-test-owner-zz9/none';

const payload: ReviewPayload = {
  commit_id: 'b'.repeat(40), event: 'COMMENT', body: 'Review notes from Airlock: 2 comments.',
  comments: [
    { path: 'src/total.ts', line: 12, side: 'RIGHT', body: 'First.' },
    { path: 'src/rows.ts', line: 20, side: 'RIGHT', start_line: 18, start_side: 'RIGHT', body: 'Second.' },
  ],
};

interface Seen { cmd: string; args: string[]; input: string | undefined; timeoutMs: number | undefined; allowGhWrite: boolean | undefined }

function fakeExec(answer: () => Promise<{ stdout: string; stderr: string; code: number }>): { exec: Exec; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    exec: async (cmd, args, opts) => {
      seen.push({ cmd, args: [...args], input: opts?.input, timeoutMs: opts?.timeoutMs, allowGhWrite: opts?.allowGhWrite });
      return answer();
    },
  };
}

const answer = (stdout: string, stderr: string, code: number) => async () => ({ stdout, stderr, code });

describe('sendReview', () => {
  it('sends the documented command with the payload as JSON on standard input, and reads the id', async () => {
    const { exec, seen } = fakeExec(answer(JSON.stringify({ id: 77, html_url: 'https://elsewhere.example/x', state: 'COMMENTED' }), '', 0));
    const result = await sendReview(exec, REPO, 7, payload);
    expect(result).toEqual({ kind: 'posted', id: 77, url: `https://github.com/${REPO}/pull/7#pullrequestreview-77` });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ cmd: 'gh', args: ['api', '--method', 'POST', `repos/${REPO}/pulls/7/reviews`, '--input', '-'] });
    expect(seen[0]?.input).toBe(JSON.stringify(payload));
    expect(seen[0]?.timeoutMs).toBeGreaterThan(0);
    // The one write says so, or the engine's exec refuses it.
    expect(seen[0]?.allowGhWrite).toBe(true);
  });

  it('reads a refusal from gh: the status from standard error, the message from the body, cleaned and cut', async () => {
    const body = JSON.stringify({ message: 'Unprocessable\u200b Entity', errors: [{ message: 'Line\n must be part of the diff' }, 'second reason'] });
    const refused = await sendReview(fakeExec(answer(body, 'gh: Unprocessable Entity (HTTP 422)\n', 1)).exec, REPO, 7, payload);
    expect(refused).toEqual({ kind: 'refused', status: 422, message: 'Unprocessable Entity: Line must be part of the diff; second reason' });

    const long = await sendReview(fakeExec(answer(JSON.stringify({ message: 'x'.repeat(900) }), 'gh: x (HTTP 403)', 1)).exec, REPO, 7, payload);
    expect(long.kind).toBe('refused');
    expect([...(long as { message: string }).message].length).toBe(300);

    for (const status of [403, 404, 422]) {
      const r = await sendReview(fakeExec(answer('{"message":"No"}', `gh: No (HTTP ${status})`, 1)).exec, REPO, 7, payload);
      expect(r, String(status)).toEqual({ kind: 'refused', status, message: 'No' });
    }

    const noBody = await sendReview(fakeExec(answer('not json', 'gh: You have exceeded a secondary rate limit (HTTP 403)\n', 1)).exec, REPO, 7, payload);
    expect(noBody).toEqual({ kind: 'refused', status: 403, message: 'You have exceeded a secondary rate limit' });
  });

  it('calls anything without a status unknown, and never runs a second time', async () => {
    const cases: Array<() => Promise<{ stdout: string; stderr: string; code: number }>> = [
      answer('', 'timed out after 60 s', 124),
      answer('', 'error connecting to api.github.com', 1),
      answer('{"message":"Bad"}', 'gh: Bad (HTTP 422)', 2),
      // A server error may come after the review was made: not a refusal.
      answer('{"message":"Server Error"}', 'gh: Server Error (HTTP 500)', 1),
      answer('{"message":"Bad Gateway"}', 'gh: Bad Gateway (HTTP 502)', 1),
      answer('{"message":"Unavailable"}', 'gh: Unavailable (HTTP 503)', 1),
      answer('{"message":"Moved"}', 'gh: Moved (HTTP 301)', 1),
      answer('not json', '', 0),
      answer('{"id":"seven"}', '', 0),
      answer('{"id":0}', '', 0),
      answer('{"id":-4}', '', 0),
      answer('{"id":1.5}', '', 0),
      answer(`{"id":${Number.MAX_SAFE_INTEGER + 2}}`, '', 0),
      answer('{"html_url":"https://github.com/airlock-test-owner-zz9/none/pull/7#pullrequestreview-3"}', '', 0),
      async () => { throw new Error('spawn gh ENOENT'); },
    ];
    for (const run of cases) {
      const { exec, seen } = fakeExec(run);
      expect((await sendReview(exec, REPO, 7, payload)).kind).toBe('unknown');
      expect(seen).toHaveLength(1);
    }
  });

  it('refuses a repository or number that could reach another address, before running anything', async () => {
    for (const [repo, number] of [['a/b/../c', 7], ['a b/c', 7], ['acme/widgets', 0], ['acme/widgets', 1.5]] as const) {
      const { exec, seen } = fakeExec(answer('{}', '', 0));
      await expect(sendReview(exec, repo, number, payload)).rejects.toThrow();
      expect(seen).toEqual([]);
    }
  });
});

describe('the one write', () => {
  it('no file but posts/github.ts gives gh a write flag, and its event can only be COMMENT', async () => {
    // The scan catches what it is meant to catch.
    const samples = [
      "exec('gh', ['pr', 'review', String(n), '--approve'])",
      "execFileSync('gh', ['pr', 'comment', '7', '--body', text])",
      "await run(`gh pr comment ${n} --body x`)",
      "exec('gh', ['api', '-X', 'POST', path])",
      "exec('gh', ['api', 'graphql', '-f', 'query=mutation { addComment }'])",
      "runGh(exec, ['api', path, '-f', 'body=x'])",
      "exec('gh', ['api', '-XPOST', path, '-Fbody=@file'])",
      "const args = ['api', '--method=PATCH', path]; await exec('gh', args)",
      "run(`gh api ${path} --input body.json`)",
      "exec('gh', ['issue', 'comment', n, '-b', t])",
      "exec('gh', ['pr', 'merge', n, '--squash'])",
      "exec('gh', ['pr', 'edit', n, '--add-label', 'x'])",
      "exec(tool, ['pr', 'review', n, '--REQUEST-CHANGES'])",
    ];
    for (const sample of samples) expect(ghWritesIn(sample), sample).not.toEqual([]);
    expect(ghWritesIn("exec('git', ['grep', '-l', '-w', '-F', name])")).toEqual([]);
    expect(ghWritesIn("const args = ['grep', '-n', '-o', '-z', '-I', '-w', '-F', '-e', token];")).toEqual([]);
    expect(ghWritesIn("exec('gh', ['api', `repos/${repo}/pulls/${n}`, '--jq', '.title'])")).toEqual([]);
    expect(ghWritesIn("exec('gh', ['auth', 'status'])")).toEqual([]);
    expect(ghWritesIn("const KEYS = ['anchorId', 'line', 'number', 'path', 'repo', 'type'];")).toEqual([]);

    const sources = await guardedSources();
    const names = sources.map((path) => relative(ROOT, path).split('\\').join('/'));
    for (const expected of ['packages/replay/scripts/capture-descriptions.mjs', 'packages/engine/scripts/cache-probe.mjs',
      'packages/extension/entrypoints/background.ts', 'packages/extension/wxt.config.ts', 'vitest.config.ts', GUARD, ONLY_WRITER]) {
      expect(names, expected).toContain(expected);
    }
    const offenders: string[] = [];
    const allowing: string[] = [];
    const setting: string[] = [];
    for (const [i, path] of sources.entries()) {
      const text = await readFile(path, 'utf8');
      const name = names[i] as string;
      if (ghWritesIn(text).length > 0) offenders.push(name);
      if (text.includes('allowGhWrite')) allowing.push(name);
      if (/allowGhWrite\s*:\s*true/.test(text)) setting.push(name);
    }
    // The guard names the flags it refuses; its behaviour is tested in the engine's exec test.
    expect(offenders.sort()).toEqual([GUARD, ONLY_WRITER, REPLAY_READER].sort());
    // Only the guard knows the option, and only the one write sets it.
    expect(allowing.sort()).toEqual([GUARD, ONLY_WRITER].sort());
    expect(setting).toEqual([ONLY_WRITER]);

    // The exception reads, and only reads: its one gh call sends the query built by its own query function.
    const reader = await readFile(join(ROOT, REPLAY_READER), 'utf8');
    expect(reader.match(/execFileSync\(\s*'gh'/g)).toHaveLength(1);
    expect(reader.match(/['"`]gh['"`]/g)).toHaveLength(1);
    expect(reader).not.toMatch(/\bspawn|\bexec\(|\bexecFile\(|\bexecSync/);
    expect(reader).toContain("['api', 'graphql', '-f', `query=${query(owner, name, c.pr)}`]");
    const queryText = /const query = \(owner, name, number\) => `([^`]*)`/.exec(reader)?.[1];
    expect(queryText).toBeDefined();
    expect(queryText?.trimStart().startsWith('query')).toBe(true);
    expect(queryText).not.toMatch(/mutation/i);

    // The payload's event is the literal COMMENT, and whatever reaches sendReview at run time, COMMENT is what is sent.
    // @ts-expect-error: another event does not type-check.
    const approve: ReviewPayload = { ...payload, event: 'APPROVE' };
    const { exec, seen } = fakeExec(answer(JSON.stringify({ id: 1 }), '', 0));
    await sendReview(exec, REPO, 7, { ...approve, position: 3, comments: [{ ...payload.comments[0], side: 'LEFT', position: 4 }] } as unknown as ReviewPayload);
    const sent = JSON.parse(seen[0]?.input ?? '{}') as Record<string, unknown>;
    expect(sent['event']).toBe('COMMENT');
    expect(Object.keys(sent)).toEqual(['commit_id', 'event', 'body', 'comments']);
    expect(sent['comments']).toEqual([{ path: 'src/total.ts', line: 12, side: 'RIGHT', body: 'First.' }]);
  });
});

describe('with a fake gh executable', () => {
  const saved = { PATH: process.env['PATH'], GH_HOST: process.env['GH_HOST'], GH_TOKEN: process.env['GH_TOKEN'] };
  let folder: string | null = null;

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (folder !== null) await rm(folder, { recursive: true, force: true });
    folder = null;
  });

  it('with a fake gh on the PATH, the real exec sends the documented arguments and body', async () => {
    folder = await mkdtemp(join(tmpdir(), 'airlock-fake-gh-'));
    const seenFile = join(folder, 'seen.json');
    const script = [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (d) => { input += d; });",
      "process.stdin.on('end', () => {",
      `  fs.writeFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ args: process.argv.slice(2), input, fake: true }));`,
      `  process.stdout.write(JSON.stringify({ id: 4242, html_url: 'https://github.com/${REPO}/pull/7#pullrequestreview-4242' }));`,
      '});',
      '',
    ].join('\n');
    await writeFile(join(folder, 'gh'), script);
    await chmod(join(folder, 'gh'), 0o755);
    process.env['PATH'] = `${folder}${delimiter}${saved.PATH ?? ''}`;
    // Belt and braces: were the real gh ever reached, it would talk to a host that does not exist, with no token.
    process.env['GH_HOST'] = 'airlock-fake-gh.invalid';
    process.env['GH_TOKEN'] = '';

    // First prove that `gh` is the fake, with a harmless read, before the write is ever made.
    const probe = await realExec('gh', ['api', 'airlock-probe'], { input: '' });
    expect(probe.code).toBe(0);
    expect(JSON.parse(await readFile(seenFile, 'utf8'))).toEqual({ args: ['api', 'airlock-probe'], input: '', fake: true });

    // The same write without the one writer's option is refused before the fake is started.
    const write = ['api', '--method', 'POST', `repos/${REPO}/pulls/7/reviews`, '--input', '-'];
    await expect(realExec('gh', write, { input: JSON.stringify(payload) })).rejects.toThrow('Airlock does not let this command write to GitHub.');
    expect(JSON.parse(await readFile(seenFile, 'utf8'))).toEqual({ args: ['api', 'airlock-probe'], input: '', fake: true });

    const result = await sendReview(realExec, REPO, 7, payload);
    expect(result).toEqual({ kind: 'posted', id: 4242, url: `https://github.com/${REPO}/pull/7#pullrequestreview-4242` });
    const seen = JSON.parse(await readFile(seenFile, 'utf8')) as { args: string[]; input: string; fake: boolean };
    expect(seen.fake).toBe(true);
    expect(seen.args).toEqual(['api', '--method', 'POST', `repos/${REPO}/pulls/7/reviews`, '--input', '-']);
    expect(seen.input).toBe(JSON.stringify(payload));
  });
});
