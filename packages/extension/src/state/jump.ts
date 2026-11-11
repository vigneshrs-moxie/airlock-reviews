import { blobUrl, diffAnchorId, filesUrl, type Finding, type Place } from '@airlock/shared';
import { realTimers, type Timers } from '../client/timers';
import { JumpReplySchema, type JumpReply, type JumpRequest } from '../page/messages';
import { placeText } from '../screens/words';

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

/** How long to wait for the tab to finish loading after sending it to the Files changed page. */
export const LOAD_MS = 15_000;

/** The Chrome calls a jump makes, so tests can pass fakes. */
export interface JumpChrome {
  /** Rejects when no content script answers in the tab. */
  sendMessage(tabId: number, message: JumpRequest): Promise<unknown>;
  updateTab(tabId: number, props: { url: string }): Promise<unknown>;
  createTab(props: { url: string }): Promise<unknown>;
  /** Starts watching when called; resolves when the tab next finishes loading, or after `LOAD_MS`. Never rejects. */
  loaded(tabId: number): Promise<void>;
  /** Told what the page answered, for the Packs screen. */
  onReport?(report: PageReport): void;
}

export const COULD_NOT_JUMP = 'Airlock could not jump to that place.';
const COULD_NOT_REACH = 'Airlock opened the Files changed page but could not reach it. Try the button again.';
const NOT_RECOGNISED = ' Airlock does not recognise this version of the page.';

const usableLine = (line: number | null): number | null =>
  line !== null && Number.isSafeInteger(line) && line > 0 ? line : null;

/** The page's reply, or null when nothing answered or the answer is not one Airlock understands. */
async function ask(chrome: JumpChrome, tabId: number, request: JumpRequest): Promise<JumpReply | null> {
  try {
    const reply = JumpReplySchema.safeParse(await chrome.sendMessage(tabId, request));
    return reply.success ? reply.data : null;
  } catch {
    return null;
  }
}

const unreached = (reply: JumpReply | null): boolean => reply === null || (!reply.ok && reply.reason === 'not-files-page');

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
 * Takes the tab `tabId` to `place` and resolves to the sentence to show. A place outside the pull request opens in a new
 * tab. Otherwise the tab's content script is asked; when the tab is not on the Files changed page, or nothing answers,
 * the tab is sent there, and asked once more when it has loaded.
 */
export async function jumpTo(chrome: JumpChrome, tabId: number, pr: JumpPr, place: JumpPlace): Promise<string> {
  const { path } = place;
  const cannotLink = `Airlock cannot build a link to ${path}.`;
  try {
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
    const request: JumpRequest = { type: 'airlock:jump', anchorId, path, line };

    let reply = await ask(chrome, tabId, request);
    if (unreached(reply)) {
      const loaded = chrome.loaded(tabId);
      await chrome.updateTab(tabId, { url });
      await loaded;
      reply = await ask(chrome, tabId, request);
    }
    if (reply === null || unreached(reply)) return COULD_NOT_REACH;
    chrome.onReport?.({ view: reply.view, missing: reply.missing });
    return sentence(reply, place, line);
  } catch {
    return COULD_NOT_JUMP;
  }
}

type UpdatedListener = (tabId: number, changeInfo: { status?: string }) => void;
/** The part of `chrome.tabs` that `tabLoaded` uses. */
export interface TabsEvents {
  onUpdated: { addListener(fn: UpdatedListener): void; removeListener(fn: UpdatedListener): void };
}

/** Resolves when tab `tabId` next reports `complete`, or after `ms`; stops watching either way. */
export function tabLoaded(tabs: TabsEvents, tabId: number, timers: Timers = realTimers, ms = LOAD_MS): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      timers.clearTimeout(timer);
      tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener: UpdatedListener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') done();
    };
    const timer = timers.setTimeout(done, ms);
    tabs.onUpdated.addListener(listener);
  });
}

/** The real calls, through Chrome's tabs API; no permission beyond the github.com host is needed for any of them. */
export function browserJumpChrome(onReport: (report: PageReport) => void): JumpChrome {
  return {
    sendMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
    updateTab: (tabId, props) => browser.tabs.update(tabId, props),
    createTab: (props) => browser.tabs.create(props),
    loaded: (tabId) => tabLoaded(browser.tabs, tabId),
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
