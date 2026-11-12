import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { LearnedReply, RemoveLearnedBody, RemoveLearnedReply, ServiceStatus } from '@airlock/shared';
import { ServiceClient } from '../client/service';
import { realTimers } from '../client/timers';
import { SERVICE_URL } from '../config';
import { PanelScreen } from '../screens/PanelScreen';
import type { OpenFinding } from '../screens/Verdict';
import { startPanel, type PanelState } from '../state/machine';
import { browserNoteOpen, listenNoteOpen } from '../state/note-open';
import { startNotes, type NotesState, type PageNotes } from '../state/notes';
import { browserSettings, type SettingsStore } from '../state/settings';
import type { SizeSetting } from '../state/size';
import {
  browserJumpChrome, COULD_NOT_JUMP, jumpTo, sendToPage, type Jump, type JumpPlace, type JumpPr, type JumpResult, type PageReport,
} from '../state/jump';
import { browserTab, type TabWatcher } from '../state/tab';
import { useDefaultDepth, usePanel, type StartPanel } from './usePanel';

/** The Chrome pieces the panel runs on; fakes in tests. `notes`: the notes on the tab's page, told what is on screen. */
export interface ChromePieces { settings: SettingsStore; tab: TabWatcher; notes?: PageNotes }

/** The real construction: the service at `SERVICE_URL` with the stored token, the tab watcher, the real clock. */
export function startRealPanel(
  onState: (state: PanelState) => void,
  pieces: ChromePieces = { settings: browserSettings(), tab: browserTab() },
  run: typeof startPanel = startPanel,
): ReturnType<StartPanel> {
  const { settings, tab, notes } = pieces;
  const client = new ServiceClient(SERVICE_URL, () => settings.getToken());
  return run({ client, tab, settings, onState, timers: realTimers, ...(notes ? { notes } : {}) });
}

/**
 * The real notes: sent to the tab the panel sits beside, through the jump's tab messaging. What the page says it
 * recognised comes back in the notes' state (`page`), which the App gives the Service screen.
 */
export function browserNotes(settings: SettingsStore, tab: TabWatcher): PageNotes {
  const chrome = browserJumpChrome(() => undefined);
  return startNotes({ tab, settings, send: (tabId, message, options) => sendToPage(chrome, tabId, message, options) });
}

/**
 * What the panel needs from outside it besides the running panel: the service's status and the stored default depth for
 * Settings, and jumping to a place on GitHub (which tells `onReport` what it found on the page).
 */
export interface PanelServices {
  settings: SettingsStore;
  fetchStatus: () => Promise<ServiceStatus>;
  fetchLearned?: (repo: string) => Promise<LearnedReply>;
  removeLearned?: (body: RemoveLearnedBody) => Promise<RemoveLearnedReply>;
  jump?: (pr: JumpPr, place: JumpPlace, options: JumpServiceOptions) => Promise<JumpResult>;
  /** The notes on the tab's page: their line under the verdict, the setting, and reloading the tab for them. */
  notes?: PageNotes;
  /** Calls `open` with a finding's id each time `Open in Airlock` is pressed on a note in this tab; returns the way to stop. */
  noteOpen?: (open: (id: string) => void) => () => void;
  /** The text and button size, already applied to the page when the panel starts. */
  size?: SizeSetting;
}

/** `reload`: the person asked to reload the GitHub tab first. `signal`: aborted when a newer jump starts. */
export interface JumpServiceOptions { reload: boolean; signal: AbortSignal; onReport: (report: PageReport) => void }

/** Jumps in the tab the panel sits beside. Needs no service, so it works while the service is away. Never rejects. */
async function jumpBeside(tab: TabWatcher, pr: JumpPr, place: JumpPlace, { reload, signal, onReport }: JumpServiceOptions): Promise<JumpResult> {
  try {
    const { tabId } = await tab.current();
    return await jumpTo(browserJumpChrome(onReport), tabId, pr, place, { reload, signal });
  } catch {
    return { sentence: COULD_NOT_JUMP, needsReload: false };
  }
}

/**
 * The real services: the service at `SERVICE_URL` with the stored token, the extension's local storage, and the tab the
 * panel sits beside (pass the panel's own watcher so both read the same tab).
 */
