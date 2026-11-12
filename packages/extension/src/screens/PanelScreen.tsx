import type { Timers } from '../client/timers';
import type { PanelState, UserAction } from '../state/reduce';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Frame, connectionOf, useAnnounce } from './Frame';
import { KeptProgress, OfflineCard } from './Offline';
import { Pair } from './Pair';
import { Problem } from './Problem';
import { Ready } from './Ready';
import { Running } from './Running';
import { Verdict, type OpenFinding } from './Verdict';
import type { Jump, PageReport } from '../state/jump';
import type { NotesLine } from '../state/notes';
import { listFindings } from '../state/selection';
import type { Depth, Finding, LearnedReply, PackRef, PrSummary, RemoveLearnedBody, RemoveLearnedReply, ServiceStatus } from '@airlock/shared';
import { DismissSheet, focusAfterClose, newDraft, type SheetDraft, type SheetView } from './DismissSheet';
import { NO_REMOVE_OFFLINE, NO_REMOVE_UNPAIRED } from './LearnedList';
import { Settings } from './Settings';
import { focusAfterPost, newPostDraft, nextTicket, PostSheet, type PostDraft, type PostSheetView } from './PostSheet';
import { PanelVisible } from './visible';
import { DEFAULT_SIZE, type SizeSetting } from '../state/size';

export interface PanelScreenProps {
  state: PanelState;
  dispatch: (action: UserAction) => void;
  /** Called when the Settings button is pressed; the Settings screen opens either way. */
  onOpenSettings?: () => void;
  /** @deprecated The old name of `onOpenSettings`, kept so callers that pass it still build; called the same way. */
  onOpenPacks?: () => void;
  /** For the Copy buttons' two seconds; the real clock unless a test passes its own. */
  timers?: Timers;
  /** Takes the person to a place on GitHub; without it the finding screen says jumping is not connected. */
  onJump?: Jump;
  /** What the last jump found on the GitHub page, for the Service screen; null before any jump. */
  pageReport?: PageReport | null;
  /** Asks the service for its status, for Settings and the Service screen. */
  fetchStatus?: () => Promise<ServiceStatus>;
  /** Reads the learned lines of a repository's packs, for Settings and the Packs screen. */
  fetchLearned?: (repo: string) => Promise<LearnedReply>;
  /** Removes one learned line, for the Packs screen. */
  removeLearned?: (body: RemoveLearnedBody) => Promise<RemoveLearnedReply>;
  /** The depth stored in Settings; null when none is stored. */
  defaultDepth?: Depth | null;
  /** Stores the default depth; null clears it. */
  onDefaultDepth?: (depth: Depth | null) => void;
  /** Storing the default depth failed, so the screen shows what is stored again and says so. */
  depthFailed?: boolean;
  /** What the notes on GitHub's page did, said under the verdict. */
  notesLine?: NotesLine | null;
  onReloadNotes?: () => void;
  /** The notes setting for Settings: null until it is read. */
  showNotes?: boolean | null;
  onShowNotes?: (on: boolean) => void;
  notesFailed?: boolean;
  /** The finding `Open in Airlock` asked for: opened when it is an open finding of the review on screen. */
  openFinding?: OpenFinding | null;
  /** The text and button size; without it Settings shows Default and changes nothing. */
  size?: SizeSetting;
}

const DEFAULT_SHOWN = { size: DEFAULT_SIZE, failed: false } as const;
const FIXED_SIZE: SizeSetting = { current: () => DEFAULT_SHOWN, subscribe: () => () => undefined, choose: () => undefined };

/** Whether this panel is paired, as far as the state proves it; null when it proves nothing. */
function pairedOf(state: PanelState): boolean | null {
  switch (state.kind) {
    case 'unpaired': return false;
    case 'ready': case 'running': case 'review': return true;
    default: return null;
  }
}

/** The review under a sheet: the finished one, or the kept one while the service is away; null when neither is on screen. */
function sheetViewOf(state: PanelState): SheetView | null {
  if (state.kind === 'review') return { pr: state.pr, latest: state.latest, offline: false, notice: state.notice, busy: state.busy };
  if (state.kind === 'offline' && state.review !== undefined) return { pr: state.review.pr, latest: state.review.latest, offline: true };
  return null;
}

const unreachable = (): Promise<never> => Promise.reject(new Error('no service'));

/** Why a learned line cannot be removed with the panel in this state; null when it can. */
function removeBlockedBy(state: PanelState): string | null {
  return state.kind === 'offline' ? NO_REMOVE_OFFLINE : state.kind === 'unpaired' ? NO_REMOVE_UNPAIRED : null;
}

