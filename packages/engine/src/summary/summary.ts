import { SEVERITY_WORD, visibleText } from '@airlock/shared';
import type { Brief, Finding } from '@airlock/shared';
import { z } from 'zod';
import { asMaterial, loadTemplate } from '../agent/prompt.js';
import type { AgentRunner, AgentUsage } from '../agent/runner.js';
import { instructionsFor, oneLine, orNone, sendRequest, type LensContext } from '../lenses/context.js';

/** The longest `short` of a finding, `gist` of a finding and `inShort` of the brief kept; the document's schema says the same. */
export const MAX_SHORT = 60;
export const MAX_GIST = 200;
export const MAX_IN_SHORT = 200;

/**
 * The note the document carries when the stage wrote nothing. On a re-review a carried finding keeps the short version
 * the earlier review gave it, so only the findings without one fall back.
 */
export const SUMMARY_FAILED_NOTE = 'Short summaries could not be written, so findings without one show their full text cut down.';

/** The note for `n` shown findings left with neither a short title nor a summary after a request that worked. */
export const missingSummariesNote = (n: number): string => (n === 1
  ? '1 finding has no short summary and shows its full text cut down.'
  : `${n} findings have no short summary and show their full text cut down.`);

export const SummaryOutputSchema = z.object({
  inShort: z.string(),
  findings: z.array(z.object({ id: z.string(), short: z.string(), gist: z.string() })),
});
export type SummaryOutput = z.infer<typeof SummaryOutputSchema>;

export interface SummaryResult {
  /** The findings given, in the same order: on success each with only the values this request gave it. */
  findings: Finding[];
  /** The brief given; on success with `inShort` when a valid one was written. */
  brief: Brief;
  /**
   * For the document's notes: SUMMARY_FAILED_NOTE when the stage wrote nothing (the findings and the brief are then as
   * given); after a request that worked, missingSummariesNote when some findings got no value; else none.
   */
  notes: string[];
  usage: AgentUsage[];
}

/** The stage's result when it wrote nothing: what it was given, unchanged, with the note. */
export const summaryFailed = (findings: Finding[], brief: Brief, usage: AgentUsage[] = []): SummaryResult =>
  ({ findings, brief, notes: [SUMMARY_FAILED_NOTE], usage });

/**
 * Words that tell the reader a finding is fine or the change can go in, in any letter case. A summary only restates a
 * finding; it never judges it, so a value holding one of these is dropped and the panel shows the full text. This is a
 * narrow net for a hostile or careless summary, not a proof that a value is faithful to its finding.
 */
const VERDICT_WORDS = [
  'approved', 'approve this', 'lgtm', 'looks good', 'safe to merge', 'ready to merge', 'nothing to fix', 'no issues',
  'no problems', 'not a problem', 'can be ignored', 'ignore this',
];
const READS_LIKE_VERDICT = new RegExp(`\\b(?:${VERDICT_WORDS.map((w) => w.replaceAll(' ', '\\s+')).join('|')})\\b`, 'i');

/** Line feed and tab, which visibleText keeps, and lone surrogates, which it does not look for. */
const NOT_ONE_LINE = /[\n\t\p{Cs}]/u;

/**
 * The value trimmed, when it is one line of plain, visible text of at most `max` characters that does not read like a
 * verdict; otherwise null. Characters are counted as code points, as the document's schema (zod's `max`) counts them, so
 * an emoji is one. A value too long is dropped, never cut. Hidden
 * characters are whatever the repository's visibleText removes (controls, zero-width and bidirectional marks, tag
 * characters, line and paragraph separators, variation selectors), plus line feeds, tabs and lone surrogates.
 */
export function summaryValue(value: string, max: number): string | null {
  const text = value.trim();
  if (text === '' || [...text].length > max) return null;
  if (visibleText(text).removed > 0 || NOT_ONE_LINE.test(text)) return null;
  return READS_LIKE_VERDICT.test(text) ? null : text;
}

