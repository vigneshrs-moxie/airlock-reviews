import { fromGithubPage, isNoteOpen, OPEN_ID_KEY, OPEN_ID_MS, type PendingOpen } from '../background/note-open';
import type { TabWatcher } from './tab';

type Sender = { id?: string; url?: string; tab?: { id?: number } };
type MessageListener = (message: unknown, sender: Sender) => undefined;
type ChangedListener = (changes: Record<string, { newValue?: unknown }>) => void;

/** The Chrome pieces the panel reads `Open in Airlock` from, so tests can pass fakes. */
export interface NoteOpenPanelChrome {
  runtime: { id: string; onMessage: { addListener(fn: MessageListener): void; removeListener(fn: MessageListener): void } };
  /** `chrome.storage.session`, where the worker leaves the id. */
  session: {
    get(keys: string[]): Promise<Record<string, unknown>>;
    remove(keys: string[]): Promise<void>;
    onChanged: { addListener(fn: ChangedListener): void; removeListener(fn: ChangedListener): void };
  };
}

function pendingOf(value: unknown): PendingOpen | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, at, tabId } = value as Record<string, unknown>;
  if (typeof at !== 'number' || typeof tabId !== 'number' || !isNoteOpen({ type: 'airlock:note-open', id })) return null;
  return { id: id as string, at, tabId };
}

/**
 * Calls `open` with a finding's id each time the person presses `Open in Airlock` on a note in the tab the panel sits
 * beside: from that tab's own message, and from the id the worker left in session storage, read as the panel starts and
 * whenever the worker leaves another. An id left for this tab is taken away when read, and used only when it is at most
 * `OPEN_ID_MS` old; one older than that is taken away whatever its tab. A fresh id for another tab is left for that tab's
 * panel, which may be starting. Other senders and anything malformed are ignored. Returns the way to stop.
 */
export function listenNoteOpen(
  chrome: NoteOpenPanelChrome, tab: TabWatcher, open: (id: string) => void, now: () => number = Date.now,
): () => void {
  let stopped = false;
  let tabId: number | null = null;

  const take = async (value: unknown): Promise<void> => {
    const pending = pendingOf(value);
    if (stopped || pending === null) return;
    const age = now() - pending.at;
    const fresh = age >= 0 && age <= OPEN_ID_MS;
    if (pending.tabId !== tabId && fresh) return;
    await chrome.session.remove([OPEN_ID_KEY]);
    if (!stopped && fresh && pending.tabId === tabId) open(pending.id);
  };
  const onMessage: MessageListener = (message, sender) => {
    if (!stopped && tabId !== null && fromGithubPage(sender, chrome.runtime.id) && sender.tab?.id === tabId && isNoteOpen(message)) {
      open(message.id);
    }
    return undefined;
  };
  const onChanged: ChangedListener = (changes) => {
    const change = changes[OPEN_ID_KEY];
    if (change !== undefined && change.newValue !== undefined) void take(change.newValue).catch(() => undefined);
  };

  chrome.runtime.onMessage.addListener(onMessage);
  chrome.session.onChanged.addListener(onChanged);
  void tab.current().then(async (current) => {
    if (stopped) return;
    tabId = current.tabId;
    const stored = await chrome.session.get([OPEN_ID_KEY]);
    await take(stored[OPEN_ID_KEY]);
  }).catch(() => undefined);

  return () => {
    stopped = true;
    chrome.runtime.onMessage.removeListener(onMessage);
    chrome.session.onChanged.removeListener(onChanged);
  };
}

/** The real pieces: this extension's runtime and its session storage. */
export function browserNoteOpen(): NoteOpenPanelChrome {
  return { runtime: browser.runtime as unknown as NoteOpenPanelChrome['runtime'], session: browser.storage.session };
}
