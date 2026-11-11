# What Chrome and GitHub's page really do

Checked by running it, not read from documentation. Each entry has the browser version and the date.

## An extension page calling a local server (2026-11-11, Chromium 158.0.8127.18 through Playwright, headless)

Test: an unpacked Manifest V3 extension with `host_permissions: ["http://127.0.0.1/*"]`, its side panel page opened as `chrome-extension://<id>/panel.html`, calling a Node server on `127.0.0.1` at a random port.

- **No prompt and no block.** `fetch` from the extension page reached the server. No Local Network Access prompt, no dialog.
- **No preflight.** With an `Authorization` header and a JSON `Content-Type`, the server saw the `GET`, `POST` and `DELETE` directly and never an `OPTIONS`.
- **The `Origin` header depends on the method.** `POST` and `DELETE` carried `Origin: chrome-extension://<extension id>`. `GET` carried no `Origin` header at all. Every request had `Sec-Fetch-Site: none` and `Sec-Fetch-Mode: cors`.
  - So the service's rule is: when `Origin` is present it must equal the paired extension origin; a `GET` is authorised by the token alone. Pairing is a `POST`, so it always carries the origin to record.
- **A long stream stays open.** A response that sent one chunk at once, the next after 35 seconds of silence and the last after 70 seconds was read to the end by the extension page (the 30-second limits apply to service workers, not to an extension page).
- **A plain web page cannot reach the port.** From `https://example.com`, both a normal `fetch` with an `Authorization` header and a `no-cors` `fetch` to the same address failed with `Failed to fetch`, and the server received nothing. (Headless Chrome answers the Local Network Access permission as denied; in a normal window the person would see a prompt naming the site.) The token and origin checks stay in place regardless: other programs on the Mac can reach the port, and a person could accept that prompt.
- **Not checked on the installed Google Chrome (157.0.8103.51):** it does not load an extension from the command line (`--load-extension` is ignored, also with `--disable-features=DisableLoadExtensionCommandLineSwitch`), so the first check on the branded build is the first real load of the extension. If the panel shows "service not running" while `airlock-service status` says it is running, this is the place to look.

The throwaway test lives outside the repository; Task 7's end-to-end test (`the panel page loads and reaches the fake service without any prompt`) keeps this checked.

## GitHub's classic Files changed view (2026-11-11, Google Chrome 157, signed out, a public pull request)

- Signed out, `/pull/<n>/files` is the classic view: one `div.file.js-file` per file, no element of the newer view on the page.
- **The file container's id is `diff-` plus the SHA-256 of the file's path** (checked by computing it in the page). The path is in `data-tagsearch-path`; the container sits inside `<copilot-diff-entry data-file-path="<path>">`. Other attributes: `data-file-type`, `data-file-deleted`.
- The diff is `table.diff-table.js-diff-table`. A changed or context row is `<tr data-hunk="…">` with three cells in the unified layout: `td#diff-<hash>L<n>.blob-num[data-line-number]` (old side), `td#diff-<hash>R<n>.blob-num.js-blob-rnum[data-line-number]` (new side), and `td.blob-code.blob-code-context|addition|deletion.js-file-line` holding `span.blob-code-inner`. A hunk header row is `tr.js-expandable-line` with `td.blob-code-hunk`.
- **Setting `location.hash` to `#diff-<hash>R<n>` makes GitHub scroll to that line and mark it**: the line-number cell and the code cell both get the classes `selected-line selected-line-top selected-line-bottom`. No reload.

## GitHub's newer Files changed view: not checked

The Chrome profile that this session can drive is not signed in to GitHub (a private pull request returned "Page not found"), and the newer view is only served to signed-in people. Everything Airlock knows about that view comes from the source of two other extensions (Refined GitHub and Codecov), as recorded in the research notes: container `[class*="diffTargetable"]` with an id starting `diff-`, rows `.diff-line-row`, line-number cells `td[class*="diff-line-number"]`, the new line number in the second cell (unified) or third (split), code in `.diff-text-inner`.

**Check first on a signed-in page: the order of the cells in a row.** `src/page/locate.ts` reads the new-side line number from the second cell of a unified row (number, number, code) and the third cell of a split row (number, code, number, code), and matches no row of any other shape. If the real rows differ, jumps in the newer view still set the address fragment but answer "Asked GitHub to show…" instead of marking the row.

What follows for the build: jumping to a line relies first on GitHub's own address fragment (`#diff-<hash>R<n>`), which is GitHub's documented permalink form for both views, and only then looks for the row to add Airlock's own mark. If the row cannot be found the jump still happened; the panel says "Asked GitHub to show <path>:<line>". The newer view's selectors are confirmed on the first real use, and the panel's Packs screen shows which selectors matched on the current page so a mismatch is visible at once.
