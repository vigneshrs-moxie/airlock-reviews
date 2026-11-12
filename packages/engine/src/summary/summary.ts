import { SEVERITY_WORD } from '@airlock/shared';
import type { Brief, Finding } from '@airlock/shared';
import { z } from 'zod';
import { asMaterial, loadTemplate } from '../agent/prompt.js';
import type { AgentRunner, AgentUsage } from '../agent/runner.js';
import { instructionsFor, orNone, sendRequest, type LensContext } from '../lenses/context.js';

/** The longest `short` of a finding, `gist` of a finding and `inShort` of the brief kept; the document's schema says the same. */
export const MAX_SHORT = 60;
export const MAX_GIST = 200;
export const MAX_IN_SHORT = 200;

/** The note the document carries when the stage wrote nothing. */
export const SUMMARY_FAILED_NOTE = 'Short summaries could not be written, so the panel shows the full text cut down.';

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
  /** SUMMARY_FAILED_NOTE when the stage wrote nothing (the findings and the brief are then as given), else null. */
  note: string | null;
  usage: AgentUsage[];
}

/** A line break (any kind), a control character, or a character that reorders text on screen. */
const NOT_PLAIN = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;

/**
 * The value trimmed, when it is one line of plain text of at most `max` characters (counted as the document's schema
 * counts them); otherwise null. A value too long is dropped, never cut.
 */
export function plainLine(value: string, max: number): string | null {
  const text = value.trim();
  return text === '' || text.length > max || NOT_PLAIN.test(text) ? null : text;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

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
    got.short ??= plainLine(e.short, MAX_SHORT) ?? undefined;
    got.gist ??= plainLine(e.gist, MAX_GIST) ?? undefined;
    values.set(e.id, got);
  }
  const inShort = plainLine(answer.inShort, MAX_IN_SHORT);
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
 * does (`ctx.brief`); a request is made even when there are no findings. Only the findings' kind, title, what happens,
 * why and the suggested change, and the brief's `whatItDoes`, are sent, all as material. Each value is checked in code
 * (see plainLine); a bad one is dropped and the others kept, and an id that is not a finding given is ignored. On success
 * every finding carries only what this request gave it, so a carried finding's earlier values are replaced. When the
 * request fails or nothing valid comes back, the findings and the brief are returned as given with the note: it is never
 * a stage error. Nothing but the panel reads what this writes.
 */
export async function summarise(runner: AgentRunner, ctx: LensContext, findings: Finding[]): Promise<SummaryResult> {
  const failed = (usage: AgentUsage[]): SummaryResult => ({ findings, brief: ctx.brief, note: SUMMARY_FAILED_NOTE, usage });
  let template: string;
  try {
    template = await loadTemplate('summary');
  } catch {
    return failed([]);
  }
  const result = await sendRequest<SummaryOutput>(runner, ctx, {
    role: 'summary',
    instructions: instructionsFor(template, [], []),
    material: summaryMaterial(ctx.brief, findings),
    schema: SummaryOutputSchema,
    cwd: ctx.headDir,
    model: ctx.models.sweep,
    effort: ctx.models.effort,
  });
  const usage = [result.usage];
  if (!result.ok) return failed(usage);
  const applied = apply(findings, ctx.brief, result.output);
  return applied === null ? failed(usage) : { ...applied, note: null, usage };
}
