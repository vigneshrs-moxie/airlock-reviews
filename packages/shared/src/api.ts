import { z } from 'zod';
import { ReviewEventSchema } from './events.js';
import { isRepo } from './pr-ref.js';
import { DepthSchema, ReviewDocumentSchema, StageSchema, type Depth } from './review.js';

export { isRepo, prRefFromUrl, type PrPage } from './pr-ref.js';

const FORBIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

export const RepoSchema = z.string().refine(isRepo, { message: 'not a repository name' });

/** A pull request number: a positive safe integer. */
export const PrNumberSchema = z.number().refine((n) => Number.isSafeInteger(n) && n > 0, {
  message: 'not a pull request number',
});

export const ReviewIdSchema = z.string().regex(/^r_[0-9a-f]{10}$/);
export const FindingIdSchema = z.string().regex(/^c_[0-9a-f]{8}$/);
export const FingerprintSchema = z.string().regex(/^[0-9a-f]{16}$/);
export const RunIdSchema = z.string().regex(/^run_[0-9a-f]{12}$/);
export const PackIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

const repo = RepoSchema;
const number = PrNumberSchema;

/**
 * The most characters of a sentence from the service the panel shows (an error, a failed review's message, a restore
 * note). The service cuts its own error sentences to this, as a whole, so the panel never cuts them a second time.
 */
export const MESSAGE_MAX = 300;

export const LEARNED_TEXT_MAX = 500;
export const LEARNED_TEXT_MIN = 10;

export const HelloSchema = z.object({ airlock: z.literal(true), version: z.string(), paired: z.boolean() });
export type Hello = z.infer<typeof HelloSchema>;

export const ServiceStatusSchema = z.object({
  version: z.string(), claude: z.boolean(), gh: z.boolean(), packsDir: z.string(),
  running: z.array(z.object({ runId: RunIdSchema, repo, number })),
});
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

export const PrSummarySchema = z.object({
  repo, number, title: z.string(), author: z.string(), viewer: z.string(),
  isOwn: z.boolean(), stage: StageSchema, baseRef: z.string(), headRef: z.string(), headSha: z.string().regex(/^[0-9a-f]{7,64}$/),
  additions: z.number().int(), deletions: z.number().int(), changedFiles: z.number().int(),
  packs: z.array(z.object({ id: PackIdSchema, title: z.string() })), suggestedDepth: DepthSchema,
});
export type PrSummary = z.infer<typeof PrSummarySchema>;

export const StartReviewBodySchema = z.object({
  repo, number, depth: DepthSchema.optional(),
  packIds: z.array(PackIdSchema).max(10).refine((ids) => new Set(ids).size === ids.length, { message: 'duplicate pack' }).optional(),
});
export type StartReviewBody = z.infer<typeof StartReviewBodySchema>;

export const StartReviewReplySchema = z.object({ runId: RunIdSchema, reused: z.boolean() });
export type StartReviewReply = z.infer<typeof StartReviewReplySchema>;

export const ServiceEventSchema = z.union([
  ReviewEventSchema,
  z.object({ type: z.literal('failed'), message: z.string() }),
]);
export type ServiceEvent = z.infer<typeof ServiceEventSchema>;

export const DismissReasonSchema = z.enum(['wrong', 'intended', 'not-now']);
export type DismissReason = z.infer<typeof DismissReasonSchema>;

export const DismissalSchema = z.object({
  fingerprint: FingerprintSchema, findingId: FindingIdSchema, reviewId: ReviewIdSchema, reason: DismissReasonSchema,
  text: z.string(), at: z.string(),
  learned: z.object({ packId: PackIdSchema, kind: z.enum(['wrong', 'intended']), date: z.string() }).nullable(),
});
export type Dismissal = z.infer<typeof DismissalSchema>;

/** Why text cannot be saved as a learned line, or null when it can. */
export function checkLearnedText(text: string, reason: DismissReason): string | null {
  if (FORBIDDEN_TEXT.test(text)) return 'The text has a control, invisible or line-break character; use plain characters on one line.';
  if (text !== text.trim()) return 'The text starts or ends with a space; remove it.';
  const length = [...text].length;
  if (length > LEARNED_TEXT_MAX) return `The text is longer than ${LEARNED_TEXT_MAX} characters.`;
  if (reason !== 'not-now' && length < LEARNED_TEXT_MIN) return `The text needs at least ${LEARNED_TEXT_MIN} characters.`;
  return null;
}

// For 'not-now' the text may be present, but the service must never write it to a learned file.
export const DismissBodySchema = z.object({
  repo, number, reviewId: ReviewIdSchema, findingId: FindingIdSchema, reason: DismissReasonSchema, text: z.string(),
}).superRefine((body, ctx) => {
  const problem = checkLearnedText(body.text, body.reason);
  if (problem !== null) ctx.addIssue({ code: 'custom', path: ['text'], message: problem });
});
export type DismissBody = z.infer<typeof DismissBodySchema>;

export const RestoreBodySchema = z.object({ repo, number, fingerprint: FingerprintSchema });
export type RestoreBody = z.infer<typeof RestoreBodySchema>;

/** `note` is set when the learned line was no longer there to remove. */
export const RestoreReplySchema = z.object({ restored: z.boolean(), note: z.string().nullable() });
export type RestoreReply = z.infer<typeof RestoreReplySchema>;

export const PairReplySchema = z.object({ paired: z.literal(true), extension: z.enum(['new', 'same']) });
export type PairReply = z.infer<typeof PairReplySchema>;

// The document is the engine's own output read back from its store, not a front door, so it is not re-validated
// field by field here; the panel builds every address through filesUrl and blobUrl, which check their inputs.
export const LatestReplySchema = z.object({ document: ReviewDocumentSchema, dismissals: z.array(DismissalSchema) });
export type LatestReply = z.infer<typeof LatestReplySchema>;

/** The body of every non-2xx response. */
export const ApiErrorSchema = z.object({ error: z.string() });
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const SMALL_PR_LINES = 150;

export function suggestedDepth(additions: number, deletions: number): Depth {
  return additions + deletions <= SMALL_PR_LINES ? 'quick' : 'standard';
}

