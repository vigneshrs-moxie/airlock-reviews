import type { Anchor, Candidate, Dropped, Place, Severity, StageError, Tier } from '@airlock/shared';
import { SeveritySchema } from '@airlock/shared';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { asMaterial, loadTemplate } from '../agent/prompt.js';
import type { AgentRunner, AgentUsage } from '../agent/runner.js';
import { anchorQuote } from '../anchor/anchor.js';
import { budgetedDiff } from '../lenses/cohort-lens.js';
import { cohortOutline, factsBlock, instructionsFor, prBlock, sendRequest, standaloneCohort, tierOf } from '../lenses/context.js';
import type { LensContext } from '../lenses/context.js';
import { SEVERITY_RANK } from '../rules/sweep.js';

/** The challenge's diff budget, in lines of formatForPrompt output, shared by the finding's file and its connected files. */
export const CHALLENGE_DIFF_LINE_BUDGET = 600;

export type ChallengeOutcome = 'keep' | 'drop' | 'downgrade' | 'ask';

export const ChallengeOutputSchema = z.object({
  outcome: z.enum(['keep', 'drop', 'downgrade', 'ask']),
  ground: z.enum(['unreachable', 'pre-existing', 'guarded-elsewhere', 'documented-intent', 'smaller', 'none']),
  explanation: z.string(),
  refutation: z.object({ path: z.string(), quote: z.string(), where: z.enum(['head', 'base']) }).nullable(),
  newSeverity: SeveritySchema.nullable(),
  checked: z.string(),
});
export type ChallengeOutput = z.infer<typeof ChallengeOutputSchema>;

/** A candidate that survived the challenge, with one or two sentences on what the challenger looked at. */
export type KeptCandidate = Candidate & { anchor: Anchor; checked: string };

export interface ChallengeResult {
  kept: KeptCandidate[];
  dropped: Dropped[];
  errors: StageError[];
  usage: AgentUsage[];
}

type Item = Candidate & { anchor: Anchor };
type Side = 'head' | 'base';
type ReadFile = (where: Side, path: string) => Promise<string | null>;
type Outcome = { kept: KeptCandidate } | { dropped: Dropped };

const NOT_CHALLENGED = 'not challenged';
const DID_NOT_COMPLETE = 'challenge did not complete';
const NOTHING_SAID = 'checked, no refutation found';
const UNCONFIRMED = ' The refutation it offered could not be confirmed in the code, so the finding stands.';

const isChallenged = (c: Item): boolean => c.severity === 'block' || c.severity === 'fix';
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const orNotGiven = (text: string): string => (text.trim() === '' ? '(not given)' : text);

/** A path inside the repository: not empty, not absolute and with no `..` segment. */
const isRepoRelative = (path: string): boolean =>
  path.trim() !== '' && !isAbsolute(path) && !path.split(/[\\/]/).includes('..');

