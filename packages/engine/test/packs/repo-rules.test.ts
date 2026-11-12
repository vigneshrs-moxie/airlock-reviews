import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRepoRules, loadRepoRulesAt } from '../../src/packs/repo-rules.js';
import { realExec } from '../../src/util/exec.js';
import { makeTempRepo } from '../helpers/temp-repo.js';

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-rules-'));
  for (const [p, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), text);
  }
  return dir;
}

describe('loadRepoRules', () => {
  it('reads from the base directory: root files first, then nested, deepest first', async () => {
    const dir = await repo({
      'CLAUDE.md': 'root claude', 'AGENTS.md': 'root agents', '.github/copilot-instructions.md': 'copilot',
      'a/AGENTS.md': 'a', 'a/b/CLAUDE.md': 'ab claude', 'a/b/AGENTS.md': 'ab agents', 'z/AGENTS.md': 'z',
    });
    const { rules } = await loadRepoRules(dir, ['a/b/c.ts', 'z/y.ts', 'a/b/d.ts']);
    expect(rules.map((r) => r.path)).toEqual([
      'CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md',
      'a/b/AGENTS.md', 'a/b/CLAUDE.md', 'a/AGENTS.md', 'z/AGENTS.md',
    ]);
    expect(rules[0]!.text).toBe('root claude');
  });

  it('stops at 8 files', async () => {
    const files: Record<string, string> = { 'CLAUDE.md': 'x', 'AGENTS.md': 'x', 'REVIEW.md': 'x', '.cursorrules': 'x' };
    for (const d of ['a', 'a/b', 'a/b/c']) files[`${d}/AGENTS.md`] = 'x';
    for (const d of ['a', 'a/b', 'a/b/c']) files[`${d}/CLAUDE.md`] = 'x';
    const { rules, leftOut } = await loadRepoRules(await repo(files), ['a/b/c/d.ts']);
    expect(rules).toHaveLength(8);
    expect(rules.at(-1)!.path).toBe('a/b/CLAUDE.md');
    expect(leftOut).toEqual([
      { path: 'a/AGENTS.md', reason: 'more than 8 rule files' }, { path: 'a/CLAUDE.md', reason: 'more than 8 rule files' },
    ]);
  });

  it('never goes past 64,000 bytes (UTF-8), and names each file it left out', async () => {
    const dir = await repo({
      'CLAUDE.md': 'é'.repeat(20000), // 40,000 bytes
      'AGENTS.md': 'a'.repeat(24000), // 64,000 total: allowed
      'REVIEW.md': 'b', // would pass the limit
      'a/AGENTS.md': 'c',
    });
    const { rules, leftOut } = await loadRepoRules(dir, ['a/f.ts']);
    expect(rules.map((r) => r.path)).toEqual(['CLAUDE.md', 'AGENTS.md']);
    expect(leftOut).toEqual([
      { path: 'REVIEW.md', reason: 'it would take the rule files past 64,000 bytes' },
      { path: 'a/AGENTS.md', reason: 'it would take the rule files past 64,000 bytes' },
    ]);
  });

  it('skips a root file of 65 KB and still reads the others', async () => {
    const dir = await repo({ 'CLAUDE.md': 'x'.repeat(65_000), 'AGENTS.md': 'small' });
    const { rules, leftOut } = await loadRepoRules(dir, []);
    expect(rules.map((r) => r.path)).toEqual(['AGENTS.md']);
    expect(leftOut).toEqual([{ path: 'CLAUDE.md', reason: 'it would take the rule files past 64,000 bytes' }]);
  });

  it('with a 63 KB CLAUDE.md, skips a 2 KB AGENTS.md and still reads a small REVIEW.md after it', async () => {
    const dir = await repo({ 'CLAUDE.md': 'x'.repeat(63_000), 'AGENTS.md': 'y'.repeat(2_000), 'REVIEW.md': 'z' });
    const { rules, leftOut } = await loadRepoRules(dir, []);
    expect(rules.map((r) => r.path)).toEqual(['CLAUDE.md', 'REVIEW.md']);
    expect(leftOut.map((l) => l.path)).toEqual(['AGENTS.md']);
  });

  it('skips symbolic links that resolve outside the base directory', async () => {
    const outside = await repo({ 'secret.md': 'secret' });
    const dir = await repo({ 'AGENTS.md': 'ok' });
    await symlink(join(outside, 'secret.md'), join(dir, 'CLAUDE.md'));
    await mkdir(join(dir, 'a'));
    await symlink(join(dir, 'AGENTS.md'), join(dir, 'a', 'AGENTS.md')); // inside: kept
    const { rules } = await loadRepoRules(dir, ['a/f.ts']);
    expect(rules.map((r) => r.path)).toEqual(['AGENTS.md', 'a/AGENTS.md']);
  });

  it('skips a nested file reached through a directory symlink that leaves the base directory', async () => {
    const outside = await repo({ 'AGENTS.md': 'outside' });
    const dir = await repo({ 'CLAUDE.md': 'root' });
    await symlink(outside, join(dir, 'a'));
    expect((await loadRepoRules(dir, ['a/f.ts'])).rules.map((r) => r.path)).toEqual(['CLAUDE.md']);
  });

  it('skips a file that cannot be read instead of failing the load', async () => {
    const dir = await repo({ 'CLAUDE.md': 'secret', 'AGENTS.md': 'ok' });
    await chmod(join(dir, 'CLAUDE.md'), 0o000);
    expect((await loadRepoRules(dir, [])).rules.map((r) => r.path)).toEqual(['AGENTS.md']);
  });

  it('reads a rule file that the base checkout holds as a link (a small file naming its target) from the target inside the repository', async () => {
    const r = await makeTempRepo();
    try {
      await r.write('docs/rules.md', 'THE REAL RULES');
      await symlink('docs/rules.md', join(r.dir, 'CLAUDE.md'));
      await symlink('../outside.md', join(r.dir, 'AGENTS.md'));
      await r.commit('links');
      // The base worktree is checked out with core.symlinks=false: each link is a small file holding its target.
      for (const [link, target] of [['CLAUDE.md', 'docs/rules.md'], ['AGENTS.md', '../outside.md']] as const) {
        await rm(join(r.dir, link));
        await writeFile(join(r.dir, link), target);
      }
      const { rules, leftOut } = await loadRepoRules(r.dir, [], realExec);
      expect(rules).toEqual([{ path: 'CLAUDE.md', text: 'THE REAL RULES' }]);
      expect(leftOut).toEqual([]);
    } finally {
      await rm(r.dir, { recursive: true, force: true });
    }
  });
});

