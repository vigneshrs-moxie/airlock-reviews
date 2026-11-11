import type { Cohort, FileDiff, Tier } from '@airlock/shared';
import { asMaterial, fill, loadTemplate } from '../agent/prompt.js';
import type { AgentRunner } from '../agent/runner.js';
import { formatForPrompt } from '../diff/format.js';
import type { LensDef, Pack } from '../packs/types.js';
import {
  briefBlock, cohortFiles, cohortOutline, diffCutSentence, factsBlock, instructionsFor, mergeResults, prBlock, readerOf,
  reviewedCohorts, runLensCall, tierOf,
} from './context.js';
import type { DiffCut, LensCall, LensContext, LensStageResult } from './context.js';

export type { LensContext, LensStageResult } from './context.js';

/** The most lines of formatForPrompt output one request carries, shared by the cohort's read and skim files. */
export const DIFF_LINE_BUDGET = 1_500;
/** A cut file always keeps its title and the line that says how much was left out. */
const SMALLEST_CUT = 2;

const lineCount = (text: string): number => text.split('\n').length;
const changedRows = (f: FileDiff): number => f.hunks.reduce((n, h) => n + h.lines.length, 0);
/** Added and deleted lines among the first `rows` rows of the file's hunks. */
const changedIn = (f: FileDiff, rows = Number.POSITIVE_INFINITY): number =>
  f.hunks.flatMap((h) => h.lines).slice(0, rows).filter((l) => l.kind !== 'ctx').length;

/** Deleted and binary files take one line: their title with its marker. */
const oneLiner = (f: FileDiff): boolean => f.binary || f.status === 'deleted';

/** The longest formatForPrompt output of `f` that fits in `allowance` lines, and how many rows it shows. */
function cutToFit(f: FileDiff, allowance: number): { text: string; rows: number } {
  let lo = 0;
  let hi = changedRows(f);
  let best = { text: formatForPrompt(f, { maxLines: 0 }), rows: 0 };
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const text = formatForPrompt(f, { maxLines: mid });
    if (lineCount(text) <= allowance) {
      best = { text, rows: mid };
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

/** A diff for a prompt, and what the budget cut from it (null when nothing was cut). */
export interface BudgetedDiff { text: string; cut: DiffCut | null }

/**
 * formatForPrompt output for the files, in the order given, within `budget` lines. When the whole text is too long, the
 * largest files are cut first, all to the same allowance, so a cut file only drops below 40 lines when the budget
 * cannot be met with every file at 40 or more. A cut file ends with formatForPrompt's line saying how much was left out.
 * Only when there are so many files that each would get fewer than two lines does the text exceed the budget. `cut`
 * counts the changed lines of the files that have a diff to show (deleted and binary files never do), and those shown.
 */
export function budgetedDiff(files: FileDiff[], budget = DIFF_LINE_BUDGET): BudgetedDiff {
  const whole = files.map((f) => (oneLiner(f) ? formatForPrompt({ ...f, hunks: [] }) : formatForPrompt(f)));
  const sizes = whole.map(lineCount);
  const fixed = files.reduce((n, f, i) => n + (oneLiner(f) ? sizes[i]! : 0), 0);
  const cuttable = sizes.filter((_, i) => !oneLiner(files[i]!));
  if (fixed + cuttable.reduce((n, s) => n + s, 0) <= budget) return { text: whole.join('\n'), cut: null };

  const allowance = Math.max(SMALLEST_CUT, allowanceFor(cuttable, budget - fixed));
  const cut: DiffCut = { shown: 0, total: 0, files: 0 };
  const parts = files.map((f, i) => {
    if (oneLiner(f)) return whole[i]!;
    const all = changedIn(f);
    cut.total += all;
    if (sizes[i]! <= allowance) {
      cut.shown += all;
      return whole[i]!;
    }
    const part = cutToFit(f, allowance);
    const shown = changedIn(f, part.rows);
    cut.shown += shown;
    if (shown < all) cut.files += 1;
    return part.text;
  });
  return { text: parts.join('\n'), cut: cut.files > 0 ? cut : null };
}

function cohortMaterial(ctx: LensContext, cohort: Cohort, tier: (path: string) => Tier): { material: string; cut: DiffCut | null } {
  const paths = cohortFiles(cohort);
  const inCohort = new Set(paths);
  const byPath = new Map(ctx.files.map((f) => [f.path, f]));
  const toRead = paths.filter((p) => tier(p) === 'read' || tier(p) === 'skim').flatMap((p) => byPath.get(p) ?? []);
  const trusted = paths.filter((p) => tier(p) === 'trust');
  const neighbours = cohort.neighbours.map((n) => `${n.path} [${n.role}] for: ${n.forFiles.join(', ')} — ${n.why.replace(/\s+/g, ' ').trim()}`);
  const orNone = (lines: string[]): string => (lines.length === 0 ? '(none)' : lines.join('\n'));
  const diff = toRead.length === 0 ? { text: '(none)', cut: null } : budgetedDiff(toRead);
  const material = [
    prBlock(ctx.pr),
    briefBlock(ctx.brief),
    asMaterial('cohort', cohortOutline(cohort, tier).join('\n')),
    asMaterial('diff', diff.text),
    asMaterial('trusted files', orNone(trusted)),
    asMaterial('neighbours', orNone(neighbours)),
    factsBlock(ctx.facts.filter((f) => inCohort.has(f.path))),
    ...ctx.repoRules.map((r) => asMaterial(`repository rule file ${r.path}`, r.text)),
  ].join('\n\n');
  return { material, cut: diff.cut };
}

/** The lenses that run: every lens of every pack, except an onlyWhenAlone lens when another pack has any lens. */
export function runnableLenses(packs: Pack[]): { pack: Pack; lens: LensDef }[] {
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
  const extra = ctx.extraInstructions?.trim() ?? '';
  const briefs = lenses.map(({ pack, lens }) => ({
    pack, lens, name: `${pack.id}/${lens.id}`,
    instructions: instructionsFor(
      fill(template, {
        reader, lensTitle: lens.title, lensInstructions: extra === '' ? lens.instructions.trim() : `${lens.instructions.trim()}\n\n${extra}`,
      }),
      ctx.packs,
      ctx.missingHelpers,
    ),
  }));
  const tier = tierOf(ctx.tiers);
  const calls: { cohortId: string; call: LensCall }[] = [];
  const limits: string[] = [];
  for (const cohort of cohorts) {
    const { material, cut } = cohortMaterial(ctx, cohort, tier);
    if (cut !== null) limits.push(diffCutSentence('lenses', cohort.title, cut));
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
  const merged = mergeResults(results);
  merged.limits.push(...limits);
  return merged;
}
