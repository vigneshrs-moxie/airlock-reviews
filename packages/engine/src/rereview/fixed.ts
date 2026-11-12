import { posix } from 'node:path';
import type { Anchor, FileDiff, Finding, StageError, StageErrorKind } from '@airlock/shared';
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

/**
 * What changed since the earlier review, which a fix's proof must be in: the diff from the earlier review's head to the
 * new head. When that head is gone (the branch was rewritten), the whole pull request's diff, with `rewritten` set.
 */
export interface ChangedSince {
  files: FileDiff[];
  rewritten: boolean;
}

/** What a vanished Ask or Note finding says in `checked`: it is marked fixed by code alone. */
export const FIXED_BY_CODE = 'The quoted code is gone; not checked further.';

/** What a fixed finding's `checked` begins with when the proof is that the faulty code was deleted. */
const REMOVED = 'The faulty code was removed.';

/** Added to a proof judged against the whole pull request because the earlier head is gone. */
const JUDGED_WHOLE = ' (the branch was rewritten, so this was judged against the whole pull request)';

const NOWHERE: Anchor = { status: 'not-found', startLine: null, endLine: null, comment: null };
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const asSentence = (text: string): string => (/[.!?]["')\]]*$/.test(text) ? text : `${text}.`);
const indented = (text: string): string[] => text.split('\n').map((l) => `    ${l}`);

/** A finding that is fixed: it is in neither list of the review and has no place at the head. */
const asFixed = (f: Finding, checked: string): Finding => ({ ...f, status: 'fixed', checked, bucket: 'also', rank: null, anchor: NOWHERE });

/** A vanished finding nothing confirmed: still open, with no place at the head. It is never fixed. */
export const leftOpen = (f: Finding): Finding => ({ ...f, status: 'still-open', anchor: NOWHERE });

/** A vanished finding whose check answered, but whose proof code refused: still open, with no place, saying why. */
const unconfirmed = (f: Finding, why: string): Finding => ({ ...leftOpen(f), checked: `Airlock could not confirm this was fixed: ${why}.` });

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

/**
 * The earlier finding, the pull request, then the diff since the earlier review of the finding's file (by either name) and
 * of its connected places' files.
 */
function material(ctx: LensContext, changed: ChangedSince, f: Finding): { text: string; cut: ReturnType<typeof budgetedDiff>['cut'] } {
  const paths = new Set([f.path, ...f.connected.map((p) => p.path)]);
  const diffs = changed.files.filter((d) => paths.has(d.path) || (d.oldPath !== null && paths.has(d.oldPath)));
  const diff = diffs.length === 0 ? { text: '(none)', cut: null } : budgetedDiff(diffs, CHALLENGE_DIFF_LINE_BUDGET);
  return { text: [findingBlock(f), prBlock(ctx.pr), asMaterial('diff', diff.text)].join('\n\n'), cut: diff.cut };
}

interface Outcome { fixed?: Finding; open?: Finding; error?: StageError; usage?: AgentUsage; limit?: string }

const squash = (text: string): string => text.replace(/\s+/g, '');

/**
 * True when one of the head file's lines `startLine` to `endLine` is a line of substance that `files` (what changed since
 * the earlier review) adds: a line already there before, or in a file nothing changed, cannot be what fixed it.
 */
function addedHere(files: FileDiff[], path: string, lines: { startLine: number; endLine: number }): boolean {
  return files.filter((d) => d.path === path).some((d) => d.hunks.some((h) => h.lines.some((l) =>
    l.kind === 'add' && l.newNo !== null && l.newNo >= lines.startLine && l.newNo <= lines.endLine && hasSubstance(l.text))));
}

/** The finding's own earlier quote: its lines of substance, without white space. */
const ownLines = (f: Finding): string[] => f.quote.split('\n').filter(hasSubstance).map(squash);

/**
 * True when every line of substance of the finding's own earlier quote is among the lines `files` (what changed since the
 * earlier review) deletes from the finding's file, under its earlier name or the one it was renamed to.
 */
function deletedHere(files: FileDiff[], f: Finding): boolean {
  const own = ownLines(f);
  if (own.length === 0) return false;
  const gone = new Set(files.filter((d) => d.path === f.path || d.oldPath === f.path)
    .flatMap((d) => d.hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'del').map((l) => squash(l.text)))));
  return own.every((l) => gone.has(l));
}

/**
 * The finding's file at the head (or the file it was renamed to) when the finding's own code is still in it, white space
 * and line breaks aside, else null: deleting its lines only to write it again in another shape is not removing it.
 */
async function stillInFile(files: FileDiff[], f: Finding, read: (path: string) => Promise<string | null>): Promise<string | null> {
  const path = files.find((d) => d.status === 'renamed' && d.oldPath === f.path)?.path ?? f.path;
  const text = await read(path);
  return text !== null && squash(text).includes(ownLines(f).join('')) ? path : null;
}

/** True when a line of `quote` with substance is a line of the finding's own earlier quote, white space aside. */
function quotesOwnCode(f: Finding, quote: string): boolean {
  const own = new Set(f.quote.split('\n').map(squash).filter((l) => l !== ''));
  return quote.split('\n').some((l) => hasSubstance(l) && own.has(squash(l)));
}

