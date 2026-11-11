import { randomBytes } from 'node:crypto';
import { CandidateSchema } from '@airlock/shared';
import type { Candidate, Dropped, Place, Question, Source } from '@airlock/shared';
import { z } from 'zod';

export const MAX_CANDIDATES_PER_LENS = 6;

const loose = z.string().optional();
/** A word from a fixed list, trimmed and lower-cased first, so "Block" or " high" is not lost; the model is sent the enum. */
const word = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.enum(values));
const SEVERITIES = ['block', 'fix', 'ask', 'note'] as const;
const CONFIDENCES = ['high', 'medium', 'low'] as const;

/**
 * Every field is optional, so the request does not fail when one candidate is incomplete. Severity and confidence are
 * enums and the line hint a whole number in the schema sent to the model, so the SDK has the model correct a wrong word
 * itself. acceptCandidates checks each candidate on its own against the shared CandidateSchema.
 */
export const RawCandidateSchema = z.object({
  severity: word(SEVERITIES).optional(), title: loose, path: loose, quote: loose, lineHint: z.number().int().nullable().optional(),
  happens: loose, why: loose, suggestedChange: loose,
  connected: z.array(z.object({ path: loose, quote: loose, role: loose })).optional(),
  wouldBeWrongIf: loose, confidence: word(CONFIDENCES).optional(),
});
export type RawCandidate = z.infer<typeof RawCandidateSchema>;

export const LensOutputSchema = z.object({ candidates: z.array(RawCandidateSchema), questions: z.array(z.string()) });
export type LensOutput = z.infer<typeof LensOutputSchema>;

/** A combined lens request returns candidates each tagged with the id (`<pack>/<lens>`) of the lens it belongs to. */
export const CombinedOutputSchema = z.object({
  candidates: z.array(RawCandidateSchema.extend({ lens: z.string().optional() })),
  questions: z.array(z.string()),
});
export type CombinedOutput = z.infer<typeof CombinedOutputSchema>;

/** A combined lens request may return at most this many candidates in all. */
export const MAX_CANDIDATES_COMBINED = 10;
/** The source of a combined request's questions, and of a candidate whose lens is not one that was given. */
export const COMBINED_SOURCE: Source = { pack: 'airlock', lens: 'combined', ruleId: null };

