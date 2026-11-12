import { afterEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_EXEC_TIMEOUT_MS, GH_WRITE_REFUSED, ghCallRefused, isGhCommand, isGhRead, must, realExec } from '../../src/util/exec.js';
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
  it('merges a given env over the process environment, and GIT_TERMINAL_PROMPT stays 0', async () => {
    const script = 'process.stdout.write([process.env.AIRLOCK_EXEC_TEST, process.env.PATH ? "path" : "", process.env.GIT_TERMINAL_PROMPT].join(","))';
    const r = await realExec('node', ['-e', script], { env: { AIRLOCK_EXEC_TEST: 'given', GIT_TERMINAL_PROMPT: '1' } });
    expect(r.stdout).toBe('given,path,0');
    const without = await realExec('node', ['-e', 'process.stdout.write(String(process.env.AIRLOCK_EXEC_TEST))']);
    expect(without.stdout).toBe('undefined');
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
    // Grouped short flags: gh reads -iXPOST as --include with --method POST, and -ifbody=x as --include with a field.
    ['api', 'repos/a/b', '-iXPOST'], ['api', 'repos/a/b', '-iX', 'DELETE'], ['api', 'repos/a/b', '-ifbody=x'],
    ['api', 'repos/a/b', '-if', 'body=x'], ['api', 'repos/a/b', '-iF', 'k=1'], ['api', '-iXPOST', 'repos/a/b'],
    // Only the exact spellings the code uses, each value as the next argument; nothing unknown.
    ['api', 'repos/a/b', '--method=POST'], ['api', 'user', '--jq=.x'], ['api', '-Hx', 'repos/a/b'], ['api', 'repos/a/b', '-i'],
    ['api', 'repos/a/b', '--include'], ['api', 'repos/a/b', '-q', '.x'], ['api', 'repos/a/b', '--jq'], ['api', 'repos/a/b', '-H'],
    ['api', 'repos/a/b', 'repos/c/d'], ['api', 'repos/a/b', '--paginate=true'], ['api'], ['api', '--jq', '.x'],
    // The GraphQL endpoint, however it is written.
    ['api', '/GraphQL'], ['api', 'GRAPHQL'], ['api', '//graphql'], ['api', 'graphql', '--jq', '.data'],
    ['auth', 'status', '--show-token'], ['auth', 'status', '-t'],
  ];
  // Every gh call the packages make today, and the shapes the allowed flags permit.
  const reads: string[][] = [
    ['api', 'repos/a/b/pulls/1'], ['api', 'user', '--jq', '.login'], ['api', 'repos/k/r/commits/main', '--jq', '.sha'],
    ['api', '-H', 'Accept: application/vnd.github.raw', 'repos/a/b/contents/x?ref=main'], ['auth', 'status'],
    ['api', 'repos/a/b/pulls', '--paginate', '--header', 'Accept: x', '--jq', '.[].number'],
    // A value is never read as a flag: this is --jq with the expression -X, and gh reads it that way.
    ['api', 'repos/a/b', '--jq', '-X'], ['api', '-H', '-fake: x', 'repos/a/b'],
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

  it('judges any command whose base name is gh, in any letter case, with or without .exe', async () => {
    for (const cmd of ['gh', 'GH', 'Gh', 'gh.exe', 'GH.EXE', '/opt/homebrew/bin/gh', '/usr/local/bin/GH', 'C:\\Program Files\\GitHub CLI\\gh.exe']) {
      expect(isGhCommand(cmd), cmd).toBe(true);
    }
    for (const cmd of ['git', 'ghq', 'node', '/opt/homebrew/bin/ghx', 'sigh']) expect(isGhCommand(cmd), cmd).toBe(false);
    // Judged without running anything: these names would be the real gh.
    expect(ghCallRefused('GH', ['api', 'repos/a/b', '-X', 'POST'], {})).toBe(true);
    expect(ghCallRefused('/opt/homebrew/bin/gh', ['pr', 'merge', '7'], {})).toBe(true);
    expect(ghCallRefused('/opt/homebrew/bin/gh', ['api', 'repos/a/b/pulls/1'], {})).toBe(false);
    expect(ghCallRefused('git', ['push', '-f'], {})).toBe(false);
    // And through realExec, with names that do not exist.
    for (const name of ['GH', 'gh.EXE']) {
      await expect(realExec(join(tmpdir(), 'airlock-no-such-folder-9f3c', name), ['pr', 'merge', '7'])).rejects.toThrow(GH_WRITE_REFUSED);
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
