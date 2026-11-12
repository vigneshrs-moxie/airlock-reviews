import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { realExec, type Exec } from '@airlock/engine';
import { isGhRead } from '../../../engine/src/util/exec.js';
import { listReviewComments, listReviews, readLogin, readPull, reviewToSend, sendReview, type ReviewPayload } from '../../src/posts/github.js';

const WRITE_SUBCOMMANDS = 'pr|issue|repo|release|workflow|label|gist|secret';

/**
 * What in a source file could make `gh` write, in order of appearance. A second net under the run-time guard in
 * `realExec`; it reads text, so it errs towards finding too much.
 * - the `gh api` flags `--method`, `--input`, `--field`, `--raw-field`, and `-X` alone or in a group of short flags
 *   (`-iXPOST`), anywhere;
 * - `-f` and `-F`, alone or in a group (`-ifbody=x`), anywhere except on a line that runs git's grep (`exec('git',
 *   ['grep', …` or `= ['grep', …`, where `-F` means fixed strings) and names no `gh`;
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
  look(/(?<![\w-])-[A-Za-z]*X/g);
  let offset = 0;
  for (const line of text.split('\n')) {
    const gitGrep = /exec\(\s*['"`]git['"`]\s*,\s*\[\s*['"`]grep['"`]|=\s*\[\s*['"`]grep['"`]\s*,/.test(line) && !/gh/i.test(line);
    const flags = /(?<![\w-])-[A-Za-z]*[fF](?![-\w])|(?<![\w-])-[A-Za-z]*[fF](?=[A-Za-z_[\]]+=)/g;
    if (!gitGrep) for (const m of line.matchAll(flags)) found.push({ at: offset + (m.index ?? 0), what: m[0] });
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

/**
 * Every source file the guard reads under `root`: each package's src and scripts, the extension's entrypoints, and
 * config files. Entries directly under `packages/` that are not folders are skipped.
 */
async function guardedSources(root: string = ROOT): Promise<string[]> {
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
  const packages = (await readdir(join(root, 'packages'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const pkg of packages) {
    for (const folder of ['src', 'scripts', 'entrypoints']) await walk(join(root, 'packages', pkg, folder));
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
  await configs(root, 0);
  for (const pkg of packages) await configs(join(root, 'packages', pkg), 1);
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

  it("shows every entry of a validation refusal's errors list, as gh prints it (measured: exit 1, the body on standard output)", async () => {
    const body = JSON.stringify({
      message: 'Validation Failed',
      errors: [
        { resource: 'PullRequestReviewComment', field: 'line', code: 'invalid' },
        'Line could not be resolved',
        { resource: 'PullRequestReview', code: 'custom', field: 'pull_request_review_thread.path', message: 'Path could not be resolved' },
        { resource: 'PullRequestReview', code: 'missing_field' },
        { resource: 'PullRequestReview', field: 'body' },
        {},
      ],
      documentation_url: 'https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request',
      status: '422',
    });
    const refused = await sendReview(fakeExec(answer(body, 'gh: Validation Failed (HTTP 422)\n', 1)).exec, REPO, 7, payload);
    expect(refused).toEqual({
      kind: 'refused', status: 422,
      message: 'Validation Failed: line: invalid; Line could not be resolved; Path could not be resolved; missing_field; body',
    });
  });
});

describe('reviewToSend', () => {
  it('makes every check sendReview makes, before anything runs, and gives the payload as it will be sent', () => {
    expect(reviewToSend(REPO, 7, payload)).toEqual(payload);
    const many = { ...payload, comments: Array.from({ length: 31 }, () => payload.comments[0] as ReviewPayload['comments'][number]) };
    expect(() => reviewToSend(REPO, 7, many)).toThrow('A post holds at most 30 comments.');
    expect(() => reviewToSend('a/b/../c', 7, payload)).toThrow();
    expect(() => reviewToSend(REPO, 0, payload)).toThrow();
  });
});

describe('readLogin', () => {
  it('reads the signed-in account with `gh api user --jq .login`, a read, within ten seconds', async () => {
    const { exec, seen } = fakeExec(answer('Bob-2\n', '', 0));
    expect(await readLogin(exec)).toBe('Bob-2');
    expect(seen).toEqual([{ cmd: 'gh', args: ['api', 'user', '--jq', '.login'], input: undefined, timeoutMs: 10_000, allowGhWrite: undefined }]);
    expect(isGhRead(seen[0]?.args ?? [])).toBe(true);
    expect(await readLogin(fakeExec(answer('acme_corp-user\n', '', 0)).exec)).toBe('acme_corp-user');
  });

  it('gives null when the account cannot be read', async () => {
    const cases: Array<() => Promise<{ stdout: string; stderr: string; code: number }>> = [
      answer('', 'To get started with GitHub CLI, please run:  gh auth login', 4),
      answer('{"message":"Bad credentials"}', 'gh: Bad credentials (HTTP 401)', 1),
      answer('', 'timed out after 10 s', 124),
      answer('', '', 0),
      answer('bob smith\n', '', 0),
      answer(`${'a'.repeat(101)}\n`, '', 0),
      async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); },
    ];
    for (const run of cases) expect(await readLogin(fakeExec(run).exec)).toBeNull();
  });
});

