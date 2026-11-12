import type { Finding, PostRecord, PrSummary } from '@airlock/shared';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Timers } from '../client/timers';
import { connectedPlace, COULD_NOT_JUMP, ownPlace, type Jump, type JumpOptions, type JumpPlace, type JumpResult } from '../state/jump';
import { CopyButton } from './CopyButton';
import { PostedMark, Reason, WAIT } from './PostedMark';
import { useVisible } from './visible';
import { fromText, locationText, placeText, severityWord, sourceText } from './words';

/** Takes the person to a place in the reviewed pull request and says what it did. */
export type OnJump = (place: JumpPlace, options: JumpOptions) => Promise<JumpResult>;

export const notConnected: Jump = () => Promise.resolve({ sentence: 'Jumping is not connected yet.', needsReload: false });

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="part">
      <h3 className="label">{title}</h3>
      {children}
    </section>
  );
}

export interface FindingDetailProps {
  finding: Finding;
  packs: PrSummary['packs'];
  previous: Finding | null;
  next: Finding | null;
  /** Dismiss needs the service; false when the review is shown read-only. */
  canDismiss: boolean;
  fixPrompt: () => string;
  onBack: () => void;
  onOpen: (finding: Finding) => void;
  onJump: OnJump;
  /** The paths of the review's files: a place among them is on the Files changed page. */
  changedPaths: ReadonlySet<string>;
  onDismiss: (finding: Finding) => void;
  /** The finding's post record, when it is posted or its post's outcome is not known. */
  posted?: PostRecord | undefined;
  /** Why nothing can be posted from this review now; null when it can. */
  postBlocked?: string | null;
  /** False while another action is in flight. */
  canPost?: boolean;
  onPost?: (finding: Finding) => void;
  /** The mark for a record whose outcome is not known, with its controls; `id` names its words. */
  unknownMark?: (id: string) => ReactNode;
  timers?: Timers;
}

/** One finding in full. Keyed by the caller on the finding's id, so each finding starts with its own focus and notes. */
export function FindingDetail({
  finding, packs, previous, next, canDismiss, fixPrompt, onBack, onOpen, onJump, changedPaths, onDismiss, posted, postBlocked = null,
  canPost = true, onPost = () => undefined, unknownMark, timers,
}: FindingDetailProps) {
  const title = useRef<HTMLHeadingElement>(null);
  const postWhy = useId();
  // Why Post comment is disabled, when the finding has no record: the review's reason, or another action in flight.
  const postWhyText = postBlocked ?? (canPost ? null : WAIT);
  // `reloadFor`: the place to jump to again after reloading the GitHub tab, when the jump said a reload is needed.
  const [note, setNote] = useState<{ key: string; text: string; reloadFor: JumpPlace | null } | null>(null);
  const visible = useVisible();
  const focused = useRef(false);
  useEffect(() => {
    if (!visible || focused.current) return;
    focused.current = true;
    title.current?.focus();
  }, [visible]);

  // Only the latest jump's answer is shown: an earlier one that answers later is dropped.
  const latestJump = useRef(0);
  const jump = (key: string, place: JumpPlace, reload = false): void => {
    const mine = ++latestJump.current;
    const said = (result: JumpResult): void => {
      if (mine === latestJump.current) setNote({ key, text: result.sentence, reloadFor: result.needsReload ? place : null });
    };
    const failed = (): void => said({ sentence: COULD_NOT_JUMP, needsReload: false });
    try {
      Promise.resolve(onJump(place, { reload })).then(said, failed);
    } catch {
      failed();
    }
  };
  // The GitHub tab is reloaded only from this button: it may hold a comment the person is typing.
  const noteFor = (key: string) => {
    if (note?.key !== key) return null;
    const { reloadFor } = note;
    return (
      <>
        <p className="muted" role="status">{note.text}</p>
        {reloadFor !== null && <button type="button" className="btn small" onClick={() => jump(key, reloadFor, true)}>Reload the GitHub tab</button>}
      </>
    );
  };

  return (
    <>
      <button type="button" className="btn small back" onClick={onBack}>Back to the review</button>
      <section className="card">
        <h2 className="title" tabIndex={-1} ref={title} data-focus="detail">{finding.title}</h2>
        <p><span className="sev">{severityWord(finding.severity)}</span></p>
        <code className="path block">{locationText(finding)}</code>
        <Part title="What happens"><p>{finding.happens}</p></Part>
        <Part title="Why"><p>{finding.why}</p></Part>
        {finding.suggestedChange.trim() !== '' && <Part title="Suggested change"><p>{finding.suggestedChange}</p></Part>}
        <Part title="The code"><pre className="quote"><code>{finding.quote}</code></pre></Part>
        {finding.connected.length > 0 && (
          <Part title="Also involves">
            <ul className="plain">
              {finding.connected.map((place, i) => (
                <li key={i}>
                  <button type="button" className="place" onClick={() => jump(`place-${i}`, connectedPlace(place, changedPaths))}>
                    <code className="path">{placeText(place.path, place.line)}</code>
                    <span className="muted">{place.role}</span>
                  </button>
                  {noteFor(`place-${i}`)}
                </li>
              ))}
            </ul>
          </Part>
        )}
        {finding.checked.trim() !== '' && <Part title="Checked"><p>{finding.checked}</p></Part>}
        {finding.wouldBeWrongIf.trim() !== '' && <Part title="Would be wrong if"><p>{finding.wouldBeWrongIf}</p></Part>}
        <Part title="From"><p>{fromText(finding, packs)}</p></Part>
        {finding.alsoRaisedBy !== undefined && finding.alsoRaisedBy.length > 0 && (
          <Part title="Also raised by">
            <ul className="plain">{finding.alsoRaisedBy.map((source, i) => <li key={i}>{sourceText(source, packs)}</li>)}</ul>
          </Part>
        )}
      </section>
      <div className="actions">
        <div className="action">
          <button type="button" className="btn" onClick={() => jump('own', ownPlace(finding, changedPaths))}>Jump to line</button>
          {noteFor('own')}
        </div>
        <div className="action"><CopyButton text={fixPrompt} label="Copy fix prompt" {...(timers ? { timers } : {})} /></div>
        <div className="action">
          <button
            type="button" className="btn" data-post-for={finding.id} disabled={posted !== undefined || postWhyText !== null}
            {...(posted !== undefined || postWhyText !== null ? { 'aria-describedby': postWhy } : {})} onClick={() => onPost(finding)}
          >
            Post comment
          </button>
          {posted !== undefined
            ? (posted.outcome === 'posted' || unknownMark === undefined ? <PostedMark record={posted} id={postWhy} /> : unknownMark(postWhy))
            : postWhyText !== null && <Reason id={postWhy} text={postWhyText} />}
        </div>
        <div className="action">
          <button type="button" className="btn" data-dismiss-for={finding.id} disabled={!canDismiss} onClick={() => onDismiss(finding)}>Dismiss</button>
        </div>
      </div>
      <div className="actions">
        <button type="button" className="btn" disabled={previous === null} onClick={() => previous && onOpen(previous)}>Previous</button>
        <button type="button" className="btn" disabled={next === null} onClick={() => next && onOpen(next)}>Next</button>
      </div>
    </>
  );
}
