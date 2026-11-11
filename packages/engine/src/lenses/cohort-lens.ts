import type { Cohort, FileDiff, Tier } from '@airlock/shared';
import { asMaterial, fill, loadTemplate } from '../agent/prompt.js';
import type { AgentRunner } from '../agent/runner.js';
import { formatForPrompt } from '../diff/format.js';
import type { LensDef, Pack } from '../packs/types.js';
import {
  briefBlock, cohortFiles, cohortOutline, factsBlock, instructionsFor, mergeResults, prBlock, readerOf, reviewedCohorts,
  runLensCall, tierOf,
} from './context.js';
import type { LensCall, LensContext, LensStageResult } from './context.js';

export type { LensContext, LensStageResult } from './context.js';

/** The most lines of formatForPrompt output one request carries, shared by the cohort's read and skim files. */
export const DIFF_LINE_BUDGET = 1_500;
/** A cut file always keeps its title and the line that says how much was left out. */
const SMALLEST_CUT = 2;

const lineCount = (text: string): number => text.split('\n').length;
const changedRows = (f: FileDiff): number => f.hunks.reduce((n, h) => n + h.lines.length, 0);

/** Deleted and binary files take one line: their title with its marker. */
const oneLiner = (f: FileDiff): boolean => f.binary || f.status === 'deleted';

/** The longest formatForPrompt output of `f` that fits in `allowance` lines. Output length grows with maxLines. */
function cutToFit(f: FileDiff, allowance: number): string {
  let lo = 0;
  let hi = changedRows(f);
  let best = formatForPrompt(f, { maxLines: 0 });
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const text = formatForPrompt(f, { maxLines: mid });
    if (lineCount(text) <= allowance) {
      best = text;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/**
 * The largest allowance per file such that every file kept whole or cut to the allowance fits in `available` lines.
 * This is the result of lowering the largest file again and again until the total fits.
 */
function allowanceFor(sizes: number[], available: number): number {
  let lo = 0;
  let hi = Math.max(0, ...sizes);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const total = sizes.reduce((n, s) => n + Math.min(s, mid), 0);
    if (total <= available) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * formatForPrompt output for the files, in the order given, within `budget` lines. When the whole text is too long, the
 * largest files are cut first, all to the same allowance, so a cut file only drops below 40 lines when the budget
 * cannot be met with every file at 40 or more. A cut file ends with formatForPrompt's line saying how much was left out.
 * Only when there are so many files that each would get fewer than two lines does the text exceed the budget.
 */
export function budgetedDiff(files: FileDiff[], budget = DIFF_LINE_BUDGET): string {
  const whole = files.map((f) => (oneLiner(f) ? formatForPrompt({ ...f, hunks: [] }) : formatForPrompt(f)));
  const sizes = whole.map(lineCount);
  const fixed = files.reduce((n, f, i) => n + (oneLiner(f) ? sizes[i]! : 0), 0);
  const cuttable = sizes.filter((_, i) => !oneLiner(files[i]!));
  if (fixed + cuttable.reduce((n, s) => n + s, 0) <= budget) return whole.join('\n');

  const allowance = Math.max(SMALLEST_CUT, allowanceFor(cuttable, budget - fixed));
  return files
    .map((f, i) => (oneLiner(f) || sizes[i]! <= allowance ? whole[i]! : cutToFit(f, allowance)))
    .join('\n');
}

function cohortMaterial(ctx: LensContext, cohort: Cohort, tier: (path: string) => Tier): string {
  const paths = cohortFiles(cohort);
  const inCohort = new Set(paths);
  const byPath = new Map(ctx.files.map((f) => [f.path, f]));
  const toRead = paths.filter((p) => tier(p) === 'read' || tier(p) === 'skim').flatMap((p) => byPath.get(p) ?? []);
  const trusted = paths.filter((p) => tier(p) === 'trust');
  const neighbours = cohort.neighbours.map((n) => `${n.path} [${n.role}] for: ${n.forFiles.join(', ')} — ${n.why.replace(/\s+/g, ' ').trim()}`);
  const orNone = (lines: string[]): string => (lines.length === 0 ? '(none)' : lines.join('\n'));
  return [
    prBlock(ctx.pr),
    briefBlock(ctx.brief),
    asMaterial('cohort', cohortOutline(cohort, tier).join('\n')),
    asMaterial('diff', toRead.length === 0 ? '(none)' : budgetedDiff(toRead)),
    asMaterial('trusted files', orNone(trusted)),
    asMaterial('neighbours', orNone(neighbours)),
    factsBlock(ctx.facts.filter((f) => inCohort.has(f.path))),
    ...ctx.repoRules.map((r) => asMaterial(`repository rule file ${r.path}`, r.text)),
  ].join('\n\n');
}

/** The lenses that run: every lens of every pack, except an onlyWhenAlone lens when another pack has any lens. */
function runnableLenses(packs: Pack[]): { pack: Pack; lens: LensDef }[] {
  return packs.flatMap((pack) => {
    const othersHaveLenses = packs.some((p) => p !== pack && p.lenses.length > 0);
    return pack.lenses.filter((l) => !(l.onlyWhenAlone && othersHaveLenses)).map((lens) => ({ pack, lens }));
  });
}

/**
 * One request per reviewed cohort per runnable lens, in cohort order, then pack order, then lens order. A failed
 * request becomes a stage error and the others carry on. `onDone` gets the cohort id and `<pack id>/<lens id>`.
 */
export async function runCohortLenses(
  runner: AgentRunner,
  ctx: LensContext,
  onDone?: (cohortId: string, lensId: string) => void,
): Promise<LensStageResult> {
  const cohorts = reviewedCohorts(ctx);
  const lenses = runnableLenses(ctx.packs);
  if (cohorts.length === 0 || lenses.length === 0) return mergeResults([]);

  const template = await loadTemplate('lens');
  const reader = readerOf(ctx.pr);
  const briefs = lenses.map(({ pack, lens }) => ({
    pack, lens, name: `${pack.id}/${lens.id}`,
    instructions: instructionsFor(
      fill(template, { reader, lensTitle: lens.title, lensInstructions: lens.instructions.trim() }),
      ctx.packs,
      ctx.missingHelpers,
    ),
  }));
  const tier = tierOf(ctx.tiers);
  const calls: { cohortId: string; call: LensCall }[] = [];
  for (const cohort of cohorts) {
    const material = cohortMaterial(ctx, cohort, tier);
    for (const { pack, lens, name, instructions } of briefs) {
      calls.push({
        cohortId: cohort.id,
        call: {
          role: `lens:${name}`, name, stage: 'lenses', source: { pack: pack.id, lens: lens.id, ruleId: null },
          cohortId: cohort.id, instructions, material,
        },
      });
    }
  }

  const taken = new Set<string>();
  const results = await Promise.all(calls.map(async ({ cohortId, call }) => {
    try {
      return await runLensCall(runner, ctx, call, taken);
    } finally {
      try {
        onDone?.(cohortId, call.name);
      } catch {
        // a broken progress listener must not stop the review
      }
    }
  }));
  return mergeResults(results);
}
