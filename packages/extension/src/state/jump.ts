import { blobUrl, diffAnchorId, filesUrl, prRefFromUrl, type Finding, type Place } from '@airlock/shared';
import { z } from 'zod';
import { realTimers, type Timers } from '../client/timers';
import { PATH_MAX, type ClearNotesMessage, type JumpReply, type JumpRequest, type NotesMessage, type NotesReply, type NotesRefused } from '../page/protocol';
import { clippedPath, placeText } from '../place-text';
import { clip } from './reduce';

/**
 * Where a jump goes. `changed`: the path is among the review's files and the line is expected on the Files changed page.
 * `outside`: among the files, but the finding's anchor says the line is outside the changed lines. `elsewhere`: not
 * among the files, so it opens at the reviewed commit in a new tab.
 */
export interface JumpPlace { path: string; line: number | null; kind: 'changed' | 'outside' | 'elsewhere' }
/** The reviewed pull request, at the reviewed commit. */
export interface JumpPr { repo: string; number: number; headSha: string }
/**
 * What a jump did, as a sentence to show. `needsReload`: no content script answered in the tab (as after the extension
 * is reloaded); the person may ask for the tab to be reloaded, and Airlock never reloads it without that.
 */
export interface JumpResult { sentence: string; needsReload: boolean }
/** `reload`: the person asked to reload the GitHub tab first. */
export interface JumpOptions { reload: boolean }
/** Takes the person to a place on GitHub and says what it did. Never rejects. */
export type Jump = (pr: JumpPr, place: JumpPlace, options: JumpOptions) => Promise<JumpResult>;
/** What the last jump found on the page: the view it recognised, and the selectors that found nothing. */
export type PageReport = Pick<JumpReply, 'view' | 'missing'>;

const report = { view: z.enum(['react', 'classic']).nullable(), missing: z.array(z.string()) };
/** The content script's reply, checked on arrival; anything else counts as no answer. */
const JumpReplySchema: z.ZodType<JumpReply> = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), how: z.enum(['line', 'file', 'asked']), ...report }),
  z.object({ ok: z.literal(false), reason: z.enum(['not-files-page', 'file-not-on-page']), ...report }),
]);
const count = z.number().int().nonnegative();
/** The content script's reply to notes: the counts, or the sentence for a message it refused. */
const NotesReplySchema: z.ZodType<NotesReply | NotesRefused> = z.union([
  z.object({ placed: count, waiting: count, ...report }),
  z.object({ error: z.string() }),
]);

/** Every message the panel sends to the content script of its tab. */
export type PageMessage = JumpRequest | NotesMessage | ClearNotesMessage;

/** How long to wait for the tab to finish loading. */
export const LOAD_MS = 15_000;
/** How long a request may go unanswered before it counts as no receiver. */
export const ANSWER_MS = 5_000;
/** The gaps before each retry when no content script answers, before the tab is reloaded once. */
export const RETRY_MS = [250, 500, 1_000] as const;

/** How a wait for a load ended. */
export type Loaded = 'complete' | 'timeout' | 'closed';

/** The Chrome calls a jump makes, and its clock, so tests can pass fakes. */
export interface JumpChrome {
  /** Rejects when no content script is listening in the tab. */
  sendMessage(tabId: number, message: PageMessage): Promise<unknown>;
  /** The tab's address (undefined when Chrome does not show it); null when the tab no longer exists. Never rejects. */
  tabUrl(tabId: number): Promise<string | undefined | null>;
  updateTab(tabId: number, props: { url: string }): Promise<unknown>;
  reloadTab(tabId: number): Promise<unknown>;
  createTab(props: { url: string }): Promise<unknown>;
  /** Starts watching when called; ends when the tab next finishes loading, after `LOAD_MS`, or when it closes. Never rejects. */
  loaded(tabId: number): Promise<Loaded>;
  timers: Timers;
  /** Told what the page answered, for the Packs screen. */
  onReport?(report: PageReport): void;
}

export const COULD_NOT_JUMP = 'Airlock could not jump to that place.';
export const COULD_NOT_REACH = 'Airlock could not reach the GitHub page. Reload it, then try again.';
const TAB_CLOSED = 'Airlock could not jump: the GitHub tab was closed.';
/** Never shown: the panel shows only the latest jump's result. */
const REPLACED = 'Airlock stopped this jump for a newer one.';
const NOT_RECOGNISED = ' Airlock does not recognise this version of the page.';

