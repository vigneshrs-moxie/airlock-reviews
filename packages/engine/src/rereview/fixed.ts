import type { Anchor, Finding, StageError, StageErrorKind } from '@airlock/shared';
import { z } from 'zod';
import { asMaterial, loadTemplate } from '../agent/prompt.js';
import type { AgentRunner, AgentUsage } from '../agent/runner.js';
import { anchorCandidates, findQuote } from '../anchor/anchor.js';
import { CHALLENGE_DIFF_LINE_BUDGET } from '../challenge/challenge.js';
import { hasSubstance, isSafePath, onlyComments } from '../challenge/proof.js';
import { budgetedDiff } from '../lenses/cohort-lens.js';
import { diffCutSentence, instructionsFor, prBlock, sendRequest, type LensContext } from '../lenses/context.js';
import { safeRead } from '../util/safe-read.js';
import { withPlace } from './carry.js';

export const FixedCheckOutputSchema = z.object({
  outcome: z.enum(['fixed', 'still-open']),
  /** For `fixed`, the line at the head that now prevents the consequence; for `still-open`, where the problem now is. */
  evidence: z.object({ path: z.string(), quote: z.string() }).nullable(),
  explanation: z.string(),
  checked: z.string(),
});
export type FixedCheckOutput = z.infer<typeof FixedCheckOutputSchema>;

export interface FixedCheckResult {
  /** Findings that are fixed: status `fixed`, the reason in `checked`, placed nowhere at the head. */
  fixed: Finding[];
  /** Findings still open: `moved` to where the check placed them, or `still-open` with no place when nothing was confirmed. */
  open: Finding[];
  errors: StageError[];
  usage: AgentUsage[];
  /** Plain sentences saying what a request was not shown because of a size limit. */
  limits: string[];
}

/** What a vanished Ask or Note finding says in `checked`: it is marked fixed by code alone. */
export const FIXED_BY_CODE = 'The quoted code is gone; not checked further.';

