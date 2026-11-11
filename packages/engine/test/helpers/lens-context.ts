import type { Brief, ChangeMap, Cohort, FileDiff, FileFact, Hunk, ModelConfig, PrInfo, Tier } from '@airlock/shared';
import { minimalDocument } from '@airlock/shared';
import type { LensContext } from '../../src/lenses/context.js';
import type { LensDef, Pack } from '../../src/packs/types.js';

/** One hunk of `n` added lines, each `<prefix> <i>`. */
export function hunk(n: number, prefix: string): Hunk {
  return {
    oldStart: 0, oldLines: 0, newStart: 1, newLines: n, header: `@@ -0,0 +1,${n} @@`,
    lines: Array.from({ length: n }, (_, i) => ({ kind: 'add' as const, oldNo: null, newNo: i + 1, text: `${prefix} ${i + 1}` })),
  };
}

export const diff = (path: string, n = 3, over: Partial<FileDiff> = {}): FileDiff => ({
  path, oldPath: null, status: 'modified', binary: false, additions: n, deletions: 0,
  hunks: n > 0 ? [hunk(n, `${path} line`)] : [], ...over,
});

export const tier = (path: string, t: Tier = 'read'): FileFact => ({ path, tier: t, reason: 'test' });

export const lens = (id: string, over: Partial<LensDef> = {}): LensDef => ({
  id, title: `Lens ${id}`, instructions: `Instructions for the ${id} lens.`, ...over,
});

export function pack(id: string, lenses: LensDef[], over: Partial<Pack> = {}): Pack {
  return {
    id, title: `Pack ${id}`, version: 'local', dir: `/packs/${id}`, repos: [], appRoot: null, stageRules: [],
    tiers: { read: [], trust: [], ignore: [] }, siblings: [], linkRules: [], checks: [],
    standards: [], lenses, rules: [], learned: [], ...over,
  };
}

export const cohort = (id: string, title: string, layers: Cohort['layers'], over: Partial<Cohort> = {}): Cohort => ({
  id, title, summary: `Summary of ${title}.`, layers, neighbours: [], inferredLinks: [], ...over,
});

export const layer = (id: string, kind: Cohort['layers'][number]['kind'], files: string[], dependsOn: string[] = [], note = ''): Cohort['layers'][number] => ({
  id, title: `Layer ${id}`, kind, files, dependsOn, note,
});

export const pr: PrInfo = {
  ...minimalDocument().pr, title: 'Let members pause a plan', body: 'Members can pause for 60 days. PR_BODY_MARKER',
};

export const brief: Brief = {
  whatItDoes: ['Members can pause their plan from the account page.'],
  claims: [{ text: 'Pauses are limited to 60 days', verdict: 'not-supported', evidence: 'src/pause.ts:4 allows 90.' }],
};

export const models: ModelConfig = { main: 'claude-opus-5-5', challenger: 'claude-opus-5-5', sweep: 'claude-haiku-5-5', effort: 'high' };

/** Two cohorts of read files and an empty standalone group. */
export const twoCohorts: ChangeMap = {
  cohorts: [
    cohort('k1', 'Pausing a plan', [
      layer('k1.l1', 'data', ['db/0042.sql']),
      layer('k1.l2', 'writes', ['src/pause.ts'], ['k1.l1'], 'The 60-day limit is set here.'),
      layer('k1.l3', 'tests', ['test/pause.test.ts'], ['k1.l2']),
    ], {
      neighbours: [
        { path: 'src/jobs/expire.ts', role: 'sibling', forFiles: ['src/pause.ts'], why: 'The existing job to match.' },
        { path: 'src/charge.ts', role: 'caller', forFiles: ['src/pause.ts'], why: 'Charges plans every night.' },
      ],
    }),
    cohort('k2', 'Invoice totals', [layer('k2.l1', 'rules', ['src/totals.ts'])]),
  ],
  standalone: [],
  links: [],
};

export const twoCohortFiles = [diff('db/0042.sql'), diff('src/pause.ts'), diff('test/pause.test.ts'), diff('src/totals.ts')];
export const twoCohortTiers = [tier('db/0042.sql'), tier('src/pause.ts'), tier('test/pause.test.ts', 'trust'), tier('src/totals.ts', 'skim')];

export const ctx = (over: Partial<LensContext> = {}): LensContext => ({
  pr, map: twoCohorts, files: twoCohortFiles, tiers: twoCohortTiers, facts: [], brief,
  packs: [pack('core', [lens('boundary')])], repoRules: [], missingHelpers: [],
  headDir: '/tmp/head', baseDir: '/tmp/base', models, run: (fn) => fn(), ...over,
});

/** A valid raw candidate as a lens would return it. */
export const rawCandidate = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  severity: 'fix', title: 'A paused plan is charged', path: 'src/pause.ts', quote: 'if (plan.active) charge(plan);',
  lineHint: 2, happens: 'A member who paused is charged.', why: 'The job checks active only.', suggestedChange: 'Skip paused plans.',
  connected: [], wouldBeWrongIf: 'The query already filters paused plans.', confidence: 'high', ...over,
});

/** The text inside the first material block whose label contains `label`, or null. */
export function block(material: string, label: string): string | null {
  const start = material.indexOf(`<material label="${label}`);
  if (start < 0) return null;
  const open = material.indexOf('>\n', start) + 2;
  return material.slice(open, material.indexOf('\n</material>', open));
}

export const labels = (material: string): string[] => [...material.matchAll(/<material label="([^"]*)">/g)].map((m) => m[1]!);
