// Empty shell: later tasks add the page script.
export default defineContentScript({
  matches: ['https://github.com/*'],
  runAt: 'document_idle',
  world: 'ISOLATED',
  main() {},
});
