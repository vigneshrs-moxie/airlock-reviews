import { z } from 'zod';
import { ReviewEventSchema } from './events.js';
import { POST_MAX_ITEMS, REVIEW_BODY_MAX } from './comment-text.js';
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
export const PreviewIdSchema = z.string().regex(/^pv_[0-9a-f]{16}$/);
export const PostIdSchema = z.string().regex(/^post_[0-9a-f]{12}$/);

const repo = RepoSchema;
const number = PrNumberSchema;

/**
 * The most characters of a sentence from the service the panel shows (an error, a failed review's message, a restore
 * note). The service cuts its own error sentences to this, as a whole, so the panel never cuts them a second time.
 */
export const MESSAGE_MAX = 300;

export const LEARNED_TEXT_MAX = 500;
export const LEARNED_TEXT_MIN = 10;

export const HelloSchema = z.object({
  airlock: z.literal(true), version: z.string(), paired: z.boolean(),
  proof: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
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
  state: z.enum(['open', 'closed', 'merged']).default('open'),
  lastReview: z.object({ reviewId: ReviewIdSchema, headSha: z.string().regex(/^[0-9a-f]{7,64}$/), createdAt: z.string(), depth: DepthSchema }).nullable().default(null),
});
export type PrSummary = z.infer<typeof PrSummarySchema>;

export const StartReviewBodySchema = z.object({
  repo, number, depth: DepthSchema.optional(),
  packIds: z.array(PackIdSchema).max(10).refine((ids) => new Set(ids).size === ids.length, { message: 'duplicate pack' }).optional(),
  since: z.literal('last').optional(),
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

export const PlacementSchema = z.enum(['inline', 'summary']);
export type Placement = z.infer<typeof PlacementSchema>;

export const PostItemSchema = z.object({ fingerprint: FingerprintSchema, body: z.string().max(REVIEW_BODY_MAX).optional(), placement: PlacementSchema.optional() });
export type PostItem = z.infer<typeof PostItemSchema>;

export const PostPreviewBodySchema = z.object({
  repo, number, reviewId: ReviewIdSchema,
  items: z.array(PostItemSchema).min(1).max(POST_MAX_ITEMS)
    .refine((items) => new Set(items.map((i) => i.fingerprint)).size === items.length, { message: 'duplicate finding' }),
  summary: z.string().max(REVIEW_BODY_MAX).optional(),
});
export type PostPreviewBody = z.infer<typeof PostPreviewBodySchema>;

export const PostPreviewItemSchema = z.object({
  fingerprint: FingerprintSchema, title: z.string(), path: z.string(), line: z.number().int().nullable(),
  startLine: z.number().int().nullable(), placement: PlacementSchema, whySummary: z.string().nullable(),
  body: z.string(), mentions: z.array(z.string()),
});
export type PostPreviewItem = z.infer<typeof PostPreviewItemSchema>;

export const PostPreviewReplySchema = z.object({
  previewId: PreviewIdSchema, headSha: z.string().regex(/^[0-9a-f]{7,64}$/), viewer: z.string(),
  items: z.array(PostPreviewItemSchema), summary: z.string(), reviewBody: z.string(), expiresAt: z.string(),
});
export type PostPreviewReply = z.infer<typeof PostPreviewReplySchema>;

/** What the person confirms: the preview the service stored, and nothing else. */
export const PostBodySchema = z.object({ previewId: PreviewIdSchema });
export type PostBody = z.infer<typeof PostBodySchema>;

export const PostRecordSchema = z.object({
  id: PostIdSchema, repo, number, reviewId: ReviewIdSchema, headSha: z.string().regex(/^[0-9a-f]{7,64}$/), postedAt: z.string(),
  outcome: z.enum(['posted', 'unknown']), githubReviewId: z.number().int().positive().nullable(), url: z.string().nullable(),
  items: z.array(z.object({ fingerprint: FingerprintSchema, aliases: z.array(FingerprintSchema).max(50), placement: PlacementSchema })),
}).superRefine((record, ctx) => {
  const bad = (path: string, message: string): void => ctx.addIssue({ code: 'custom', path: [path], message });
  if (record.outcome === 'unknown') {
    if (record.url !== null || record.githubReviewId !== null) bad('outcome', 'an unknown outcome has no review address or id');
    return;
  }
  if (record.url === null || record.githubReviewId === null) { bad('url', 'a posted review has an address and an id'); return; }
  // Not a regular expression: the dot of the host would be escaped in it, and the bundle's address check reads that as another host.
  const start = `https://github.com/${record.repo}/pull/${record.number}#pullrequestreview-`;
  if (!record.url.startsWith(start) || record.url.slice(start.length) !== String(record.githubReviewId)) {
    bad('url', "not this pull request's review address");
  }
});
export type PostRecord = z.infer<typeof PostRecordSchema>;

export const ForgetPostBodySchema = z.object({ repo, number, id: PostIdSchema });
export type ForgetPostBody = z.infer<typeof ForgetPostBodySchema>;

export const LearnedKindSchema = z.enum(['wrong', 'product-knowledge']);
export type LearnedKind = z.infer<typeof LearnedKindSchema>;

export const LearnedLineSchema = z.object({
  pack: PackIdSchema, packTitle: z.string(), kind: LearnedKindSchema, date: z.string(), repo: RepoSchema.nullable(),
  text: z.string(), key: FingerprintSchema, appliesHere: z.boolean(), removable: z.boolean(),
});
export type LearnedLine = z.infer<typeof LearnedLineSchema>;

export const LearnedReplySchema = z.object({ lines: z.array(LearnedLineSchema), cap: z.number().int() });
export type LearnedReply = z.infer<typeof LearnedReplySchema>;

export const RemoveLearnedBodySchema = z.object({ repo, pack: PackIdSchema, kind: LearnedKindSchema, key: FingerprintSchema });
export type RemoveLearnedBody = z.infer<typeof RemoveLearnedBodySchema>;

export const RemoveLearnedReplySchema = z.object({ removed: z.boolean(), note: z.string().nullable() });
export type RemoveLearnedReply = z.infer<typeof RemoveLearnedReplySchema>;

export const PairReplySchema = z.object({ paired: z.literal(true), extension: z.enum(['new', 'same']) });
export type PairReply = z.infer<typeof PairReplySchema>;

// The document is the engine's own output read back from its store, not a front door, so it is not re-validated
// field by field here; the panel builds every address through filesUrl and blobUrl, which check their inputs.
export const LatestReplySchema = z.object({
  document: ReviewDocumentSchema, dismissals: z.array(DismissalSchema), posts: z.array(PostRecordSchema).default([]),
});
export type LatestReply = z.infer<typeof LatestReplySchema>;

/** The body of every non-2xx response. */
export const ApiErrorSchema = z.object({ error: z.string() });
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const SMALL_PR_LINES = 150;

export function suggestedDepth(additions: number, deletions: number): Depth {
  return additions + deletions <= SMALL_PR_LINES ? 'quick' : 'standard';
}

