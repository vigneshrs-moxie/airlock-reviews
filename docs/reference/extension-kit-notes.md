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

So for the pack's tiers: the manifest, the background script, the content scripts, `config.js`, anything that sends data out (`apps-script/*.gs`, files that call `fetch` or Google's APIs) are read closely; the popup's files and styles are skimmed; tests, fixtures, icons, the changelog and the other words for people are trusted.

## The kit

`Moxie-Pest-Control-Phoenix/moxie-ext-review-kit`, branch `main`. The files a reviewer's judgement rests on are under `skills/ext-review/`:

- `standard.md` (the bar a pull request must meet)
- `conventions.md` (the rulebook)
- `lens-rules.md`
- `calibration.md` (dated entries from past reviews)
- `register.md`
- `fieldroutes.md` (facts about the FieldRoutes API the extensions use)

Not fetched by Airlock: `SKILL.md`, `lenses.md`, `asks.md`, the templates, the agents and the scripts. Airlock's four lens briefs for this pack are its own, as its briefs for the team kit are.