/** The pull request and the review's packs the state knows about, kept readable even offline. */
function knownOf(state: PanelState): { pr: PrSummary | null; packs: readonly PackRef[] } {
  switch (state.kind) {
    case 'ready': case 'running': case 'problem': return { pr: state.pr, packs: [] };
    case 'review': return { pr: state.pr, packs: state.latest.document.packs };
    case 'offline':
      if (state.review !== undefined) return { pr: state.review.pr, packs: state.review.latest.document.packs };
      return { pr: state.ready ?? state.progress?.pr ?? null, packs: [] };
    default: return { pr: null, packs: [] };
  }
}

/** Whether `id` is an open finding of the review on screen (live, or kept while the service is away). */
function isOpenFinding(state: PanelState, id: string): boolean {
  const shown = state.kind === 'review' ? state : state.kind === 'offline' ? state.review : undefined;
  return shown !== undefined && listFindings(shown.latest.document.findings, shown.latest.dismissals).order.some((f) => f.id === id);
}

/** Keyed so a different pull request or a new head starts with its own choices. */
const readyKey = (pr: PrSummary): string => `${pr.repo}#${pr.number}@${pr.headSha}`;

type BodyProps = Pick<PanelScreenProps, 'state' | 'dispatch' | 'timers' | 'onJump' | 'defaultDepth' | 'notesLine' | 'onReloadNotes' | 'openFinding'> & {
  onDismiss: (finding: Finding) => void;
  /** `opener`: the finding whose Post comment was pressed, or `selected` for the bar. */
  onPost: (findings: Finding[], opener: string) => void;
};

/**
 * The screen for the state. A review, or Ready, kept while the service is away is drawn by the same keyed element as
 * when it is live, so its own state (the open finding, the ticks, the depth and pack choices) survives the flip.
 */
function screenFor({ state, dispatch, timers, onJump, onDismiss, onPost, defaultDepth, notesLine = null, onReloadNotes, openFinding = null }: BodyProps) {
  const t = timers ? { timers } : {};
  const review = { ...(onJump ? { onJump } : {}), onDismiss, onPost, notesLine, ...(onReloadNotes ? { onReloadNotes } : {}), openFinding };
  switch (state.kind) {
    case 'loading': return <p className="muted">Looking at this pull request…</p>;
    case 'no-pr': return <p className="muted">Open a pull request on GitHub and Airlock will appear here.</p>;
    case 'offline':
      if (state.review !== undefined) {
        return <Verdict key={state.review.latest.document.id} state={state.review} dispatch={dispatch} readOnly {...t} {...review} />;
      }
      if (state.ready !== undefined) {
        return <Ready key={readyKey(state.ready)} state={{ kind: 'ready', pr: state.ready }} dispatch={dispatch} defaultDepth={defaultDepth ?? null} offline />;
      }
      return <KeptProgress progress={state.progress} />;
    case 'unpaired': return <Pair state={state} dispatch={dispatch} {...t} />;
    case 'ready': return <Ready key={readyKey(state.pr)} state={state} dispatch={dispatch} defaultDepth={defaultDepth ?? null} />;
    case 'running': return <Running state={state} />;
    case 'problem': return <Problem state={state} dispatch={dispatch} />;
    // Keyed so a new review starts with nothing selected and nothing open.
    case 'review': return <Verdict key={state.latest.document.id} state={state} dispatch={dispatch} {...t} {...review} />;
  }
}

/** The offline card in the first place, when there is one, and the screen always in the second. */
function Body(props: BodyProps) {
  const { state, timers } = props;
  return (
    <>
      {state.kind === 'offline' ? <OfflineCard state={state} {...(timers ? { timers } : {})} /> : null}
      {screenFor(props)}
    </>
  );
}

/** Says a review has finished, once, when the panel moves from a running review to the finished one. */
function FinishedAnnouncer({ kind }: { kind: PanelState['kind'] }) {
  const announce = useAnnounce();
  const was = useRef(kind);
  useEffect(() => {
    if (was.current === 'running' && kind === 'review') announce('Review finished.');
    was.current = kind;
  }, [announce, kind]);
  return null;
}

