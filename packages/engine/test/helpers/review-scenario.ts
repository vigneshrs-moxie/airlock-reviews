import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach } from 'vitest';
import type { ChangeMap, ReviewEvent } from '@airlock/shared';
import { createFakeRunner } from '../../src/agent/fake-runner.js';
import type { AgentRequest, AgentRunner } from '../../src/agent/runner.js';
import { runReview, type ReviewRequest } from '../../src/pipeline/review.js';
import { realExec, type Exec } from '../../src/util/exec.js';
import { commitFiles } from './change-repo.js';
import { block, rawCandidate } from './lens-context.js';
import { makeTempRepo, type TempRepo } from './temp-repo.js';

export const REPO = 'acme/app';
export const NUMBER = 7;
export const PACKS_DIR = fileURLToPath(new URL('../fixtures/pipeline/packs/', import.meta.url));
export const KIT_DIR = fileURLToPath(new URL('../fixtures/pipeline/kit/', import.meta.url));
export const NOW = new Date('2026-11-11T09:30:00.000Z');
export const DEEP_SENTENCE = 'This is a second, closer pass over one layer: read every non-test file in it in full.';

export const STANDARD_STAGES = [
  'intake', 'packs', 'shape', 'facts', 'map', 'brief', 'lenses', 'sweep', 'seams', 'anchor', 'challenge', 'select', 'store',
];

export const BASE_FILES: Record<string, string> = {
  'CLAUDE.md': 'Base rules BASE_RULES_MARKER\n',
  'src/money.ts': 'export function formatMoney(n: number): string {\n  return n.toFixed(2);\n}\n',
  'src/billing.ts': "import { formatMoney } from './money';\n\nexport function bill(total: number): string {\n  return formatMoney(total);\n}\n",
  'src/jobs/expire.ts': 'export function expireJob(): void {}\n',
};

export const HEAD_FILES: Record<string, string> = {
  'CLAUDE.md': 'Head rules HEAD_RULES_MARKER\n',
  'src/money.ts': 'export function formatMoney(n: number): string {\n  // TODO round half up\n  return n.toFixed(2);\n}\n',
  'src/billing.ts': `${BASE_FILES['src/billing.ts']}\nexport function refund(total: number): string {\n  return formatMoney(-total);\n}\n`,
  'src/jobs/pause.ts': 'export function pauseJob(): void {}\n',
  'test/money.test.ts': "import { formatMoney } from '../src/money';\n",
};

/** The map the fake mapper returns for the scenario: two cohorts, the first with two layers, and CLAUDE.md alone. */
export const SCENARIO_MAP: Omit<ChangeMap, 'links'> = {
  cohorts: [
    {
      id: 'k1', title: 'Money', summary: 'Rounding and refunds.', neighbours: [], inferredLinks: [],
      layers: [
        { id: 'k1.l1', title: 'Rules', kind: 'rules', files: ['src/money.ts'], dependsOn: [], note: '' },
        { id: 'k1.l2', title: 'Callers', kind: 'writes', files: ['src/billing.ts', 'test/money.test.ts'], dependsOn: ['k1.l1'], note: '' },
      ],
    },
    {
      id: 'k2', title: 'Jobs', summary: 'A new job.', neighbours: [], inferredLinks: [],
      layers: [{ id: 'k2.l1', title: 'Jobs', kind: 'jobs', files: ['src/jobs/pause.ts'], dependsOn: [], note: '' }],
    },
  ],
  standalone: ['CLAUDE.md'],
};

export const GOOD = rawCandidate({
  severity: 'fix', title: 'A TODO is left in formatMoney', path: 'src/money.ts', quote: 'return n.toFixed(2);', lineHint: 3,
});
export const GHOST = rawCandidate({
  severity: 'fix', title: 'Rounding uses Math.round', path: 'src/money.ts', quote: 'return Math.round(n * 100) / 100;', lineHint: 3,
});
export const RULED = rawCandidate({
  ruleId: 'money-rounding', severity: 'note', title: 'A refund formats a negative amount', path: 'src/billing.ts',
  quote: 'return formatMoney(-total);', lineHint: 8,
});
export const UNRULED = rawCandidate({
  ruleId: 'made-up', severity: 'fix', title: 'Names a rule nobody gave', path: 'src/billing.ts', quote: 'return formatMoney(-total);',
});
export const DEEP_NEW = rawCandidate({
  severity: 'fix', title: 'bill does not round', path: 'src/billing.ts', quote: 'return formatMoney(total);', lineHint: 4,
});

const none = { candidates: [], questions: [] };
const cohortLine = (req: AgentRequest<unknown>): string => block(req.material, 'cohort')?.split('\n')[0] ?? '';

/** Answers each request of the scenario by role. `over` replaces the answer for a role prefix. */
export function scenarioScript(over: Record<string, (req: AgentRequest<unknown>) => unknown> = {}) {
  return (req: AgentRequest<unknown>): unknown => {
    const custom = Object.entries(over).find(([prefix]) => req.role.startsWith(prefix));
    if (custom) return custom[1](req);
    if (req.role === 'mapper') return SCENARIO_MAP;
    if (req.role === 'brief') return { whatItDoes: ['Adds refunds and a pause job.'], claims: [] };
    if (req.role.startsWith('lens:')) {
      if (req.role !== 'lens:core/correctness') return none;
      if (req.instructions.includes(DEEP_SENTENCE)) {
        if (cohortLine(req) === 'Cohort: Money: Rules') return { candidates: [GOOD], questions: [] };
        if (cohortLine(req) === 'Cohort: Money: Callers') return { candidates: [DEEP_NEW], questions: [] };
        return none;
      }
      if (cohortLine(req) === 'Cohort: Money') return { candidates: [GOOD, GHOST], questions: ['Is rounding half up intended?'] };
      return none;
    }
    if (req.role.startsWith('sweep:')) {
      return block(req.material, 'diff')?.includes('## File: src/billing.ts') ? { candidates: [RULED, UNRULED], questions: [] } : none;
    }
    if (req.role === 'seams') return { candidates: [], questions: ['Does a refund need a ledger entry?'] };
    if (req.role.startsWith('challenge:')) {
      return { outcome: 'keep', ground: 'none', explanation: '', refutation: null, newSeverity: null, checked: 'Read the callers.' };
    }
    if (req.role === 'select') {
      return {
        top: [], also: [], sameAs: [], questionSameAs: [], whoseCall: ['Whether refunds may be negative is a product call.'],
        checksAfterMerge: [], splitSuggested: false,
      };
    }
    throw new Error(`unexpected role ${req.role}`);
  };
}

