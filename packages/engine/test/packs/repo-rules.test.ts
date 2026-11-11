import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
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
    const rules = await loadRepoRules(dir, ['a/b/c.ts', 'z/y.ts', 'a/b/d.ts']);
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
    const rules = await loadRepoRules(await repo(files), ['a/b/c/d.ts']);
    expect(rules).toHaveLength(8);
    expect(rules.at(-1)!.path).toBe('a/b/CLAUDE.md');
  });

  it('stops before exceeding 64,000 bytes (UTF-8)', async () => {
    const dir = await repo({
      'CLAUDE.md': 'é'.repeat(20000), // 40,000 bytes
      'AGENTS.md': 'a'.repeat(24000), // 64,000 total: allowed
      'REVIEW.md': 'b', // would pass the limit
      'a/AGENTS.md': 'c',
    });
    const rules = await loadRepoRules(dir, ['a/f.ts']);
    expect(rules.map((r) => r.path)).toEqual(['CLAUDE.md', 'AGENTS.md']);
  });

  it('skips symbolic links that resolve outside the base directory', async () => {
    const outside = await repo({ 'secret.md': 'secret' });
    const dir = await repo({ 'AGENTS.md': 'ok' });
    await symlink(join(outside, 'secret.md'), join(dir, 'CLAUDE.md'));
    await mkdir(join(dir, 'a'));
    await symlink(join(dir, 'AGENTS.md'), join(dir, 'a', 'AGENTS.md')); // inside: kept
    const rules = await loadRepoRules(dir, ['a/f.ts']);
    expect(rules.map((r) => r.path)).toEqual(['AGENTS.md', 'a/AGENTS.md']);
  });
});