export function realServices(settings: SettingsStore = browserSettings(), tab: TabWatcher = browserTab(), notes?: PageNotes): PanelServices {
  const client = new ServiceClient(SERVICE_URL, () => settings.getToken());
  return {
    settings,
    fetchStatus: () => client.status(),
    fetchLearned: (repo) => client.learned(repo),
    removeLearned: (body) => client.removeLearned(body),
    jump: (pr, place, options) => jumpBeside(tab, pr, place, options),
    ...(notes ? { notes } : {}),
    noteOpen: (open) => listenNoteOpen(browserNoteOpen(), tab, open),
  };
}

const NO_NOTES: NotesState = { on: null, line: null, failed: false };
const noSubscribe = (): (() => void) => () => undefined;
const noNotes = (): NotesState => NO_NOTES;

/**
 * The finding `Open in Airlock` asks for. One asked for while the panel is still loading waits for the first screen,
 * and is asked for only when that screen is a review.
 */
function useOpenFinding(state: PanelState, noteOpen: PanelServices['noteOpen']): OpenFinding | null {
  const [asked, setAsked] = useState<OpenFinding | null>(null);
  const seq = useRef(0);
  const held = useRef<string | null>(null);
  const loading = useRef(state.kind === 'loading');
  loading.current = state.kind === 'loading';
  useEffect(() => noteOpen?.((id) => {
    if (loading.current) held.current = id;
    else setAsked({ id, seq: ++seq.current });
  }), [noteOpen]);
  useEffect(() => {
    const id = held.current;
    if (state.kind === 'loading' || id === null) return;
    held.current = null;
    if (state.kind === 'review' || (state.kind === 'offline' && state.review !== undefined)) setAsked({ id, seq: ++seq.current });
  }, [state]);
  return asked;
}

/** Whether the tour was seen: read once when the panel starts; null until then, or when it cannot be read. */
function useTourSeen(settings: SettingsStore | undefined): { seen: boolean | null; markSeen: () => void } {
  const [seen, setSeen] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    settings?.getTourSeen().then((value) => { if (live) setSeen((was) => was ?? value); }, () => undefined);
    return () => { live = false; };
  }, [settings]);
  // Seen for the rest of this panel even if it cannot be stored; it may then show again next time.
  const markSeen = useCallback((): void => {
    setSeen(true);
    settings?.setTourSeen().catch(() => undefined);
  }, [settings]);
  return { seen, markSeen };
}

export function App({ start = (onState) => startRealPanel(onState), services }: { start?: StartPanel; services?: PanelServices }) {
  const { state, dispatch } = usePanel(start);
  const tour = useTourSeen(services?.settings);
  const { depth, failed, setDepth } = useDefaultDepth(services?.settings);
  const notes = services?.notes;
  const notesState = useSyncExternalStore(notes?.subscribe ?? noSubscribe, notes?.current ?? noNotes);
  const openFinding = useOpenFinding(state, services?.noteOpen);
  const [pageReport, setPageReport] = useState<PageReport | null>(null);
  // The page's report on the notes is the same report as a jump's: the latest of either is what Packs shows.
  const notesPage = notesState.page;
  useEffect(() => { if (notesPage !== undefined) setPageReport(notesPage); }, [notesPage]);
  const jump = services?.jump;
  // Only the latest jump runs and reports: starting one aborts the one before, and a late report is dropped.
  const latestJump = useRef(0);
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  const onJump = useMemo((): Jump | undefined => {
    if (!jump) return undefined;
    return (pr, place, { reload }) => {
      const mine = ++latestJump.current;
      running.current?.abort();
      const controller = new AbortController();
      running.current = controller;
      const onReport = (report: PageReport): void => { if (mine === latestJump.current) setPageReport(report); };
      return jump(pr, place, { reload, signal: controller.signal, onReport });
    };
  }, [jump]);
  return (
    <PanelScreen
      state={state} dispatch={dispatch} defaultDepth={depth} onDefaultDepth={setDepth} depthFailed={failed}
      pageReport={pageReport} {...(onJump ? { onJump } : {})}
      notesLine={notesState.line} showNotes={notesState.on} notesFailed={notesState.failed} openFinding={openFinding}
      {...(notes ? { onReloadNotes: notes.reload, onShowNotes: notes.setShown } : {})}
      {...(services ? { fetchStatus: services.fetchStatus } : {})}
      {...(services?.fetchLearned ? { fetchLearned: services.fetchLearned } : {})}
      {...(services?.removeLearned ? { removeLearned: services.removeLearned } : {})}
      {...(services?.size ? { size: services.size } : {})}
      tourSeen={tour.seen} onTourSeen={tour.markSeen}
    />
  );
}
