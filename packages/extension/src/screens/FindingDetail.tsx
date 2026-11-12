import type { Finding, PostRecord, PrSummary } from '@airlock/shared';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Timers } from '../client/timers';
import { connectedPlace, COULD_NOT_JUMP, ownPlace, type Jump, type JumpOptions, type JumpPlace, type JumpResult } from '../state/jump';
import { RefusedCopy, useCopy } from './CopyButton';
import { useFindingFolds, type FindingFold } from './finding-folds';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Crosshair } from './FindingIcons';
import { PostedMark, Reason, WAIT } from './PostedMark';
import { gistOf, shortTitle } from './summary';
import { useVisible } from './visible';
import { fromText, locationText, placeText, severityWord, sourceText } from './words';

/** Takes the person to a place in the reviewed pull request and says what it did. */
export type OnJump = (place: JumpPlace, options: JumpOptions) => Promise<JumpResult>;

export const notConnected: Jump = () => Promise.resolve({ sentence: 'Jumping is not connected yet.', needsReload: false });

/** The three actions' quiet lines, under their buttons. */
export const CAPTION = { copy: 'for your coding agent', post: 'you see it first', dismiss: 'hide it, teach Airlock' } as const;

/** Said when the fix prompt is on the clipboard. */
export const COPIED_PROMPT = 'Copied. Paste it to your coding agent.';

/** A place that, when too long for its row, is cut at its start, so the file name and the line stay in view. */
function EndInView({ className, text }: { className: string; text: string }) {
  return <code className={`${className} ap-end`}><span dir="ltr">{text}</span></code>;
}

/** The action whose button is filled, by the finding's kind: none for a note. */
const MAIN: Record<Finding['severity'], 'copy' | 'post' | null> = { block: 'copy', fix: 'copy', ask: 'post', note: null };

/** One fold: a heading whose button shows or hides what is under it, with a short word on its right. */
function Fold({ fold, title, aside, open, onToggle, children }: {
  fold: FindingFold; title: string; aside?: string; open: boolean; onToggle: (fold: FindingFold) => void; children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="ap-fold-part" data-fold={fold}>
      <h3 className="ap-fold-head">
        <button type="button" className="ap-fold" aria-expanded={open} {...(open ? { 'aria-controls': id } : {})} onClick={() => onToggle(fold)}>
          <ChevronRight />
          <span>{title}</span>
          {aside !== undefined && <span className="n ap-end"><span dir="ltr">{aside}</span></span>}
        </button>
      </h3>
      {open && <div className="ap-folded" id={id}>{children}</div>}
    </section>
  );
}

/** A label and its text inside a fold. */
function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ap-line">
      <h4 className="label">{label}</h4>
      {children}
    </div>
  );
}

