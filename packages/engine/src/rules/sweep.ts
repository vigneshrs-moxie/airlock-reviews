import type { Candidate, Dropped, Severity } from '@airlock/shared';
import { z } from 'zod';
import { asMaterial, fill, loadTemplate } from '../agent/prompt.js';
import type { AgentRunner } from '../agent/runner.js';
import { budgetedDiff } from '../lenses/cohort-lens.js';
import { RawCandidateSchema, acceptCandidates } from '../lenses/candidate.js';
import {
  briefBlock, cohortOutline, diffCutSentence, emptyResult, factsBlock, instructionsFor, mergeResults, prBlock, readerOf,
  sendRequest, standaloneCohort, tierOf,
} from '../lenses/context.js';
import type { DiffCut, LensContext, LensStageResult } from '../lenses/context.js';
import type { Rule } from '../packs/types.js';
import { planSweep, ruleApplies } from './match.js';
import type { SweepBatch } from './match.js';

/** A sweep request (one batch of up to MAX_BATCH_FILES files and MAX_BATCH_RULES rules) may return this many candidates. */
export const MAX_CANDIDATES_PER_SWEEP = 12;

/** The sweep's diff budget, in lines of formatForPrompt output. */
export const SWEEP_DIFF_LINE_BUDGET = 1_200;

const SweepOutputSchema = z.object({
  candidates: z.array(RawCandidateSchema.extend({ ruleId: z.string().optional() })),
  questions: z.array(z.string()),
});
type SweepOutput = z.infer<typeof SweepOutputSchema>;

/** Higher is more serious: block > fix > ask > note. */
export const SEVERITY_RANK: Record<Severity, number> = { note: 0, ask: 1, fix: 2, block: 3 };
/**
 * A definite breach (`note`, `fix` or `block`) is at least the rule's floor; a doubt (`ask`) stays a doubt whatever the
 * floor, since the model could not confirm the breach.
 */
const floored = (severity: Severity, floor: Severity): Severity =>
  (severity === 'ask' || SEVERITY_RANK[severity] >= SEVERITY_RANK[floor] ? severity : floor);

function rulesText(rules: Rule[]): string {
  const parts = rules.map((r) => `### ${r.id}: ${r.title}\n\n${r.body.trim()}\n\nApplies to: ${r.paths.join(', ')}\nFloor: ${r.severityFloor}`);
  return `# The rules to check\n\n${parts.join('\n\n')}`;
}

function batchMaterial(ctx: LensContext, batch: SweepBatch): { material: string; cut: DiffCut | null; title: string } {
  const tier = tierOf(ctx.tiers);
  const cohort = [...ctx.map.cohorts, standaloneCohort(ctx.map)].find((c) => c.id === batch.cohortId)!;
  const inBatch = new Set(batch.files);
  const byPath = new Map(ctx.files.map((f) => [f.path, f]));
  const diffs = batch.files.flatMap((p) => byPath.get(p) ?? []);
  const neighbours = cohort.neighbours.map((n) => `${n.path} [${n.role}] for: ${n.forFiles.join(', ')} — ${n.why.replace(/\s+/g, ' ').trim()}`);
  const diff = budgetedDiff(diffs, SWEEP_DIFF_LINE_BUDGET);
  const rulesOf = batch.files.map((p) => `${p}: ${batch.rulesOf[p]!.join(', ')}`);
  const material = [
    prBlock(ctx.pr),
    asMaterial('cohort', cohortOutline(cohort, tier).join('\n')),
    asMaterial('files and their rules', rulesOf.join('\n')),
    asMaterial('diff', diff.text),
    factsBlock(ctx.facts.filter((f) => inBatch.has(f.path))),
    asMaterial('neighbours', neighbours.length === 0 ? '(none)' : neighbours.join('\n')),
  ].join('\n\n');
  return { material, cut: diff.cut, title: cohort.title };
}

/**
 * Checks one batch's raw candidates against its rules: a candidate naming a rule that was not given, or a rule that does
 * not match the candidate's file, is dropped; a definite breach is raised to the rule's floor.
 */
