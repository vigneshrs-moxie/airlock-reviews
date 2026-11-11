import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileDiff } from '@airlock/shared';
import picomatch from 'picomatch';
import { describe, expect, it } from 'vitest';
import { runChecks } from '../../src/facts/checks.js';
import { loadPack } from '../../src/packs/load.js';
import type { Pack } from '../../src/packs/types.js';

const packsDir = fileURLToPath(new URL('../../../../packs/', import.meta.url));
const KIT_DIR = '/Users/moxie/research_notes/AI code review extension research/moxie-review-kit-copy/skills/moxie-review/';
const PACK_IDS = ['generic', 'raj-standard', 'orbit-mine'] as const;
const SPEC_CHECKS: [string, string][] = [
  ['migration-without-schema', 'file-pair'], ['feature-without-seed', 'file-pair'],
  ['cron-missing-config', 'new-file-requires'], ['raw-unsafe', 'added-line-matches'],
  ['literal-all', 'added-line-matches'], ['guard-test-edited', 'file-touched'],
];

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(path)));
    else out.push(path);
  }
  return out.sort();
}

const kitPresent = existsSync(KIT_DIR);
const normalise = (line: string): string => line.trim().replace(/\s+/g, ' ');
const RUN_WORDS = 8;
/** Every run of 8 consecutive words, lower-cased, apostrophes dropped and other punctuation read as a space. */
function wordRuns(text: string): Set<string> {
  const words = text.toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const runs = new Set<string>();
  for (let i = 0; i + RUN_WORDS <= words.length; i++) runs.add(words.slice(i, i + RUN_WORDS).join(' '));
  return runs;
}
const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;
const orbit = (): Promise<Pack> => loadPack(join(packsDir, 'orbit-mine'));

/** A changed file whose added lines carry the given new line numbers. */
const file = (path: string, status: FileDiff['status'] = 'modified', added: string[] = []): FileDiff => ({
  path, oldPath: null, status, binary: false, additions: added.length, deletions: 0,
  hunks: added.length
    ? [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: added.length, header: '',
      lines: added.map((text, i) => ({ kind: 'add' as const, oldNo: null, newNo: i + 1, text })) }]
    : [],
});
type ReadHead = (path: string) => Promise<string | null>;
const noHead: ReadHead = async () => null;
const checkIds = async (files: FileDiff[], head: ReadHead = noHead): Promise<string[]> =>
  (await runChecks(files, [await orbit()], head)).map((f) => `${f.checkId} ${f.path}${f.line === null ? '' : `:${f.line}`}`);

