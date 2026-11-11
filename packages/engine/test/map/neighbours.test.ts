import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { findLinks } from '../../src/map/links.js';
import { findNeighbours } from '../../src/map/neighbours.js';
import type { Pack } from '../../src/packs/types.js';
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

const DAY = 86_400;
const JAN_1_2026 = 1_767_225_600;

describe('findNeighbours', () => {
  it('finds an unchanged caller of a changed export and reports it as a neighbour', async () => {
    const r = await newRepo();
    const swaps = (n: number): string =>
      `export function approveSwap() { return ${n}; }\nexport function declineSwap() { return ${n}; }\n`;
    const files = await makeChange(r, {
      'src/swaps/actions.ts': swaps(1),
      'src/swaps/panel.tsx': "import { approveSwap, declineSwap } from './actions';\nexport const P = [approveSwap, declineSwap];\n",
      'src/swaps/page.tsx': "import { approveSwap } from './actions';\nexport const Q = approveSwap;\n",
    }, {
      'src/swaps/actions.ts': swaps(2),
      'src/swaps/page.tsx': "import { approveSwap } from './actions';\nexport const Q = approveSwap();\n",
    });
    const links = await findLinks(realExec, r.dir, files, []);
    expect(await findNeighbours(realExec, r.dir, files, links, [])).toEqual([
      { path: 'src/swaps/panel.tsx', role: 'caller', forFiles: ['src/swaps/actions.ts'], why: 'uses approveSwap, declineSwap' },
    ]);
  });

  it('caps callers at 6 per changed file, nearest folders first', async () => {
    const r = await newRepo();
    const caller = (from: string): string => `import { computeTotals } from '${from}';\ncomputeTotals();\n`;
    const files = await makeChange(r, {
      'src/core/lib.ts': 'export function computeTotals() { return 1; }\n',
      'aa/a.ts': caller('../src/core/lib.js'),
      'zz/a.ts': caller('../src/core/lib.js'),
      'src/far/f1.ts': caller('../core/lib.js'),
      'src/far/f2.ts': caller('../core/lib.js'),
      'src/far/f3.ts': caller('../core/lib.js'),
      'src/far/f4.ts': caller('../core/lib.js'),
      'src/far/f5.ts': caller('../core/lib.js'),
      'src/core/near2.ts': caller('./lib.js'),
      'src/core/near1.ts': caller('./lib.js'),
    }, { 'src/core/lib.ts': 'export function computeTotals() { return 2; }\n' });
    const links = await findLinks(realExec, r.dir, files, []);
    const found = await findNeighbours(realExec, r.dir, files, links, []);
    expect(found.map((n) => n.path)).toEqual([
      'src/core/near1.ts', 'src/core/near2.ts', 'src/far/f1.ts', 'src/far/f2.ts', 'src/far/f3.ts', 'src/far/f4.ts',
    ]);
    expect(found.every((n) => n.role === 'caller' && n.why === 'uses computeTotals')).toBe(true);
  });

  it('picks the most recently changed existing cron route as the sibling of a new one', async () => {
    const r = await newRepo();
    await commitFiles(r, { 'app/api/cron/purge/route.ts': 'export function GET() {}\n' }, 'purge', JAN_1_2026);
    await commitFiles(r, { 'app/api/cron/digest/route.ts': 'export function GET() {}\n' }, 'digest', JAN_1_2026 + 30 * DAY);
    const base = await commitFiles(r, { 'app/api/cron/sync/route.ts': 'export function GET() {}\n' }, 'sync', JAN_1_2026 + 10 * DAY);
    const head = await commitFiles(r, { 'app/api/cron/reminders/route.ts': 'export function GET() {}\n' }, 'new', JAN_1_2026 + 40 * DAY);
    const files = await diffOf(r, base, head);
    const packs = [pack('next', { siblings: [{ id: 'cron-route', glob: 'app/api/cron/*/route.ts' }] })];
    expect(await findNeighbours(realExec, r.dir, files, [], packs)).toEqual([
      { path: 'app/api/cron/digest/route.ts', role: 'sibling', forFiles: ['app/api/cron/reminders/route.ts'],
        why: 'closest existing cron-route, last changed 2026-01-31' },
      { path: 'app/api/cron/sync/route.ts', role: 'sibling', forFiles: ['app/api/cron/reminders/route.ts'],
        why: 'closest existing cron-route, last changed 2026-01-11' },
    ]);
  });

  it('ranks siblings by shared folder before recency', async () => {
    const r = await newRepo();
    await commitFiles(r, { 'app/api/cron/weekly/route.ts': 'x\n' }, 'old', JAN_1_2026);
    await commitFiles(r, { 'app/route.ts': 'x\n' }, 'mid', JAN_1_2026 + 10 * DAY);
    const base = await commitFiles(r, { 'app/api/users/route.ts': 'x\n' }, 'newest', JAN_1_2026 + 20 * DAY);
    const head = await commitFiles(r, { 'app/api/cron/daily/route.ts': 'x\n' }, 'new', JAN_1_2026 + 30 * DAY);
    const files = await diffOf(r, base, head);
    const packs = [pack('next', { siblings: [{ id: 'route', glob: 'app/**/route.ts' }] })];
    const found = await findNeighbours(realExec, r.dir, files, [], packs);
    expect(found.map((n) => n.path)).toEqual(['app/api/cron/weekly/route.ts', 'app/api/users/route.ts']);
  });

  it('without a pack, picks files of the same name under the same grandparent folder', async () => {
    const r = await newRepo();
    await commitFiles(r, { 'src/features/archive/actions.ts': 'x\n' }, 'archive', JAN_1_2026 - 30 * DAY);
    await commitFiles(r, { 'src/features/leave/actions.ts': 'x\n' }, 'leave', JAN_1_2026);
    await commitFiles(r, { 'src/features/pay/actions.ts': 'x\n' }, 'pay', JAN_1_2026 + 5 * DAY);
    const base = await commitFiles(r, { 'src/other/actions.ts': 'x\n' }, 'other', JAN_1_2026 + 9 * DAY);
    const head = await commitFiles(r, { 'src/features/swaps/actions.ts': 'x\n' }, 'new', JAN_1_2026 + 20 * DAY);
    const files = await diffOf(r, base, head);
    expect(await findNeighbours(realExec, r.dir, files, [], [])).toEqual([
      { path: 'src/features/leave/actions.ts', role: 'sibling', forFiles: ['src/features/swaps/actions.ts'],
        why: 'closest existing file of the same name, last changed 2026-01-01' },
      { path: 'src/features/pay/actions.ts', role: 'sibling', forFiles: ['src/features/swaps/actions.ts'],
        why: 'closest existing file of the same name, last changed 2026-01-06' },
    ]);
  });

  it('never returns a file that is in the diff', async () => {
    const r = await newRepo();
    const files = await makeChange(r, {
      'src/lib.ts': 'export function shared() { return 1; }\n',
      'src/a.ts': "import { shared } from './lib.js';\nshared();\n",
    }, {
      'src/lib.ts': 'export function shared() { return 2; }\n',
      'src/a.ts': "import { shared } from './lib.js';\nshared(); shared();\n",
    });
    const links = await findLinks(realExec, r.dir, files, []);
    expect(links.length).toBeGreaterThan(0);
    expect(await findNeighbours(realExec, r.dir, files, links, [])).toEqual([]);
  });
});
