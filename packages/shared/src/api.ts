import { z } from 'zod';
import { ReviewEventSchema } from './events.js';
import { DepthSchema, ReviewDocumentSchema, StageSchema, type Depth } from './review.js';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// eslint-disable-next-line no-control-regex
const ONE_LINE = /^[^\u0000-\u001f\u007f]*$/;

const repo = z.string().regex(REPO_PATTERN);
const number = z.number().int().positive();

export const HelloSchema = z.object({ airlock: z.literal(true), version: z.string(), paired: z.boolean() });
export type Hello = z.infer<typeof HelloSchema>;

export const ServiceStatusSchema = z.object({
  version: z.string(), claude: z.boolean(), gh: z.boolean(), packsDir: z.string(),
  running: z.array(z.object({ runId: z.string(), repo: z.string(), number: z.number().int() })),
});
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

export const PrSummarySchema = z.object({
  repo: z.string(), number: z.number().int(), title: z.string(), author: z.string(), viewer: z.string(),
  isOwn: z.boolean(), stage: StageSchema, baseRef: z.string(), headRef: z.string(), headSha: z.string(),
  additions: z.number().int(), deletions: z.number().int(), changedFiles: z.number().int(),
  packs: z.array(z.object({ id: z.string(), title: z.string() })), suggestedDepth: DepthSchema,
});
export type PrSummary = z.infer<typeof PrSummarySchema>;

export const StartReviewBodySchema = z.object({
  repo, number, depth: DepthSchema.optional(), packIds: z.array(z.string()).optional(),
});
export type StartReviewBody = z.infer<typeof StartReviewBodySchema>;

export const StartReviewReplySchema = z.object({ runId: z.string(), reused: z.boolean() });
export type StartReviewReply = z.infer<typeof StartReviewReplySchema>;

export const ServiceEventSchema = z.union([
  ReviewEventSchema,
  z.object({ type: z.literal('failed'), message: z.string() }),
]);
export type ServiceEvent = z.infer<typeof ServiceEventSchema>;

export const DismissReasonSchema = z.enum(['wrong', 'intended', 'not-now']);
export type DismissReason = z.infer<typeof DismissReasonSchema>;

export const DismissalSchema = z.object({
  fingerprint: z.string(), findingId: z.string(), reviewId: z.string(), reason: DismissReasonSchema,
  text: z.string(), at: z.string(),
  learned: z.object({ packId: z.string(), kind: z.enum(['wrong', 'intended']), date: z.string() }).nullable(),
});
export type Dismissal = z.infer<typeof DismissalSchema>;

export const DismissBodySchema = z.object({
  repo, number, reviewId: z.string(), findingId: z.string(), reason: DismissReasonSchema,
  text: z.string().max(500).regex(ONE_LINE, 'one line, no control characters'),
}).superRefine((body, ctx) => {
  if (body.reason !== 'not-now' && body.text.length < 10) {
    ctx.addIssue({ code: 'custom', path: ['text'], message: 'at least 10 characters' });
  }
});
export type DismissBody = z.infer<typeof DismissBodySchema>;

export const RestoreBodySchema = z.object({ repo, number, fingerprint: z.string() });
export type RestoreBody = z.infer<typeof RestoreBodySchema>;

/** `note` is set when the learned line was no longer there to remove. */
export const RestoreReplySchema = z.object({ restored: z.boolean(), note: z.string().nullable() });
export type RestoreReply = z.infer<typeof RestoreReplySchema>;

export const PairReplySchema = z.object({ paired: z.literal(true), extension: z.enum(['new', 'same']) });
export type PairReply = z.infer<typeof PairReplySchema>;

export const LatestReplySchema = z.object({ document: ReviewDocumentSchema, dismissals: z.array(DismissalSchema) });
export type LatestReply = z.infer<typeof LatestReplySchema>;

/** The body of every non-2xx response. */
export const ApiErrorSchema = z.object({ error: z.string() });
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const SMALL_PR_LINES = 150;

export function suggestedDepth(additions: number, deletions: number): Depth {
  return additions + deletions <= SMALL_PR_LINES ? 'quick' : 'standard';
}

export type PrPage = 'conversation' | 'files' | 'commits' | 'checks' | 'other';

function pageOf(rest: string[]): PrPage {
  const [first, ...more] = rest;
  if (first === undefined) return 'conversation';
  if (first === 'files') return more.length === 0 ? 'files' : 'other';
  if (first === 'changes') return 'files';
  if (first === 'commits') return more.length <= 1 ? 'commits' : 'other';
  if (first === 'checks') return more.length === 0 ? 'checks' : 'other';
  return 'other';
}

/** Reads a GitHub pull request page address; null for anything else. Never throws. */
export function prRefFromUrl(url: string): { repo: string; number: number; page: PrPage } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.host !== 'github.com' || parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  const segments = parsed.pathname.split('/').slice(1);
  if (segments[segments.length - 1] === '') segments.pop();
  const [owner, name, pull, num, ...rest] = segments;
  if (owner === undefined || name === undefined || pull !== 'pull' || num === undefined) return null;
  const fullName = `${owner}/${name}`;
  if (!REPO_PATTERN.test(fullName) || !/^[1-9][0-9]*$/.test(num)) return null;
  const parsedNumber = Number(num);
  if (!Number.isSafeInteger(parsedNumber)) return null;
  return { repo: fullName, number: parsedNumber, page: pageOf(rest) };
}
