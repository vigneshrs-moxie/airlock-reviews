import { POST_MAX_ITEMS, type Finding } from '@airlock/shared';
import { useId, type Ref } from 'react';
import type { Timers } from '../client/timers';
import { CopyButton } from './CopyButton';
import { Pinned } from './Pinned';
import { ALL_POSTED, Reason, TOO_MANY, WAIT } from './PostedMark';

/** The bar's label for one prompt covering every open Block and Fix. */
export const fixesLabel = (n: number): string => `Copy fix prompt for the ${n} ${n === 1 ? 'fix' : 'fixes'}`;

/**
 * Why Comment on GitHub cannot be pressed for the ticked findings; null when it can. The rules of the old Post selected:
 * the review's reason first, then nothing left to post, too many, or another action in flight. Nothing ticked has no
 * sentence: the count says it.
 */
export function whyNotCommenting(ticked: number, postable: number, blocked: string | null, busy: boolean): string | null {
  if (ticked === 0) return null;
  return blocked ?? (postable === 0 ? ALL_POSTED : postable > POST_MAX_ITEMS ? TOO_MANY : busy ? WAIT : null);
}

/**
 * The bar pinned to the bottom of the review. Out of select mode: one prompt for every open Block and Fix, when there is
 * one, and Select. In select mode: a prompt for the ticked findings, Comment on GitHub for those not yet posted, and Done.
 */
export function ReviewBar({ selecting, fixes, ticked, postable, blocked, busy, prompt, onSelect, onDone, onPost, selectRef, timers }: {
  selecting: boolean;
  /** The open findings whose kind is Block or Fix, in list order. */
  fixes: readonly Finding[];
  /** The ticked findings, in list order. */
  ticked: readonly Finding[];
  /** The ticked findings that are not posted and whose post is not in doubt. */
  postable: readonly Finding[];
  /** Why nothing can be posted from this review now; null when it can. */
  blocked: string | null;
  busy: boolean;
  prompt: (findings: readonly Finding[]) => () => string;
  onSelect: () => void;
  onDone: () => void;
  onPost: () => void;
  selectRef: Ref<HTMLButtonElement>;
  timers?: Timers | undefined;
}) {
  const whyId = useId();
  const t = timers ? { timers } : {};
  if (!selecting) {
    return (
      <Pinned name="review" label="Findings actions">
        {fixes.length > 0 && (
          <div className="ap-bar-main ap-primary">
            <CopyButton key={fixes.map((f) => f.id).join()} text={prompt(fixes)} label={fixesLabel(fixes.length)} {...t} />
          </div>
        )}
        <button type="button" className="btn" ref={selectRef} onClick={onSelect}>Select</button>
      </Pinned>
    );
  }
  const why = whyNotCommenting(ticked.length, postable.length, blocked, busy);
  const disabled = ticked.length === 0 || why !== null;
  return (
    <Pinned name="review" label="Actions on the selected findings">
      <div className="ap-bar-main">
        {ticked.length === 0
          ? <button type="button" className="btn" disabled>Copy fix prompt (0)</button>
          : <CopyButton key={ticked.map((f) => f.id).join()} text={prompt(ticked)} label={`Copy fix prompt (${ticked.length})`} {...t} />}
      </div>
      <button
        type="button" className="btn primary ap-bar-main" data-post-selected disabled={disabled}
        {...(why === null ? {} : { 'aria-describedby': whyId })} onClick={onPost}
      >
        {`Comment on GitHub (${postable.length})`}
      </button>
      <button type="button" className="btn" onClick={onDone}>Done</button>
      {why !== null && <p className="ap-bar-why"><Reason id={whyId} text={why} /></p>}
    </Pinned>
  );
}
