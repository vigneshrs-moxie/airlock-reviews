import { POST_MAX_ITEMS, type Finding } from '@airlock/shared';
import { useId, useRef, type Ref } from 'react';
import type { Timers } from '../client/timers';
import { RefusedCopy, useCopy } from './CopyButton';
import { COPIED_PROMPT } from './FindingDetail';
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
 * A fix prompt's Copy button says Copied for two seconds and announces where the prompt goes, as the finding screen's
 * does. A refused copy shows the prompt to copy by hand above the buttons (it scrolls on its own; the buttons stay), and
 * its Close puts focus back on the Copy button.
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
  const copying = selecting ? ticked : fixes;
  // What the prompt covers: a change (a tick, a mode) takes a refused prompt's box away, as it no longer matches.
  const copyKey = `${selecting ? 'ticked' : 'fixes'}:${copying.map((f) => f.id).join()}`;
  const { copied, shown, copy, putAway, box } = useCopy(prompt(copying), timers, COPIED_PROMPT, copyKey);
  const copyButton = useRef<HTMLButtonElement>(null);
  const putAwayCopy = (): void => { putAway(); copyButton.current?.focus(); };
  const above = shown !== null && <RefusedCopy shown={shown} box={box} onClose={putAwayCopy} />;
  const copyPrompt = (label: string) => (
    <button type="button" className="btn small" ref={copyButton} onClick={copy}>{copied ? 'Copied' : label}</button>
  );
  if (!selecting) {
    return (
      <Pinned name="review" label="Findings actions" above={above}>
        {fixes.length > 0 && <div className="ap-bar-main ap-primary">{copyPrompt(fixesLabel(fixes.length))}</div>}
        <button type="button" className="btn" ref={selectRef} onClick={onSelect}>Select</button>
      </Pinned>
    );
  }
  const why = whyNotCommenting(ticked.length, postable.length, blocked, busy);
  const disabled = ticked.length === 0 || why !== null;
  return (
    <Pinned name="review" label="Actions on the selected findings" above={above}>
      <div className="ap-bar-main">
        {ticked.length === 0
          ? <button type="button" className="btn" disabled>Copy fix prompt (0)</button>
          : copyPrompt(`Copy fix prompt (${ticked.length})`)}
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
