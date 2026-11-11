import { afterEach, describe, expect, it } from 'vitest';
import { must, realExec } from '../../src/util/exec.js';
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
  it('slugs a repo', () => expect(repoSlug('acme/app')).toBe('acme__app'));
});
