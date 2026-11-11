import type { Stage, VerdictLabel } from './review.js';

const READY: Record<Stage, string> = {
  pr1: 'Ready for PR #2', pr2: 'Ready for PR #3', pr3: 'Ready to release', other: 'Ready',
};

const WORDS: Record<Exclude<VerdictLabel, 'ready-for-pr2'>, string> = {
  'not-ready': 'Not ready',
  'split-first': 'Split first',
  'request-changes': 'Request changes',
  'approve-after-fixes': 'Approve after fixes',
  approve: 'Approve',
  incomplete: 'Incomplete',
};

/** A verdict label in the prototype's words; `ready-for-pr2` names the stage the pull request moves to next. */
export function verdictWords(label: VerdictLabel, stage: Stage): string {
  return label === 'ready-for-pr2' ? READY[stage] : WORDS[label];
}
