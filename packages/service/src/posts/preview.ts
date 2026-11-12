import { randomBytes } from 'node:crypto';
import { reviewById } from '@airlock/engine';
import {
  checkCommentText, commentBody, mentionsIn, PostPreviewReplySchema, REVIEW_BODY_MAX, summaryBody, SUMMARY_MAX, type Dismissal,
  type Finding, type Placement, type PostPreviewBody, type PostPreviewItem,
} from '@airlock/shared';
import { z } from 'zod';
import type { ReviewComment, ReviewPayload } from './github.js';
import { blockingRecord, fit, keysOf, PostError, recordsOf, shown } from './records.js';

/** How long a preview can be posted, from when it was made (or, after GitHub refused it, from the refusal). */
export const PREVIEW_MS = 10 * 60_000;
/** The most previews held; past this the oldest goes. */
export const PREVIEWS_KEPT = 20;
/** The preview route's body limit: 30 comments and a summary of 4,000 characters each, in any script, fit in it. */
export const PREVIEW_BODY_MAX = 512 * 1024;
/** The most aliases a record keeps for a finding. */
const ALIASES_KEPT = 50;
const FINGERPRINT = /^[0-9a-f]{16}$/;

const NO_REVIEW = 'Airlock cannot find that review of this pull request.';
const NOT_FOUND = 'Airlock cannot find that finding in the stored review.';
const NOT_ON_DIFF = 'The line is not part of the diff GitHub shows.';
const CHOSEN = 'You chose the summary.';

/** A preview as the service stored it: what `POST /posts` sends, byte for byte, and what its record will hold. */
export interface StoredPreview {
  previewId: string;
  repo: string;
  number: number;
  reviewId: string;
  headSha: string;
  payload: ReviewPayload;
  items: Array<{ fingerprint: string; aliases: string[]; placement: Placement; title: string }>;
  /** Milliseconds since the epoch, on the service's clock. */
  expiresAt: number;
}

/** The previews the service made, in memory only: at most PREVIEWS_KEPT, each for PREVIEW_MS. */
export class Previews {
  private readonly held = new Map<string, StoredPreview>();

  add(preview: StoredPreview): void {
    this.held.delete(preview.previewId);
    this.held.set(preview.previewId, preview);
    for (const id of this.held.keys()) {
      if (this.held.size <= PREVIEWS_KEPT) break;
      this.held.delete(id);
    }
  }

  /** The preview, or null when there is none or it has expired. */
  get(previewId: string, now: Date): StoredPreview | null {
    const preview = this.held.get(previewId);
    if (preview === undefined) return null;
    if (now.getTime() >= preview.expiresAt) {
      this.held.delete(previewId);
      return null;
    }
    return preview;
  }

  remove(previewId: string): void {
    this.held.delete(previewId);
  }

  /** Holds the preview again, for another PREVIEW_MS from now. */
  keep(preview: StoredPreview, now: Date): void {
    this.add({ ...preview, expiresAt: now.getTime() + PREVIEW_MS });
  }
}

/** What building a preview needs from the service. */
export interface PreviewDeps {
  home: string;
  now: () => Date;
  previews: Previews;
  /** The dismissals recorded for a pull request. */
  dismissals: (repo: string, number: number) => Promise<Dismissal[]>;
}

// LOCAL COPY until the contract branch is merged into this lane: the shared package gains `postMentions` (comment-text.ts)
// and `reviewBodyMentions` on PostPreviewReplySchema. At the merge, delete this block and use the shared ones.
/** Which names each comment and the review body would notify: none for Airlock's own text, mentionsIn otherwise. */
export function postMentions(
  items: { body: string; isDefault: boolean; inSummary: boolean }[], summary: { text: string; isDefault: boolean }, reviewBody: string,
): { items: string[][]; reviewBody: string[] } {
  const allDefault = summary.isDefault && items.every((item) => !item.inSummary || item.isDefault);
  return {
    items: items.map((item) => (item.isDefault ? [] : mentionsIn(item.body))),
    reviewBody: allDefault ? [] : mentionsIn(reviewBody),
  };
}
export const PreviewReplySchema = PostPreviewReplySchema.extend({ reviewBodyMentions: z.array(z.string()).default([]) });
export type PreviewReply = z.infer<typeof PreviewReplySchema>;
// END OF LOCAL COPY.

// `summaryBody`'s first argument is unused and is being removed; only this line changes when it goes.
const reviewText = (inSummary: { path: string; line: number | null; body: string }[], summary: string): string =>
  summaryBody(0, inSummary, summary);

const shares = (keys: readonly string[], f: Finding): boolean => keysOf(f.fingerprint, f.aliases ?? []).some((k) => keys.includes(k));

/**
 * Builds the exact review `POST /posts` would send for chosen findings of a stored review, and stores it for PREVIEW_MS.
 * Refuses (PostError) a review that is not this pull request's (404); a finding it does not have or that is fixed (404);
 * one chosen twice (400); one dismissed, posted, or of a post whose outcome is not known (409); text the person gave that
 * `checkCommentText` refuses (400); and a review text over REVIEW_BODY_MAX (400).
 */
