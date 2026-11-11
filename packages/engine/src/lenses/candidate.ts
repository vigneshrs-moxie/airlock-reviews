import { randomBytes } from 'node:crypto';
import { CandidateSchema } from '@airlock/shared';
import type { Candidate, Dropped, Place, Question, Source } from '@airlock/shared';
import { z } from 'zod';

export const MAX_CANDIDATES_PER_LENS = 6;

const loose = z.string().optional();

/**
 * Every field is optional, so the request does not fail when one candidate is incomplete. acceptCandidates checks each
 * candidate on its own against the shared CandidateSchema.
 */
export const RawCandidateSchema = z.object({
  severity: loose, title: loose, path: loose, quote: loose, lineHint: z.number().nullable().optional(),
  happens: loose, why: loose, suggestedChange: loose,
  connected: z.array(z.object({ path: loose, quote: loose, role: loose })).optional(),
  wouldBeWrongIf: loose, confidence: loose,
});
export type RawCandidate = z.infer<typeof RawCandidateSchema>;

export const LensOutputSchema = z.object({ candidates: z.array(RawCandidateSchema), questions: z.array(z.string()) });
export type LensOutput = z.infer<typeof LensOutputSchema>;

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

/**
 * Turns a lens's raw candidates into checked ones. Each gets an id, the source and the cohort. Missing parts that a
 * one-place finding can lack get defaults: no connected places, an empty suggested change and wouldBeWrongIf, medium
 * confidence, no line hint; a connected place without a path or a quote is left out. A candidate that still fails
 * CandidateSchema (a blank title, path, quote, happens or why, or a severity outside the four words) becomes a question
 * when it has a title or says what happens, and is ignored otherwise. Valid candidates after the
 * first MAX_CANDIDATES_PER_LENS are dropped. Pass the same `taken` set across calls to keep ids unique in a review.
 */
export function acceptCandidates(raw: unknown[], source: Source, cohortId: string | null, taken: Set<string> = new Set()): Accepted {
  const valid: Candidate[] = [];
  const questions: Question[] = [];
  for (const item of raw) {
    const r = isObj(item) ? item : {};
    const parsed = CandidateSchema.safeParse({
      id: '', source, cohortId, severity: r.severity, title: r.title, path: r.path, quote: r.quote,
      lineHint: r.lineHint ?? null, happens: r.happens, why: r.why, suggestedChange: r.suggestedChange ?? '',
      connected: connectedPlaces(r.connected), wouldBeWrongIf: r.wouldBeWrongIf ?? '', confidence: r.confidence ?? 'medium',
    });
    if (parsed.success) {
      valid.push({ ...parsed.data, id: newId(taken) });
      continue;
    }
    const text = present(r.title) ?? present(r.happens);
    if (text !== null) questions.push({ text, cohortId, source });
  }
  const dropped: Dropped[] = valid.slice(MAX_CANDIDATES_PER_LENS).map((candidate) => ({
    candidate, stage: 'schema', reason: `more than ${MAX_CANDIDATES_PER_LENS} candidates from one lens`, refutation: null,
  }));
  return { candidates: valid.slice(0, MAX_CANDIDATES_PER_LENS), dropped, questions };
}
