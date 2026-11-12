import { diffAnchorId, prRefFromUrl, type Finding } from '@airlock/shared';
import { NOTES_MAX, NOTE_ID, TITLE_MAX, type ClearNotesMessage, type NotesMessage, type PageNote } from '../page/protocol';
import { COULD_NOT_REACH, type NotesResult } from './jump';
import type { ReviewView } from './reduce';
import { listFindings } from './selection';
import type { SettingsStore } from './settings';
import type { TabWatcher } from './tab';

// The review's private notes on GitHub's Files changed page: which notes the panel sends, when it sends them, and the
// line under the verdict that says what the page did with them.

/** The reload sentence of step 2's jump, said when no page script answers the notes either. */
export const COULD_NOT_REACH_PAGE = COULD_NOT_REACH;
export const CLEAR_NOTES: ClearNotesMessage = { type: 'airlock:notes-clear' };

/** A title the page accepts: at most `TITLE_MAX` UTF-16 units, ending in `…` when cut, never splitting a character. */
export function noteTitle(title: string): string {
  if (title.length <= TITLE_MAX) return title;
  let cut = '';
  for (const char of title) {
    if (cut.length + char.length + 1 > TITLE_MAX) break;
    cut += char;
  }
  return `${cut}…`;
}

const isLine = (line: number | null): line is number => line !== null && Number.isSafeInteger(line) && line > 0;
const keysOf = (f: Pick<Finding, 'fingerprint' | 'aliases'>): string[] => [f.fingerprint, ...(f.aliases ?? [])];

/**
 * The notes for a review: every open finding with a line (not dismissed, not among the findings fixed since the last
 * review), top findings first in rank order, then Also found, at most `NOTES_MAX`. A posted finding is still open.
 * `left`: how many open findings with a line were left out.
 */
export async function notesFor(view: ReviewView): Promise<{ message: NotesMessage; left: number }> {
  const { document: doc, dismissals } = view.latest;
  const fixed = new Set((doc.fixed ?? []).flatMap(keysOf));
  const ids = new Set<string>();
  // A finding the page would refuse (an id of another shape, a repeated id, no title) is left out rather than refusing all.
  const open = listFindings(doc.findings, dismissals).order.filter((f) => {
    const usable = f.status !== 'fixed' && !keysOf(f).some((k) => fixed.has(k)) && isLine(f.anchor.startLine)
      && NOTE_ID.test(f.id) && !ids.has(f.id) && f.title !== '';
    if (usable) ids.add(f.id);
    return usable;
  });
  const chosen = open.slice(0, NOTES_MAX);
  const notes = await Promise.all(chosen.map(async (f): Promise<PageNote> => ({
    id: f.id, anchorId: await diffAnchorId(f.path), line: f.anchor.startLine as number, severity: f.severity, title: noteTitle(f.title),
  })));
  return { message: { type: 'airlock:notes', pr: { repo: view.pr.repo, number: view.pr.number }, notes }, left: open.length - chosen.length };
}

/** The line under the verdict; `reload`: it offers to reload the GitHub tab. */
export interface NotesLine { text: string; reload: boolean }

/** What to say about sending notes; null when there is nothing to say (no notes, or the page was not the Files changed view). */
export function notesLine(result: NotesResult, left: number): NotesLine | null {
  const said = (text: string, reload = false): NotesLine => ({ text, reload });
  switch (result.kind) {
    case 'refused': return said(result.sentence);
    case 'unreached': return said(COULD_NOT_REACH_PAGE, true);
    case 'gone': return null;
    case 'shown': {
      const { placed, waiting, view, missing } = result;
      if (view === null) {
        return missing.length === 0 ? null
          : said(`Notes cannot be shown on this version of GitHub's page (${missing.join(', ')}). Jump to line still works.`);
      }
      if (placed + waiting === 0) return null;
      const cut = left > 0 ? ` (the first ${NOTES_MAX} findings)` : '';
      return said(waiting === 0
        ? `${placed} ${placed === 1 ? 'note' : 'notes'} shown in the diff${cut}`
        : `${placed} shown, ${waiting} waiting for their lines to load${cut}`);
    }
  }
}

/** `on`: the setting, null until it is read. `failed`: the last change of it could not be stored, and was undone. */
export interface NotesState { on: boolean | null; line: NotesLine | null; failed: boolean }

/** Sends a message to the content script of tab `tabId`; `reload` when the person asked to reload the tab first. */
export type SendNotes = (
  tabId: number, message: NotesMessage | ClearNotesMessage, options: { reload: boolean; signal: AbortSignal },
) => Promise<NotesResult>;

export interface NotesDeps {
  /** The tab the panel sits beside: where the notes go. */
  tab: TabWatcher;
  settings: Pick<SettingsStore, 'getShowNotes' | 'setShowNotes'>;
  send: SendNotes;
}

