import { describe, expect, it } from 'vitest';
import { VerdictLabelSchema, verdictWords } from '@airlock/shared';

describe('verdictWords', () => {
  it('has words for every label, never the raw id', () => {
    for (const label of VerdictLabelSchema.options) {
      const words = verdictWords(label, 'pr1');
      expect(words).not.toBe(label);
      expect(words).not.toMatch(/-/);
    }
  });
  it('names the stage a ready pull request moves to', () => {
    expect(verdictWords('ready-for-pr2', 'pr1')).toBe('Ready for PR #2');
    expect(verdictWords('ready-for-pr2', 'pr2')).toBe('Ready for PR #3');
    expect(verdictWords('ready-for-pr2', 'pr3')).toBe('Ready to release');
    expect(verdictWords('ready-for-pr2', 'other')).toBe('Ready');
  });
  it('says the other labels the same at every stage', () => {
    expect(verdictWords('approve-after-fixes', 'pr3')).toBe('Approve after fixes');
    expect(verdictWords('not-ready', 'other')).toBe('Not ready');
    expect(verdictWords('incomplete', 'pr2')).toBe('Incomplete');
  });
});
