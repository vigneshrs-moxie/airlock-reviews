import type { FileDiff } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import { runChecks } from '../../src/facts/checks.js';
import type { CheckDef, Pack } from '../../src/packs/types.js';

const file = (path: string, extra: Partial<FileDiff> = {}, added: [number, string][] = []): FileDiff => ({
  path, oldPath: null, status: 'modified', binary: false, additions: added.length, deletions: 0,
  hunks: added.length
    ? [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: added.length, header: '',
      lines: [{ kind: 'ctx', oldNo: 1, newNo: 1, text: 'keep' },
        ...added.map(([n, text]) => ({ kind: 'add' as const, oldNo: null, newNo: n, text }))] }]
    : [],
  ...extra,
});

const pack = (id: string, checks: CheckDef[]): Pack => ({
  id, title: id, version: '1', dir: '/x', repos: [], appRoot: null, stageRules: [],
  tiers: { read: [], trust: [], ignore: [] }, siblings: [], linkRules: [], checks,
  standards: [], lenses: [], rules: [], learned: [],
});

const noHead = async (): Promise<string | null> => null;

describe('runChecks', () => {
  it('added-line-matches reports the new line number of a $queryRawUnsafe call and skips test files', async () => {
    const check: CheckDef = {
      id: 'raw', kind: 'added-line-matches', paths: ['src/**'], exceptPaths: ['**/*.test.ts'],
      pattern: '\\$queryRawUnsafe\\(', message: 'unsafe raw query',
    };
    const files = [
      file('src/db.ts', {}, [[7, 'const a = 1;'], [9, 'await db.$queryRawUnsafe(sql);']]),
      file('src/db.test.ts', {}, [[3, 'db.$queryRawUnsafe(x)']]),
      file('src/gone.ts', { status: 'deleted' }, [[2, 'db.$queryRawUnsafe(x)']]),
      file('lib/other.ts', {}, [[2, 'db.$queryRawUnsafe(x)']]),
    ];
    expect(await runChecks(files, [pack('p', [check])], noHead)).toEqual([
      { checkId: 'raw', path: 'src/db.ts', line: 9, message: 'unsafe raw query' },
    ]);
  });

  it('file-pair reports a migration with no schema.prisma change', async () => {
    const check: CheckDef = {
      id: 'pair', kind: 'file-pair', paths: ['prisma/migrations/**/*.sql'],
      requires: [{ path: 'prisma/schema.prisma' }], message: 'migration without schema change',
    };
    const files = [file('prisma/migrations/2/m.sql'), file('prisma/migrations/1/m.sql'), file('src/a.ts')];
    expect(await runChecks(files, [pack('p', [check])], noHead)).toEqual([
      { checkId: 'pair', path: 'prisma/migrations/1/m.sql', line: null, message: 'migration without schema change' },
      { checkId: 'pair', path: 'prisma/migrations/2/m.sql', line: null, message: 'migration without schema change' },
    ]);
  });

  it('file-pair is silent when schema.prisma also changed', async () => {
    const check: CheckDef = {
      id: 'pair', kind: 'file-pair', paths: ['prisma/migrations/**/*.sql'],
      requires: [{ path: 'prisma/schema.prisma' }], message: 'm',
    };
    const files = [file('prisma/migrations/1/m.sql'), file('prisma/schema.prisma')];
    expect(await runChecks(files, [pack('p', [check])], noHead)).toEqual([]);
  });

  it('file-pair is silent when no matching file changed or the only match is deleted', async () => {
    const check: CheckDef = {
      id: 'pair', kind: 'file-pair', paths: ['prisma/migrations/**/*.sql'],
      requires: [{ path: 'prisma/schema.prisma' }], message: 'm',
    };
    const files = [file('prisma/migrations/1/m.sql', { status: 'deleted' }), file('src/a.ts')];
    expect(await runChecks(files, [pack('p', [check])], noHead)).toEqual([]);
  });

  describe('new-file-requires', () => {
    const check: CheckDef = {
      id: 'cron', kind: 'new-file-requires', paths: ['app/api/cron/*/route.ts'],
      requires: [
        { path: '{self}', pattern: 'maxDuration' },
        { path: 'vercel.json', pattern: '/api/cron/{dir}' },
      ],
      message: 'new cron route is incomplete',
    };

    it('reports a new cron route with no maxDuration and no vercel.json entry', async () => {
      const heads: Record<string, string> = {
        'app/api/cron/sync-x/route.ts': 'export async function GET() {}',
        'vercel.json': '{"crons":[{"path":"/api/cron/other"}]}',
      };
      const out = await runChecks(
        [file('app/api/cron/sync-x/route.ts', { status: 'added' })], [pack('p', [check])],
        async (p) => heads[p] ?? null,
      );
      expect(out).toEqual([
        { checkId: 'cron', path: 'app/api/cron/sync-x/route.ts', line: null,
          message: 'new cron route is incomplete (missing in app/api/cron/sync-x/route.ts)' },
        { checkId: 'cron', path: 'app/api/cron/sync-x/route.ts', line: null,
          message: 'new cron route is incomplete (missing in vercel.json)' },
      ]);
    });

    it('is silent when both are present, treating {dir} literally; reports a missing file', async () => {
      const heads: Record<string, string> = {
        'app/api/cron/a.b/route.ts': 'export const maxDuration = 60;',
        'vercel.json': '{"path":"/api/cron/a.b"}',
      };
      const files = [file('app/api/cron/a.b/route.ts', { status: 'added' })];
      expect(await runChecks(files, [pack('p', [check])], async (p) => heads[p] ?? null)).toEqual([]);
      heads['vercel.json'] = '{"path":"/api/cron/aXb"}';
      expect(await runChecks(files, [pack('p', [check])], async (p) => heads[p] ?? null)).toHaveLength(1);
    });

    it('{parent} is the folder above the new file\'s folder, escaped in a pattern and plain in a path', async () => {
      const nested: CheckDef = {
        id: 'two', kind: 'new-file-requires', paths: ['app/api/**/route.ts'],
        requires: [
          { path: 'vercel.json', pattern: '"/api/{parent}/{dir}"' },
          { path: 'docs/{parent}.md' },
        ],
        message: 'm',
      };
      const heads: Record<string, string> = {
        'vercel.json': '{"path":"/api/calls/warm"}',
        'docs/fleet.v2.md': 'x',
      };
      const read = async (p: string): Promise<string | null> => heads[p] ?? null;
      const run = (path: string) => runChecks([file(path, { status: 'added' })], [pack('p', [nested])], read);
      expect(await run('app/api/fleet.v2/warm/route.ts')).toEqual([
        { checkId: 'two', path: 'app/api/fleet.v2/warm/route.ts', line: null, message: 'm (missing in vercel.json)' },
      ]);
      heads['vercel.json'] = '{"path":"/api/fleetXv2/warm"}';
      expect(await run('app/api/fleet.v2/warm/route.ts')).toHaveLength(1);
      heads['vercel.json'] = '{"path":"/api/fleet.v2/warm"}';
      expect(await run('app/api/fleet.v2/warm/route.ts')).toEqual([]);
    });

    it('{parent} is empty when the new file\'s folder has no folder above it', async () => {
      const top: CheckDef = {
        id: 'top', kind: 'new-file-requires', paths: ['**/route.ts'],
        requires: [{ path: 'index.txt', pattern: '^\\[{parent}\\]$' }], message: 'm',
      };
      const read = async (): Promise<string | null> => '[]';
      expect(await runChecks([file('warm/route.ts', { status: 'added' })], [pack('p', [top])], read)).toEqual([]);
      expect(await runChecks([file('route.ts', { status: 'added' })], [pack('p', [top])], read)).toEqual([]);
      expect(await runChecks([file('a/warm/route.ts', { status: 'added' })], [pack('p', [top])], read)).toHaveLength(1);
    });

    it('ignores modified files and reads each path at most once', async () => {
      const reads: string[] = [];
      const two = [
        file('app/api/cron/a/route.ts', { status: 'added' }), file('app/api/cron/b/route.ts', { status: 'added' }),
        file('app/api/cron/c/route.ts'),
      ];
      const out = await runChecks(two, [pack('p', [check, { ...check, id: 'again' }])], async (p) => {
        reads.push(p);
        return null;
      });
      expect(out).toHaveLength(8);
      expect(new Set(reads).size).toBe(reads.length);
      expect(reads.sort()).toEqual(['app/api/cron/a/route.ts', 'app/api/cron/b/route.ts', 'vercel.json']);
    });
  });

  it('file-touched reports an edit to a guard test', async () => {
    const check: CheckDef = {
      id: 'guard', kind: 'file-touched', paths: ['test/guards/**'], exceptPaths: ['test/guards/helpers.ts'],
      message: 'guard test edited',
    };
    const files = [file('test/guards/no-raw.test.ts'), file('test/guards/helpers.ts'), file('src/a.ts')];
    expect(await runChecks(files, [pack('p', [check])], noHead)).toEqual([
      { checkId: 'guard', path: 'test/guards/no-raw.test.ts', line: null, message: 'guard test edited' },
    ]);
  });

  it('orders facts by pack, check, path, then line', async () => {
    const mk = (id: string): CheckDef => ({ id, kind: 'added-line-matches', paths: ['**'], pattern: 'x', message: id });
    const files = [file('b.ts', {}, [[5, 'x'], [2, 'x']]), file('a.ts', {}, [[9, 'x']])];
    const out = await runChecks(files, [pack('p2', [mk('c1')]), pack('p1', [mk('z'), mk('a')])], noHead);
    expect(out.map((f) => `${f.checkId}:${f.path}:${f.line}`)).toEqual([
      'c1:a.ts:9', 'c1:b.ts:2', 'c1:b.ts:5', 'z:a.ts:9', 'z:b.ts:2', 'z:b.ts:5', 'a:a.ts:9', 'a:b.ts:2', 'a:b.ts:5',
    ]);
  });

  it('matches the new path of a renamed file', async () => {
    const check: CheckDef = { id: 't', kind: 'file-touched', paths: ['new/**'], message: 'm' };
    const files = [file('new/a.ts', { status: 'renamed', oldPath: 'old/a.ts' })];
    expect(await runChecks(files, [pack('p', [check])], noHead)).toHaveLength(1);
  });

  it('throws naming the pack and check when a pattern is not a valid regular expression', async () => {
    const check: CheckDef = { id: 'bad', kind: 'added-line-matches', paths: ['**'], pattern: '(', message: 'm' };
    await expect(runChecks([], [pack('mypack', [check])], noHead)).rejects.toThrow(/mypack.*bad/);
  });
});