const NOWHERE: Anchor = { status: 'not-found', startLine: null, endLine: null, comment: null };
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const asSentence = (text: string): string => (/[.!?]["')\]]*$/.test(text) ? text : `${text}.`);
const indented = (text: string): string[] => text.split('\n').map((l) => `    ${l}`);

/** A finding that is fixed: it is in neither list of the review and has no place at the head. */
const asFixed = (f: Finding, checked: string): Finding => ({ ...f, status: 'fixed', checked, bucket: 'also', rank: null, anchor: NOWHERE });

/** A vanished finding nothing confirmed: still open, with no place at the head. It is never fixed. */
export const leftOpen = (f: Finding): Finding => ({ ...f, status: 'still-open', anchor: NOWHERE });

/** A vanished Ask or Note finding: fixed by code alone, saying it was not checked further. */
export const fixedByCode = (f: Finding): Finding => asFixed(f, FIXED_BY_CODE);

/** Whether a vanished finding needs the request: only Block and Fix findings are checked; Ask and Note are fixed by code. */
export const needsCheck = (f: Finding): boolean => f.severity === 'block' || f.severity === 'fix';

function whereItWas(f: Finding): string {
  const { startLine, endLine } = f.anchor;
  const lines = startLine === null ? '' : endLine === null || endLine === startLine ? `, line ${startLine}` : `, lines ${startLine}-${endLine}`;
  return `${f.path}${lines}`;
}

function findingBlock(f: Finding): string {
  const connected = f.connected.length === 0 ? ['(none)'] : f.connected.flatMap((p) => [
    `- ${p.path}${p.line === null ? '' : `:${p.line}`} (${oneLine(p.role)})`,
    ...(p.quote.trim() === '' ? [] : indented(p.quote)),
  ]);
  const orNotGiven = (text: string): string => (text.trim() === '' ? '(not given)' : text);
  return asMaterial('earlier finding', [
    `Severity: ${f.severity}`,
    `Title: ${f.title}`,
    `Where it was at the last review: ${whereItWas(f)}`,
    'Quoted code at the last review:',
    ...indented(f.quote),
    `What happens: ${f.happens}`,
    `Why: ${f.why}`,
    `Suggested change: ${orNotGiven(f.suggestedChange)}`,
    'Connected places:',
    ...connected,
  ].join('\n'));
}

/** The earlier finding, the pull request, then the diff of the finding's file (by either name) and of its connected places' files. */
function material(ctx: LensContext, f: Finding): { text: string; cut: ReturnType<typeof budgetedDiff>['cut'] } {
  const paths = new Set([f.path, ...f.connected.map((p) => p.path)]);
  const diffs = ctx.files.filter((d) => paths.has(d.path) || (d.oldPath !== null && paths.has(d.oldPath)));
  const diff = diffs.length === 0 ? { text: '(none)', cut: null } : budgetedDiff(diffs, CHALLENGE_DIFF_LINE_BUDGET);
  return { text: [findingBlock(f), prBlock(ctx.pr), asMaterial('diff', diff.text)].join('\n\n'), cut: diff.cut };
}

interface Outcome { fixed?: Finding; open?: Finding; error?: StageError; usage?: AgentUsage; limit?: string }

/**
 * Applies the answer. `fixed` counts only when its quote is real code at the head (a safe path, at least one line of
 * substance, not only comments) and code finds the whole quote in that file. `still-open` counts only when the anchoring
 * the anchor stage uses finds its quote at the head: the finding is then `moved` there, keeping its old fingerprint as an
 * alias. Anything else leaves it open with no place and is an error.
 */
async function apply(ctx: LensContext, f: Finding, answer: FixedCheckOutput): Promise<Outcome> {
  const failed = (why: string): Outcome => ({ open: leftOpen(f), error: { stage: 'challenge', cohortId: f.cohortId, message: `${f.id}: ${why}` } });
  const evidence = answer.evidence;
  if (evidence === null) return failed(`the check answered "${answer.outcome}" without saying where; the finding stays open`);
  const read = (path: string): Promise<string | null> => safeRead(ctx.headDir, path);
  if (answer.outcome === 'fixed') {
    const proves = isSafePath(evidence.path) && hasSubstance(evidence.quote) && !onlyComments(evidence.quote);
    const found = proves ? findQuote(await read(evidence.path), evidence.quote) : [];
    if (found.length === 0) return failed(`the check said it is fixed, but its quote was not found as code in ${evidence.path} at the head; the finding stays open`);
    const said = [answer.explanation, answer.checked].map((t) => t.trim()).find((t) => t !== '') ?? 'The check found it fixed';
    return { fixed: asFixed(f, `${asSentence(said)} Proof: ${evidence.path}:${found[0]!.startLine} on the head.`) };
  }
  const { anchored } = await anchorCandidates(
    [{ ...f, path: evidence.path, quote: evidence.quote, lineHint: null }], ctx.files, read, ctx.push?.whole ?? undefined,
  );
  const placed = anchored[0];
  if (placed === undefined) return failed(`the check said it is still open, but its quote was not found in ${evidence.path} at the head; the finding stays open`);
  return { open: withPlace({ ...placed, lineHint: f.lineHint, status: 'moved' }) };
}

/**
 * The fixed check for the earlier findings whose quoted code is gone. Each Block or Fix finding gets one request (the
 * challenger, read tools on both worktrees) that answers `fixed` with the line at the head that now prevents the
 * consequence, or `still-open` with where the problem now is; code then checks the quote (see apply). A request that
 * fails, or an answer code cannot confirm, leaves the finding open with no place and adds a stage error: it is never
 * fixed. Ask and Note findings are fixed by code alone, without a request. Both lists keep the order given.
 */
export async function confirmFixed(runner: AgentRunner, ctx: LensContext, vanished: Finding[]): Promise<FixedCheckResult> {
  const out: FixedCheckResult = { fixed: [], open: [], errors: [], usage: [], limits: [] };
  const instructions = vanished.some(needsCheck) ? instructionsFor(await loadTemplate('fixed-check'), ctx.packs, ctx.missingHelpers) : '';
  const results = await Promise.all(vanished.map(async (f): Promise<Outcome> => {
    if (!needsCheck(f)) return { fixed: fixedByCode(f) };
    let usage: AgentUsage | undefined;
    let limit: string | undefined;
    try {
      const { text, cut } = material(ctx, f);
      if (cut !== null) limit = diffCutSentence('fixed check', f.title, cut);
      const result = await sendRequest<FixedCheckOutput>(runner, ctx, {
        role: `challenge:fixed:${f.id}`,
        instructions,
        material: text,
        schema: FixedCheckOutputSchema,
        cwd: ctx.headDir,
        extraDirs: [ctx.baseDir],
        model: ctx.models.challenger,
        effort: ctx.models.effort,
      });
      usage = result.usage;
      const noted = { ...(limit === undefined ? {} : { limit }), usage };
      if (!result.ok) {
        const kind: StageErrorKind = result.kind;
        return { open: leftOpen(f), error: { stage: 'challenge', cohortId: f.cohortId, message: `${f.id}: ${result.error}`, kind }, ...noted };
      }
      return { ...(await apply(ctx, f, result.output)), ...noted };
    } catch (err) {
      const message = `${f.id}: ${err instanceof Error ? err.message : String(err)}`;
      return { open: leftOpen(f), error: { stage: 'challenge', cohortId: f.cohortId, message }, ...(usage ? { usage } : {}) };
    }
  }));
  for (const r of results) {
    if (r.fixed) out.fixed.push(r.fixed);
    if (r.open) out.open.push(r.open);
    if (r.error) out.errors.push(r.error);
    if (r.usage) out.usage.push(r.usage);
    if (r.limit !== undefined) out.limits.push(r.limit);
  }
  return out;
}
