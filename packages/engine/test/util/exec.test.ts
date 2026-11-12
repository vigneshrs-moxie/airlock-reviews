import { afterEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_EXEC_TIMEOUT_MS, GH_WRITE_REFUSED, isGhRead, must, realExec } from '../../src/util/exec.js';
import { airlockHome, repoSlug } from '../../src/util/paths.js';

describe('must', () => {
  it('returns stdout on code 0', () => expect(must({ stdout: 'ok', stderr: '', code: 0 }, 'x')).toBe('ok'));
  it('throws with the stderr text on a non-zero code', () =>
    expect(() => must({ stdout: '', stderr: 'nope', code: 1 }, 'git fetch')).toThrow('git fetch: nope'));
});

describe('realExec', () => {
  it('captures stdout and exit code 0', async () => {
    const r = await realExec('node', ['-e', 'process.stdout.write("hi")']);
    expect(r).toEqual({ stdout: 'hi', stderr: '', code: 0 });
  });
  it('returns a non-zero code without rejecting', async () => {
    const r = await realExec('node', ['-e', 'console.error("bad"); process.exit(3)']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('bad');
  });
  it('feeds input to stdin', async () => {
    const r = await realExec('node', ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'abc' });
    expect(r.stdout).toBe('abc');
  });
  it('does not use a shell', async () => {
    const r = await realExec('node', ['-e', 'process.stdout.write(process.argv[1])', '$(echo hi); x']);
    expect(r.stdout).toBe('$(echo hi); x');
  });
  it('rejects when the command cannot start', async () => {
    await expect(realExec('definitely-not-a-command-xyz', [])).rejects.toThrow();
  });
  it('kills a command at its timeout and reports exit 124, never an answer like exit 1', async () => {
    const started = Date.now();
    const r = await realExec('sleep', ['5'], { timeoutMs: 200 });
    expect(r).toEqual({ stdout: '', stderr: 'timed out after 0.2 s', code: 124 });
    expect(Date.now() - started).toBeLessThan(4000);
  });
  it('has a default timeout of 60 s and gives the child GIT_TERMINAL_PROMPT=0', async () => {
    expect(DEFAULT_EXEC_TIMEOUT_MS).toBe(60_000);
    const r = await realExec('node', ['-e', 'process.stdout.write(String(process.env.GIT_TERMINAL_PROMPT))']);
    expect(r.stdout).toBe('0');
  });
  it('rejects with The command was stopped. when its signal aborts', async () => {
    const ac = new AbortController();
    const running = realExec('sleep', ['5'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(running).rejects.toThrow('The command was stopped.');
  });
});

describe('realExec and gh', () => {
  // A gh that does not exist: had the guard let a call through, it would fail to start (ENOENT), not with the guard's
  // sentence, and it can never be the real gh.
  const NO_GH = join(tmpdir(), 'airlock-no-such-folder-9f3c', 'gh');
  const refused: string[][] = [
    ['pr', 'review', '7', '--approve'], ['pr', 'review', '7', '--request-changes', '--body', 'x'], ['pr', 'comment', '7', '--body', 'x'],
    ['pr', 'merge', '7', '--squash'], ['pr', 'close', '7'], ['pr', 'edit', '7', '--add-label', 'x'], ['issue', 'comment', '7', '-b', 'x'],
    ['repo', 'delete', 'a/b'], ['release', 'create', 'v1'], ['workflow', 'run', 'x'], ['label', 'create', 'x'], ['gist', 'create', 'f'],
    ['secret', 'set', 'X'], ['auth', 'login'], ['auth', 'logout'], ['auth'], [],
    ['api', '-X', 'POST', 'repos/a/b/pulls/1/reviews'], ['api', '-XDELETE', 'repos/a/b'], ['api', '--method', 'PATCH', 'repos/a/b'],
    ['api', '--method=PUT', 'repos/a/b/pulls/1/merge'], ['api', 'repos/a/b/issues/1/comments', '-f', 'body=x'],
    ['api', 'repos/a/b/issues/1/comments', '-fbody=x'], ['api', 'repos/a/b/issues/1/labels', '-F', 'labels[]=x'],
    ['api', 'repos/a/b/issues/1/comments', '--field', 'body=x'], ['api', 'repos/a/b/issues/1/comments', '--raw-field', 'body=x'],
    ['api', 'repos/a/b/pulls/1/reviews', '--input', '-'], ['api', 'repos/a/b/pulls/1/reviews', '--input=body.json'],
    ['api', 'graphql'], ['api', 'graphql', '-f', 'query=mutation { x }'],
  ];
  const reads: string[][] = [
    ['api', 'repos/a/b/pulls/1'], ['api', 'user', '--jq', '.login'], ['api', '-H', 'Accept: application/vnd.github.raw', 'repos/a/b/contents/x?ref=main'],
    ['auth', 'status'],
  ];

  it('refuses every gh call that is not a read, before anything is started', async () => {
    for (const args of refused) {
      expect(isGhRead(args), args.join(' ')).toBe(false);
      await expect(realExec(NO_GH, args), args.join(' ')).rejects.toThrow(GH_WRITE_REFUSED);
    }
    expect(GH_WRITE_REFUSED).toBe('Airlock does not let this command write to GitHub.');
  });

  it('lets a read through', async () => {
    for (const args of reads) {
      expect(isGhRead(args), args.join(' ')).toBe(true);
      await expect(realExec(NO_GH, args), args.join(' ')).rejects.toThrow(/ENOENT/);
    }
  });

  it('lets the one write through only when the caller says so', async () => {
    const write = ['api', '--method', 'POST', 'repos/a/b/pulls/1/reviews', '--input', '-'];
    await expect(realExec(NO_GH, write, { input: '{}' })).rejects.toThrow(GH_WRITE_REFUSED);
    await expect(realExec(NO_GH, write, { input: '{}', allowGhWrite: false })).rejects.toThrow(GH_WRITE_REFUSED);
    await expect(realExec(NO_GH, write, { input: '{}', allowGhWrite: true })).rejects.toThrow(/ENOENT/);
  });

  it('leaves other commands alone, whatever their arguments', async () => {
    const r = await realExec('node', ['-e', 'process.stdout.write(process.argv.slice(1).join(" "))', '--', '-f', '--method', 'pr']);
    expect(r.stdout).toBe('-f --method pr');
  });
});

describe('paths', () => {
  const saved = process.env.AIRLOCK_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.AIRLOCK_HOME;
    else process.env.AIRLOCK_HOME = saved;
  });
  it('uses AIRLOCK_HOME when set', () => {
    process.env.AIRLOCK_HOME = '/tmp/al';
    expect(airlockHome()).toBe('/tmp/al');
    delete process.env.AIRLOCK_HOME;
    expect(airlockHome()).toMatch(/\.airlock$/);
  });
  it('treats an empty AIRLOCK_HOME as unset', () => {
    process.env.AIRLOCK_HOME = '';
    expect(airlockHome()).toMatch(/\.airlock$/);
  });
  it('slugs a repo', () => expect(repoSlug('acme/app')).toBe('acme__app'));
});