/**
 * Applies the answer, judging it against `changed` (what changed since the earlier review). `fixed` counts only when its
 * quote is real code at the head (a safe path, at least one line of substance, not only comments, not the finding's own
 * code) that code finds whole in that file, and either the place found holds a line of substance changed since the
 * earlier review (see addedHere), or every line of substance of the finding's own quote was deleted since then (see
 * deletedHere) and that code is not still in its file in another shape; `checked` then begins REMOVED. The proof names the
 * place. `still-open` counts only when the anchoring the anchor stage uses finds its quote at the head: the finding is
 * then `moved` there, keeping its old fingerprint as an alias. An answer code cannot confirm leaves the finding open with
 * no place, its `checked` saying why; it is an answer, not a failed stage, so it adds no stage error.
 */
async function apply(ctx: LensContext, changed: ChangedSince, f: Finding, answer: FixedCheckOutput): Promise<Outcome> {
  const refused = (why: string): Outcome => ({ open: unconfirmed(f, why) });
  const evidence = answer.evidence;
  const said = answer.outcome === 'fixed' ? 'said it is fixed' : 'said it is still open';
  if (evidence === null) return refused(`the check ${said} but quoted no code at the head`);
  const read = (path: string): Promise<string | null> => safeRead(ctx.headDir, path);
  const whole = changed.rewritten ? JUDGED_WHOLE : '';
  // The finding's own earlier code, found in another place, is the faulty code moved, not a fix: it is placed there.
  const ownCode = quotesOwnCode(f, evidence.quote);
  if (answer.outcome === 'fixed' && !ownCode) {
    const proves = isSafePath(evidence.path) && hasSubstance(evidence.quote) && !onlyComments(evidence.quote);
    const found = proves ? findQuote(await read(evidence.path), evidence.quote) : [];
    if (found.length === 0) return refused(`the code the check gave as the fix was not found in ${evidence.path} at the head`);
    const path = posix.normalize(evidence.path);
    const why = [answer.explanation, answer.checked].map((t) => t.trim()).find((t) => t !== '') ?? 'The check found it fixed';
    const proof = (at: { startLine: number }): string => `${asSentence(why)} Proof: ${evidence.path}:${at.startLine} on the head${whole}.`;
    const added = found.find((at) => addedHere(changed.files, path, at));
    if (added !== undefined) return { fixed: asFixed(f, proof(added)) };
    if (deletedHere(changed.files, f)) {
      const still = await stillInFile(changed.files, f, read);
      if (still === null) return { fixed: asFixed(f, `${REMOVED} ${proof(found[0]!)}`) };
      return refused(`its quoted code was deleted but is still in ${still} at the head in another shape${whole}`);
    }
    return refused(`the code the check gave as the fix, in ${evidence.path}, was not changed since the last review, and the faulty code was not removed${whole}`);
  }
  const { anchored } = await anchorCandidates(
    [{ ...f, path: evidence.path, quote: evidence.quote, lineHint: null }], ctx.files, read, ctx.push?.whole ?? undefined,
  );
  const placed = anchored[0];
  if (placed === undefined) {
    return refused(ownCode
      ? `the check gave the finding's own code in ${evidence.path} as the fix, but it was not found there at the head`
      : `the check ${said} in ${evidence.path}, but its quote was not found there at the head`);
  }
  return { open: withPlace({ ...placed, lineHint: f.lineHint, status: 'moved' }) };
}

/**
 * The fixed check for the earlier findings whose quoted code is gone. Each Block or Fix finding gets one request (the
 * challenger, read tools on both worktrees) that answers `fixed` with the line at the head that now prevents the
 * consequence, or `still-open` with where the problem now is; code then checks the quote against `changed` (see apply).
 * An answer code cannot confirm leaves the finding open with no place, saying why. A request that fails (a timeout, a turn
 * limit, unusable output, a usage limit) leaves it open with no place and adds a stage error. Neither is ever fixed. Ask
 * and Note findings are fixed by code alone, without a request. Both lists keep the order given. `changed` defaults to the
 * review's own diff, which on a push re-review is what changed since the earlier review.
 */
export async function confirmFixed(
  runner: AgentRunner, ctx: LensContext, vanished: Finding[], changed: ChangedSince = { files: ctx.files, rewritten: false },
): Promise<FixedCheckResult> {
  const out: FixedCheckResult = { fixed: [], open: [], errors: [], usage: [], limits: [] };
  const instructions = vanished.some(needsCheck) ? instructionsFor(await loadTemplate('fixed-check'), ctx.packs, ctx.missingHelpers) : '';
  const results = await Promise.all(vanished.map(async (f): Promise<Outcome> => {
    if (!needsCheck(f)) return { fixed: fixedByCode(f) };
    let usage: AgentUsage | undefined;
    let limit: string | undefined;
    try {
      const { text, cut } = material(ctx, changed, f);
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
      return { ...(await apply(ctx, changed, f, result.output)), ...noted };
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