/** One entry per finding, each field on its own line; a field is flattened to one line so it cannot start another entry. */
function findingEntry(f: Finding): string {
  return [
    `id: ${f.id}`, `kind: ${SEVERITY_WORD[f.severity]}`, `title: ${oneLine(f.title)}`, `happens: ${oneLine(f.happens)}`,
    `why: ${oneLine(f.why)}`, `suggested change: ${oneLine(f.suggestedChange)}`,
  ].join('\n');
}

/** Everything sent is model-written text from the pull request, so all of it is material. */
function summaryMaterial(brief: Brief, findings: Finding[]): string {
  return [
    asMaterial('what the change does', orNone(brief.whatItDoes.map((l) => `- ${oneLine(l)}`))),
    asMaterial('findings', findings.length === 0 ? '(none)' : findings.map(findingEntry).join('\n\n')),
  ].join('\n\n');
}

const withoutShort = ({ short: _s, gist: _g, ...rest }: Finding): Finding => rest;
const withoutInShort = ({ inShort: _i, ...rest }: Brief): Brief => rest;

/** The answer applied: each finding gets the first valid value of each field listed for its id; null when nothing is valid. */
function apply(findings: Finding[], brief: Brief, answer: SummaryOutput): { findings: Finding[]; brief: Brief } | null {
  const shown = new Set(findings.map((f) => f.id));
  const values = new Map<string, { short?: string; gist?: string }>();
  for (const e of answer.findings) {
    if (!shown.has(e.id)) continue;
    const got = values.get(e.id) ?? {};
    got.short ??= summaryValue(e.short, MAX_SHORT) ?? undefined;
    got.gist ??= summaryValue(e.gist, MAX_GIST) ?? undefined;
    values.set(e.id, got);
  }
  const inShort = summaryValue(answer.inShort, MAX_IN_SHORT);
  const anyValue = [...values.values()].some((v) => v.short !== undefined || v.gist !== undefined);
  if (inShort === null && !anyValue) return null;
  return {
    findings: findings.map((f) => {
      const { short, gist } = values.get(f.id) ?? {};
      return { ...withoutShort(f), ...(short === undefined ? {} : { short }), ...(gist === undefined ? {} : { gist }) };
    }),
    brief: { ...withoutInShort(brief), ...(inShort === null ? {} : { inShort }) },
  };
}

/**
 * The summary stage. One request on the fast model (`models.sweep`) writes, for a person who does not read code, a short
 * title and a one-line summary of each finding given (the top list and also found), and one sentence on what the change
 * does (`ctx.brief`); a request is made even when there are no findings. It is sent once (never again after a bad
 * answer), with no tools, and the runner gives the role a short time limit, so the stage cannot hold a review up for
 * long. Only the findings' kind, title, what happens, why and the suggested change, and the brief's `whatItDoes`, are
 * sent, all as material. Each value is checked in code (see summaryValue); a bad one is dropped and the others kept, and
 * an id that is not a finding given is ignored. On success every finding carries only what this request gave it, so a
 * carried finding's earlier values are replaced, and a note counts the findings left with none. When the request fails
 * or nothing valid comes back, the findings and the brief are returned as given with the failure note. It never throws.
 * Nothing but the panel reads what this writes.
 */
export async function summarise(runner: AgentRunner, ctx: LensContext, findings: Finding[]): Promise<SummaryResult> {
  try {
    const template = await loadTemplate('summary');
    const result = await sendRequest<SummaryOutput>(runner, ctx, {
      role: 'summary',
      instructions: instructionsFor(template, [], []),
      material: summaryMaterial(ctx.brief, findings),
      schema: SummaryOutputSchema,
      cwd: ctx.headDir,
      model: ctx.models.sweep,
      effort: ctx.models.effort,
      noRetry: true,
      noTools: true,
    });
    const usage = [result.usage];
    if (!result.ok) return summaryFailed(findings, ctx.brief, usage);
    const applied = apply(findings, ctx.brief, result.output);
    if (applied === null) return summaryFailed(findings, ctx.brief, usage);
    const without = applied.findings.filter((f) => f.short === undefined && f.gist === undefined).length;
    return { ...applied, notes: without === 0 ? [] : [missingSummariesNote(without)], usage };
  } catch {
    return summaryFailed(findings, ctx.brief);
  }
}
