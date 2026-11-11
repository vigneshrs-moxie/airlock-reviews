import type { FileDiff } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import { classifyFiles } from '../../src/facts/classify.js';
import type { Pack } from '../../src/packs/types.js';

const file = (path: string, extra: Partial<FileDiff> = {}): FileDiff => ({
  path, oldPath: null, status: 'modified', binary: false, additions: 1, deletions: 0, hunks: [], ...extra,
});

const pack = (id: string, tiers: Partial<Pack['tiers']> = {}): Pack => ({
  id, title: id, version: '1', dir: '/x', repos: [], appRoot: null, stageRules: [],
  tiers: { read: [], trust: [], ignore: [], ...tiers }, siblings: [], linkRules: [], checks: [],
  standards: [], lenses: [], rules: [], learned: [],
});

describe('classifyFiles', () => {
  const p = pack('web', { read: ['prisma/migrations/**'], trust: ['docs/**'], ignore: ['vendor/**'] });

  it('a lock file is ignored, a migration is read, a test is trust, the rest skim', () => {
    const out = classifyFiles(
      [file('package-lock.json'), file('prisma/migrations/1/migration.sql'), file('src/a.test.ts'), file('src/a.ts')],
      [p],
    );
    expect(out.map((f) => [f.path, f.tier])).toEqual([
      ['package-lock.json', 'ignored'], ['prisma/migrations/1/migration.sql', 'read'],
      ['src/a.test.ts', 'trust'], ['src/a.ts', 'skim'],
    ]);
  });

  it('the reason names the matching glob', () => {
    const out = classifyFiles(
      [file('package-lock.json'), file('vendor/x.js'), file('prisma/migrations/1/m.sql'), file('docs/a.md'),
        file('src/a.spec.ts'), file('img.png', { binary: true }), file('src/a.ts')],
      [p],
    );
    expect(out.map((f) => f.reason)).toEqual([
      'lock file (built-in: **/package-lock.json)', 'web: vendor/**', 'web: prisma/migrations/**', 'web: docs/**',
      'built-in: **/*.spec.*', 'binary file', 'default',
    ]);
  });

  it('ignore beats read, read beats trust, and dotfiles and renames use the new path', () => {
    const q = pack('q', { read: ['**/*.test.ts', '.github/**'], ignore: ['src/gen/**'] });
    const out = classifyFiles(
      [file('src/gen/a.test.ts'), file('src/a.test.ts'), file('.github/ci.yml'),
        file('src/new.ts', { status: 'renamed', oldPath: 'dist/old.ts' }), file('src/gone.ts', { status: 'deleted' })],
      [q],
    );
    expect(out.map((f) => [f.tier, f.reason])).toEqual([
      ['ignored', 'q: src/gen/**'], ['read', 'q: **/*.test.ts'], ['read', 'q: .github/**'],
      ['skim', 'default'], ['skim', 'default'],
    ]);
  });

  it('the first pack that matches supplies the reason', () => {
    const out = classifyFiles([file('a/b.ts')], [pack('one', { read: ['a/**'] }), pack('two', { read: ['**/*.ts'] })]);
    expect(out[0]).toEqual({ path: 'a/b.ts', tier: 'read', reason: 'one: a/**' });
  });

  it('a symbolic link is trusted, never read or swept as code', () => {
    const out = classifyFiles([file('src/link.ts', { mode: '120000' }), file('dist/link.js', { mode: '120000' })], [pack('p')]);
    expect(out).toEqual([
      { path: 'src/link.ts', tier: 'trust', reason: 'symbolic link' },
      { path: 'dist/link.js', tier: 'ignored', reason: 'build output (built-in: **/dist/**)' },
    ]);
  });
});
