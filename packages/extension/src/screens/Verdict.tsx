import { fixPrompt, rereviewCovered, type Dismissal, type Finding, type ReviewDocument } from '@airlock/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Timers } from '../client/timers';
import { listFindings, neighbours, postOf, selectedInOrder, toggled } from '../state/selection';
import { pushReviewable, type PostReply, type ReviewView, type UserAction } from '../state/reduce';
import { AlsoFound } from './AlsoFound';
import { ChangeTab, type ChangeFold } from './ChangeTab';
import { Collapsible } from './Collapsible';
import { useVisible } from './visible';
import { DroppedSheet } from './DroppedSheet';
import { FindingCard } from './FindingCard';
import { FixedList } from './FixedList';
import type { Jump } from '../state/jump';
import type { NotesLine } from '../state/notes';
import { FindingDetail, notConnected } from './FindingDetail';
import { useAnnounce } from './Frame';
import { MoreTab, type MoreFold } from './MoreTab';
import { FORGOTTEN, NO_POST_OFFLINE, pullAddress, UnknownMark, WAIT, whyNotPosting } from './PostedMark';
import { nextTicket } from './PostSheet';
import { ReviewBar } from './ReviewBar';
import { StageErrors } from './StageErrors';
import { Tabs, type TabItem } from './Tabs';
import { VerdictStrip } from './VerdictStrip';

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
  /** What the notes on GitHub's page did, said in the verdict strip; null for nothing to say. */
  notesLine?: NotesLine | null;
  /** Reloads the GitHub tab and sends the notes again: the person pressed the line's button. */
  onReloadNotes?: () => void;
  /** The finding `Open in Airlock` asked for; a new `seq` asks again. Ignored when it is not an open finding of this review. */
  openFinding?: OpenFinding | null;
}

/** A request to open one finding, numbered so the same finding can be asked for again. */
export interface OpenFinding { id: string; seq: number }

type Tab = 'findings' | 'change' | 'more';
type Fold = 'also' | 'fixed' | ChangeFold | MoreFold;

const noDismiss = (): void => undefined;
const noPost = (): void => undefined;

function ReviewAgain({ doc, disabled, dispatch, label = 'Review again' }: {
  doc: ReviewDocument; disabled: boolean; dispatch: VerdictProps['dispatch']; label?: string;
}) {
  return <button type="button" className="btn ap-start" disabled={disabled} onClick={() => dispatch({ type: 'start', depth: doc.depth })}>{label}</button>;
}

const short = (sha: string): string => sha.slice(0, 7);

/**
 * The line in the verdict strip that says what a re-review covered, as the document says (`rereviewCovered`): the push; a
 * pushed merge, said to be reviewed by hand only when the document says so (`mergeReview`) and naming no branch (the
 * push may have merged one other than the base), and nothing for one Airlock could not review or a document that does
 * not say (the stage error says what happened). Nothing for a full review (its note says why), nor when everything was
 * reviewed again (its note, under More, says why).
 */
function rangeLine(doc: ReviewDocument): string | null {
  const covered = rereviewCovered(doc);
  if (doc.previous === undefined || covered === null || covered === 'everything') return null;
  if (covered === 'push') return `Review of the push ${short(doc.previous.headSha)} to ${short(doc.pr.headSha)}`;
  if (doc.mergeReview === 'by-hand') return `Review of the merge pushed since ${short(doc.previous.headSha)}: only what was changed by hand was reviewed.`;
  if (doc.mergeReview === 'nothing-by-hand') {
    return 'The push only merged another branch in; git merged it without conflicts and nothing was changed by hand.';
  }
  return null;
}

/** For a first review of a merge, what its brief's heading says it covered; none unless the document says (`mergeReview`). */
function mergeOf(doc: ReviewDocument): { base: string; kind: 'by-hand' | 'nothing-by-hand' } | undefined {
  if (doc.range.kind !== 'sync-merge' || doc.previous !== undefined) return undefined;
  if (doc.mergeReview !== 'by-hand' && doc.mergeReview !== 'nothing-by-hand') return undefined;
  return { base: doc.pr.baseRef, kind: doc.mergeReview };
}

/** What scrolls the panel. */
const scroller = (): Element => document.scrollingElement ?? document.documentElement;
/** The Findings tab, which the sheets' focus helpers also look for; none when no finding is open. */
const findingsTab = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-focus="findings"]');

/**
 * The finished review: the verdict strip, what must be seen at once (the stale banner, the notice, the stage errors), then
 * three tabs (the findings, the change, more) and a bar pinned to the bottom; one finding in full when it is opened.
 */
