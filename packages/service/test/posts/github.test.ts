import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { realExec, type Exec } from '@airlock/engine';
import { sendReview, type ReviewPayload } from '../../src/posts/github.js';

/**
 * The flags that make `gh api` write, as they appear in a source file: `--method`, `--input`, `--field`, `--raw-field` and
 * `-X` anywhere; `-f` and `-F` in a file that runs `gh` (git's `grep -F` is a search). In order of appearance.
 */
function writeFlagsIn(text: string): string[] {
  const found: Array<{ at: number; flag: string }> = [];
  const look = (pattern: RegExp): void => {
    for (const match of text.matchAll(pattern)) found.push({ at: match.index, flag: match[0] });
  };
  look(/(?<![\w-])--(?:method|input|field|raw-field)(?![\w-])/g);
  look(/(?<![\w-])-X/g);
  if (/['"`]gh['"`\s]/.test(text)) look(/(?<![\w-])-[fF](?!-)/g);
  return found.sort((a, b) => a.at - b.at).map((f) => f.flag);
}

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ONLY_WRITER = 'packages/service/src/posts/github.ts';
// A repository that does not exist, so even a mistake could not touch a real pull request.
const REPO = 'airlock-test-owner-zz9/none';

const payload: ReviewPayload = {
  commit_id: 'b'.repeat(40), event: 'COMMENT', body: 'Review notes from Airlock: 2 comments.',
  comments: [
    { path: 'src/total.ts', line: 12, side: 'RIGHT', body: 'First.' },
    { path: 'src/rows.ts', line: 20, side: 'RIGHT', start_line: 18, start_side: 'RIGHT', body: 'Second.' },
  ],
};

interface Seen { cmd: string; args: string[]; input: string | undefined; timeoutMs: number | undefined }

function fakeExec(answer: () => Promise<{ stdout: string; stderr: string; code: number }>): { exec: Exec; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    exec: async (cmd, args, opts) => {
      seen.push({ cmd, args: [...args], input: opts?.input, timeoutMs: opts?.timeoutMs });
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
    expect(writeFlagsIn("exec('gh', ['api', '-X', 'DELETE', path])")).toEqual(['-X']);
    expect(writeFlagsIn("exec('gh', ['api', path, '-f', 'body=hi', '--field', 'x=1'])")).toEqual(['-f', '--field']);
    expect(writeFlagsIn("const args = ['api', '--method=PATCH', path]; await exec('gh', args)")).toEqual(['--method']);
    expect(writeFlagsIn("exec('gh', ['api', '-XPOST', path, '-Fbody=@file'])")).toEqual(['-X', '-F']);
    expect(writeFlagsIn("run(`gh api ${path} --input body.json`)")).toEqual(['--input']);
    expect(writeFlagsIn("exec('git', ['grep', '-l', '-w', '-F', name])")).toEqual([]);
    expect(writeFlagsIn("exec('gh', ['api', `repos/${repo}/pulls/${n}`, '--jq', '.title'])")).toEqual([]);

    const offenders: string[] = [];
    const words: string[] = [];
    const sources: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) sources.push(path);
      }
    };
    for (const pkg of await readdir(join(ROOT, 'packages'))) {
      await walk(join(ROOT, 'packages', pkg, 'src')).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    }
    expect(sources.length).toBeGreaterThan(50);
    for (const path of sources) {
      const text = await readFile(path, 'utf8');
      const name = relative(ROOT, path).split('\\').join('/');
      if (writeFlagsIn(text).length > 0) offenders.push(name);
      if (/APPROVE|REQUEST_CHANGES|PENDING/.test(text)) words.push(name);
    }
    expect(offenders).toEqual([ONLY_WRITER]);
    expect(words).toEqual([]);

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

    // First prove that `gh` is the fake, with a harmless argument, before the write is ever made.
    const probe = await realExec('gh', ['airlock-probe'], { input: '' });
    expect(probe.code).toBe(0);
    expect(JSON.parse(await readFile(seenFile, 'utf8'))).toEqual({ args: ['airlock-probe'], input: '', fake: true });

    const result = await sendReview(realExec, REPO, 7, payload);
    expect(result).toEqual({ kind: 'posted', id: 4242, url: `https://github.com/${REPO}/pull/7#pullrequestreview-4242` });
    const seen = JSON.parse(await readFile(seenFile, 'utf8')) as { args: string[]; input: string; fake: boolean };
    expect(seen.fake).toBe(true);
    expect(seen.args).toEqual(['api', '--method', 'POST', `repos/${REPO}/pulls/7/reviews`, '--input', '-']);
    expect(seen.input).toBe(JSON.stringify(payload));
  });
});
