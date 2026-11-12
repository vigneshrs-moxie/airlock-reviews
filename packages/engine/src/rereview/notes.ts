import type { PrInfo, ReviewDocument } from '@airlock/shared';
import type { EverythingReason } from './range.js';

/** A re-review's note when the whole pull request was reviewed again, saying why. */
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

/**
 * A re-review's note when the push was one merge of the base branch, as far as `mergeReview` says: that only what was
 * changed by hand in it was reviewed (`by-hand`); only that it merges the base in, when Airlock could not review it (its
 * stage error says what happened); none when git merged it by itself, which the brief and the line under the verdict say.
 */
export function baseMergeNote(pr: PrInfo, mergeReview: NonNullable<ReviewDocument['mergeReview']>): string | null {
  const merges = `The push since the last review only merges the base branch ${pr.baseRef} in`;
  if (mergeReview === 'by-hand') return `${merges}, so only what was changed by hand in that merge was reviewed.`;
  return mergeReview === 'not-reviewed' ? `${merges}.` : null;
}

/** A push re-review's note when it repeats the last review's questions, whose-call lines or checks after merge. */
export const CARRIED_QUESTIONS_NOTE = 'Questions and checks from the last review are repeated here.';
