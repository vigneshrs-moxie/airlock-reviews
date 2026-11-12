import { POST_MAX_ITEMS, type PostRecord, type PrSummary } from '@airlock/shared';
import { useEffect, useId, useRef, useState } from 'react';
import type { PostReply } from '../state/reduce';

export const POSTED_WORD = 'Posted';
export const UNKNOWN_MARK = 'Not known whether this was posted';

export const NO_POST_OFFLINE = 'Posting needs the Airlock service, which is not answering.';
export const NO_POST_STALE = 'This review is of an older commit. Review the new commits before posting.';
export const NO_POST_CLOSED = 'The pull request is closed, so nothing can be posted to it.';
export const NO_POST_MERGED = 'The pull request is merged, so nothing can be posted to it.';
export const ALL_POSTED = 'The selected findings are already posted.';
export const TOO_MANY = `At most ${POST_MAX_ITEMS} comments go in one post.`;
/** Beside a button disabled only because another action is in flight; for a screen reader. */
export const WAIT = 'Wait for the current action to finish.';
export const FORGET_ASK = 'Forget this record? Only do this after looking at the pull request.';
export const FORGOTTEN = 'Record forgotten.';

/** The notice under a text that names people. */
export const mentionNotice = (names: readonly string[]): string => `Names ${names.join(', ')}: GitHub notifies them unless the name is inside code.`;

/** The pull request's address, built by code from its repository and number. */
export const pullAddress = (pr: Pick<PrSummary, 'repo' | 'number'>): string => `https://github.com/${pr.repo}/pull/${pr.number}`;

/** A reason beside a disabled control: shown, or for a screen reader only when it is the passing wait. */
export function Reason({ id, text }: { id: string; text: string }) {
  return <span id={id} className={text === WAIT ? 'sr-only' : 'muted block'}>{text}</span>;
}

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

/**
 * `It was not posted`, which asks once more before it forgets a record whose outcome is not known: the question in
 * place, with `It was not posted` and `Keep`. Focus follows the question: to Keep when it is asked, back to It was not
 * posted when it is put away. `blocked`: why it cannot be pressed now. The same in the post sheet as on a finding.
 */
export function ForgetAsk({ blocked, onForget, small = false }: {
  blocked: string | null;
  /** Called on the second press, once the person said the review was not posted. */
  onForget: () => void;
  small?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const whyId = useId();
  const askButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    (asking ? keepButton : askButton).current?.focus();
  }, [asking]);
  const ask = (open: boolean): void => {
    moved.current = true;
    setAsking(open);
  };
  const described = blocked === null ? {} : { 'aria-describedby': whyId };
  const className = small ? 'btn small' : 'btn';
  const forget = (): void => {
    if (blocked !== null) return;
    setAsking(false);
    onForget();
  };
  return (
    <>
      {asking ? (
        <>
          <p>{FORGET_ASK}</p>
          <div className="actions">
            <button type="button" className={className} disabled={blocked !== null} {...described} onClick={forget}>It was not posted</button>
            <button type="button" className={className} ref={keepButton} onClick={() => ask(false)}>Keep</button>
          </div>
        </>
      ) : (
        <button type="button" className={className} ref={askButton} disabled={blocked !== null} {...described} onClick={() => ask(true)}>
          It was not posted
        </button>
      )}
      {blocked !== null && <Reason id={whyId} text={blocked} />}
    </>
  );
}

/**
 * A record whose outcome is not known, where its finding is shown: the words, the pull request to look at, and `It was
 * not posted`, which asks once more before it forgets the record. `blocked`: why it cannot be forgotten now. A refusal
 * of this mark's own request is said here.
 */
export function UnknownMark({ record, address, blocked, onForget, reply, id }: {
  record: PostRecord;
  address: string;
  blocked: string | null;
  /** Sends the forget and gives its ticket. */
  onForget: (record: PostRecord) => number;
  reply?: PostReply | undefined;
  /** The id of the words, for the Post button they explain. */
  id?: string;
}) {
  const [ticket, setTicket] = useState<number | null>(null);
  const refusal = reply !== undefined && reply.ticket === ticket && reply.kind === 'refused' ? reply.message : null;
  return (
    <div className="mark block">
      <span {...(id === undefined ? {} : { id })}>{UNKNOWN_MARK}</span>
      <p><a href={address} target="_blank" rel="noopener noreferrer">Open the pull request</a></p>
      <ForgetAsk blocked={blocked} small onForget={() => setTicket(onForget(record))} />
      {refusal !== null && <p role="alert" className="notice">{refusal}</p>}
    </div>
  );
}