/** The frame and the screen for one state, with the Settings screens and the dismiss and post sheets over it. */
export function PanelScreen({
  state, dispatch, onOpenSettings, onOpenPacks, timers, onJump, pageReport = null, fetchStatus = unreachable, fetchLearned = unreachable,
  removeLearned = unreachable, defaultDepth = null, onDefaultDepth, depthFailed = false, notesLine = null, onReloadNotes,
  showNotes = null, onShowNotes, notesFailed = false, openFinding = null, size = FIXED_SIZE,
}: PanelScreenProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  // `Open in Airlock` for a finding on screen: Settings goes, so the finding is what the person sees.
  useEffect(() => {
    if (openFinding !== null && isOpenFinding(state, openFinding.id)) setSettingsOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFinding]);
  // What is in the sheet outlives the sheet being out of sight; only Cancel and Done drop it.
  const [draft, setDraft] = useState<SheetDraft | null>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // Back returns focus to the button that opened the screen.
  // A layout effect, so a move that waited in the panel while it was out of sight still happens after it.
  useLayoutEffect(() => {
    if (settingsOpen) wasOpen.current = true;
    else if (wasOpen.current) { wasOpen.current = false; settingsButton.current?.focus(); }
  }, [settingsOpen]);
  // Focus goes back only when the person closes the sheet, not when the state takes it out of sight.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const closing = useRef<Finding | null>(null);
  const closeDismiss = useCallback((): void => { closing.current = draftRef.current?.finding ?? null; setDraft(null); }, []);
  const startDismiss = (finding: Finding): void => { if (state.kind === 'review') setDraft(newDraft(finding, state.latest.document.id)); };
  // The post sheet's draft, kept here like the dismiss sheet's.
  const [postDraft, setPostDraft] = useState<PostDraft | null>(null);
  const postDraftRef = useRef(postDraft);
  postDraftRef.current = postDraft;
  const postClosing = useRef<PostDraft | null>(null);
  const closePost = useCallback((): void => { postClosing.current = postDraftRef.current; setPostDraft(null); }, []);
  const startPost = (findings: Finding[], opener: string): void => {
    if (state.kind !== 'review' || findings.length === 0) return;
    const { pr, latest } = state;
    const fingerprints = findings.map((f) => f.fingerprint);
    const ticket = nextTicket();
    setPostDraft(newPostDraft(fingerprints, latest.document.id, opener, ticket, pr));
    dispatch({
      type: 'preview-post', ticket,
      body: { repo: pr.repo, number: pr.number, reviewId: latest.document.id, items: fingerprints.map((fingerprint) => ({ fingerprint })) },
    });
  };
  useEffect(() => {
    const closed = postClosing.current;
    if (postDraft !== null || closed === null) return;
    postClosing.current = null;
    (focusAfterPost(closed) ?? document.querySelector<HTMLElement>('main'))?.focus();
  }, [postDraft]);
  const sheetView = sheetViewOf(state);
  // A finding asked for while a dismiss or post sheet is open waits for the sheet to close: the review under the sheet
  // does not change, and the person's typing and focus stay where they are.
  const openUnderSheets = useRef(openFinding);
  if (draft === null && postDraft === null) openUnderSheets.current = openFinding;
  const postView: PostSheetView | null = state.kind === 'review' && sheetView !== null ? { ...sheetView, post: state.post, stale: state.stale }
    : state.kind === 'offline' && state.review !== undefined && sheetView !== null ? { ...sheetView, stale: state.review.stale } : null;
  const known = knownOf(state);
  useEffect(() => {
    const finding = closing.current;
    if (draft !== null || finding === null) return;
    closing.current = null;
    (focusAfterClose(finding, sheetView) ?? document.querySelector<HTMLElement>('main'))?.focus();
  }, [draft, sheetView]);
  return (
    <Frame
      status={connectionOf(state)} settingsRef={settingsButton} {...(timers ? { timers } : {})}
      onOpenSettings={() => { setSettingsOpen(true); onOpenSettings?.(); onOpenPacks?.(); }}
    >
      <FinishedAnnouncer kind={state.kind} />
      {/* Settings opens beside the panel, which stays as it was, out of sight and out of reach. */}
      <div className="kept" hidden={settingsOpen} inert={settingsOpen}>
        <PanelVisible value={!settingsOpen}>
        <Body
          state={state} dispatch={dispatch} timers={timers} onJump={onJump} onDismiss={startDismiss} onPost={startPost} defaultDepth={defaultDepth}
          notesLine={notesLine} onReloadNotes={onReloadNotes} openFinding={openUnderSheets.current}
        />
        {draft !== null && sheetView !== null && (
          <DismissSheet draft={draft} onDraft={setDraft} view={sheetView} dispatch={dispatch} active={!settingsOpen} onClose={closeDismiss} />
        )}
        {postDraft !== null && postView !== null && (
          <PostSheet draft={postDraft} onDraft={setPostDraft} view={postView} dispatch={dispatch} active={!settingsOpen} onClose={closePost} />
        )}
        </PanelVisible>
      </div>
      {settingsOpen && (
        <Settings
          pr={known.pr} packVersions={known.packs} paired={pairedOf(state)} fetchStatus={fetchStatus}
          fetchLearned={fetchLearned} removeLearned={removeLearned} removeBlocked={removeBlockedBy(state)}
          defaultDepth={defaultDepth} onDefaultDepth={onDefaultDepth ?? (() => undefined)} depthFailed={depthFailed} page={pageReport}
          showNotes={showNotes} {...(onShowNotes ? { onShowNotes } : {})} notesFailed={notesFailed} size={size}
          onBack={() => setSettingsOpen(false)} {...(timers ? { timers } : {})}
        />
      )}
    </Frame>
  );
}
