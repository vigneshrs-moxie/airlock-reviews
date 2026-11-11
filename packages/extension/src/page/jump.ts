// Imported by path, not from '@airlock/shared': this module has no zod, and the content script must stay small.
import { prRefFromUrl } from '../../../shared/src/pr-ref';
import { detectView, findFile, findLine, targetsOf } from './locate';
import { notFilesPage, parseJumpRequest, type JumpReply, type JumpRequest, type View } from './protocol';
import { missingFor } from './selectors';
import type { PageMove } from './soft-nav';

/** How long the script looks for the row after setting the address fragment, and how often. */
export const LOOK_MS = 3_000;
export const STEP_MS = 100;

export const MARK_CLASS = 'airlock-target';
// An outline does not change the layout. Orange reads on GitHub's light and dark backgrounds.
const STYLE = `.${MARK_CLASS} { outline: 2px solid #f0883e !important; outline-offset: -2px; }`;

/** The page the script works on, passed in so tests can give a fixture and a clock that moves only when it waits. */
export interface PageEnv {
  doc: Document;
  location: { readonly href: string; hash: string };
  now(): number;
  wait(ms: number): Promise<void>;
}

export interface Page {
  /** Answers one jump request; see JumpReply (protocol.ts) for what each reply means. */
  answer(request: JumpRequest): Promise<JumpReply>;
  /**
   * GitHub moved within the page, or the address changed: the mark is removed, unless this is a popstate or address
   * change to the address the mark was made at (the script's own fragment). `to` is the new address when the event names
   * it; WXT's watcher can fire before the address is committed, so `location.href` may still be the old one.
   */
  softNavigated(event: PageMove, to?: string): void;
}

/** Puts the one mark on `targets`, taking it off the previous target first. An empty list only takes it off. */
export function createMarker(doc: Document): { mark(targets: HTMLElement[]): void } {
  let marked: HTMLElement[] = [];
  let style: HTMLStyleElement | null = null;
  return {
    mark(targets) {
      for (const el of marked) el.classList.remove(MARK_CLASS);
      marked = targets;
      if (targets.length === 0) return;
      if (style === null || !style.isConnected) {
        style = doc.createElement('style');
        style.textContent = STYLE;
        (doc.head ?? doc.documentElement).append(style);
      }
      for (const el of targets) el.classList.add(MARK_CLASS);
    },
  };
}

export function createPage(env: PageEnv): Page {
  const { doc, location } = env;
  const marker = createMarker(doc);
  // The address the current mark was made at; a popstate there is the script's own fragment change.
  let markedAt: string | null = null;
  // A newer request takes over: an older one that is still looking marks nothing.
  let latest = 0;

  const mark = (targets: HTMLElement[]): void => {
    marker.mark(targets);
    markedAt = targets.length === 0 ? null : location.href;
  };

  return {
    async answer(request) {
      const mine = ++latest;
      const ref = prRefFromUrl(location.href);
      const samePull = ref !== null && ref.page === 'files' && ref.number === request.number
        && ref.repo.toLowerCase() === request.repo.toLowerCase();
      if (!samePull) return notFilesPage();

      // GitHub's own permalink form: in both views GitHub scrolls to the line and marks it. Everything after is extra.
      location.hash = `#${request.anchorId}${request.line === null ? '' : `R${request.line}`}`;

      const deadline = env.now() + LOOK_MS;
      let view: View | null = null;
      let file: HTMLElement | null = null;
      let row: HTMLElement | null = null;
      for (;;) {
        view = detectView(doc);
        file = view === null ? null : findFile(doc, request.anchorId);
        row = file === null || view === null || request.line === null ? null : findLine(doc, view, file, request.anchorId, request.line);
        const done = row !== null || (file !== null && request.line === null);
        if (done || env.now() >= deadline || mine !== latest) break;
        await env.wait(STEP_MS);
      }

      const missing = missingFor(doc, view);
      if (missing.length > 0) console.warn(`Airlock: selectors that found nothing on this page: ${missing.join(', ')}`);
      const fileOnly = view !== null && file !== null && request.line === null;
      if (mine === latest) {
        mark(row !== null && view !== null ? targetsOf(view, row) : []);
        // Also when GitHub does not scroll: setting the fragment it already has is not a navigation.
        if (row !== null) row.scrollIntoView({ block: 'center' });
        else if (fileOnly) file?.scrollIntoView({ block: 'start' });
      }

      if (view === null) return { ok: true, how: 'asked', view, missing };
      if (file === null) return { ok: false, reason: 'file-not-on-page', view, missing };
      if (row !== null) return { ok: true, how: 'line', view, missing };
      return { ok: true, how: request.line === null ? 'file' : 'asked', view, missing };
    },
    softNavigated(event, to) {
      if ((event === 'popstate' || event === 'locationchange') && markedAt === (to ?? location.href)) return;
      mark([]);
    },
  };
}

type Sender = { id?: string };
type Listener = (message: unknown, sender: Sender, sendResponse: (reply: JumpReply) => void) => true | undefined;

/** The part of `chrome.runtime` the script uses, so tests can pass a fake. */
export interface RuntimeLike {
  readonly id: string;
  onMessage: { addListener(fn: Listener): void };
}

const listening = new WeakSet<object>();

/**
 * Answers jump requests from this extension only, and always answers them (a failure answers not-files-page); every
 * other message gets no reply. Registers once per runtime.
 */
export function listen(runtime: RuntimeLike, page: Page): void {
  if (listening.has(runtime.onMessage)) return;
  listening.add(runtime.onMessage);
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== runtime.id) return undefined;
    const request = parseJumpRequest(message);
    if (request === null) return undefined;
    void page.answer(request).then(sendResponse, () => sendResponse(notFilesPage()));
    return true;
  });
}
