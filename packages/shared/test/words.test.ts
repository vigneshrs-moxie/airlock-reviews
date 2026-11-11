import { describe, expect, it } from 'vitest';
import { StageSchema, VerdictLabelSchema, verdictWords, type VerdictLabel } from '@airlock/shared';

describe('verdictWords', () => {
  it('says Ready for PR #2 only at stage pr1 and Ready to merge at every other stage', () => {
    expect(verdictWords('ready-for-pr2', 'pr1')).toBe('Ready for PR #2');
    for (const stage of ['pr2', 'pr3', 'other'] as const) expect(verdictWords('ready-for-pr2', stage)).toBe('Ready to merge');
  });

  it('has words for every verdict label', () => {
    const words: Record<Exclude<VerdictLabel, 'ready-for-pr2'>, string> = {
      'not-ready': 'Not ready', 'split-first': 'Split first', 'request-changes': 'Request changes',
      'approve-after-fixes': 'Approve after fixes', approve: 'Approve', incomplete: 'Review incomplete',
    };
    for (const label of VerdictLabelSchema.options) {
      for (const stage of StageSchema.options) {
        const said = verdictWords(label, stage);
        expect(said.trim(), `${label} at ${stage}`).not.toBe('');
        if (label !== 'ready-for-pr2') expect(said, `${label} at ${stage}`).toBe(words[label]);
      }
    }
  });
});
