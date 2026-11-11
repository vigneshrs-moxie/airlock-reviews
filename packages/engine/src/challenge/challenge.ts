import type { Dropped, Severity, StageError, StageErrorKind, Tier } from '@airlock/shared';
import { SeveritySchema } from '@airlock/shared';
import { z } from 'zod';
import { asMaterial, loadTemplate } from '../agent/prompt.js';
import type { AgentRunner, AgentUsage } from '../agent/runner.js';
import { budgetedDiff } from '../lenses/cohort-lens.js';
import { plainCandidate, type AnchoredCandidate } from '../merge/merge.js';
import {
  cohortOutline, diffCutSentence, factsBlock, instructionsFor, prBlock, sendRequest, standaloneCohort, tierOf,
} from '../lenses/context.js';
import type { DiffCut, LensContext } from '../lenses/context.js';
import { SEVERITY_RANK } from '../rules/sweep.js';
import { createEvidence, proveDrop } from './proof.js';
import type { Evidence, ReadFile } from './proof.js';

/** The challenge's diff budget, in lines of formatForPrompt output, shared by the finding's file and its connected files. */
export const CHALLENGE_DIFF_LINE_BUDGET = 600;

export type ChallengeOutcome = 'keep' | 'drop' | 'downgrade' | 'ask';

export const ChallengeOutputSchema = z.object({
  outcome: z.enum(['keep', 'drop', 'downgrade', 'ask']),
  ground: z.enum(['unreachable', 'pre-existing', 'guarded-elsewhere', 'documented-intent', 'smaller', 'none']),
  explanation: z.string(),
  refutation: z.object({ path: z.string(), quote: z.string(), where: z.enum(['head', 'base', 'standard']) }).nullable(),
  newSeverity: SeveritySchema.nullable(),
  checked: z.string(),
});
export type ChallengeOutput = z.infer<typeof ChallengeOutputSchema>;

/** A candidate that survived the challenge, with one or two sentences on what the challenger looked at. */
export type KeptCandidate = AnchoredCandidate & { checked: string };

export interface ChallengeResult {
  kept: KeptCandidate[];
  dropped: Dropped[];
  errors: StageError[];
  usage: AgentUsage[];
  /** Plain sentences saying what a request was not shown because of a size limit. */
  limits: string[];
}

type Item = AnchoredCandidate;
type Outcome = { kept: KeptCandidate } | { dropped: Dropped };

const NOT_CHALLENGED = 'not challenged';
const DID_NOT_COMPLETE = 'challenge did not complete';
const NOTHING_SAID = 'checked, no refutation found';
const UNCONFIRMED = ' The refutation it offered could not be confirmed in the code, so the finding stands.';

const isChallenged = (c: Item): boolean => c.severity === 'block' || c.severity === 'fix';
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const orNotGiven = (text: string): string => (text.trim() === '' ? '(not given)' : text);

// ---- Material ----

function whereText(c: Item): string {
  const { status, startLine, endLine } = c.anchor;
  const lines = startLine === null ? ''
    : endLine === null || endLine === startLine ? `, line ${startLine}` : `, lines ${startLine}-${endLine}`;
  return `${c.path}${lines}${status === 'outside-diff' ? ', outside the diff' : ''}`;
}

const indented = (text: string): string[] => text.split('\n').map((l) => `    ${l}`);

function findingBlock(c: Item): string {
  const connected = c.connected.length === 0 ? ['(none)'] : c.connected.flatMap((p) => [
    `- ${p.path}${p.line === null ? '' : `:${p.line}`} (${oneLine(p.role)})`,
    ...(p.quote.trim() === '' ? [] : indented(p.quote)),
  ]);
  return asMaterial('finding', [
    `Severity: ${c.severity}`,
    `Title: ${c.title}`,
    `Where: ${whereText(c)}`,
    'Quoted code:',
    ...indented(c.quote),
    `What happens: ${c.happens}`,
    `Why: ${c.why}`,
    `Suggested change: ${orNotGiven(c.suggestedChange)}`,
    'Connected places:',
    ...connected,
    `Would be wrong if: ${orNotGiven(c.wouldBeWrongIf)}`,
  ].join('\n'));
}

/** The finding, the pull request, the finding's cohort, the diff and facts of its files, then the repository's rule files. */
function challengeMaterial(ctx: LensContext, c: Item, tier: (path: string) => Tier): { material: string; cut: DiffCut | null } {
  const paths = new Set([c.path, ...c.connected.map((p) => p.path)]);
  const byPath = new Map(ctx.files.map((f) => [f.path, f]));
  const diffs = [...paths].flatMap((p) => byPath.get(p) ?? []);
  const cohort = c.cohortId === null ? undefined
    : [...ctx.map.cohorts, standaloneCohort(ctx.map)].find((k) => k.id === c.cohortId);
  const diff = diffs.length === 0 ? { text: '(none)', cut: null } : budgetedDiff(diffs, CHALLENGE_DIFF_LINE_BUDGET);
  const material = [
    findingBlock(c),
    prBlock(ctx.pr),
    ...(cohort ? [asMaterial('cohort', cohortOutline(cohort, tier).join('\n'))] : []),
    asMaterial('diff', diff.text),
    factsBlock(ctx.facts.filter((f) => paths.has(f.path))),
    ...ctx.repoRules.map((r) => asMaterial(`repository rule file ${r.path}`, r.text)),
  ].join('\n\n');
  return { material, cut: diff.cut };
}

