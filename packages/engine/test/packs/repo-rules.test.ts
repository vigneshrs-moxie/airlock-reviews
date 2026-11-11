import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRepoRules } from '../../src/packs/repo-rules.js';

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
});