/** `read` with each side and path asked for once; a read that fails counts as a missing file. */
function readOnce(read: ReadFile): ReadFile {
  const cache = new Map<string, Promise<string | null>>();
  return (where, path) => {
    const key = `${where}\0${path}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = Promise.resolve().then(() => read(where, path)).catch(() => null);
      cache.set(key, hit);
    }
    return hit;
  };
}

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
function challengeMaterial(ctx: LensContext, c: Item, tier: (path: string) => Tier): string {
  const paths = new Set([c.path, ...c.connected.map((p) => p.path)]);
  const byPath = new Map(ctx.files.map((f) => [f.path, f]));
  const diffs = [...paths].flatMap((p) => byPath.get(p) ?? []);
  const cohort = c.cohortId === null ? undefined
    : [...ctx.map.cohorts, standaloneCohort(ctx.map)].find((k) => k.id === c.cohortId);
  return [
    findingBlock(c),
    prBlock(ctx.pr),
    ...(cohort ? [asMaterial('cohort', cohortOutline(cohort, tier).join('\n'))] : []),
    asMaterial('diff', diffs.length === 0 ? '(none)' : budgetedDiff(diffs, CHALLENGE_DIFF_LINE_BUDGET)),
    factsBlock(ctx.facts.filter((f) => paths.has(f.path))),
    ...ctx.repoRules.map((r) => asMaterial(`repository rule file ${r.path}`, r.text)),
  ].join('\n\n');
}

// ---- The answer ----

/** The place the refutation quotes, when its quote is found in that file on that side. */
async function confirmRefutation(refutation: ChallengeOutput['refutation'], read: ReadFile): Promise<Place | null> {
  if (refutation === null || !isRepoRelative(refutation.path)) return null;
  const found = anchorQuote(await read(refutation.where, refutation.path), refutation.quote, null, undefined);
  if (found.status === 'not-found') return null;
  return { path: refutation.path, line: found.startLine, role: refutation.where, quote: refutation.quote };
}

const lowered = (current: Severity, proposed: Severity | null): Severity =>
  proposed !== null && SEVERITY_RANK[proposed] < SEVERITY_RANK[current] ? proposed : current;

/** Applies the answer: a drop needs a refutation found in the code, a downgrade only lowers, an ask becomes ask. */
async function applyAnswer(item: Item, answer: ChallengeOutput, read: ReadFile): Promise<Outcome> {
  const checked = answer.checked.trim() === '' ? NOTHING_SAID : answer.checked.trim();
  switch (answer.outcome) {
    case 'drop': {
      const place = await confirmRefutation(answer.refutation, read);
      if (place === null) return { kept: { ...item, checked: `${checked}${UNCONFIRMED}` } };
      const { anchor: _anchor, ...candidate } = item;
      const reason = `${answer.ground}: ${answer.explanation.trim()}`;
      return { dropped: { candidate, stage: 'challenge', reason, refutation: place } };
    }
    case 'downgrade':
      return { kept: { ...item, severity: lowered(item.severity, answer.newSeverity), checked } };
    case 'ask':
      return { kept: { ...item, severity: 'ask', checked } };
    case 'keep':
      return { kept: { ...item, checked } };
  }
}

/**
 * The challenge stage: one request per block or fix candidate tries to refute it. A candidate is removed only when the
 * code the challenger quotes is found on the side it names. Ask and note candidates pass through unchallenged. A failed
 * request keeps its candidate and becomes a stage error; the others carry on. `kept` and `dropped` keep the input order.
 * `read` returns a file's text on one side, or null; it is called only to confirm refutations, once per side and path.
 */
export async function challenge(
  runner: AgentRunner,
  ctx: LensContext,
  items: Item[],
  read: ReadFile,
): Promise<ChallengeResult> {
  const out: ChallengeResult = { kept: [], dropped: [], errors: [], usage: [] };
  if (!items.some(isChallenged)) {
    out.kept = items.map((item) => ({ ...item, checked: NOT_CHALLENGED }));
    return out;
  }

  const instructions = instructionsFor(await loadTemplate('challenge'), ctx.packs, null);
  const tier = tierOf(ctx.tiers);
  const readFile = readOnce(read);
  const results = await Promise.all(items.map(async (item): Promise<Outcome & { usage?: AgentUsage; error?: StageError }> => {
    if (!isChallenged(item)) return { kept: { ...item, checked: NOT_CHALLENGED } };
    const result = await sendRequest<ChallengeOutput>(runner, ctx, {
      role: `challenge:${item.id}`,
      instructions,
      material: challengeMaterial(ctx, item, tier),
      schema: ChallengeOutputSchema,
      cwd: ctx.headDir,
      extraDirs: [ctx.baseDir],
      model: ctx.models.challenger,
      effort: ctx.models.effort,
    });
    if (!result.ok) {
      return {
        kept: { ...item, checked: DID_NOT_COMPLETE }, usage: result.usage,
        error: { stage: 'challenge', cohortId: item.cohortId, message: `${item.id}: ${result.error}` },
      };
    }
    return { ...(await applyAnswer(item, result.output, readFile)), usage: result.usage };
  }));

  for (const r of results) {
    if ('kept' in r) out.kept.push(r.kept);
    else out.dropped.push(r.dropped);
    if (r.error) out.errors.push(r.error);
    if (r.usage) out.usage.push(r.usage);
  }
  return out;
}
