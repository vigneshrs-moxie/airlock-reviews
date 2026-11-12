import { createPage, destinationOf, listen, locationChanged } from '../src/page/jump';
import { createNotes, listenNotes } from '../src/page/notes';
import { onSoftNavigation } from '../src/page/soft-nav';

// The one part of Airlock that runs inside a page it does not control, so it does as little as possible: it answers the
// panel's jump request by setting the address fragment and marking one row, and shows the panel's private notes as rows
// under their lines. No network, no storage, no markup, and no dependencies beyond the zod-free address rules and words.
export default defineContentScript({
  matches: ['https://github.com/*'],
  runAt: 'document_idle',
  world: 'ISOLATED',
  // WXT would otherwise post a "content script started" message to the page's window, which the page can read.
  noScriptStartedPostMessage: true,
  main(ctx) {
    const page = createPage({
      doc: document,
      location: window.location,
      now: () => performance.now(),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    listen(browser.runtime, page);
    // `Open in Airlock` is the one message the page script sends; with no panel or worker listening it goes nowhere.
    const notes = createNotes(document, (message) => void browser.runtime.sendMessage(message).catch(() => undefined));
    listenNotes(browser.runtime, notes);
    ctx.onInvalidated(() => notes.stop());
    ctx.onInvalidated(onSoftNavigation(document, window, (event) => {
      page.softNavigated(event);
      notes.moved();
    }));
    // Every change of address, including history.pushState, which fires none of the events above.
    ctx.addEventListener(window, 'wxt:locationchange', (event) => {
      locationChanged(page, event);
      notes.moved(destinationOf(event));
    });
  },
});
