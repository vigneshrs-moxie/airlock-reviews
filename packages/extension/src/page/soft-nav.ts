// GitHub moves between its pages without loading a new document. These are the events taken to mark that: Turbo's render
// and GitHub's own soft-nav end on the document, and the history's popstate on the window. Not yet checked on a live page.

export type SoftNavigation = 'turbo:render' | 'soft-nav:end' | 'popstate';
/** A soft navigation, or any change of the page's address (WXT's location watcher, wired in the entry point). */
export type PageMove = SoftNavigation | 'locationchange';

/** Calls `fn` on each of GitHub's soft navigations until the returned function is called. */
export function onSoftNavigation(doc: EventTarget, win: EventTarget, fn: (event: SoftNavigation) => void): () => void {
  const listeners: [EventTarget, SoftNavigation, () => void][] = [
    [doc, 'turbo:render', () => fn('turbo:render')],
    [doc, 'soft-nav:end', () => fn('soft-nav:end')],
    [win, 'popstate', () => fn('popstate')],
  ];
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener);
  return () => {
    for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
  };
}
