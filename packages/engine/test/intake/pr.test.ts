import { describe, expect, it } from 'vitest';
import { detectStage, fetchPr, parsePrRef, type StageRule } from '../../src/intake/pr.js';
import type { Exec } from '../../src/util/exec.js';

describe('parsePrRef', () => {
  it('parses owner/name#12', () => expect(parsePrRef('acme/app#12')).toEqual({ repo: 'acme/app', number: 12 }));
  it('parses a pull URL with a /files suffix', () =>
    expect(parsePrRef('https://github.com/acme/app/pull/12/files')).toEqual({ repo: 'acme/app', number: 12 }));
  it('throws on text that is not a pull request', () => expect(() => parsePrRef('acme/app')).toThrow(/pull request/));
});

describe('detectStage', () => {
  it('maps staging to pr2, main to pr3, anything else to pr1', () => {
    const rules: StageRule[] = [{ base: 'staging', stage: 'pr2' }, { base: 'main', stage: 'pr3' }, { default: true, stage: 'pr1' }];
    expect(detectStage('staging', rules)).toBe('pr2');
    expect(detectStage('main', rules)).toBe('pr3');
    expect(detectStage('feature/x', rules)).toBe('pr1');
    expect(detectStage('main', [])).toBe('other');
  });
});

describe('fetchPr', () => {
  const pull = {
    title: 'T', body: null, additions: 5, deletions: 2, changed_files: 3, html_url: 'https://github.com/acme/app/pull/12',
    user: { login: 'alice' },
    base: { ref: 'staging', sha: 'b'.repeat(40), repo: { full_name: 'acme/app' } },
    head: { ref: 'fix', sha: 'h'.repeat(40), repo: { full_name: 'bob/app' } },
  };
  it('builds PrInfo from gh output and marks a fork', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return args[1] === 'user'
        ? { stdout: 'viewer1\n', stderr: '', code: 0 }
        : { stdout: JSON.stringify(pull), stderr: '', code: 0 };
    };
    const pr = await fetchPr(exec, 'acme/app', 12, [{ base: 'staging', stage: 'pr2' }]);
    expect(pr).toMatchObject({
      repo: 'acme/app', number: 12, title: 'T', body: '', author: 'alice', viewer: 'viewer1',
      baseRef: 'staging', headRef: 'fix', baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40),
      isFork: true, additions: 5, deletions: 2, changedFiles: 3, stage: 'pr2', url: pull.html_url,
    });
    expect(calls).toContainEqual(['gh', 'api', 'repos/acme/app/pulls/12']);
    expect(calls).toContainEqual(['gh', 'api', 'user', '--jq', '.login']);
  });
  it('is not a fork when head and base repos match, and throws when gh fails', async () => {
    const same = { ...pull, head: { ...pull.head, repo: { full_name: 'acme/app' } } };
    const ok: Exec = async (_c, a) => ({ stdout: a[1] === 'user' ? 'v' : JSON.stringify(same), stderr: '', code: 0 });
    expect((await fetchPr(ok, 'acme/app', 12, [])).isFork).toBe(false);
    const bad: Exec = async () => ({ stdout: '', stderr: 'HTTP 404', code: 1 });
    await expect(fetchPr(bad, 'acme/app', 12, [])).rejects.toThrow('HTTP 404');
  });
});
