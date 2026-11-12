// `Open in Airlock` on a note, as the worker handles it: the panel may be closed, so the worker asks Chrome to open it
// for that tab and leaves the finding's id where the panel looks as it starts. Imported by path, not from
// '@airlock/shared': the worker stays small and free of zod. It makes no network request and keeps nothing else.
import { NOTE_ID, type NoteOpenMessage } from '../page/protocol';

/** Where the id waits in `chrome.storage.session`, which only the extension's own pages and worker can read. */
export const OPEN_ID_KEY = 'airlock.noteOpen';
/** How long the id is good for: a panel that starts later does not open it. */
export const OPEN_ID_MS = 30_000;

/**
 * The id left for the panel of tab `tabId`, and when (milliseconds since 1970). One record under one key: a new press
 * replaces the one before.
 */
export interface PendingOpen { id: string; at: number; tabId: number }

/** Exactly `{ type: 'airlock:note-open', id }` with a finding's id. */
export function isNoteOpen(message: unknown): message is NoteOpenMessage {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
  const m = message as Record<string, unknown>;
  return Object.keys(m).sort().join() === 'id,type' && m.type === 'airlock:note-open' && typeof m.id === 'string' && NOTE_ID.test(m.id);
}

type Sender = { id?: string; url?: string; tab?: { id?: number } };

/** From this extension's content script on a github.com page: an extension page open in a tab does not count. */
export const fromGithubPage = (sender: Sender, runtimeId: string): boolean =>
  sender.id === runtimeId && sender.tab?.id !== undefined && sender.url?.startsWith('https://github.com/') === true;

/** The Chrome calls the worker makes for a note, so tests can pass a fake. */
export interface NoteOpenWorkerChrome {
  runtime: { id: string; onMessage: { addListener(fn: (message: unknown, sender: Sender) => undefined): void } };
  sidePanel: { open(options: { tabId: number }): Promise<void> };
  storage: { session: { set(items: Record<string, unknown>): Promise<void> } };
}

/**
 * On a note-open from a page of this extension's content script: opens the side panel for that tab (here, inside the
 * message handler, so Chrome counts the click as the person's action, which opening needs) and leaves `{ id, at, tabId }`
 * for the panel. An open panel takes the id at once; a closed one as it starts. A refused open is caught.
 */
export function wireNoteOpen(chrome: NoteOpenWorkerChrome, now: () => number = Date.now): void {
  chrome.runtime.onMessage.addListener((message, sender) => {
    const tabId = sender.tab?.id;
    if (!fromGithubPage(sender, chrome.runtime.id) || tabId === undefined || !isNoteOpen(message)) return undefined;
    try {
      chrome.sidePanel.open({ tabId }).catch(() => undefined);
    } catch {
      // A Chrome without sidePanel.open: the panel opens the finding when the person opens it.
    }
    const pending: PendingOpen = { id: message.id, at: now(), tabId };
    try {
      chrome.storage.session.set({ [OPEN_ID_KEY]: pending }).catch(() => undefined);
    } catch {
      // Nowhere to leave it: an open panel still opens the finding from the note's own message.
    }
    return undefined;
  });
}
