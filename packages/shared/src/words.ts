import type { Finding, Severity, Stage, VerdictLabel } from './review.js';

/** A severity as the reader sees it. */
export const SEVERITY_WORD: Record<Severity, string> = { block: 'Block', fix: 'Fix', ask: 'Ask', note: 'Note' };

/** A re-review finding's status as the reader sees it. */
export const STATUS_WORD: Record<NonNullable<Finding['status']>, string> = { new: 'New', 'still-open': 'Still open', moved: 'Moved', fixed: 'Fixed' };

const VERDICT_WORDS: Record<VerdictLabel, string> = {
  'not-ready': 'Not ready',
  'ready-for-pr2': 'Ready for PR #2',
  'split-first': 'Split first',
  'request-changes': 'Request changes',
  'approve-after-fixes': 'Approve after fixes',
  approve: 'Approve',
  incomplete: 'Review incomplete',
};

/** The verdict as the reader sees it. A pull request past PR #1 that is ready is ready to merge, not ready for PR #2. */
export function verdictWords(label: VerdictLabel, stage: Stage): string {
  if (label === 'ready-for-pr2' && stage !== 'pr1') return 'Ready to merge';
  return VERDICT_WORDS[label];
}