// ---- The answer ----

/** Text that ends a sentence, with a full stop added when it has none. */
const asSentence = (text: string): string => (/[.!?]["')\]]*$/.test(text) ? text : `${text}.`);

const lowered = (current: Severity, proposed: Severity | null): Severity =>
  proposed !== null && SEVERITY_RANK[proposed] < SEVERITY_RANK[current] ? proposed : current;

/**
 * Applies the answer. A drop is honoured only on grounds 1 to 4 with a proved refutation (see proof.ts); a drop on the
 * ground `smaller` is a downgrade. A downgrade only lowers, and an ask becomes ask.
 */
async function applyAnswer(item: Item, answer: ChallengeOutput, evidence: Evidence): Promise<Outcome> {
  const checked = answer.checked.trim() === '' ? NOTHING_SAID : answer.checked.trim();
  const downgraded: Outcome = { kept: { ...item, severity: lowered(item.severity, answer.newSeverity), checked } };
  switch (answer.outcome) {
    case 'drop': {
      if (answer.ground === 'smaller') return downgraded;
      const proof = await proveDrop(item, answer.ground, answer.refutation, evidence);
      if (proof.place === null) {
        // On the finding's own lines the challenger reads the code differently; the reader should see its argument.
        const explanation = answer.explanation.trim();
        const said = proof.ownCode && explanation !== '' ? `${asSentence(checked)} ${explanation}` : checked;
        return { kept: { ...item, checked: `${asSentence(said)}${UNCONFIRMED}` } };
      }
      const candidate = plainCandidate(item);
      const note = proof.added === true ? ' (the proof is code this pull request added)' : '';
      const reason = `${answer.ground}: ${answer.explanation.trim()} (proof: ${proof.source})${note}`;
      return { dropped: { candidate, stage: 'challenge', reason, refutation: proof.place } };
    }
    case 'downgrade':
      return downgraded;
    case 'ask':
      return { kept: { ...item, severity: 'ask', checked } };
    case 'keep':
      return { kept: { ...item, checked } };
  }
}

/**
 * The challenge stage: one request per block or fix candidate tries to refute it. A candidate is removed only when the
 * refutation proves its ground (see proof.ts). Ask and note candidates pass through unchallenged. A request that fails,
 * or an item that throws, keeps its candidate and becomes a stage error; the others carry on. `kept` and `dropped` keep
 * the input order. `read` returns a file's text on one side, or null; it is called only to confirm refutations, once
 * per side and path.
 */
export async function challenge(
  runner: AgentRunner,
  ctx: LensContext,
  items: Item[],
  read: ReadFile,
): Promise<ChallengeResult> {
  const out: ChallengeResult = { kept: [], dropped: [], errors: [], usage: [], limits: [] };
  if (!items.some(isChallenged)) {
    out.kept = items.map((item) => ({ ...item, checked: NOT_CHALLENGED }));
    return out;
  }

  const instructions = instructionsFor(await loadTemplate('challenge'), ctx.packs, ctx.missingHelpers);
  const evidence = createEvidence(read, ctx.files, ctx.packs);
  const tier = tierOf(ctx.tiers);
  type ItemResult = Outcome & { usage?: AgentUsage; error?: StageError; limit?: string };
  const failed = (item: Item, message: string, usage: AgentUsage | undefined, kind?: StageErrorKind): ItemResult => ({
    kept: { ...item, checked: DID_NOT_COMPLETE }, ...(usage ? { usage } : {}),
    error: { stage: 'challenge', cohortId: item.cohortId, message: `${item.id}: ${message}`, ...(kind ? { kind } : {}) },
  });
  const results = await Promise.all(items.map(async (item): Promise<ItemResult> => {
    if (!isChallenged(item)) return { kept: { ...item, checked: NOT_CHALLENGED } };
    let usage: AgentUsage | undefined;
    let limit: string | undefined;
    try {
      const { material, cut } = challengeMaterial(ctx, item, tier);
      if (cut !== null) limit = diffCutSentence('challenge', item.title, cut);
      const result = await sendRequest<ChallengeOutput>(runner, ctx, {
        role: `challenge:${item.id}`,
        instructions,
        material,
        schema: ChallengeOutputSchema,
        cwd: ctx.headDir,
        extraDirs: [ctx.baseDir],
        model: ctx.models.challenger,
        effort: ctx.models.effort,
      });
      usage = result.usage;
      const noted = limit === undefined ? {} : { limit };
      if (!result.ok) return { ...failed(item, result.error, usage, result.kind), ...noted };
      return { ...(await applyAnswer(item, result.output, evidence)), usage, ...noted };
    } catch (err) {
      return { ...failed(item, err instanceof Error ? err.message : String(err), usage), ...(limit === undefined ? {} : { limit }) };
    }
  }));

  for (const r of results) {
    if ('kept' in r) out.kept.push(r.kept);
    else out.dropped.push(r.dropped);
    if (r.error) out.errors.push(r.error);
    if (r.usage) out.usage.push(r.usage);
    if (r.limit !== undefined) out.limits.push(r.limit);
  }
  return out;
}