describe('loadRepoRulesAt', () => {
  it('reads the rule files of one commit from the git folder, not of a later one, in the same order and with the same limits', async () => {
    const r = await makeTempRepo();
    try {
      await r.write('CLAUDE.md', 'BASE CLAUDE');
      await r.write('a/b/AGENTS.md', 'BASE NESTED');
      await r.write('docs/rules.md', 'RULES THROUGH A LINK');
      await symlink('docs/rules.md', join(r.dir, 'AGENTS.md'));
      await symlink('../outside.md', join(r.dir, 'REVIEW.md'));
      await r.write('src/x.ts', 'x');
      const base = await r.commit('base');
      await r.write('CLAUDE.md', 'LATER CLAUDE');
      await r.write('.cursorrules', 'LATER CURSOR');
      await r.commit('later');
      const gitDir = join(r.dir, '.git');
      const { rules, leftOut } = await loadRepoRulesAt(realExec, gitDir, base, ['a/b/c.ts']);
      expect(rules).toEqual([
        { path: 'CLAUDE.md', text: 'BASE CLAUDE' }, { path: 'AGENTS.md', text: 'RULES THROUGH A LINK' },
        { path: 'a/b/AGENTS.md', text: 'BASE NESTED' },
      ]);
      expect(leftOut).toEqual([]);
      // The size limit is the same as for a checkout.
      await r.write('CLAUDE.md', 'x'.repeat(64_001));
      const big = await r.commit('big');
      const capped = await loadRepoRulesAt(realExec, gitDir, big, []);
      expect(capped.rules.map((x) => x.path)).toEqual(['AGENTS.md', '.cursorrules']);
      expect(capped.leftOut).toEqual([{ path: 'CLAUDE.md', reason: 'it would take the rule files past 64,000 bytes' }]);
      // Only a full commit id is given to git.
      await expect(loadRepoRulesAt(realExec, gitDir, '--output=x', [])).rejects.toThrow('is not a full commit id');
    } finally {
      await rm(r.dir, { recursive: true, force: true });
    }
  });

  it('finds rule files whose names are in another letter case, as a first review reads them from a checkout', async () => {
    const r = await makeTempRepo();
    try {
      await r.write('Claude.md', 'MIXED CLAUDE');
      await r.write('agents.md', 'LOWER AGENTS');
      await r.write('.GitHub/Copilot-Instructions.md', 'COPILOT');
      await r.write('a/b/claude.md', 'NESTED');
      await r.write('a/b/c.ts', 'x');
      const commit = await r.commit('rules in another case');
      const got = await loadRepoRulesAt(realExec, join(r.dir, '.git'), commit, ['a/b/c.ts']);
      expect(got).toEqual({
        rules: [
          { path: 'CLAUDE.md', text: 'MIXED CLAUDE' }, { path: 'AGENTS.md', text: 'LOWER AGENTS' },
          { path: '.github/copilot-instructions.md', text: 'COPILOT' }, { path: 'a/b/CLAUDE.md', text: 'NESTED' },
        ],
        leftOut: [],
      });
      // On a disk that ignores letter case (this Mac's), a first review reads the same files from the checkout.
      if (await stat(join(r.dir, 'CLAUDE.md')).then(() => true, () => false)) {
        expect(await loadRepoRules(r.dir, ['a/b/c.ts'], realExec)).toEqual(got);
      }
    } finally {
      await rm(r.dir, { recursive: true, force: true });
    }
  });

  it('of two names that differ only by case, reads the engine\'s own spelling, else the first in the tree', async () => {
    const r = await makeTempRepo();
    try {
      // Built with git's own commands, since a disk that ignores case cannot hold both names.
      const gitDir = join(r.dir, '.git');
      const blob = async (text: string): Promise<string> =>
        (await realExec('git', ['--git-dir', gitDir, 'hash-object', '-w', '--stdin'], { input: text })).stdout.trim();
      const entries = [
        ['Claude.md', 'MIXED CLAUDE'], ['CLAUDE.md', 'UPPER CLAUDE'], ['claude.md', 'LOWER CLAUDE'],
        ['agents.md', 'LOWER AGENTS'], ['Agents.md', 'MIXED AGENTS'],
      ];
      const lines = await Promise.all(entries.map(async ([name, text]) => `100644 blob ${await blob(text!)}\t${name}\n`));
      const tree = (await realExec('git', ['--git-dir', gitDir, 'mktree'], { input: lines.join('') })).stdout.trim();
      const commit = (await realExec('git', ['--git-dir', gitDir, 'commit-tree', '-m', 'both', tree], {
        env: { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@airlock.invalid', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@airlock.invalid' },
      })).stdout.trim();
      const { rules } = await loadRepoRulesAt(realExec, gitDir, commit, []);
      expect(rules).toEqual([{ path: 'CLAUDE.md', text: 'UPPER CLAUDE' }, { path: 'AGENTS.md', text: 'MIXED AGENTS' }]);
    } finally {
      await rm(r.dir, { recursive: true, force: true });
    }
  });
});
