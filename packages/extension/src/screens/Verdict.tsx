import { fixPrompt, POST_MAX_ITEMS, verdictWords, type Dismissal, type Finding, type ReviewDocument, type Tier } from '@airlock/shared';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Timers } from '../client/timers';
import { listFindings, neighbours, postOf, selectedInOrder, toggled } from '../state/selection';
import type { PostReply, ReviewView, UserAction } from '../state/reduce';
import { AlsoFound } from './AlsoFound';
import { BriefBlock } from './BriefBlock';
import { Collapsible } from './Collapsible';
import { CopyButton } from './CopyButton';
import { useVisible } from './visible';
import { DismissedList } from './DismissedList';
import { DroppedSheet } from './DroppedSheet';
import { FindingCard } from './FindingCard';
import { FixedList } from './FixedList';
import type { Jump } from '../state/jump';
import { FindingDetail, notConnected } from './FindingDetail';
import { useAnnounce } from './Frame';
import { MapBlock } from './MapBlock';
import { ALL_POSTED, NO_POST_OFFLINE, pullAddress, Reason, TOO_MANY, UnknownMark, WAIT, whyNotPosting } from './PostedMark';
import { nextTicket } from './PostSheet';
import { StageErrors } from './StageErrors';
import { TimingTable, tookTime } from './TimingTable';
import { depthWord } from './words';

export interface VerdictProps {
  state: ReviewView & { notice?: string; busy?: boolean; post?: PostReply };
  dispatch: (action: UserAction) => void;
  /** Shown from before the service stopped: everything that needs the service is disabled. */
  readOnly?: boolean;
  /** Called with the reviewed pull request and the place; works read-only too, as it needs no service. */
  onJump?: Jump;
  onDismiss?: (finding: Finding) => void;
  /** Opens the post sheet for these findings, none of them posted; `opener` is a finding's id, or `selected` for the bar. */
  onPost?: (findings: Finding[], opener: string) => void;
  /** For the Copy buttons' two seconds. */
  timers?: Timers;
}

type Fold = 'limits' | 'notes' | 'also' | 'dismissed' | 'timing' | 'fixed';

const noDismiss = (): void => undefined;
const noPost = (): void => undefined;

function ReviewAgain({ doc, disabled, dispatch, label = 'Review again' }: {
  doc: ReviewDocument; disabled: boolean; dispatch: VerdictProps['dispatch']; label?: string;
}) {
  return <button type="button" className="btn" disabled={disabled} onClick={() => dispatch({ type: 'start', depth: doc.depth })}>{label}</button>;
}

const short = (sha: string): string => sha.slice(0, 7);

/** The line under the verdict that says what a re-review or a merge review covered; nothing for a full review (its note says why). */
function rangeLine(doc: ReviewDocument): string | null {
  if (doc.range.kind === 'sync-merge' && doc.previous !== undefined) {
    return `Review of the merge pushed since ${short(doc.previous.headSha)}: only what was changed by hand was reviewed.`;
  }
  if (doc.range.kind === 'rereview' && doc.previous !== undefined) {
    return `Review of the push ${short(doc.previous.headSha)} to ${short(doc.pr.headSha)}`;
  }
  return null;
}