export function Verdict({
  state, dispatch, readOnly = false, onJump = notConnected, onDismiss = noDismiss, onPost = noPost, timers, notesLine = null,
  onReloadNotes, openFinding = null,
}: VerdictProps) {
  const { pr, latest, stale } = state;
  const doc = latest.document;
  const announce = useAnnounce();
  const visible = useVisible();
  const t = timers ? { timers } : {};
  const lists = useMemo(() => listFindings(doc.findings, latest.dismissals), [doc.findings, latest.dismissals]);
  const changedPaths = useMemo(() => new Set(doc.files.map((f) => f.path)), [doc.files]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('findings');
  const [folds, setFolds] = useState<ReadonlySet<string>>(new Set());
  const [sheet, setSheet] = useState(false);
  const droppedButton = useRef<HTMLButtonElement>(null);
  const selectButton = useRef<HTMLButtonElement>(null);
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  const shownDetail = useRef<string | null>(null);
  /** Where the panel was scrolled when a finding was opened, put back when the review is shown again. */
  const scrolledTo = useRef<number | null>(null);
  const verdictHeading = useRef<HTMLHeadingElement>(null);
  /** Forgets sent from a mark, by ticket, with the finding each was for. */
  const forgetting = useRef(new Map<number, string>());
  /** The service's sentence when a forget sent from a mark found the review on GitHub, so nothing was forgotten. */
  const [found, setFound] = useState<string | null>(null);
  const foundLine = useRef<HTMLParagraphElement>(null);

  const chosen = selectedInOrder(lists.order, selected);
  const detail = openId === null ? undefined : lists.order.find((f) => f.id === openId);
  const detailId = detail?.id ?? null;
  const disabled = readOnly || state.busy === true;
  const recordOf = (f: Finding) => postOf(f, latest.posts);
  const postBlocked = whyNotPosting(pr, stale, readOnly);
  // Ticked findings already posted (or whose post is not known) are left out of a post.
  const postable = chosen.filter((f) => recordOf(f) === undefined);
  // A record whose outcome is not known is cleared where its finding is shown.
  const forgetBlocked = readOnly ? NO_POST_OFFLINE : state.busy === true ? WAIT : null;
  const forget = (record: Parameters<typeof UnknownMark>[0]['record'], findingId: string): number => {
    const ticket = nextTicket();
    setFound(null);
    forgetting.current.set(ticket, findingId);
    dispatch({ type: 'forget-post', ticket, id: record.id });
    return ticket;
  };
  const unknownMark = (f: Finding, id?: string) => {
    const record = recordOf(f);
    if (record === undefined || record.outcome === 'posted') return null;
    return (
      <UnknownMark
        record={record} address={pullAddress(pr)} blocked={forgetBlocked} onForget={(r) => forget(r, f.id)} reply={state.post}
        {...(id === undefined ? {} : { id })}
      />
    );
  };

  /** Opens a finding, keeping where the review was scrolled to. */
  const open = useCallback((id: string): void => {
    if (shownDetail.current === null) scrolledTo.current = scroller().scrollTop;
    setOpenId(id);
  }, []);

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

  // `Open in Airlock` on a note: that finding, when it is open in this review. A request made before this review was
  // shown (for an earlier one) is not acted on.
  const askedOpen = useRef(openFinding?.seq ?? 0);
  useEffect(() => {
    if (openFinding === null || openFinding.seq === askedOpen.current) return;
    askedOpen.current = openFinding.seq;
    if (lists.order.some((f) => f.id === openFinding.id)) open(openFinding.id);
  }, [openFinding, lists.order, open]);

  // The notes line is said when it changes, not when the notes are sent again with the same counts.
  const notesText = notesLine?.text ?? null;
  const saidNotes = useRef<string | null>(null);
  useEffect(() => {
    if (notesText === saidNotes.current) return;
    saidNotes.current = notesText;
    if (notesText !== null) announce(notesText);
  }, [announce, notesText]);

  // An open finding that is no longer shown (dismissed) is forgotten, so restoring it does not reopen it.
  useEffect(() => { if (openId !== null && detail === undefined) setOpenId(null); }, [openId, detail]);

  // Back from a finding, the review is where it was scrolled to before the finding was opened.
  useLayoutEffect(() => {
    if (detailId !== null || scrolledTo.current === null || !visible) return;
    scroller().scrollTop = scrolledTo.current;
    scrolledTo.current = null;
  }, [detailId, visible]);

  // Opening a finding is announced by the focus on its heading. Leaving it puts focus back on the row that opened it (opening
  // Also found when the row is in it), or on the Findings tab, or the verdict, when that finding is gone; on the More tab,
  // from a finding the dropped sheet showed, on Dropped.
  useEffect(() => {
    if (detailId !== null) { shownDetail.current = detailId; return; }
    const id = shownDetail.current;
    // Out of sight, the move waits and is not used up; it happens when the panel is in sight again.
    if (id === null || !visible) return;
    const node = nodes.current.get(id);
    if (node) {
      node.focus({ preventScroll: true });
      node.scrollIntoView?.({ block: 'nearest' });
      shownDetail.current = null;
      return;
    }
    if (tab === 'findings' && lists.also.some((f) => f.id === id) && !folds.has('also')) { setFolds((was) => toggled(was, 'also')); return; }
    ((tab === 'more' ? droppedButton.current : null) ?? findingsTab() ?? verdictHeading.current)?.focus();
    shownDetail.current = null;
  }, [detailId, folds, lists, visible, tab]);

  // A record forgotten from a mark: say so, and put focus on the finding's Comment on GitHub, or the Findings tab. One that
  // GitHub has after all (found): its sentence is shown and has focus, and the finding's mark now says Posted.
  const reply = state.post;
  useEffect(() => {
    if (reply?.kind !== 'forgotten' && reply?.kind !== 'found') return;
    const findingId = forgetting.current.get(reply.ticket);
    if (findingId === undefined) return;
    forgetting.current.delete(reply.ticket);
    if (reply.kind === 'found') {
      setFound(reply.message);
      announce(reply.message);
      return;
    }
    announce(FORGOTTEN);
    const own = [...document.querySelectorAll<HTMLButtonElement>('[data-post-for]')].find((n) => n.getAttribute('data-post-for') === findingId);
    if (own !== undefined && !own.disabled) own.focus();
    else (findingsTab() ?? verdictHeading.current)?.focus();
  }, [reply, announce]);

  useEffect(() => { if (found !== null) foundLine.current?.focus(); }, [found]);

  // Select puts focus on the first checkbox; Done puts it back on Select.
  const modeMoved = useRef<'pick' | 'select' | null>(null);
  useEffect(() => {
    const to = modeMoved.current;
    modeMoved.current = null;
    if (to === 'pick') document.querySelector<HTMLElement>('.ap-pick')?.focus();
    else if (to === 'select') selectButton.current?.focus();
  }, [selecting]);

  const empty = lists.order.length === 0;
  const unfinished = doc.verdict.label === 'incomplete';
  const allDismissed = empty && !unfinished && lists.dismissed.length > 0;
  useEffect(() => { if (allDismissed) setFolds((was) => (was.has('dismissed') ? was : toggled(was, 'dismissed'))); }, [allDismissed]);
  // With nothing open there is nothing to select.
  useEffect(() => { if (empty) setSelecting(false); }, [empty]);

  const fold = (key: Fold): void => setFolds((was) => toggled(was, key));
  const closeSheet = useCallback((): void => setSheet(false), []);
  const shownIds = useMemo(() => new Set(lists.order.map((f) => f.id)), [lists.order]);
  const showMerged = useCallback((id: string): void => { setSheet(false); open(id); }, [open]);
  const restore = (d: Dismissal): void => dispatch({ type: 'restore', fingerprint: d.fingerprint });
  const promptFor = (findings: readonly Finding[]) => (): string => fixPrompt(doc, [...findings]);

  const banners = (
    <>
      {stale && (
        <section className="card banner ap-banner">
          <p>New commits since this review.</p>
          <div className="bar">
            {pushReviewable(pr) && (
              <button type="button" className="btn" disabled={disabled} onClick={() => dispatch({ type: 'start', depth: doc.depth, since: 'last' })}>
                Review the push
              </button>
            )}
            <ReviewAgain doc={doc} disabled={disabled} dispatch={dispatch} label="Review everything again" />
          </div>
        </section>
      )}
      {state.notice !== undefined && <p role="alert" className="notice">{state.notice}</p>}
      {found !== null && <p className="notice" tabIndex={-1} ref={foundLine}>{found}</p>}
    </>
  );

  if (detail !== undefined) {
    const { previous, next } = neighbours(lists.order, detail.id);
    const position = { index: lists.order.indexOf(detail) + 1, total: lists.order.length };
    return (
      <>
      {banners}
      <FindingDetail
        key={detail.id} finding={detail} packs={pr.packs} previous={previous} next={next} canDismiss={!disabled}
        fixPrompt={promptFor([detail])} onBack={() => setOpenId(null)} onOpen={(f) => open(f.id)}
        onJump={(place, options) => onJump(doc.pr, place, options)} changedPaths={changedPaths} onDismiss={onDismiss}
        posted={recordOf(detail)} postBlocked={postBlocked} canPost={state.busy !== true} onPost={(f) => onPost([f], f.id)}
        unknownMark={(id) => unknownMark(detail, id)} position={position} {...t}
      />
      </>
    );
  }

  const titles = doc.packs.map((p) => pr.packs.find((known) => known.id === p.id)?.title ?? p.id).join(', ');
  const fixed = doc.fixed ?? [];
  const showStatus = doc.previous !== undefined;
  const fixes = lists.order.filter((f) => f.severity === 'block' || f.severity === 'fix');
  const emptySentence = !empty ? null
    : unfinished ? 'The review did not finish, so nothing here is cleared.'
      : lists.dismissed.length > 0 ? `No open findings. ${lists.dismissed.length} dismissed.` : 'No findings.';
  const toggle = (f: Finding): void => setSelected((was) => toggled(was, f.id));
  const tabs: TabItem<Tab>[] = [
    { key: 'findings', label: `Findings · ${lists.order.length}`, ...(empty ? {} : { focusName: 'findings' }) },
    { key: 'change', label: 'The change' },
    { key: 'more', label: 'More' },
  ];

  return (
    <>
      <VerdictStrip
        doc={doc} open={lists.order} empty={emptySentence} range={rangeLine(doc)} notesLine={notesLine} onReloadNotes={onReloadNotes}
        headingRef={verdictHeading}
      />
      {banners}
      <StageErrors errors={doc.stageErrors} map={doc.map} />
      <Tabs label="The review" items={tabs} chosen={tab} onChoose={setTab}>
        {tab === 'findings' && (
          <>
            {lists.top.length > 0 && (
              <ol className="plain ap-list" aria-label="Top findings">
                {lists.top.map((f) => (
                  <FindingCard
                    key={f.id} finding={f} showStatus={showStatus} selecting={selecting} selected={selected.has(f.id)} posted={recordOf(f)}
                    after={unknownMark(f)} onToggle={() => toggle(f)} onOpen={() => open(f.id)} register={register}
                  />
                ))}
              </ol>
            )}
            {lists.also.length > 0 && (
              <Collapsible title="Also found" count={String(lists.also.length)} open={folds.has('also')} onToggle={() => fold('also')}>
                <AlsoFound
                  findings={lists.also} showStatus={showStatus} selecting={selecting} selected={selected} onToggle={toggle}
                  onOpen={(f) => open(f.id)} register={register} postOf={recordOf} after={(f) => unknownMark(f)}
                />
              </Collapsible>
            )}
            {fixed.length > 0 && (
              <Collapsible title="Fixed since the last review" count={String(fixed.length)} open={folds.has('fixed')} onToggle={() => fold('fixed')}>
                <FixedList findings={fixed} />
              </Collapsible>
            )}
          </>
        )}
        {tab === 'change' && <ChangeTab doc={doc} merge={mergeOf(doc)} folds={folds} onFold={fold} {...t} />}
        {tab === 'more' && (
          <MoreTab
            doc={doc} packTitles={titles} reviewAgain={stale ? null : <ReviewAgain doc={doc} disabled={disabled} dispatch={dispatch} />}
            dismissed={lists.dismissed} canRestore={!disabled} onRestore={restore} folds={folds} onFold={fold}
            droppedRef={droppedButton} onDropped={() => setSheet(true)}
          />
        )}
      </Tabs>
      {!empty && (
        <ReviewBar
          selecting={selecting} fixes={fixes} ticked={chosen} postable={postable} blocked={postBlocked} busy={state.busy === true}
          prompt={promptFor} selectRef={selectButton} onPost={() => onPost(postable, 'selected')} {...t}
          onSelect={() => { modeMoved.current = 'pick'; setTab('findings'); setSelecting(true); }}
          onDone={() => { modeMoved.current = 'select'; setSelecting(false); setSelected(new Set()); }}
        />
      )}
      {sheet && <DroppedSheet dropped={doc.dropped} opener={droppedButton} onClose={closeSheet} shown={shownIds} onShow={showMerged} />}
    </>
  );
}