function acceptSweep(output: SweepOutput, batch: SweepBatch, taken: Set<string>): LensStageResult {
  const out = emptyResult();
  const byId = new Map(batch.rules.map((r) => [r.id, r]));
  const valid: { candidate: Candidate; rule: Rule | null; named: string }[] = [];
  for (const raw of output.candidates) {
    const named = (raw.ruleId ?? '').trim();
    const rule = byId.get(named) ?? null;
    const source = { pack: (rule ?? batch.rules[0]!).packId, lens: null, ruleId: rule ? rule.id : null };
    const accepted = acceptCandidates([raw], source, batch.cohortId, taken);
    out.questions.push(...accepted.questions);
    out.dropped.push(...accepted.dropped);
    const candidate = accepted.candidates[0];
    if (candidate) valid.push({ candidate, rule, named });
  }
  let kept = 0;
  for (const { candidate, rule, named } of valid) {
    const reason = rule === null ? `names a rule that was not given: ${named}`
      : !ruleApplies(rule, candidate.path) ? `the rule ${rule.id} does not apply to ${candidate.path}`
        : kept >= MAX_CANDIDATES_PER_SWEEP ? `more than ${MAX_CANDIDATES_PER_SWEEP} candidates from one sweep request` : null;
    if (reason !== null) {
      const dropped: Dropped = { candidate, stage: 'schema', reason, refutation: null };
      out.dropped.push(dropped);
      continue;
    }
    kept++;
    out.candidates.push({ ...candidate, severity: floored(candidate.severity, rule!.severityFloor) });
  }
  for (const q of output.questions) {
    if (q.trim() !== '') out.questions.push({ text: q.trim(), cohortId: batch.cohortId, source: { pack: batch.rules[0]!.packId, lens: null, ruleId: null } });
  }
  return out;
}

/**
 * The rule sweep: one request per batch of a group's changed files (see planSweep), carrying the rules that match them,
 * with each file listed beside the ids of its own rules. A failed request becomes a stage error naming the batch and its
 * files, and the others carry on. With no batches nothing is sent.
 */
export async function runSweep(runner: AgentRunner, ctx: LensContext): Promise<LensStageResult> {
  const batches = planSweep(ctx.map, ctx.tiers, ctx.files, ctx.packs);
  if (batches.length === 0) return mergeResults([]);

  const template = fill(await loadTemplate('sweep'), { reader: readerOf(ctx.pr), maxCandidates: String(MAX_CANDIDATES_PER_SWEEP) });
  // The rules are the standard of a sweep, so the packs go in without theirs; the learned entries stay.
  const withoutStandards = ctx.packs.map((p) => ({ ...p, standards: [] }));
  const counters = new Map<string, number>();
  const numbered = batches.map((batch) => {
    const n = (counters.get(batch.cohortId) ?? 0) + 1;
    counters.set(batch.cohortId, n);
    return { batch, n };
  });

  const taken = new Set<string>();
  const results = await Promise.all(numbered.map(async ({ batch, n }) => {
    const { material, cut, title } = batchMaterial(ctx, batch);
    const limits = cut === null ? [] : [diffCutSentence('sweep', `${title}, batch ${n}`, cut)];
    const result = await sendRequest<SweepOutput>(runner, ctx, {
      role: `sweep:${batch.cohortId}#${n}`,
      instructions: instructionsFor(`${template.trimEnd()}\n\n${rulesText(batch.rules)}`, withoutStandards, ctx.missingHelpers),
      material,
      schema: SweepOutputSchema,
      cwd: ctx.headDir,
      extraDirs: [ctx.baseDir],
      model: ctx.models.sweep,
      effort: ctx.models.effort,
    });
    if (!result.ok) {
      const failed = emptyResult();
      failed.usage.push(result.usage);
      // A batch holds at most MAX_BATCH_FILES files, so naming them all says what was not checked.
      const named = [...new Set(batch.files)].join(', ');
      failed.errors.push({ stage: 'sweep', cohortId: batch.cohortId, message: `batch ${n} (${named}): ${result.error}`, kind: result.kind });
      failed.limits.push(...limits);
      return failed;
    }
    const accepted = acceptSweep(result.output, batch, taken);
    accepted.usage.push(result.usage);
    accepted.limits.push(...limits);
    return accepted;
  }));
  return mergeResults(results);
}
