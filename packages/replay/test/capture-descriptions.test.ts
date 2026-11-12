import { describe, expect, it } from 'vitest';
import { descriptionAtReview } from '../scripts/description-at-review.mjs';

const REVIEWED_AT = '2026-10-01T10:00:00Z';
const edit = (at: string, diff: string | null | undefined) => ({ createdAt: at, editedAt: at, ...(diff === undefined ? {} : { diff }) });

describe('descriptionAtReview', () => {
  it('is today\'s description when no edit came after the review', () => {
    const result = descriptionAtReview({
      pullRequest: 'acme/widgets#12', reviewedAt: REVIEWED_AT, body: 'Today.',
      edits: [edit('2026-09-30T09:00:00Z', 'First.'), edit('2026-09-30T12:00:00Z', null)],
    });
    expect(result).toEqual({ body: 'Today.', editedAfterReview: 0 });
  });

  it('is the last version at or before the review when the description was edited after it', () => {
    const result = descriptionAtReview({
      pullRequest: 'acme/widgets#12', reviewedAt: REVIEWED_AT, body: 'Today.',
      edits: [edit('2026-10-02T09:00:00Z', 'Today.'), edit('2026-09-30T09:00:00Z', 'First.'), edit(REVIEWED_AT, 'As reviewed.')],
    });
    expect(result).toEqual({ body: 'As reviewed.', editedAfterReview: 1 });
  });

  it('keeps a version whose recorded text is empty: the description really was empty', () => {
    const result = descriptionAtReview({
      pullRequest: 'acme/widgets#12', reviewedAt: REVIEWED_AT, body: 'Today.',
      edits: [edit('2026-09-30T09:00:00Z', ''), edit('2026-10-02T09:00:00Z', 'Today.')],
    });
    expect(result).toEqual({ body: '', editedAfterReview: 1 });
  });

  for (const [label, diff] of [['null', null], ['missing', undefined]] as const) {
    it(`stops, naming the pull request, when the version at review time was recorded without its text (${label}), never giving an empty description`, () => {
      const input = {
        pullRequest: 'acme/widgets#12', reviewedAt: REVIEWED_AT, body: 'Today.',
        edits: [edit('2026-09-30T09:00:00Z', diff), edit('2026-10-02T09:00:00Z', 'Today.')],
      };
      expect(() => descriptionAtReview(input)).toThrow(
        'acme/widgets#12: GitHub recorded the version of the description at review time (2026-09-30T09:00:00Z) without its text, ' +
          'so the description the reviewer read is not known.',
      );
    });
  }

  it('stops, naming the pull request, when the description was edited after the review and no earlier version is recorded', () => {
    expect(() => descriptionAtReview({
      pullRequest: 'acme/widgets#12', reviewedAt: REVIEWED_AT, body: 'Today.', edits: [edit('2026-10-02T09:00:00Z', 'Today.')],
    })).toThrow(/^acme\/widgets#12: the description was edited after the review and no earlier version is recorded/);
  });
});
