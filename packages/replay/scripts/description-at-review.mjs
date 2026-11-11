// The description of a pull request as it stood when it was reviewed, from the edit history GitHub keeps. Used by
// capture-descriptions.mjs; kept apart so it can be tested without GitHub.

/**
 * The description as it stood at `reviewedAt`: today's `body` when no edit came after the review, else the text of the
 * last edit at or before it. Throws, naming `pullRequest`, when that version is not recorded or was recorded without its
 * text, so an empty description is never made up.
 * @param {{ pullRequest: string, reviewedAt: string, body: string, edits: { createdAt: string, editedAt?: string | null, diff?: string | null }[] }} input
 * @returns {{ body: string, editedAfterReview: number }}
 */
export function descriptionAtReview({ pullRequest, reviewedAt, body, edits }) {
  // A version without its text stays without it: an empty description is only one GitHub recorded as empty.
  const versions = edits
    .map((e) => ({ at: e.editedAt ?? e.createdAt, text: e.diff ?? null }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const editedAfterReview = versions.filter((v) => v.at > reviewedAt).length;
  // No version after the review: the description today is the one that was reviewed.
  if (editedAfterReview === 0) return { body, editedAfterReview };
  const atReview = versions.filter((v) => v.at <= reviewedAt).at(-1);
  if (atReview === undefined) throw new Error(`${pullRequest}: the description was edited after the review and no earlier version is recorded`);
  if (atReview.text === null) {
    throw new Error(
      `${pullRequest}: GitHub recorded the version of the description at review time (${atReview.at}) without its text, ` +
        'so the description the reviewer read is not known.',
    );
  }
  return { body: atReview.text, editedAfterReview };
}