export interface FindingDetailProps {
  finding: Finding;
  packs: PrSummary['packs'];
  previous: Finding | null;
  next: Finding | null;
  /** Where the finding is among the open findings in list order: `index` counts from 1 (1 is the first). Shown as "n of m". */
  position?: { index: number; total: number } | undefined;
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

/**
 * One finding: the short version first (kind, title, place, summary, what to do), the detail in folds, and the three
 * actions pinned at the bottom. Keyed by the caller on the finding's id, so each finding starts with its own focus and
 * notes; which folds are open is remembered across findings.
 */
export function FindingDetail({
  finding, packs, previous, next, position, canDismiss, fixPrompt, onBack, onOpen, onJump, changedPaths, onDismiss, posted,
  postBlocked = null, canPost = true, onPost = () => undefined, unknownMark, timers,
}: FindingDetailProps) {
  const title = useRef<HTMLHeadingElement>(null);
  const ids = { copy: useId(), post: useId(), dismiss: useId(), mark: useId() };
  // Why Comment on GitHub is disabled, when the finding has no record: the review's reason, or another action in flight.
  const postWhyText = postBlocked ?? (canPost ? null : WAIT);
  // `reloadFor`: the place to jump to again after reloading the GitHub tab, when the jump said a reload is needed.
  const [note, setNote] = useState<{ key: string; text: string; reloadFor: JumpPlace | null } | null>(null);
  const [open, toggle] = useFindingFolds();
  const copy = useCopy(fixPrompt, timers, COPIED_PROMPT);
  const copyButton = useRef<HTMLButtonElement>(null);
  const putAwayCopy = (): void => { copy.putAway(); copyButton.current?.focus(); };
  // The pinned actions' height, so a control reached with Tab is scrolled clear of them, never behind them.
  const pinnedBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = pinnedBox.current;
    const root = document.documentElement;
    if (node === null) return undefined;
    const measure = (): void => root.style.setProperty('--ap-pinned-height', `${Math.ceil(node.getBoundingClientRect().height)}px`);
    measure();
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    watch?.observe(node);
    return () => {
      watch?.disconnect();
      root.style.removeProperty('--ap-pinned-height');
    };
  }, []);
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

  const shown = shortTitle(finding);
  const gist = gistOf(finding);
  const main = MAIN[finding.severity];
  const raisedToo = finding.alsoRaisedBy ?? [];
  const unknown = posted !== undefined && posted.outcome !== 'posted' && unknownMark !== undefined;
  const postDisabled = posted !== undefined || postWhyText !== null;
  // Under Comment on GitHub: the post's mark, else why it cannot be pressed, else its line. The passing wait is said to a
  // screen reader only, so the line stays in sight.
  const postLine = posted !== undefined ? <PostedMark record={posted} id={ids.post} />
    : postWhyText !== null && postWhyText !== WAIT ? <Reason id={ids.post} text={postWhyText} />
      : (
        <>
          <span className="cap" {...(postWhyText === null ? { id: ids.post } : {})}>{CAPTION.post}</span>
          {postWhyText === WAIT && <Reason id={ids.post} text={WAIT} />}
        </>
      );
  const filled = (action: 'copy' | 'post'): string => (main === action ? 'btn primary' : 'btn');

  return (
    <div className="finding-screen">
      <div className="ap-top">
        <button type="button" className="ap-back" aria-label="Back to the review" onClick={onBack}><ChevronLeft />Review</button>
        {position !== undefined && <span className="ap-count">{`${position.index} of ${position.total}`}</span>}
        <button type="button" className="ap-icon" aria-label="Previous finding" disabled={previous === null} onClick={() => previous && onOpen(previous)}>
          <ChevronUp />
        </button>
        <button type="button" className="ap-icon" aria-label="Next finding" disabled={next === null} onClick={() => next && onOpen(next)}>
          <ChevronDown />
        </button>
      </div>

      <section className="ap-heading">
        <span className={`ap-tag sev-${finding.severity}`}>{severityWord(finding.severity)}</span>
        <h2 className="ap-title" tabIndex={-1} ref={title} data-focus="detail">{shown}</h2>
        <div className="ap-where">
          <EndInView className="path" text={locationText(finding)} />
          <button type="button" className="btn small" onClick={() => jump('own', ownPlace(finding, changedPaths))}><Crosshair />Show in diff</button>
        </div>
        {noteFor('own')}
      </section>

      {unknown && <div className="ap-onhub">{unknownMark(ids.mark)}</div>}
      {gist !== '' && <p className="ap-short">{gist}</p>}
      {finding.suggestedChange.trim() !== '' && (
        <section className="ap-do">
          <h3 className="label">What to do</h3>
          <p>{finding.suggestedChange}</p>
        </section>
      )}

      <div className="ap-folds">
        <Fold fold="happens" title="What happens" open={open.has('happens')} onToggle={toggle}>
          {shown !== finding.title && <p className="ap-whole">{finding.title}</p>}
          <p>{finding.happens}</p>
        </Fold>
        <Fold fold="why" title="Why it matters" open={open.has('why')} onToggle={toggle}>
          <p>{finding.why}</p>
        </Fold>
        <Fold fold="code" title="The code" aside={locationText(finding)} open={open.has('code')} onToggle={toggle}>
          <p className="path ap-place-whole">{locationText(finding)}</p>
          <pre className="quote"><code>{finding.quote}</code></pre>
        </Fold>
        {finding.connected.length > 0 && (
          <Fold fold="involves" title="Also involves" aside={String(finding.connected.length)} open={open.has('involves')} onToggle={toggle}>
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
          </Fold>
        )}
        <Fold fold="proof" title="How sure is this" open={open.has('proof')} onToggle={toggle}>
          {finding.checked.trim() !== '' && <Line label="Checked"><p>{finding.checked}</p></Line>}
          {finding.wouldBeWrongIf.trim() !== '' && <Line label="It would be wrong if"><p>{finding.wouldBeWrongIf}</p></Line>}
          <Line label="From"><p>{fromText(finding, packs)}</p></Line>
          {raisedToo.length > 0 && (
            <Line label="Also raised by">
              <ul className="plain">{raisedToo.map((source, i) => <li key={i}>{sourceText(source, packs)}</li>)}</ul>
            </Line>
          )}
        </Fold>
      </div>

      <div className="ap-pinned" ref={pinnedBox}>
        {copy.shown !== null && <div className="ap-refused"><RefusedCopy shown={copy.shown} box={copy.box} onClose={putAwayCopy} /></div>}
        <div className="ap-bar">
          <div className="ap-act">
            <button type="button" className={filled('copy')} ref={copyButton} aria-describedby={ids.copy} onClick={copy.copy}>
              {copy.copied ? 'Copied' : 'Copy fix prompt'}
            </button>
            <span className="cap" id={ids.copy}>{CAPTION.copy}</span>
          </div>
          <div className="ap-act">
            <button
              type="button" className={filled('post')} data-post-for={finding.id} disabled={postDisabled} aria-describedby={ids.post}
              onClick={() => onPost(finding)}
            >
              Comment on GitHub
            </button>
            {postLine}
          </div>
          <div className="ap-act">
            <button
              type="button" className="btn" data-dismiss-for={finding.id} disabled={!canDismiss} aria-describedby={ids.dismiss}
              onClick={() => onDismiss(finding)}
            >
              Dismiss
            </button>
            <span className="cap" id={ids.dismiss}>{CAPTION.dismiss}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