const usableLine = (line: number | null): number | null =>
  line !== null && Number.isSafeInteger(line) && line > 0 ? line : null;

/** Waits `ms`, or less when `signal` aborts. */
function sleep(timers: Timers, ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    let handle: unknown;
    const done = (): void => {
      timers.clearTimeout(handle);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    if (signal?.aborted === true) { resolve(); return; }
    handle = timers.setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Thrown inside a jump that a newer jump has replaced; caught at its top. */
const CANCELLED = new Error('replaced by a newer jump');

/** `chrome` with every call refused once `signal` has aborted, so a replaced jump sends, opens and navigates nothing more. */
function guarded(chrome: JumpChrome, signal: AbortSignal | undefined): JumpChrome {
  const check = (): void => { if (signal?.aborted === true) throw CANCELLED; };
  return {
    sendMessage: (tabId, message) => { check(); return chrome.sendMessage(tabId, message); },
    tabUrl: (tabId) => { check(); return chrome.tabUrl(tabId); },
    updateTab: (tabId, props) => { check(); return chrome.updateTab(tabId, props); },
    reloadTab: (tabId) => { check(); return chrome.reloadTab(tabId); },
    createTab: (props) => { check(); return chrome.createTab(props); },
    loaded: (tabId) => { check(); return chrome.loaded(tabId); },
    timers: chrome.timers,
    onReport: (report) => { check(); chrome.onReport?.(report); },
  };
}

/** The page's reply; null when nothing is listening, nothing answers within `ANSWER_MS`, or the answer is not understood. */
async function ask<T>(chrome: JumpChrome, tabId: number, message: PageMessage, schema: z.ZodType<T>): Promise<T | null> {
  let timer: unknown;
  const silence = new Promise<undefined>((resolve) => { timer = chrome.timers.setTimeout(() => resolve(undefined), ANSWER_MS); });
  try {
    const answer = await Promise.race([chrome.sendMessage(tabId, message), silence]);
    const reply = schema.safeParse(answer);
    return reply.success ? reply.data : null;
  } catch (error) {
    if (error === CANCELLED) throw error;
    return null;
  } finally {
    chrome.timers.clearTimeout(timer);
  }
}

/** `first`, or while nothing answers, the answer to `again` after each of `RETRY_MS`: a script may still be starting. */
async function retried<T>(chrome: JumpChrome, signal: AbortSignal | undefined, first: T | null, again: () => Promise<T | null>): Promise<T | null> {
  let reply = first;
  for (const ms of RETRY_MS) {
    if (reply !== null) break;
    await sleep(chrome.timers, ms, signal);
    reply = await again();
  }
  return reply;
}

const unreached = (reply: JumpReply | null): boolean => reply === null || (!reply.ok && reply.reason === 'not-files-page');

/** Whether `address` is the same pull request's Files changed page, whatever its fragment. */
function onFilesPage(address: string | undefined, pr: JumpPr): boolean {
  const ref = address === undefined ? null : prRefFromUrl(address);
  return ref !== null && ref.page === 'files' && ref.number === pr.number && ref.repo.toLowerCase() === pr.repo.toLowerCase();
}

function sentence(reply: JumpReply, place: JumpPlace, line: number | null): string {
  const { path } = place;
  const asked = `Asked GitHub to show ${placeText(path, line)}.`;
  if (reply.view === null) return `${asked}${NOT_RECOGNISED}`;
  if (!reply.ok) return `GitHub has not loaded ${path} on this page yet. Scroll to it, then try again.`;
  if (reply.how === 'line' && line !== null) return `Showing ${path}:${line}.`;
  if (reply.how === 'file' && place.kind === 'outside') return `Showing ${path}; that line is outside the changed lines.`;
  return asked;
}

/**
 * Takes the tab `tabId` to `place` and resolves to what it did; never rejects. A place outside the pull request opens in
 * a new tab. Otherwise the tab's content script is asked. When it is not on this pull request's Files changed page (or
 * nothing answers and the tab is elsewhere), the tab is sent there and asked again once it has loaded. A tab with no live
 * script is asked again after each of `RETRY_MS`; then the result says a reload is needed, and the tab is reloaded only
 * when `options.reload` says the person asked for it. Once `options.signal` aborts (a newer jump started), it makes no
 * further Chrome call.
 */
export async function jumpTo(
  unguarded: JumpChrome, tabId: number, pr: JumpPr, place: JumpPlace,
  options: { reload?: boolean; signal?: AbortSignal } = {},
): Promise<JumpResult> {
  const { signal } = options;
  const chrome = guarded(unguarded, signal);
  const said = (sentence: string, needsReload = false): JumpResult => ({ sentence, needsReload });
  const { path } = place;
  const cannotLink = said(`Airlock cannot build a link to ${path}.`);
  try {
    if (signal?.aborted === true) throw CANCELLED;
    // Longer than the content script accepts: refused here, shown cut so the sentence stays readable.
    if (path.length > PATH_MAX) return said(`Airlock cannot build a link to ${clippedPath(path)}.`);
    if (place.kind === 'elsewhere') {
      const url = blobUrl(pr.repo, pr.headSha, path, place.line);
      if (url === null) return cannotLink;
      await chrome.createTab({ url });
      return said(`Opened ${path} in a new tab; it is not part of this pull request.`);
    }
    // A line outside the changed lines is not on the page: the file is asked for alone.
    const line = place.kind === 'outside' ? null : usableLine(place.line);
    const anchorId = await diffAnchorId(path);
    const url = filesUrl(pr.repo, pr.number, anchorId, line ?? undefined);
    if (url === null) return cannotLink;
    const request: JumpRequest = { type: 'airlock:jump', repo: pr.repo, number: pr.number, anchorId, path, line };

    /** Runs `act` and waits for the load it starts; false when the tab was closed meanwhile. */
    const andLoad = async (act: () => Promise<unknown>): Promise<boolean> => {
      const loaded = chrome.loaded(tabId);
      await act();
      return (await loaded) !== 'closed';
    };

    if (options.reload === true && !(await andLoad(() => chrome.reloadTab(tabId)))) return said(TAB_CLOSED);
    const again = (): Promise<JumpReply | null> => ask(chrome, tabId, request, JumpReplySchema);
    let reply = await again();
    if (unreached(reply)) {
      // Moving to the same document with a new fragment would not load a script, so that tab is not navigated.
      const address = await chrome.tabUrl(tabId);
      if (address === null) return said(TAB_CLOSED);
      if (!onFilesPage(address, pr)) {
        if (!(await andLoad(() => chrome.updateTab(tabId, { url })))) return said(TAB_CLOSED);
        reply = await again();
      }
      reply = await retried(chrome, signal, reply, again);
      if (reply === null) return (await chrome.tabUrl(tabId)) === null ? said(TAB_CLOSED) : said(COULD_NOT_REACH, true);
    }
    if (reply === null || unreached(reply)) return said(COULD_NOT_REACH);
    chrome.onReport?.({ view: reply.view, missing: reply.missing });
    return said(sentence(reply, place, line));
  } catch (error) {
    return said(error === CANCELLED ? REPLACED : COULD_NOT_JUMP);
  }
}

/**
 * What sending notes did. `shown`: the page's counts (zero and zero with no view when it is not that pull request's Files
 * changed view). `refused`: the page's sentence. `unreached`: no page script answered, so the tab needs a reload, which
 * only the person asks for. `gone`: nothing to say (the tab was closed, or a newer send replaced this one).
 */
export type NotesResult =
  | ({ kind: 'shown'; placed: number; waiting: number } & PageReport)
  | { kind: 'refused'; sentence: string }
  | { kind: 'unreached' }
  | { kind: 'gone' };

/**
 * Sends notes, or the message clearing them, to the content script of tab `tabId`, with the jump's handling of a tab
 * with no live script: asked again after each of `RETRY_MS`, then `unreached`. The tab is reloaded first only when
 * `options.reload` says the person asked for it, and never navigated. Once `options.signal` aborts it makes no further
 * Chrome call. Never rejects.
 */
export async function sendToPage(
  unguarded: JumpChrome, tabId: number, message: NotesMessage | ClearNotesMessage,
  options: { reload?: boolean; signal?: AbortSignal } = {},
): Promise<NotesResult> {
  const { signal } = options;
  const chrome = guarded(unguarded, signal);
  try {
    if (signal?.aborted === true) throw CANCELLED;
    if (options.reload === true) {
      const loaded = chrome.loaded(tabId);
      await chrome.reloadTab(tabId);
      if ((await loaded) === 'closed') return { kind: 'gone' };
    }
    const again = (): Promise<NotesReply | NotesRefused | null> => ask(chrome, tabId, message, NotesReplySchema);
    const reply = await retried(chrome, signal, await again(), again);
    if (reply === null) return (await chrome.tabUrl(tabId)) === null ? { kind: 'gone' } : { kind: 'unreached' };
    if ('error' in reply) return { kind: 'refused', sentence: clip(reply.error) };
    return { kind: 'shown', placed: reply.placed, waiting: reply.waiting, view: reply.view, missing: reply.missing };
  } catch {
    return { kind: 'gone' };
  }
}

type UpdatedListener = (tabId: number, changeInfo: { status?: string }) => void;
type RemovedListener = (tabId: number) => void;
/** The part of `chrome.tabs` that `tabLoaded` uses. */
export interface TabsEvents {
  onUpdated: { addListener(fn: UpdatedListener): void; removeListener(fn: UpdatedListener): void };
  onRemoved: { addListener(fn: RemovedListener): void; removeListener(fn: RemovedListener): void };
}

/** Ends when tab `tabId` next reports `complete`, after `ms`, or when it is closed; stops watching either way. */
export function tabLoaded(tabs: TabsEvents, tabId: number, timers: Timers = realTimers, ms = LOAD_MS): Promise<Loaded> {
  return new Promise((resolve) => {
    const done = (how: Loaded): void => {
      timers.clearTimeout(timer);
      tabs.onUpdated.removeListener(updated);
      tabs.onRemoved.removeListener(removed);
      resolve(how);
    };
    const updated: UpdatedListener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') done('complete');
    };
    const removed: RemovedListener = (id) => {
      if (id === tabId) done('closed');
    };
    const timer = timers.setTimeout(() => done('timeout'), ms);
    tabs.onUpdated.addListener(updated);
    tabs.onRemoved.addListener(removed);
  });
}

/** The real calls, through Chrome's tabs API; no permission beyond the github.com host is needed for any of them. */
export function browserJumpChrome(onReport: (report: PageReport) => void): JumpChrome {
  return {
    sendMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
    tabUrl: (tabId) => browser.tabs.get(tabId).then((tab) => tab.url, () => null),
    updateTab: (tabId, props) => browser.tabs.update(tabId, props),
    reloadTab: (tabId) => browser.tabs.reload(tabId),
    createTab: (props) => browser.tabs.create(props),
    loaded: (tabId) => tabLoaded(browser.tabs, tabId),
    timers: realTimers,
    onReport,
  };
}

/** A finding's own place: its kind from its anchor; a finding whose quote was not found counts by its path. */
export function ownPlace(finding: Finding, changed: ReadonlySet<string>): JumpPlace {
  const { path, anchor } = finding;
  const kind = anchor.status === 'in-diff' ? 'changed'
    : anchor.status === 'outside-diff' ? 'outside'
    : changed.has(path) ? 'changed' : 'elsewhere';
  return { path, line: anchor.startLine, kind };
}

/** A connected place: on the Files changed page when its path is among the review's files, else elsewhere. */
export function connectedPlace(place: Place, changed: ReadonlySet<string>): JumpPlace {
  return { path: place.path, line: place.line, kind: changed.has(place.path) ? 'changed' : 'elsewhere' };
}

/** The Packs screen's words for the last jump's report. */
export function pageWords(report: PageReport | null): string {
  if (report === null) return 'No jump made yet.';
  const nothing = report.missing.length === 0 ? '' : `Selectors that found nothing: ${report.missing.join(', ')}.`;
  if (report.view === null) return `Not recognised. ${nothing}`.trimEnd();
  const recognised = report.view === 'classic' ? 'Recognised as the classic view.' : 'Recognised as the newer view.';
  return nothing === '' ? recognised : `${recognised} ${nothing}`;
}
