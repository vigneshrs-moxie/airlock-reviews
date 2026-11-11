import { createPage, listen } from '../src/page/jump';
import { onSoftNavigation } from '../src/page/soft-nav';

// The one part of Airlock that runs inside a page it does not control, so it does as little as possible: it answers the
// panel's jump request by setting the address fragment and marking one row. No network, no storage, no markup, and no
// dependencies beyond the zod-free address rules.
export default defineContentScript({
  matches: ['https://github.com/*'],
  runAt: 'document_idle',
  world: 'ISOLATED',
  main(ctx) {
    const page = createPage({
      doc: document,
      location: window.location,
      now: () => performance.now(),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    listen(browser.runtime, page);
    ctx.onInvalidated(onSoftNavigation(document, window, (event) => page.softNavigated(event)));
    // Every change of address, including history.pushState, which fires none of the events above.
    ctx.addEventListener(window, 'wxt:locationchange', (event) => page.softNavigated('locationchange', event.newUrl.href));
  },
});