export interface Accepted { candidates: Candidate[]; dropped: Dropped[]; questions: Question[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const present = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** The connected places that have a path and a quote, each with no line yet; a missing role is empty. The rest are left out. */
function connectedPlaces(value: unknown): Place[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((p: unknown) => {
    if (!isObj(p)) return [];
    const path = present(p.path);
    const quote = present(p.quote);
    if (path === null || quote === null) return [];
    return [{ path, line: null, role: typeof p.role === 'string' ? p.role.trim() : '', quote: p.quote as string }];
  });
}

/** `c_` and 8 hex characters, never one already in `taken`; the new id is added to it. */
function newId(taken: Set<string>): string {
  let id: string;
  do id = `c_${randomBytes(4).toString('hex')}`; while (taken.has(id));
  taken.add(id);
  return id;
}

/** Trimmed and lower-cased when it is a string; anything else as it is. */
const asWord = (v: unknown): unknown => (typeof v === 'string' ? v.trim().toLowerCase() : v);
const MISSING = '(missing)';

/**
 * Why a candidate that has a quote and says what happens still fails the schema, in words, and a stand-in that passes it
 * so the Dropped entry can carry the rest: a blank text field reads `(missing)`, a severity outside the four words `note`,
 * a confidence outside the three `low`.
 */
function whyInvalid(fields: Record<string, unknown>, r: Record<string, unknown>): { reasons: string[]; standIn: Record<string, unknown> } {
  const reasons: string[] = [];
  const standIn = { ...fields };
  const blank = (key: string, reason: string): void => {
    if (present(fields[key]) !== null) return;
    reasons.push(reason);
    standIn[key] = MISSING;
  };
  if (!(SEVERITIES as readonly unknown[]).includes(fields.severity)) {
    reasons.push(r.severity === undefined ? 'it has no severity' : `the severity ${JSON.stringify(r.severity)} is not block, fix, ask or note`);
    standIn.severity = 'note';
  }
  blank('title', 'it has no title');
  blank('path', 'it names no file');
  blank('why', 'it does not say why');
  if (!(CONFIDENCES as readonly unknown[]).includes(fields.confidence)) {
    reasons.push(`the confidence ${JSON.stringify(r.confidence)} is not high, medium or low`);
    standIn.confidence = 'low';
  }
  for (const key of ['suggestedChange', 'wouldBeWrongIf'] as const) {
    if (typeof fields[key] !== 'string') {
      reasons.push(`its ${key} is not text`);
      standIn[key] = '';
    }
  }
  return { reasons, standIn };
}

/**
 * Turns a lens's raw candidates into checked ones. Each gets an id, the source and the cohort. Severity and confidence are
 * trimmed and lower-cased first. Missing parts that a one-place finding can lack get defaults: no connected places, an
 * empty suggested change and wouldBeWrongIf, medium confidence, no line hint (a line hint that is not a whole number is
 * only a hint, and counts as none); a connected place without a path or a quote is left out. A candidate with no quote or
 * that does not say what happens becomes a question when it has a title or says what happens, and is ignored otherwise.
 * Any other candidate that fails CandidateSchema (a blank title, path or why, a word outside its list) is dropped at stage
 * `schema` with the reason in words. Valid candidates after the first MAX_CANDIDATES_PER_LENS are dropped. Pass the same
 * `taken` set across calls to keep ids unique in a review.
 */
export function acceptCandidates(raw: unknown[], source: Source, cohortId: string | null, taken: Set<string> = new Set()): Accepted {
  const valid: Candidate[] = [];
  const invalid: Dropped[] = [];
  const questions: Question[] = [];
  for (const item of raw) {
    const r = isObj(item) ? item : {};
    const hint = typeof r.lineHint === 'number' && Number.isSafeInteger(r.lineHint) ? r.lineHint : null;
    const fields: Record<string, unknown> = {
      id: '', source, cohortId, severity: asWord(r.severity), title: r.title, path: r.path, quote: r.quote,
      lineHint: hint, happens: r.happens, why: r.why, suggestedChange: r.suggestedChange ?? '',
      connected: connectedPlaces(r.connected), wouldBeWrongIf: r.wouldBeWrongIf ?? '', confidence: asWord(r.confidence ?? 'medium'),
    };
    const parsed = CandidateSchema.safeParse(fields);
    if (parsed.success) {
      valid.push({ ...parsed.data, id: newId(taken) });
      continue;
    }
    // What the design keeps as a question: a point with no quote to anchor it, or no consequence.
    if (present(r.quote) === null || present(r.happens) === null) {
      const text = present(r.title) ?? present(r.happens);
      if (text !== null) questions.push({ text, cohortId, source });
      continue;
    }
    const { reasons, standIn } = whyInvalid(fields, r);
    const candidate = CandidateSchema.safeParse(standIn);
    if (!candidate.success || reasons.length === 0) continue; // cannot happen: every failing field has a stand-in
    invalid.push({ candidate: { ...candidate.data, id: newId(taken) }, stage: 'schema', reason: reasons.join('; '), refutation: null });
  }
  const dropped: Dropped[] = [...invalid, ...valid.slice(MAX_CANDIDATES_PER_LENS).map((candidate): Dropped => ({
    candidate, stage: 'schema', reason: `more than ${MAX_CANDIDATES_PER_LENS} candidates from one lens`, refutation: null,
  }))];
  return { candidates: valid.slice(0, MAX_CANDIDATES_PER_LENS), dropped, questions };
}

/**
 * Turns a combined lens request's raw candidates into checked ones, each with the source of the lens it names. A
 * candidate that names no lens, or a lens that was not given, is dropped at stage `schema`; valid candidates after the
 * first MAX_CANDIDATES_COMBINED are dropped too. Otherwise each is checked as acceptCandidates checks it.
 */
export function acceptCombined(
  raw: CombinedOutput['candidates'], lenses: ReadonlyMap<string, Source>, cohortId: string | null, taken: Set<string>,
): Accepted {
  const out: Accepted = { candidates: [], dropped: [], questions: [] };
  for (const item of raw) {
    const named = (item.lens ?? '').trim();
    const source = lenses.get(named) ?? null;
    const accepted = acceptCandidates([item], source ?? COMBINED_SOURCE, cohortId, taken);
    out.questions.push(...accepted.questions);
    out.dropped.push(...accepted.dropped);
    const candidate = accepted.candidates[0];
    if (candidate === undefined) continue;
    const reason = source === null ? (named === '' ? 'names no lens' : `names a lens that was not given: ${named}`)
      : out.candidates.length >= MAX_CANDIDATES_COMBINED ? `more than ${MAX_CANDIDATES_COMBINED} candidates from one combined request` : null;
    if (reason === null) out.candidates.push(candidate);
    else out.dropped.push({ candidate, stage: 'schema', reason, refutation: null });
  }
  return out;
}
