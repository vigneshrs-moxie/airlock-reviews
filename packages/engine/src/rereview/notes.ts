import type { PrInfo, ReviewDocument } from '@airlock/shared';
import type { EverythingReason } from './range.js';

/** A re-review's note when the whole pull request was reviewed again, saying why. Each ends as AGAIN_IN_FULL matches. */
export function everythingNote(reason: EverythingReason, previous: ReviewDocument, pr: PrInfo): string {
  switch (reason) {
    case 'rewritten':
      return `The branch was rewritten since the last review (its earlier head ${previous.pr.headSha.slice(0, 7)} is no longer part of it), so the whole pull request was reviewed again.`;
    case 'base-merged-in':
      return `A commit pushed since the last review merges the base branch ${pr.baseRef} in, so the whole pull request was reviewed again.`;
    case 'earlier-incomplete':
      return 'The last review did not finish, so everything was reviewed again.';
    case 'retargeted':
      return `The pull request now targets ${pr.baseRef}; the last review was against ${previous.pr.baseRef}, so everything was reviewed again.`;
    case 'earlier-partial':
      return 'The last review covered a range given by hand, so everything was reviewed again.';
  }
}

/** How every everythingNote ends. */
const AGAIN_IN_FULL = /, so (?:everything|the whole pull request) was reviewed again\.$/;

/**
 * True when a document's notes say the whole pull request was reviewed again: a re-review whose range is a merge then
 * covered the pull request's merge, not a merge pushed since the last review.
 */
export const reviewedAgainInFull = (notes: readonly string[]): boolean => notes.some((n) => AGAIN_IN_FULL.test(n));

/** A re-review's note when the push was one merge of the base branch, of which only the changes made by hand were reviewed. */
export const baseMergeNote = (pr: PrInfo): string =>
  `The push since the last review only merges the base branch ${pr.baseRef} in, so only what was changed by hand in that merge was reviewed.`;

/** A push re-review's note when it repeats the last review's questions, whose-call lines or checks after merge. */
export const CARRIED_QUESTIONS_NOTE = 'Questions and checks from the last review are repeated here.';