describe('the packs in this repository', () => {
  it.each(PACK_IDS)('loads %s', async (id) => {
    const p = await loadPack(join(packsDir, id));
    expect(p.id).toBe(id);
    expect(p.lenses.length).toBeGreaterThan(0);
  });

  it('every orbit-mine rule has paths, an origin and a body of at least 40 characters', async () => {
    const { rules } = await orbit();
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r.paths.length, r.id).toBeGreaterThan(0);
      expect(r.origin.trim(), r.id).not.toBe('');
      expect(r.body.trim().length, r.id).toBeGreaterThanOrEqual(40);
    }
  });

  it('every rule mined from a review names its source pull requests', async () => {
    const mined = (await orbit()).rules.filter((r) => r.origin.includes('past_review_comment_mining'));
    expect(mined.length).toBeGreaterThan(0);
    for (const r of mined) expect(r.sourcePrs.length, r.id).toBeGreaterThan(0);
  });

  it('orbit-mine rule ids are unique, kebab-case and match their file names', async () => {
    const dir = join(packsDir, 'orbit-mine', 'rules');
    const names = (await readdir(dir)).filter((n) => n.endsWith('.md')).map((n) => basename(n, '.md')).sort();
    const ids = (await orbit()).rules.map((r) => r.id).sort();
    expect(ids).toEqual(names);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it('every orbit-mine rule path is a glob from the repository root', async () => {
    for (const r of (await orbit()).rules) {
      for (const g of r.paths) expect(g.startsWith('app/') || g.startsWith('**/'), `${r.id}: ${g}`).toBe(true);
    }
  });

  it('each lens file has between 100 and 450 words', async () => {
    for (const id of PACK_IDS) {
      for (const lens of (await loadPack(join(packsDir, id))).lenses) {
        const n = wordCount(lens.instructions);
        expect(n, `${id}/${lens.id}`).toBeGreaterThanOrEqual(100);
        expect(n, `${id}/${lens.id}`).toBeLessThanOrEqual(450);
      }
    }
  });

  it('orbit-mine has exactly the six code checks from the spec', async () => {
    const checks = (await orbit()).checks.map((c) => [c.id, c.kind]);
    expect(checks.sort()).toEqual([...SPEC_CHECKS].sort());
  });

  it('orbit-mine reads the structural guard tests and trusts other tests', async () => {
    const read = (await orbit()).tiers.read.map((g) => picomatch(g, { dot: true }));
    const isRead = (path: string): boolean => read.some((m) => m(path));
    expect(isRead('app/src/lib/no-hardcoded-offices.test.ts')).toBe(true);
    expect(isRead('app/src/lib/announcements/release-guard.test.ts')).toBe(true);
    expect(isRead('app/src/app/api/cron-methods.test.ts')).toBe(true);
    expect(isRead('app/src/lib/scope.test.ts')).toBe(false);
    expect(isRead('app/src/app/api/observations/route.test.ts')).toBe(false);
    expect(isRead('app/src/app/api/observations/route.ts')).toBe(true);
  });

  it.skipIf(!kitPresent)('no pack file contains a line or an 8-word run copied from the team kit', async () => {
    const kitLines = new Set<string>();
    const kitRuns = new Set<string>();
    for (const path of await filesUnder(KIT_DIR)) {
      const text = await readFile(path, 'utf8');
      for (const line of text.split('\n')) {
        const n = normalise(line);
        if (n.length >= 60) kitLines.add(n);
      }
      for (const run of wordRuns(text)) kitRuns.add(run);
    }
    expect(kitLines.size).toBeGreaterThan(0);
    expect(kitRuns.size).toBeGreaterThan(0);
    const copied: string[] = [];
    for (const path of await filesUnder(packsDir)) {
      const text = await readFile(path, 'utf8');
      for (const line of text.split('\n')) {
        const n = normalise(line);
        if (n.length >= 60 && kitLines.has(n)) copied.push(`${relative(packsDir, path)}: line: ${n}`);
      }
      for (const run of wordRuns(text)) {
        if (kitRuns.has(run)) copied.push(`${relative(packsDir, path)}: words: ${run}`);
      }
    }
    expect(copied).toEqual([]);
  });
});

