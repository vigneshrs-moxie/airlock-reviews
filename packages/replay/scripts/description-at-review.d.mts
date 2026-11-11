/** One version of a description as GitHub records it in `userContentEdits`: `diff` is that version's full text. */
export interface DescriptionEdit {
  createdAt: string;
  editedAt?: string | null;
  diff?: string | null;
}

/**
 * The description as it stood at `reviewedAt`: today's `body` when no edit came after the review, else the text of the
 * last edit at or before it. Throws, naming `pullRequest`, when that version is not recorded or was recorded without its
 * text, so an empty description is never made up.
 */
export function descriptionAtReview(input: {
  pullRequest: string;
  reviewedAt: string;
  body: string;
  edits: DescriptionEdit[];
}): { body: string; editedAfterReview: number };
