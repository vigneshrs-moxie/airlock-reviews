import { POST_MAX_ITEMS, type PostRecord, type PrSummary } from '@airlock/shared';

export const POSTED_WORD = 'Posted';
export const UNKNOWN_MARK = 'Not known whether this was posted';

export const NO_POST_OFFLINE = 'Posting needs the Airlock service, which is not answering.';
export const NO_POST_STALE = 'This review is of an older commit. Review the new commits before posting.';
export const NO_POST_CLOSED = 'The pull request is closed, so nothing can be posted to it.';
export const NO_POST_MERGED = 'The pull request is merged, so nothing can be posted to it.';
export const ALL_POSTED = 'The selected findings are already posted.';
export const TOO_MANY = `At most ${POST_MAX_ITEMS} comments go in one post.`;

/** Why nothing can be posted from this review now, in a sentence; null when it can. */
export function whyNotPosting(pr: Pick<PrSummary, 'state'>, stale: boolean, offline: boolean): string | null {
  if (offline) return NO_POST_OFFLINE;
  if (pr.state === 'merged') return NO_POST_MERGED;
  if (pr.state === 'closed') return NO_POST_CLOSED;
  if (stale) return NO_POST_STALE;
  return null;
}

/**
 * A finding's post record: Posted, with the posted review's address, or that it is not known whether it was posted.
 * `link` false (inside a card's button) gives the words only. The address is the record's, which the contract accepted
 * only as this pull request's review address.
 */
export function PostedMark({ record, link = true, id }: { record: PostRecord; link?: boolean; id?: string }) {
  if (record.outcome !== 'posted') {
    return <span className="mark block" {...(id === undefined ? {} : { id })}><span>{UNKNOWN_MARK}</span></span>;
  }
  return (
    <span className="mark block" {...(id === undefined ? {} : { id })}>
      <span>{POSTED_WORD}</span>
      {link && record.url !== null && (
        <>
          {' '}
          <a href={record.url} target="_blank" rel="noopener noreferrer">Open on GitHub</a>
        </>
      )}
    </span>
  );
}