describe('the orbit-mine code checks on sample changes', () => {
  it('raw-unsafe flags an unsafe raw query in app code but not in a test', async () => {
    expect(await checkIds([
      file('app/src/lib/report.ts', 'modified', ['const a = 1;', 'await db.$queryRawUnsafe(sql);']),
      file('app/src/lib/report.test.ts', 'modified', ['await db.$queryRawUnsafe(sql);']),
      file('app/src/test/fixture/load.ts', 'modified', ['await db.$executeRawUnsafe(sql);']),
    ])).toEqual(['raw-unsafe app/src/lib/report.ts:2']);
  });

  it('literal-all flags a visible-ids comparison with "all" and ignores ordinary filters', async () => {
    expect(await checkIds([
      file('app/src/app/api/scorecards/generate/route.ts', 'modified', [
        'if (visibleIds !== "all" && !visibleIds.includes(id)) {',
        'const isAllTime = period === "all";',
        "...(visible !== 'all' ? { id: { in: visible } } : {}),",
        "const showTeams = scope === 'all' && counts.field > 0",
      ]),
    ])).toEqual([
      'literal-all app/src/app/api/scorecards/generate/route.ts:1',
      'literal-all app/src/app/api/scorecards/generate/route.ts:3',
    ]);
  });

  it('migration-without-schema and feature-without-seed fire only when the partner file is missing', async () => {
    expect(await checkIds([
      file('app/prisma/migrations/0160_swaps/migration.sql', 'added'), file('app/src/lib/feature-catalog.ts'),
    ])).toEqual(['migration-without-schema app/prisma/migrations/0160_swaps/migration.sql']);
    expect(await checkIds([file('app/src/lib/feature-catalog.ts')]))
      .toEqual(['feature-without-seed app/src/lib/feature-catalog.ts']);
    expect(await checkIds([file('app/prisma/migrations/0160_swaps/migration.sql', 'added'), file('app/prisma/schema.prisma')]))
      .toEqual([]);
  });

  it('cron-missing-config names each missing part of a new cron route, and is silent when all are there', async () => {
    const route = 'app/src/app/api/fleet/sync-trailers/route.ts';
    const heads: Record<string, string> = {
      [route]: 'export async function GET() {}',
      'app/vercel.json': '{"crons":[{"path":"/api/fleet/sync-trucks","schedule":"0 12 * * *"}]}',
      'app/src/middleware.ts': 'pathname.startsWith("/api/fleet/sync-trucks") ||',
    };
    const read = async (p: string): Promise<string | null> => heads[p] ?? null;
    const facts = await runChecks([file(route, 'added')], [await orbit()], read);
    expect(facts.filter((f) => f.checkId === 'cron-missing-config').map((f) => f.message.replace(/^.*\(missing in (.*)\)$/, '$1')))
      .toEqual([route, 'app/vercel.json', 'app/src/middleware.ts']);

    heads[route] = 'export const maxDuration = 300;\nexport async function GET() {}';
    heads['app/vercel.json'] = '{"crons":[{"path":"/api/fleet/sync-trailers","schedule":"0 12 * * *"}]}';
    heads['app/src/middleware.ts'] = 'pathname.startsWith("/api/fleet/sync-trailers") ||';
    expect((await runChecks([file(route, 'added')], [await orbit()], read)).filter((f) => f.checkId === 'cron-missing-config'))
      .toEqual([]);
    expect(await checkIds([file('app/src/app/api/observations/route.ts', 'added')], read)).toEqual([]);
  });

  it('cron-missing-config is not satisfied by another route that ends in the same folder name', async () => {
    const route = 'app/src/app/api/budget/warm/route.ts';
    const heads: Record<string, string> = {
      [route]: 'export const maxDuration = 120;',
      'app/vercel.json': '{"crons":[{"path":"/api/calls/warm"},{"path":"/api/productivity/warm"},{"path":"/api/field-ops/warm"}]}',
      'app/src/middleware.ts': 'pathname.startsWith("/api/calls/warm") ||\npathname.startsWith("/api/field-ops/warm") ||',
    };
    const facts = await runChecks([file(route, 'added')], [await orbit()], async (p) => heads[p] ?? null);
    expect(facts.filter((f) => f.checkId === 'cron-missing-config').map((f) => f.message)).toEqual([
      'A new route named like a cron job is missing maxDuration, its vercel.json schedule or its middleware allowlist entry. (missing in app/vercel.json)',
      'A new route named like a cron job is missing maxDuration, its vercel.json schedule or its middleware allowlist entry. (missing in app/src/middleware.ts)',
    ]);
  });

  it('guard-test-edited flags an edit to a structural guard test or the visibility baseline', async () => {
    expect(await checkIds([
      file('app/src/lib/no-hardcoded-offices.test.ts'), file('app/src/test/visibility/__baselines__/visibility.json'),
      file('app/src/lib/scope.test.ts'),
    ])).toEqual([
      'guard-test-edited app/src/lib/no-hardcoded-offices.test.ts',
      'guard-test-edited app/src/test/visibility/__baselines__/visibility.json',
    ]);
  });
});

describe('the orbit-mine link rules', () => {
  const captures = async (id: string, line: string): Promise<string[]> => {
    const rule = (await orbit()).linkRules.find((r) => r.id === id);
    if (!rule) throw new Error(`no link rule ${id}`);
    return [...line.matchAll(new RegExp(rule.capture, 'g'))].map((m) => m[1] ?? '');
  };
  const appliesTo = async (id: string, path: string): Promise<boolean> => {
    const rule = (await orbit()).linkRules.find((r) => r.id === id);
    return rule !== undefined && picomatch(rule.from, { dot: true })(path);
  };

  it('captures the table a migration creates, quoted or not', async () => {
    expect(await appliesTo('migration-table-to-model', 'app/prisma/migrations/0160_swaps/migration.sql')).toBe(true);
    expect(await captures('migration-table-to-model', 'CREATE TABLE IF NOT EXISTS shift_swaps (')).toEqual(['shift_swaps']);
    expect(await captures('migration-table-to-model', 'CREATE TABLE "entities" (')).toEqual(['entities']);
    expect(await captures('migration-table-to-model', 'ALTER TABLE shift_swaps ADD COLUMN x int;')).toEqual([]);
  });

  it('captures the name of a model added to schema.prisma', async () => {
    expect(await appliesTo('model-to-code', 'app/prisma/schema.prisma')).toBe(true);
    expect(await captures('model-to-code', 'model ShiftSwap {')).toEqual(['ShiftSwap']);
    expect(await captures('model-to-code', '  @@map("shift_swaps")')).toEqual([]);
  });

  it('captures a FEATURES key but not its V1_DEFAULTS line', async () => {
    for (const id of ['feature-key-to-seed', 'feature-key-to-guard']) {
      expect(await appliesTo(id, 'app/src/lib/feature-catalog.ts')).toBe(true);
      expect(await captures(id, '  shift_swaps: "Shift Swaps",')).toEqual(['shift_swaps']);
      expect(await captures(id, '  shift_swaps: false,')).toEqual([]);
    }
  });
});
