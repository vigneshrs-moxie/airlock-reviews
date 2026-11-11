import type { Candidate, Dropped, Severity } from '@airlock/shared';
import { z } from 'zod';
import { asMaterial, fill, loadTemplate } from '../agent/prompt.js';
import type { AgentRunner } from '../agent/runner.js';
import { budgetedDiff } from '../lenses/cohort-lens.js';
import { MAX_CANDIDATES_PER_LENS, RawCandidateSchema, acceptCandidates } from '../lenses/candidate.js';
import {
  briefBlock, cohortOutline, emptyResult, factsBlock, instructionsFor, mergeResults, prBlock, readerOf, sendRequest,
  standaloneCohort, tierOf,
} from '../lenses/context.js';
import type { LensContext, LensStageResult } from '../lenses/context.js';
import type { Rule } from '../packs/types.js';
import { planSweep } from './match.js';
import type { SweepBatch } from './match.js';

/** The sweep's diff budget, in lines of formatForPrompt output. */
export const SWEEP_DIFF_LINE_BUDGET = 1_200;

const SweepOutputSchema = z.object({
  candidates: z.array(RawCandidateSchema.extend({ ruleId: z.string().optional() })),
  questions: z.array(z.string()),
});
type SweepOutput = z.infer<typeof SweepOutputSchema>;

const SEVERITY_RANK: Record<Severity, number> = { note: 0, ask: 1, fix: 2, block: 3 };
const raised = (severity: Severity, floor: Severity): Severity => (SEVERITY_RANK[severity] < SEVERITY_RANK[floor] ? floor : severity);

function rulesText(rules: Rule[]): string {
  const parts = rules.map((r) => `### ${r.id}: ${r.title}\n\n${r.body.trim()}\n\nApplies to: ${r.paths.join(', ')}`);
  return `# The rules to check\n\n${parts.join('\n\n')}`;
}

function batchMaterial(ctx: LensContext, batch: SweepBatch): string {
  const tier = tierOf(ctx.tiers);
  const cohort = [...ctx.map.cohorts, standaloneCohort(ctx.map)].find((c) => c.id === batch.cohortId)!;
  const inBatch = new Set(batch.files);
  const byPath = new Map(ctx.files.map((f) => [f.path, f]));
  const diffs = batch.files.flatMap((p) => byPath.get(p) ?? []);
  const neighbours = cohort.neighbours.map((n) => `${n.path} [${n.role}] for: ${n.forFiles.join(', ')} — ${n.why.replace(/\s+/g, ' ').trim()}`);
  return [
    prBlock(ctx.pr),
    asMaterial('cohort', cohortOutline(cohort, tier).join('\n')),
    asMaterial('diff', budgetedDiff(diffs, SWEEP_DIFF_LINE_BUDGET)),
    factsBlock(ctx.facts.filter((f) => inBatch.has(f.path))),
    asMaterial('neighbours', neighbours.length === 0 ? '(none)' : neighbours.join('\n')),
  ].join('\n\n');
}

/** Checks one batch's raw candidates against its rules: unknown rule ids are dropped, severity is raised to the rule's floor. */
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
    const candidate = accepted.candidates[0];
    if (candidate) valid.push({ candidate, rule, named });
  }
  let kept = 0;
  for (const { candidate, rule, named } of valid) {
    const reason = rule === null ? `names a rule that was not given: ${named}`
      : kept >= MAX_CANDIDATES_PER_LENS ? `more than ${MAX_CANDIDATES_PER_LENS} candidates from one lens` : null;
    if (reason !== null) {
      const dropped: Dropped = { candidate, stage: 'schema', reason, refutation: null };
      out.dropped.push(dropped);
      continue;
    }
    kept++;
    out.candidates.push({ ...candidate, severity: raised(candidate.severity, rule!.severityFloor) });
  }
  for (const q of output.questions) {
    if (q.trim() !== '') out.questions.push({ text: q.trim(), cohortId: batch.cohortId, source: { pack: batch.rules[0]!.packId, lens: null, ruleId: null } });
  }
  return out;
}

/**
 * The rule sweep: one request per batch of changed files, carrying only the rules that match them. A failed request
 * becomes a stage error naming the batch and the others carry on. With no batches nothing is sent.
 */
export async function runSweep(runner: AgentRunner, ctx: LensContext): Promise<LensStageResult> {
  const batches = planSweep(ctx.map, ctx.tiers, ctx.files, ctx.packs);
  if (batches.length === 0) return mergeResults([]);

  const template = fill(await loadTemplate('sweep'), { reader: readerOf(ctx.pr) });
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
    const result = await sendRequest<SweepOutput>(runner, ctx, {
      role: `sweep:${batch.cohortId}#${n}`,
      instructions: instructionsFor(`${template.trimEnd()}\n\n${rulesText(batch.rules)}`, withoutStandards, null),
      material: batchMaterial(ctx, batch),
      schema: SweepOutputSchema,
      cwd: ctx.headDir,
      extraDirs: [ctx.baseDir],
      model: ctx.models.sweep,
      effort: ctx.models.effort,
    });
    if (!result.ok) {
      const failed = emptyResult();
      failed.usage.push(result.usage);
      failed.errors.push({ stage: 'sweep', cohortId: batch.cohortId, message: `batch ${n}: ${result.error}` });
      return failed;
    }
    const accepted = acceptSweep(result.output, batch, taken);
    accepted.usage.push(result.usage);
    return accepted;
  }));
  return mergeResults(results);
}