export async function buildPreview(deps: PreviewDeps, body: PostPreviewBody): Promise<PreviewReply> {
  const doc = await reviewById(body.repo, body.number, body.reviewId);
  if (doc === null || doc.pr.repo.toLowerCase() !== body.repo.toLowerCase() || doc.pr.number !== body.number) {
    throw new PostError(404, NO_REVIEW);
  }
  const { repo, number } = doc.pr;
  const dismissals = await deps.dismissals(repo, number);
  const { list: records } = await recordsOf(deps.home, repo, number);

  const chosen: Finding[] = [];
  for (const item of body.items) {
    const finding = doc.findings.find((f) => shares([item.fingerprint], f));
    const keys = finding === undefined ? [item.fingerprint] : keysOf(finding.fingerprint, finding.aliases ?? []);
    const fixed = (doc.fixed ?? []).find((f) => shares(keys, f));
    if (fixed !== undefined) throw new PostError(404, fit(`This finding is fixed, so it cannot be posted: ${shown(fixed.title)}.`));
    if (finding === undefined) throw new PostError(404, NOT_FOUND);
    const title = shown(finding.title);
    if (chosen.includes(finding)) throw new PostError(400, fit(`This finding is chosen twice: ${title}.`));
    if (dismissals.some((d) => keys.includes(d.fingerprint))) {
      throw new PostError(409, fit(`This finding is dismissed; restore it before posting it: ${title}.`));
    }
    const earlier = blockingRecord(records, keys);
    if (earlier !== undefined) {
      throw new PostError(409, fit(earlier.outcome === 'posted'
        ? `This finding is already posted on this pull request: ${title}.`
        : `Airlock does not know whether this finding was posted: ${title}. Look at the pull request first.`));
    }
    chosen.push(finding);
  }

  const items: PostPreviewItem[] = [];
  const comments: ReviewComment[] = [];
  const inSummary: { path: string; line: number | null; body: string }[] = [];
  const texts: { body: string; isDefault: boolean; inSummary: boolean }[] = [];
  for (const [i, item] of body.items.entries()) {
    const finding = chosen[i] as Finding;
    const drafted = commentBody(finding);
    const text = item.body ?? drafted;
    // The drafted text is Airlock's own; text the person wrote or changed is what `postMentions` checks.
    // Airlock's own text when it is exactly the drafted comment; the names are filled once the review body is known.
    const isDefault = text === drafted;
    const mentions: string[] = [];
    const problem = checkCommentText(text);
    if (problem !== null) throw new PostError(400, problem);
    const place = finding.anchor.comment ?? null;
    if (place !== null && item.placement !== 'summary') {
      const startLine = place.startLine !== null && place.startLine < place.line ? place.startLine : null;
      comments.push({
        path: finding.path, line: place.line, side: 'RIGHT',
        ...(startLine === null ? {} : { start_line: startLine, start_side: 'RIGHT' as const }), body: text,
      });
      items.push({
        fingerprint: item.fingerprint, title: finding.title, path: finding.path, line: place.line, startLine, placement: 'inline',
        whySummary: null, body: text, mentions,
      });
      texts.push({ body: text, isDefault, inSummary: false });
    } else {
      const line = place?.line ?? finding.anchor.startLine ?? null;
      inSummary.push({ path: finding.path, line, body: text });
      items.push({
        fingerprint: item.fingerprint, title: finding.title, path: finding.path, line, startLine: null, placement: 'summary',
        whySummary: item.placement === 'summary' ? CHOSEN : NOT_ON_DIFF, body: text, mentions,
      });
      texts.push({ body: text, isDefault, inSummary: true });
    }
  }

  const count = body.items.length;
  const generated = `Review notes from Airlock: ${count} comment${count === 1 ? '' : 's'}.`;
  const summary = body.summary ?? generated;
  const summaryProblem = checkCommentText(summary, SUMMARY_MAX);
  if (summaryProblem !== null) throw new PostError(400, summaryProblem);
  const reviewBody = reviewText(inSummary, summary);
  if ([...reviewBody].length > REVIEW_BODY_MAX) {
    throw new PostError(400, `The review's text is longer than the ${REVIEW_BODY_MAX} characters GitHub accepts; put fewer comments in the summary.`);
  }

  const now = deps.now().getTime();
  const previewId = `pv_${randomBytes(8).toString('hex')}`;
  const stored: StoredPreview = {
    previewId, repo, number, reviewId: doc.id, headSha: doc.pr.headSha,
    payload: { commit_id: doc.pr.headSha, event: 'COMMENT', body: reviewBody, comments },
    items: chosen.map((f, i) => ({
      fingerprint: f.fingerprint, aliases: (f.aliases ?? []).filter((a) => FINGERPRINT.test(a)).slice(0, ALIASES_KEPT), placement: (items[i] as PostPreviewItem).placement, title: f.title,
    })),
    expiresAt: now + PREVIEW_MS,
  };
  deps.previews.add(stored);
  const named = postMentions(texts, { text: summary, isDefault: summary === generated }, reviewBody);
  for (const [i, item] of items.entries()) item.mentions = named.items[i] ?? [];
  return {
    previewId, headSha: doc.pr.headSha, viewer: doc.pr.viewer, items, summary, reviewBody, reviewBodyMentions: named.reviewBody, expiresAt: new Date(stored.expiresAt).toISOString(),
  };
}
