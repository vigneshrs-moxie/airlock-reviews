import { blobUrl, diffAnchorId, filesUrl, prRefFromUrl, type Finding, type Place } from '@airlock/shared';
import { z } from 'zod';
import { realTimers, type Timers } from '../client/timers';
import { PATH_MAX, type JumpReply, type JumpRequest } from '../page/protocol';
import { clippedPath, placeText } from '../place-text';

/**
 * Where a jump goes. `changed`: the path is among the review's files and the line is expected on the Files changed page.
 * `outside`: among the files, but the finding's anchor says the line is outside the changed lines. `elsewhere`: not
 * among the files, so it opens at the reviewed commit in a new tab.
 */
export interface JumpPlace { path: string; line: number | null; kind: 'changed' | 'outside' | 'elsewhere' }
/** The reviewed pull request, at the reviewed commit. */
export interface JumpPr { repo: string; number: number; headSha: string }
/** Takes the person to a place on GitHub and says in a sentence what it did. Never rejects. */
export type Jump = (pr: JumpPr, place: JumpPlace) => Promise<string>;
/** What the last jump found on the page: the view it recognised, and the selectors that found nothing. */
export type PageReport = Pick<JumpReply, 'view' | 'missing'>;

const report = { view: z.enum(['react', 'classic']).nullable(), missing: z.array(z.string()) };
/** The content script's reply, checked on arrival; anything else counts as no answer. */
const JumpReplySchema: z.ZodType<JumpReply> = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), how: z.enum(['line', 'file', 'asked']), ...report }),
  z.object({ ok: z.literal(false), reason: z.enum(['not-files-page', 'file-not-on-page']), ...report }),
]);

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
  sendMessage(tabId: number, message: JumpRequest): Promise<unknown>;
  /** The tab's address, when Chrome shows it. */
  tabUrl(tabId: number): Promise<string | undefined>;
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
const COULD_NOT_REACH = 'Airlock could not reach the GitHub page. Reload it, then try again.';
const TAB_CLOSED = 'Airlock could not jump: the GitHub tab was closed.';
const NOT_RECOGNISED = ' Airlock does not recognise this version of the page.';

const usableLine = (line: number | null): number | null =>
  line !== null && Number.isSafeInteger(line) && line > 0 ? line : null;

const sleep = (timers: Timers, ms: number): Promise<void> => new Promise((resolve) => { timers.setTimeout(resolve, ms); });

/** The page's reply; null when nothing is listening, nothing answers within `ANSWER_MS`, or the answer is not understood. */
async function ask(chrome: JumpChrome, tabId: number, request: JumpRequest): Promise<JumpReply | null> {
  let timer: unknown;
  const silence = new Promise<undefined>((resolve) => { timer = chrome.timers.setTimeout(() => resolve(undefined), ANSWER_MS); });
  try {
    const answer = await Promise.race([chrome.sendMessage(tabId, request), silence]);
    const reply = JumpReplySchema.safeParse(answer);
    return reply.success ? reply.data : null;
  } catch {
    return null;
  } finally {
    chrome.timers.clearTimeout(timer);
  }
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
 * Takes the tab `tabId` to `place` and resolves to the sentence to show; never rejects. A place outside the pull request
 * opens in a new tab. Otherwise the tab's content script is asked. When it is not on this pull request's Files changed
 * page (or nothing answers and the tab is elsewhere), the tab is sent there and asked again once it has loaded. A tab
 * with no live script (the extension was reloaded) is asked again after each of `RETRY_MS`, then reloaded once and asked
 * a last time.
 */
export async function jumpTo(chrome: JumpChrome, tabId: number, pr: JumpPr, place: JumpPlace): Promise<string> {
  const { path } = place;
  const cannotLink = `Airlock cannot build a link to ${path}.`;
  try {
    // Longer than the content script accepts: refused here, shown cut so the sentence stays readable.
    if (path.length > PATH_MAX) return `Airlock cannot build a link to ${clippedPath(path)}.`;
    if (place.kind === 'elsewhere') {
      const url = blobUrl(pr.repo, pr.headSha, path, place.line);
      if (url === null) return cannotLink;
      await chrome.createTab({ url });
      return `Opened ${path} in a new tab; it is not part of this pull request.`;
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

    let reply = await ask(chrome, tabId, request);
    if (unreached(reply)) {
      // Moving to the same document with a new fragment would not load a script, so that tab is not navigated.
      const address = await chrome.tabUrl(tabId).catch(() => undefined);
      if (!onFilesPage(address, pr)) {
        if (!(await andLoad(() => chrome.updateTab(tabId, { url })))) return TAB_CLOSED;
        reply = await ask(chrome, tabId, request);
      }
      for (const ms of RETRY_MS) {
        if (reply !== null) break;
        await sleep(chrome.timers, ms);
        reply = await ask(chrome, tabId, request);
      }
      if (reply === null) {
        if (!(await andLoad(() => chrome.reloadTab(tabId)))) return TAB_CLOSED;
        reply = await ask(chrome, tabId, request);
      }
    }
    if (reply === null || unreached(reply)) return COULD_NOT_REACH;
    chrome.onReport?.({ view: reply.view, missing: reply.missing });
    return sentence(reply, place, line);
  } catch {
    return COULD_NOT_JUMP;
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
    tabUrl: async (tabId) => (await browser.tabs.get(tabId)).url,
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
