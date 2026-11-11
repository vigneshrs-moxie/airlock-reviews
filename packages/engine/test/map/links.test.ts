import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileDiff, Link } from '@airlock/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { findLinks } from '../../src/map/links.js';
import type { LinkRule, Pack } from '../../src/packs/types.js';
import { realExec } from '../../src/util/exec.js';
import { commitFiles, diffOf, makeChange } from '../helpers/change-repo.js';
import { makeTempRepo, type TempRepo } from '../helpers/temp-repo.js';

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await rm(r.dir, { recursive: true, force: true });
});
async function newRepo(): Promise<TempRepo> {
  const r = await makeTempRepo();
  repos.push(r);
  return r;
}

const pack = (id: string, extra: Partial<Pack> = {}): Pack => ({
  id, title: id, version: '1', dir: '/x', repos: [], appRoot: null, stageRules: [],
  tiers: { read: [], trust: [], ignore: [] }, siblings: [], linkRules: [], checks: [],
  standards: [], lenses: [], rules: [], learned: [], ...extra,
});

const ofKind = (links: Link[], kind: Link['kind']): Link[] => links.filter((l) => l.kind === kind);

describe('findLinks', () => {
  it('links a changed page to the changed action it imports', async () => {
    const r = await newRepo();
    const files = await makeChange(r, {
      'app/swaps/page.tsx': "import { approveSwap } from './actions';\nexport default function Page() { return approveSwap; }\n",
      'app/swaps/actions.ts': 'export function approveSwap() { return 1; }\n',
    }, {
      'app/swaps/page.tsx': "import { approveSwap } from './actions';\nexport default function Page() { return approveSwap(); }\n",
      'app/swaps/actions.ts': 'export function approveSwap() { return 2; }\n',
    });
    const { links } = await findLinks(realExec, r.dir, files, []);
    expect(ofKind(links, 'imports')).toEqual([
      { from: 'app/swaps/page.tsx', to: 'app/swaps/actions.ts', kind: 'imports', detail: './actions', line: 1 },
    ]);
    expect(ofKind(links, 'uses')).toEqual([
      { from: 'app/swaps/page.tsx', to: 'app/swaps/actions.ts', kind: 'uses', detail: 'approveSwap', line: 1 },
      { from: 'app/swaps/page.tsx', to: 'app/swaps/actions.ts', kind: 'uses', detail: 'approveSwap', line: 2 },
    ]);
  });

  it('ignores a uses hit in a TypeScript file that does not import the defining file', async () => {
    const r = await newRepo();
    const files = await makeChange(r, {
      'src/swaps.ts': 'export function approveSwap() { return 1; }\n',
      'src/caller.ts': "import { approveSwap } from './swaps.js';\napproveSwap();\n",
      'src/other.ts': '// approveSwap lives elsewhere\nexport function approveSwapLater() {}\n',
      'docs/notes.md': 'Call approveSwap first.\n',
    }, { 'src/swaps.ts': 'export function approveSwap() { return 2; }\n' });
    const { links } = await findLinks(realExec, r.dir, files, []);
    expect(ofKind(links, 'uses')).toEqual([
      { from: 'docs/notes.md', to: 'src/swaps.ts', kind: 'uses', detail: 'approveSwap', line: 1 },
      { from: 'src/caller.ts', to: 'src/swaps.ts', kind: 'uses', detail: 'approveSwap', line: 1 },
      { from: 'src/caller.ts', to: 'src/swaps.ts', kind: 'uses', detail: 'approveSwap', line: 2 },
    ]);
  });

  it('does not search names on the stop list or shorter than 4 characters', async () => {
    const r = await newRepo();
    const files = await makeChange(r, {
      'app/api/route.ts': 'export const config = 1;\nexport function GET() {}\nexport const run = 2;\n',
      'app/use.ts': "import { config, GET, run } from './api/route';\nconsole.log(config, GET, run);\n",
    }, { 'app/api/route.ts': 'export const config = 2;\nexport function GET() { return 1; }\nexport const run = 3;\n' });
    const { links } = await findLinks(realExec, r.dir, files, []);
    expect(ofKind(links, 'uses')).toEqual([]);
  });

  it('a repository with only Python files yields uses-links by name and no error', async () => {
    const r = await newRepo();
    const files = await makeChange(r, {
      'billing/app.py': 'def other():\n    return 1\n',
      'billing/report.py': 'from app import compute_total\n\nprint(compute_total([]))\n',
    }, { 'billing/app.py': 'def other():\n    return 1\n\ndef compute_total(items):\n    return sum(items)\n' });
    const { links } = await findLinks(realExec, r.dir, files, []);
    expect(links).toEqual([
      { from: 'billing/report.py', to: 'billing/app.py', kind: 'uses', detail: 'compute_total', line: 1 },
      { from: 'billing/report.py', to: 'billing/app.py', kind: 'uses', detail: 'compute_total', line: 3 },
    ]);
  });

  it('links changed test files to their subjects, including a mirrored test/ folder', async () => {
    const r = await newRepo();
    const files = await makeChange(r, {
      'packages/engine/src/map/links.ts': 'export const x = 1;\n',
      'lib/sum.ts': 'export const y = 1;\n',
      'lib/calc.ts': 'export const z = 1;\n',
      'lib/lonely.ts': 'export const w = 1;\n',
    }, {
      'packages/engine/test/map/links.test.ts': "it('a', () => {});\n",
      'lib/sum.spec.ts': "it('b', () => {});\n",
      'lib/__tests__/calc.ts': "it('c', () => {});\n",
      'lib/other/nothing.dbtest.ts': "it('d', () => {});\n",
    });
    const { links } = await findLinks(realExec, r.dir, files, []);
    expect(ofKind(links, 'tests').map((l) => [l.from, l.to])).toEqual([
      ['lib/__tests__/calc.ts', 'lib/calc.ts'],
      ['lib/sum.spec.ts', 'lib/sum.ts'],
      ['packages/engine/test/map/links.test.ts', 'packages/engine/src/map/links.ts'],
    ]);
  });

  it('a convention rule links a migration that creates shift_swaps to the file that mentions shiftSwap', async () => {
    const r = await newRepo();
    const rule: LinkRule = {
      id: 'table-to-model', from: 'prisma/migrations/**/*.sql', capture: 'CREATE TABLE "(\\w+?)s"',
      transform: 'camel', searchIn: ['src/**/*.ts'], detail: 'table used in code',
    };
    const files = await makeChange(r, {
      'src/swaps/service.ts': 'export async function list() {\n  return prisma.shiftSwap.findMany();\n}\n',
      'scripts/seed.ts': 'await prisma.shiftSwap.create({});\n',
    }, { 'prisma/migrations/20261101_swaps/migration.sql': 'CREATE TABLE "shift_swaps" (id int);\n' });
    const { links } = await findLinks(realExec, r.dir, files, [pack('next', { linkRules: [rule] })]);
    expect(links).toEqual([{
      from: 'prisma/migrations/20261101_swaps/migration.sql', to: 'src/swaps/service.ts', kind: 'convention',
      detail: 'table used in code: shiftSwap', line: 2,
    }]);
  });

  it('a pascal convention rule turns snake case into a type name', async () => {
    const r = await newRepo();
    const rule: LinkRule = {
      id: 'model', from: '**/*.sql', capture: 'CREATE TABLE (\\w+)', transform: 'pascal', searchIn: ['**/*.ts'], detail: 'model',
    };
    const files = await makeChange(r, { 'types.ts': 'export type ShiftSwaps = {};\n' }, { 'db/1.sql': 'CREATE TABLE shift_swaps ();\n' });
    const { links } = await findLinks(realExec, r.dir, files, [pack('p', { linkRules: [rule] })]);
    expect(links).toEqual([{ from: 'db/1.sql', to: 'types.ts', kind: 'convention', detail: 'model: ShiftSwaps', line: 1 }]);
  });

  it('throws naming the pack, the rule and the failed step for a bad capture or from glob', async () => {
    const r = await newRepo();
    const files = await makeChange(r, { 'a.txt': 'a\n' }, { 'a.txt': 'b\n' });
    const badCapture: LinkRule = { id: 'broken', from: '**', capture: '(', transform: 'none', searchIn: ['**'], detail: 'd' };
    await expect(findLinks(realExec, r.dir, files, [pack('mypack', { linkRules: [badCapture] })]))
      .rejects.toThrow(/pack "mypack" link rule "broken": invalid capture/);
    const badFrom: LinkRule = { id: 'noglob', from: '', capture: '(x)', transform: 'none', searchIn: ['**'], detail: 'd' };
    await expect(findLinks(realExec, r.dir, files, [pack('mypack', { linkRules: [badFrom] })]))
      .rejects.toThrow(/pack "mypack" link rule "noglob": invalid from glob/);
  });

  it('reads a tracked symbolic link to a file outside the repository as empty', async () => {
    const r = await newRepo();
    const outside = await mkdtemp(join(tmpdir(), 'airlock-outside-'));
    try {
      await writeFile(join(outside, 'evil.ts'), "import './caller';\nexport function stealSecret() {}\n");
      await commitFiles(r, { 'src/caller.ts': "import { stealSecret } from './evil';\nstealSecret();\n" }, 'base');
      const baseSha = await r.git('rev-parse', 'HEAD');
      await symlink(join(outside, 'evil.ts'), join(r.dir, 'src/evil.ts'));
      const headSha = await commitFiles(r, {}, 'link');
      const files = await diffOf(r, baseSha, headSha);
      expect(files.map((f) => [f.path, f.status])).toEqual([['src/evil.ts', 'added']]);
      expect(await findLinks(realExec, r.dir, files, [])).toEqual({ links: [], skippedNames: 0, limits: [] });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('writes down a searched name that has more than 40 places, and links only the first 40', async () => {
    const r = await newRepo();
    const users: Record<string, string> = {};
    for (let i = 0; i < 45; i++) users[`src/u${String(i).padStart(2, '0')}.ts`] = "import { widelyUsed } from './w';\nwidelyUsed();\n";
    const files = await makeChange(r, { 'src/w.ts': 'export const widelyUsed = () => 1;\n', ...users }, {
      'src/w.ts': 'export const widelyUsed = () => 2;\n',
    });
    const { links, limits } = await findLinks(realExec, r.dir, files, []);
    expect(ofKind(links, 'uses')).toHaveLength(40);
    expect(limits).toEqual(['links: "widelyUsed" was found on 90 lines; only the first 40 places in path order were linked']);
  }, 60_000);

  it('a deleted file produces no links, even when its subject and callers still exist', async () => {
    const r = await newRepo();
    const files = await makeChange(r, {
      'src/old.ts': "import { keep } from './keep.js';\nexport function retireOld() { return keep; }\n",
      'src/keep.ts': 'export const keep = 1;\n',
      'src/user.ts': "import { retireOld } from './old.js';\nretireOld();\n",
      'src/keep.test.ts': "import { keep } from './keep.js';\n",
      'billing/app.py': 'def compute_total(items):\n    return sum(items)\n',
      'billing/report.py': 'from app import compute_total\n',
    }, { 'src/old.ts': null, 'src/keep.test.ts': null, 'billing/app.py': null });
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['billing/app.py', 'deleted'], ['src/keep.test.ts', 'deleted'], ['src/old.ts', 'deleted'],
    ]);
    expect(await findLinks(realExec, r.dir, files, [])).toEqual({ links: [], skippedNames: 0, limits: [] });
  });

  it('a deleted file marked with added lines still produces no links', async () => {
    const r = await newRepo();
    await commitFiles(r, { 'billing/report.py': 'from app import compute_total\n' }, 'base');
    const gone: FileDiff = {
      path: 'billing/app.py', oldPath: null, status: 'deleted', binary: false, additions: 1, deletions: 0,
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, header: '',
        lines: [{ kind: 'add', oldNo: null, newNo: 1, text: 'def compute_total(items):' }] }],
    };
    expect(await findLinks(realExec, r.dir, [gone], [])).toEqual({ links: [], skippedNames: 0, limits: [] });
  });

  it('applies the import filter before the 40-hit cap', async () => {
    const r = await newRepo();
    const base: Record<string, string> = {
      'src/swaps.ts': 'export function approveSwap() { return 1; }\n',
      'src/caller.ts': "import { approveSwap } from './swaps.js';\napproveSwap();\n",
    };
    for (let i = 10; i < 55; i++) base[`aaa/n${i}.ts`] = 'export const approveSwap = 0;\n';
    const files = await makeChange(r, base, { 'src/swaps.ts': 'export function approveSwap() { return 2; }\n' });
    const { links } = await findLinks(realExec, r.dir, files, []);
    expect(ofKind(links, 'uses').map((l) => [l.from, l.line])).toEqual([['src/caller.ts', 1], ['src/caller.ts', 2]]);
  });

  it('searches at most 600 names, added files first, then files with the fewest names', async () => {
    const r = await newRepo();
    const names = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`);
    const exportsOf = (list: string[], v: number): string => list.map((n) => `export const ${n} = ${v};\n`).join('');
    const fresh = names('freshName', 590);
    const small = names('smallName', 2);
    const mid = names('midName', 10);
    const barrel = names('barrelName', 80);
    const user = [
      "import './a-barrel.js';", "import './fresh.js';", "import './mid.js';", "import './small.js';",
      ...[...fresh, ...small, ...mid, ...barrel].map((n) => `// ${n}`),
    ].join('\n');
    const files = await makeChange(r, {
      'src/a-barrel.ts': exportsOf(barrel, 1), 'src/mid.ts': exportsOf(mid, 1), 'src/small.ts': exportsOf(small, 1),
      'src/use.ts': `${user}\n`,
    }, {
      'src/a-barrel.ts': exportsOf(barrel, 2), 'src/mid.ts': exportsOf(mid, 2), 'src/small.ts': exportsOf(small, 2),
      'src/fresh.ts': exportsOf(fresh, 1),
    });
    const { links, skippedNames } = await findLinks(realExec, r.dir, files, []);
    const searched = new Set(ofKind(links, 'uses').map((l) => l.detail));
    expect(skippedNames).toBe(82);
    expect(searched.size).toBe(600);
    expect(fresh.every((n) => searched.has(n))).toBe(true);
    expect(small.every((n) => searched.has(n))).toBe(true);
    expect(mid.filter((n) => searched.has(n))).toEqual(mid.slice(0, 8));
    expect(barrel.some((n) => searched.has(n))).toBe(false);
  }, 120_000); // a few seconds on a quiet machine; generous because this Mac often runs other work
});