/** The finished review: the verdict, the findings and what sits around them; one finding in full when it is opened. */
export function Verdict({ state, dispatch, readOnly = false, onJump = notConnected, onDismiss = noDismiss, onPost = noPost, timers }: VerdictProps) {
  const { pr, latest, stale } = state;
  const doc = latest.document;
  const announce = useAnnounce();
  const visible = useVisible();
  const t = timers ? { timers } : {};
  const lists = useMemo(() => listFindings(doc.findings, latest.dismissals), [doc.findings, latest.dismissals]);
  const changedPaths = useMemo(() => new Set(doc.files.map((f) => f.path)), [doc.files]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [folds, setFolds] = useState<ReadonlySet<string>>(new Set());
  const [sheet, setSheet] = useState(false);
  const droppedButton = useRef<HTMLButtonElement>(null);
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  const shownDetail = useRef<string | null>(null);
  const verdictHeading = useRef<HTMLHeadingElement>(null);
  const findingsHeading = useRef<HTMLHeadingElement>(null);
  const postWhy = useId();

  const chosen = selectedInOrder(lists.order, selected);
  const detail = openId === null ? undefined : lists.order.find((f) => f.id === openId);
  const detailId = detail?.id ?? null;
  const disabled = readOnly || state.busy === true;
  const recordOf = (f: Finding) => postOf(f, latest.posts);
  const postBlocked = whyNotPosting(pr, stale, readOnly);
  // Ticked findings already posted (or whose post is not known) are left out of a post.
  const postable = chosen.filter((f) => recordOf(f) === undefined);
  const barWhy = postBlocked ?? (postable.length === 0 ? ALL_POSTED : postable.length > POST_MAX_ITEMS ? TOO_MANY : state.busy === true ? WAIT : null);
  // A record whose outcome is not known is cleared where its finding is shown.
  const forgetBlocked = readOnly ? NO_POST_OFFLINE : state.busy === true ? WAIT : null;
  const forget = (record: Parameters<typeof UnknownMark>[0]['record']): number => {
    const ticket = nextTicket();
    dispatch({ type: 'forget-post', ticket, id: record.id });
    return ticket;
  };
  const unknownMark = (f: Finding, id?: string) => {
    const record = recordOf(f);
    if (record === undefined || record.outcome === 'posted') return null;
    return (
      <UnknownMark
        record={record} address={pullAddress(pr)} blocked={forgetBlocked} onForget={forget} reply={state.post}
        {...(id === undefined ? {} : { id })}
      />
    );
  };

  const register = useCallback((id: string, node: HTMLButtonElement | null): void => {
    if (node === null) nodes.current.delete(id);
    else nodes.current.set(id, node);
  }, []);

  const count = chosen.length;
  const counted = useRef(count);
  useEffect(() => {
    if (counted.current === count) return;
    counted.current = count;
    announce(count === 0 ? 'Selection cleared' : `${count} selected`);
  }, [announce, count]);

  // A selection never holds a finding that is not shown (one dismissed since), so a restored finding comes back unticked.
  useEffect(() => {
    const visible = new Set(lists.order.map((f) => f.id));
    setSelected((was) => {
      const kept = [...was].filter((id) => visible.has(id));
      return kept.length === was.size ? was : new Set(kept);
    });
  }, [lists.order]);

  // An open finding that is no longer shown (dismissed) is forgotten, so restoring it does not reopen it.
  useEffect(() => { if (openId !== null && detail === undefined) setOpenId(null); }, [openId, detail]);

  // Opening a finding is announced by the focus on its heading. Leaving it puts focus back on the line that opened it (opening
  // Also found when the line is in it), or on the Findings heading, or the verdict, when that finding is gone.
  useEffect(() => {
    if (detailId !== null) { shownDetail.current = detailId; return; }
    const id = shownDetail.current;
    // Out of sight, the move waits and is not used up; it happens when the panel is in sight again.
    if (id === null || !visible) return;
    const node = nodes.current.get(id);
    if (node) { node.focus(); shownDetail.current = null; return; }
    if (lists.also.some((f) => f.id === id) && !folds.has('also')) { setFolds((was) => toggled(was, 'also')); return; }
    (findingsHeading.current ?? verdictHeading.current)?.focus();
    shownDetail.current = null;
  }, [detailId, folds, lists, visible]);

  const empty = lists.order.length === 0;
  const unfinished = doc.verdict.label === 'incomplete';
  const allDismissed = empty && !unfinished && lists.dismissed.length > 0;
  useEffect(() => { if (allDismissed) setFolds((was) => (was.has('dismissed') ? was : toggled(was, 'dismissed'))); }, [allDismissed]);

  const fold = (key: Fold): void => setFolds((was) => toggled(was, key));
  const closeSheet = useCallback((): void => setSheet(false), []);
  const shownIds = useMemo(() => new Set(lists.order.map((f) => f.id)), [lists.order]);
  const showMerged = useCallback((id: string): void => { setSheet(false); setOpenId(id); }, []);
  const restore = (d: Dismissal): void => dispatch({ type: 'restore', fingerprint: d.fingerprint });
  const promptFor = (findings: Finding[]) => (): string => fixPrompt(doc, findings);

  const banners = (
    <>
      {stale && (
        <section className="card banner">
          <p>New commits since this review.</p>
          <div className="bar">
            <button type="button" className="btn" disabled={disabled} onClick={() => dispatch({ type: 'start', depth: doc.depth, since: 'last' })}>
              Review the push
            </button>
            <ReviewAgain doc={doc} disabled={disabled} dispatch={dispatch} label="Review everything again" />
          </div>
        </section>
      )}
      {state.notice !== undefined && <p role="alert" className="notice">{state.notice}</p>}
    </>
  );

  if (detail !== undefined) {
    const { previous, next } = neighbours(lists.order, detail.id);
    return (
      <>
      {banners}
      <FindingDetail
        key={detail.id} finding={detail} packs={pr.packs} previous={previous} next={next} canDismiss={!disabled}
        fixPrompt={promptFor([detail])} onBack={() => setOpenId(null)} onOpen={(f) => setOpenId(f.id)}
        onJump={(place, options) => onJump(doc.pr, place, options)} changedPaths={changedPaths} onDismiss={onDismiss}
        posted={recordOf(detail)} postBlocked={postBlocked} canPost={state.busy !== true} onPost={(f) => onPost([f], f.id)}
        unknownMark={(id) => unknownMark(detail, id)} {...t}
      />
      </>
    );
  }

  const titles = doc.packs.map((p) => pr.packs.find((known) => known.id === p.id)?.title ?? p.id).join(', ');
  const tiers = new Map<string, Tier>(doc.files.map((f) => [f.path, f.tier]));
  const ran = doc.timings.some(tookTime);
  const line = rangeLine(doc);
  // A re-review's notes say why it covered what it did, so they sit under the verdict; a first review's stay folded.
  const notesUnderVerdict = doc.previous !== undefined && doc.notes !== undefined && doc.notes.length > 0;
  const fixed = doc.fixed ?? [];

  return (
    <>
      <section className="card verdict">
        <h2 className="title" tabIndex={-1} data-focus="verdict" ref={verdictHeading}>{verdictWords(doc.verdict.label, doc.pr.stage)}</h2>
        <p>{doc.verdict.sentence}</p>
        {empty && (
          <p>
            {unfinished ? 'The review did not finish, so nothing here is cleared.'
              : lists.dismissed.length > 0 ? `No open findings. ${lists.dismissed.length} dismissed.` : 'No findings.'}
          </p>
        )}
        {line !== null && <p>{line}</p>}
        {notesUnderVerdict && doc.notes!.map((note, i) => <p key={i}>{note}</p>)}
        <p className="muted">{`Reviewed at ${doc.pr.headSha.slice(0, 7)} · ${depthWord(doc.depth)}${titles === '' ? '' : ` · ${titles}`}`}</p>
      </section>
      {banners}
      <StageErrors errors={doc.stageErrors} map={doc.map} />
      {doc.limits !== undefined && doc.limits.length > 0 && (
        <Collapsible title="Not shown to the reviewer" open={folds.has('limits')} onToggle={() => fold('limits')}>
          <ul className="plain">{doc.limits.map((line, i) => <li key={i}>{line}</li>)}</ul>
        </Collapsible>
      )}
      {!notesUnderVerdict && doc.notes !== undefined && doc.notes.length > 0 && (
        <Collapsible title={`Notes (${doc.notes.length})`} open={folds.has('notes')} onToggle={() => fold('notes')}>
          <ul className="plain">{doc.notes.map((line, i) => <li key={i}>{line}</li>)}</ul>
        </Collapsible>
      )}
      {lists.top.length > 0 && (
        <section>
          <h2 className="label" tabIndex={-1} data-focus="findings" ref={findingsHeading}>Findings</h2>
          {count > 0 && (
            <div className="bar">
              <CopyButton key={chosen.map((f) => f.id).join()} text={promptFor(chosen)} label={`Copy fix prompt for ${count} selected`} {...t} />
              <div className="action">
                <button
                  type="button" className="btn small" data-post-selected disabled={barWhy !== null}
                  {...(barWhy === null ? {} : { 'aria-describedby': postWhy })} onClick={() => onPost(postable, 'selected')}
                >
                  {`Post selected (${postable.length})`}
                </button>
                {barWhy !== null && <Reason id={postWhy} text={barWhy} />}
              </div>
              <button type="button" className="btn small" onClick={() => setSelected(new Set())}>Clear</button>
            </div>
          )}
          <ol className="plain cards">
            {lists.top.map((f, i) => (
              <FindingCard
                key={f.id} finding={f} rank={i + 1} packs={pr.packs} selected={selected.has(f.id)} posted={recordOf(f)} after={unknownMark(f)}
                onToggle={() => setSelected((was) => toggled(was, f.id))} onOpen={() => setOpenId(f.id)} register={register}
              />
            ))}
          </ol>
        </section>
      )}
      {fixed.length > 0 && (
        <Collapsible title={`Fixed since the last review (${fixed.length})`} open={folds.has('fixed')} onToggle={() => fold('fixed')}>
          <FixedList findings={fixed} />
        </Collapsible>
      )}
      {lists.also.length > 0 && (
        <Collapsible title="Also found" open={folds.has('also')} onToggle={() => fold('also')}>
          <AlsoFound findings={lists.also} onOpen={(f) => setOpenId(f.id)} register={register} postOf={recordOf} after={(f) => unknownMark(f)} />
        </Collapsible>
      )}
      {doc.questions.length > 0 && (
        <section className="card">
          <h2 className="label">Questions</h2>
          <ul className="plain">{doc.questions.map((q, i) => <li key={i}>{q.text}</li>)}</ul>
        </section>
      )}
      {doc.whoseCall.length > 0 && (
        <section className="card">
          <h2 className="label">Whose call</h2>
          <ul className="plain">{doc.whoseCall.map((line, i) => <li key={i}>{line}</li>)}</ul>
        </section>
      )}
      {doc.checksAfterMerge.length > 0 && (
        <section className="card">
          <h2 className="label">Check after merge</h2>
          <ol className="steps">{doc.checksAfterMerge.map((line, i) => <li key={i}>{line}</li>)}</ol>
        </section>
      )}
      <BriefBlock brief={doc.brief} {...(doc.range.kind === 'sync-merge' && doc.previous === undefined ? { mergeOf: doc.pr.baseRef } : {})} />
      {doc.selfReviewText.trim() !== '' && (
        <section className="card">
          <h2 className="label">Text for your pull request</h2>
          <div className="quote">{doc.selfReviewText}</div>
          <CopyButton text={() => doc.selfReviewText} label="Copy" {...t} />
        </section>
      )}
      {(doc.map.cohorts.length > 0 || doc.map.standalone.length > 0) && <MapBlock map={doc.map} tiers={tiers} />}
      {doc.dropped.length > 0 && (
        <button type="button" className="btn" ref={droppedButton} onClick={() => setSheet(true)}>{`Dropped: ${doc.dropped.length}`}</button>
      )}
      {lists.dismissed.length > 0 && (
        <Collapsible title={`Dismissed: ${lists.dismissed.length}`} open={folds.has('dismissed')} onToggle={() => fold('dismissed')}>
          <DismissedList items={lists.dismissed} canRestore={!disabled} onRestore={restore} />
        </Collapsible>
      )}
      {ran && (
        <Collapsible title="Timing" open={folds.has('timing')} onToggle={() => fold('timing')}>
          <TimingTable timings={doc.timings} />
        </Collapsible>
      )}
      {!stale && <ReviewAgain doc={doc} disabled={disabled} dispatch={dispatch} />}
      {sheet && <DroppedSheet dropped={doc.dropped} opener={droppedButton} onClose={closeSheet} shown={shownIds} onShow={showMerged} />}
    </>
  );
}