export interface Scenario { remote: TempRepo; baseSha: string; headSha: string }

/** A remote with the base on main and the change on branch feature; with no head files, feature stays at the base. */
export async function buildScenario(
  base: Record<string, string> = BASE_FILES,
  head: Record<string, string> = HEAD_FILES,
): Promise<Scenario> {
  const remote = await makeTempRepo();
  const baseSha = await commitFiles(remote, base, 'base');
  await remote.git('checkout', '-b', 'feature');
  const headSha = Object.keys(head).length === 0 ? baseSha : await commitFiles(remote, head, 'head');
  return { remote, baseSha, headSha };
}

export interface GhOptions { baseSha: string; headSha: string; author?: string; viewer?: string; failClone?: string }

/** Answers the two `gh api` calls of fetchPr, refuses every other gh call, and passes everything else to realExec. */
export function fakeGh(opts: GhOptions): Exec & { calls: string[][] } {
  const calls: string[][] = [];
  const pull = {
    title: 'Add refunds', body: 'Refunds reuse formatMoney.', additions: 9, deletions: 0, changed_files: 5,
    html_url: `https://github.com/${REPO}/pull/${NUMBER}`, user: { login: opts.author ?? 'alice' },
    base: { ref: 'main', sha: opts.baseSha, repo: { full_name: REPO } },
    head: { ref: 'feature', sha: opts.headSha, repo: { full_name: REPO } },
  };
  const exec: Exec = async (cmd, args, o) => {
    calls.push([cmd, ...args]);
    if (cmd === 'gh') {
      if (args[0] === 'api' && args[1] === `repos/${REPO}/pulls/${NUMBER}`) return { stdout: JSON.stringify(pull), stderr: '', code: 0 };
      if (args[0] === 'api' && args[1] === 'user') return { stdout: `${opts.viewer ?? 'bob'}\n`, stderr: '', code: 0 };
      return { stdout: '', stderr: 'gh: no network in tests', code: 1 };
    }
    if (opts.failClone !== undefined && cmd === 'git' && args[0] === 'clone') return { stdout: '', stderr: opts.failClone, code: 128 };
    return realExec(cmd, args, o);
  };
  return Object.assign(exec, { calls });
}

/** Wraps a runner to count how many requests run at the same time; each request waits `delayMs` first. */
export function concurrencyProbe(inner: AgentRunner, delayMs = 3): AgentRunner & { max: () => number } {
  let active = 0;
  let max = 0;
  return {
    max: () => max,
    async run(req) {
      active++;
      max = Math.max(max, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return await inner.run(req);
      } finally {
        active--;
      }
    },
  };
}

export interface ReviewRun {
  s?: Scenario;
  req?: Partial<ReviewRequest>;
  script?: (req: AgentRequest<unknown>) => unknown;
  wrap?: (runner: AgentRunner) => AgentRunner;
  exec?: Exec;
  onEvent?: (e: ReviewEvent) => void;
}

/**
 * Gives each test its own AIRLOCK_HOME and removes it and every scenario remote afterwards. `review` runs a review of a
 * scenario (a new default one unless given) with the fixture packs and kit, the fake gh and a fake runner.
 */
export function useReviewHarness() {
  let home = '';
  let savedHome: string | undefined;
  const made: Scenario[] = [];

  beforeEach(async () => {
    savedHome = process.env.AIRLOCK_HOME;
    home = await mkdtemp(join(tmpdir(), 'airlock-pipeline-'));
    process.env.AIRLOCK_HOME = home;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.AIRLOCK_HOME;
    else process.env.AIRLOCK_HOME = savedHome;
    await rm(home, { recursive: true, force: true });
    for (const s of made.splice(0)) await rm(s.remote.dir, { recursive: true, force: true });
  });

  async function scenario(...args: Parameters<typeof buildScenario>): Promise<Scenario> {
    const s = await buildScenario(...args);
    made.push(s);
    return s;
  }

  async function review(opts: ReviewRun = {}) {
    const s = opts.s ?? (await scenario());
    const fake = createFakeRunner(opts.script ?? scenarioScript());
    const runner = opts.wrap ? opts.wrap(fake) : fake;
    const events: ReviewEvent[] = [];
    const doc = await runReview(
      { repo: REPO, number: NUMBER, packsDir: PACKS_DIR, kitDir: KIT_DIR, remoteUrl: s.remote.dir, ...opts.req },
      { exec: opts.exec ?? fakeGh({ baseSha: s.baseSha, headSha: s.headSha }), runner, now: () => NOW },
      (e) => { events.push(e); opts.onEvent?.(e); },
    );
    return { doc, events, calls: fake.calls, s };
  }

  return { home: () => home, scenario, review };
}