describe('listReviews', () => {
  const review = (id: number, login: string | null, body: string | null = 'Text.') =>
    ({ id, user: login === null ? null : { login }, commit_id: 'c'.repeat(40), body, state: 'COMMENTED' });

  it('lists the reviews with `gh api repos/<repo>/pulls/<number>/reviews --paginate`, a read, and joins the pages', async () => {
    const pages = `${JSON.stringify([review(1, 'bob'), review(2, null)])}\n${JSON.stringify([review(3, 'carol', 'A ][ in the text, and "quotes" \\ too.')])}`;
    const { exec, seen } = fakeExec(answer(pages, '', 0));
    expect(await listReviews(exec, REPO, 7)).toEqual([
      { id: 1, login: 'bob', commitId: 'c'.repeat(40), body: 'Text.' },
      { id: 2, login: null, commitId: 'c'.repeat(40), body: 'Text.' },
      { id: 3, login: 'carol', commitId: 'c'.repeat(40), body: 'A ][ in the text, and "quotes" \\ too.' },
    ]);
    expect(seen).toEqual([{
      cmd: 'gh', args: ['api', `repos/${REPO}/pulls/7/reviews`, '--paginate'], input: undefined, timeoutMs: 30_000, allowGhWrite: undefined,
    }]);
    expect(isGhRead(seen[0]?.args ?? [])).toBe(true);
    expect(await listReviews(fakeExec(answer('[]', '', 0)).exec, REPO, 7)).toEqual([]);
    expect(await listReviews(fakeExec(answer(JSON.stringify([review(4, 'bob', null)]), '', 0)).exec, REPO, 7))
      .toEqual([{ id: 4, login: 'bob', commitId: 'c'.repeat(40), body: '' }]);
  });

  it('gives null when the list cannot be read whole, and throws for an address that is not one before running anything', async () => {
    const cases: Array<() => Promise<{ stdout: string; stderr: string; code: number }>> = [
      answer('{"message":"Server Error"}', 'gh: Server Error (HTTP 500)', 1),
      answer('{"message":"Not Found"}', 'gh: Not Found (HTTP 404)', 1),
      answer('', 'timed out after 30 s', 124),
      answer('not json', '', 0),
      answer('[{"id":1}', '', 0),
      answer(`${JSON.stringify([review(1, 'bob')])} x`, '', 0),
      answer('{"id":1}', '', 0),
      answer(JSON.stringify([{ id: 'one', user: null, commit_id: null, body: '' }]), '', 0),
      async () => { throw new Error('spawn gh ENOENT'); },
    ];
    for (const run of cases) expect(await listReviews(fakeExec(run).exec, REPO, 7)).toBeNull();
    const { exec, seen } = fakeExec(answer('[]', '', 0));
    await expect(listReviews(exec, 'a/b/c', 7)).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});

describe('listReviewComments', () => {
  const comment = (over: Record<string, unknown> = {}) => ({
    id: 1, pull_request_review_id: 901, path: 'src/total.ts', line: 12, start_line: null, original_line: 12, original_start_line: null,
    body: 'First.', ...over,
  });

  it('reads one review\'s comments with `gh api repos/<repo>/pulls/<number>/reviews/<id>/comments --paginate`, a read, and joins the pages', async () => {
    const pages = `${JSON.stringify([comment()])}\n${JSON.stringify([comment({ id: 2, path: 'src/rows.ts', line: null, start_line: null, original_line: 20, original_start_line: 18, body: 'A ][ "b" \\ c.' })])}`;
    const { exec, seen } = fakeExec(answer(pages, '', 0));
    expect(await listReviewComments(exec, REPO, 7, 901)).toEqual({
      kind: 'comments',
      comments: [
        { path: 'src/total.ts', line: 12, startLine: null, originalLine: 12, originalStartLine: null, body: 'First.' },
        { path: 'src/rows.ts', line: null, startLine: null, originalLine: 20, originalStartLine: 18, body: 'A ][ "b" \\ c.' },
      ],
    });
    expect(seen).toEqual([{
      cmd: 'gh', args: ['api', `repos/${REPO}/pulls/7/reviews/901/comments`, '--paginate'], input: undefined, timeoutMs: 20_000, allowGhWrite: undefined,
    }]);
    expect(isGhRead(seen[0]?.args ?? [])).toBe(true);
    expect(await listReviewComments(fakeExec(answer('[]', '', 0)).exec, REPO, 7, 901)).toEqual({ kind: 'comments', comments: [] });
  });

  it('says when a list was read but is not comments, and when it could not be read', async () => {
    const unparsed: Array<() => Promise<{ stdout: string; stderr: string; code: number }>> = [
      answer('not json', '', 0),
      answer('[{"id":1}', '', 0),
      answer('{"id":1}', '', 0),
      answer(JSON.stringify([comment({ path: 7 })]), '', 0),
      answer(JSON.stringify([comment({ body: null })]), '', 0),
      answer(JSON.stringify([comment({ line: 'twelve' })]), '', 0),
    ];
    for (const run of unparsed) expect(await listReviewComments(fakeExec(run).exec, REPO, 7, 901)).toEqual({ kind: 'unparsed' });
    const unread: Array<() => Promise<{ stdout: string; stderr: string; code: number }>> = [
      answer('{"message":"Server Error"}', 'gh: Server Error (HTTP 500)', 1),
      answer('{"message":"Not Found"}', 'gh: Not Found (HTTP 404)', 1),
      answer('', 'timed out after 20 s', 124),
      async () => { throw new Error('spawn gh ENOENT'); },
    ];
    for (const run of unread) expect(await listReviewComments(fakeExec(run).exec, REPO, 7, 901)).toEqual({ kind: 'no-answer' });
  });

  it('throws, before running anything, for a review id that is not a positive safe integer or an address that is not one', async () => {
    for (const [repo, id] of [[REPO, 0], [REPO, -3], [REPO, 1.5], [REPO, Number.MAX_SAFE_INTEGER + 2], [REPO, Number.NaN], ['a/b/c', 901]] as const) {
      const { exec, seen } = fakeExec(answer('[]', '', 0));
      await expect(listReviewComments(exec, repo, 7, id)).rejects.toThrow();
      expect(seen).toEqual([]);
    }
  });
});

describe('sendReview (continued)', () => {

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

describe('the scan', () => {
  it('skips a stray file directly under packages, such as .DS_Store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airlock-scan-root-'));
    try {
      await mkdir(join(root, 'packages', 'one', 'src'), { recursive: true });
      await writeFile(join(root, 'packages', '.DS_Store'), 'not a folder');
      await writeFile(join(root, 'packages', 'one', 'src', 'a.ts'), 'export const a = 1;\n');
      expect((await guardedSources(root)).map((p) => relative(root, p))).toEqual([join('packages', 'one', 'src', 'a.ts')]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('readPull', () => {
  it('reads only the pull request, within ten seconds, as a read the engine lets through', async () => {
    const pullJson = JSON.stringify({ state: 'open', merged: false, head: { sha: 'c'.repeat(40) } });
    const { exec, seen } = fakeExec(answer(pullJson, '', 0));
    expect(await readPull(exec, REPO, 7)).toEqual({ kind: 'pull', state: 'open', merged: false, headSha: 'c'.repeat(40) });
    expect(seen).toEqual([{ cmd: 'gh', args: ['api', `repos/${REPO}/pulls/7`], input: undefined, timeoutMs: 10_000, allowGhWrite: undefined }]);
    expect(isGhRead(seen[0]?.args ?? [])).toBe(true);
    expect(await readPull(fakeExec(answer('{"message":"Not Found"}', 'gh: Not Found (HTTP 404)', 1)).exec, REPO, 7)).toEqual({ kind: 'missing' });
    expect(await readPull(fakeExec(answer('{"message":"Bad credentials"}', 'gh: Bad credentials (HTTP 401)', 1)).exec, REPO, 7))
      .toEqual({ kind: 'refused', status: 401, message: 'Bad credentials' });
    expect(await readPull(fakeExec(answer('', 'timed out after 10 s', 124)).exec, REPO, 7)).toEqual({ kind: 'no-answer' });
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    expect(await readPull(fakeExec(async () => { throw enoent; }).exec, REPO, 7)).toEqual({ kind: 'unavailable' });
    expect(await readPull(fakeExec(answer('', 'To get started with GitHub CLI, please run:  gh auth login', 4)).exec, REPO, 7)).toEqual({ kind: 'unavailable' });
    expect(await readPull(fakeExec(async () => { throw new Error('The command was stopped.'); }).exec, REPO, 7)).toEqual({ kind: 'no-answer' });
    for (const status of [500, 502, 503]) {
      expect(await readPull(fakeExec(answer('{"message":"x"}', `gh: x (HTTP ${status})`, 1)).exec, REPO, 7)).toEqual({ kind: 'server-error', status });
    }
    expect(await readPull(fakeExec(answer('{"state":"open"}', '', 0)).exec, REPO, 7)).toEqual({ kind: 'unreadable' });
    await expect(readPull(fakeExec(answer('{}', '', 0)).exec, 'a/b/c', 7)).rejects.toThrow();
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
      // Short flags grouped behind one dash.
      "runGh(exec, ['api', path, '-iXPOST'])",
      "exec('gh', ['api', path, '-iX', 'DELETE'])",
      "exec('gh', ['api', path, '-ifbody=x'])",
      "exec('gh', ['api', path, '-iF', 'k=1'])",
      // A grep word on the line does not hide a field.
      "runGh(exec, ['api', path, '-f', 'body=x', 'grep'])",
      "runGh(exec, ['api', path, '-f', 'body=x']); // 'grep'",
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