export interface PageNotes {
  /** The review on screen: null when none is; undefined while the panel is still loading (nothing changes). */
  review(view: ReviewView | null | undefined): void;
  /** Turns the notes on or off and stores the choice; one that cannot be stored is undone and `failed` says so. */
  setShown(on: boolean): void;
  /** The person asked to reload the GitHub tab: it is reloaded, then the notes are sent again. */
  reload(): void;
  current(): NotesState;
  subscribe(fn: (state: NotesState) => void): () => void;
  stop(): void;
}

const filesOf = (address: string | undefined): ReturnType<typeof prRefFromUrl> => {
  const ref = address === undefined ? null : prRefFromUrl(address);
  return ref !== null && ref.page === 'files' ? ref : null;
};
const isFilesOf = (address: string | undefined, pr: { repo: string; number: number }): boolean => {
  const ref = filesOf(address);
  return ref !== null && ref.number === pr.number && ref.repo.toLowerCase() === pr.repo.toLowerCase();
};
const sameLine = (a: NotesLine | null, b: NotesLine | null): boolean =>
  a === b || (a !== null && b !== null && a.text === b.text && a.reload === b.reload);

/**
 * Keeps the notes on the tab's page in step with the panel. While a review is on screen, the setting is on and the review
 * is of the pull request's head, the notes for its open findings go to the tab when it shows that pull request's Files
 * changed view: again whenever the notes, the tab's address or the setting change, and when the page finishes loading
 * again (a reload starts it empty). Otherwise a clear message goes, while notes may still be there. Nothing is sent to a
 * tab that is not that pull request's Files changed view, and nothing reloads the tab but `reload`.
 */
export function startNotes({ tab, settings, send }: NotesDeps): PageNotes {
  let state: NotesState = { on: null, line: null, failed: false };
  const subscribers = new Set<(state: NotesState) => void>();
  let stopped = false;
  let view: ReviewView | null | undefined;
  let tabId: number | null = null;
  let address: string | undefined;
  let addressKnown = false;
  /** What is stored, to go back to when a change cannot be stored; and which change is the latest. */
  let stored = true;
  let storing = 0;
  /** The last message sent, with the address it was sent to. */
  let sentKey: string | null = null;
  /** Notes may be on the page: from the start (an earlier panel may have left some), and after notes were sent. */
  let mayHold = true;
  let generation = 0;
  let inflight: AbortController | null = null;

  const publish = (next: Partial<NotesState>): void => {
    const merged = { ...state, ...next };
    if (merged.on === state.on && merged.failed === state.failed && sameLine(merged.line, state.line)) return;
    state = merged;
    for (const fn of subscribers) fn(state);
  };

  const update = async (force: { address?: boolean; reload?: boolean } = {}): Promise<void> => {
    if (stopped || state.on === null || view === undefined || tabId === null) return;
    const g = ++generation;
    const [shown, id, at] = [view, tabId, address];
    const wanted = shown !== null && state.on && !shown.stale ? await notesFor(shown) : null;
    if (g !== generation || stopped) return;
    let message: NotesMessage | ClearNotesMessage;
    if (wanted === null) {
      publish({ line: null });
      // The panel's pull request is the tab's, so with no review the tab's own Files changed view is the one to clear.
      const target = shown === null ? filesOf(at) !== null : isFilesOf(at, shown.pr);
      if (!mayHold || !target) return;
      message = CLEAR_NOTES;
    } else if (!isFilesOf(at, wanted.message.pr)) {
      publish({ line: null });
      return;
    } else {
      message = wanted.message;
    }
    const key = `${at ?? ''}\n${JSON.stringify(message)}`;
    if (key === sentKey && force.address !== true && force.reload !== true) return;
    sentKey = key;
    if (wanted !== null) mayHold = true;
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;
    const result = await send(id, message, { reload: force.reload === true, signal: controller.signal });
    if (inflight !== controller || stopped) return;
    inflight = null;
    if (wanted === null) {
      if (result.kind === 'shown') mayHold = false;
      return;
    }
    publish({ line: notesLine(result, wanted.left) });
  };

  const unsubscribe = tab.onChange((url, status) => {
    if (addressKnown && url === address && status !== 'complete') return;
    address = url;
    addressKnown = true;
    void update({ address: true });
  });

  void Promise.all([tab.current(), settings.getShowNotes().catch(() => true)]).then(([current, on]) => {
    if (stopped) return;
    // No tab (Chrome gives -1 when the window has none): nothing to send to.
    if (current.tabId >= 0) tabId = current.tabId;
    if (!addressKnown) address = current.url;
    addressKnown = true;
    stored = on;
    publish({ on: state.on ?? on });
    void update({ address: true });
  }, () => undefined);

  return {
    review(next) {
      if (next === undefined || stopped) return;
      view = next;
      void update();
    },
    setShown(on) {
      if (stopped) return;
      const mine = ++storing;
      publish({ on, failed: false });
      void update();
      settings.setShowNotes(on).then(
        () => { if (mine === storing) stored = on; },
        () => {
          if (stopped || mine !== storing) return;
          publish({ on: stored, failed: true });
          void update();
        },
      );
    },
    reload() {
      void update({ reload: true });
    },
    current: () => state,
    subscribe(fn) {
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      inflight?.abort();
      unsubscribe();
    },
  };
}
