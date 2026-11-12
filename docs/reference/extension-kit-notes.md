# The extension repositories and their review kit: what was checked before step 4

Checked on 2026-11-12 with reads through `gh`. Nothing from the kit is copied here; this file only says where things are.

## The repositories

Five repositories under `Moxie-Pest-Control-Phoenix` hold Chrome extensions built by supervisors. Their default branch is `main`:

- `scheduling-tool-suite`
- `termites-tool-suite`
- `moxie-click-to-dial`
- `isales-audit-tool`
- `TI-route-snapshot`

On `main` each holds only what the tech team added: `.github/CODEOWNERS`, a pull request template, `trufflehog-exclude.txt` and three workflows (`ext-checks`, `ext-release`, `ext-deploy`). The extension itself arrives in a pull request from a builder's branch (for example `james-dev`) into `main`, so the author of a pull request there is normally not the person running Airlock, and the review's verdict is one of the "someone else's pull request" words.

## How an extension is laid out

There is no build step and no `src` folder: the files Chrome loads are at the top of the repository. From the open first pull requests of two of them:

| What | Where (examples) |
|---|---|
| The manifest | `manifest.json` |
| Background (service worker) | `background.js` |
| Content scripts | `content.js`, `bridge-content.js`, `sheets-content.js` |
| Feature logic | top-level `*.js` such as `batch-controller.js`, `route-fill-controller.js`, `reminder-policy.js`, `config.js`, `destinations.js` |
| The popup | `popup.html`, `popup.js`, `popup.css`, `styles.css` |
| Apps Script that receives data in Google Sheets | `apps-script/*.gs`, with setup notes beside them as `.md` |
| Tests | `tests/*.js`, `tests/*.cjs`, `tests/*.py`, fixtures under `tests/fixtures/` |
| Words for people | `README.md`, `CHANGELOG.md`, `PRIVACY.md`, `TEST-CHECKLIST.md` |
| Icons | `icons/*.png` |

So for the pack's tiers: the manifest, the background script, the content scripts, `config.js`, anything that sends data out (`apps-script/*.gs`, files that call `fetch` or Google's APIs) and the setup notes beside the receivers (every `.md` under an `apps-script/` folder at any depth, and every `.md` whose name holds "setup" in any letter case, since a token or a receiver's address can be pasted there) are read closely; the popup's files and styles are skimmed; the top-level `tests/` folder (the fixtures under it included), the image files under `icons/` (not other files there), the changelog and the other words for people are trusted.

On top of the tiers, every changed file the extension loads is read closely whatever its tier, ignored and trusted included: what `manifest.json` names, the local scripts its pages pull in, and what those scripts load in turn (`importScripts`, `import`, `new Worker`, `executeScript`, `registerContentScripts` and `updateContentScripts`, and the pages of an offscreen document, `tabs.create`, `windows.create`, `setPopup`, `sidePanel.setOptions` and an `<iframe>`; a path climbing above the root stops at the root, as in a browser), followed through the whole chain from the head. With no build step, a `*.min.js`, `dist/` or `*.generated.*` script or page is committed by hand, so one that nothing is seen to load is skimmed rather than left out, with a fact saying why. When a loaded script cannot be read, or following runs past its budget (200 files, 8 million characters, 50,000 loader calls, a manifest entry over 256 characters, or too much `*` matching), a fact says so and no file is trusted as a test.

## The kit

`Moxie-Pest-Control-Phoenix/moxie-ext-review-kit`, branch `main`. The files a reviewer's judgement rests on are under `skills/ext-review/`:

- `standard.md` (the bar a pull request must meet)
- `conventions.md` (the rulebook)
- `calibration.md` (dated entries from past reviews)
- `register.md`
- `fieldroutes.md` (facts about the FieldRoutes API the extensions use)
- `lenses.md` (the team's rules for each of its four lenses, which are Airlock's four: what blocks a pull request and what is asked about)

Airlock attaches these six, in this order, with `calibration.md` the only dated one. Copies are cached by the kit's ref and commit. Each brief tells its lens to hold what it finds to its own part of `lenses.md`, and that the portfolio outcome for the extension and updating `register.md` are not a lens's job.

Not fetched by Airlock: `SKILL.md`, `asks.md`, the templates, the agents and the scripts. `lens-rules.md` is left out too: it tells the kit's own agents which tools to use, where to write and how to reply, which contradicts Airlock's own output contract. The attached files name some of these, and also `profile.md` and `extensions.md`, which are not attached either, so each brief says that a file of such a name in the working folder belongs to the pull request. Airlock's four lens briefs for this pack are its own, as its briefs for the team kit are.
