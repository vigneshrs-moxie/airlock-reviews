# Panel redesign: summaries first

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** The side panel leads with the answer, keeps each finding to one line and puts the detail one tap away, with a Settings screen (text and button size), a three-step tour, and actions that say what they do.

**Architecture:** Panel-only changes in `packages/extension` for Part 1 (Settings, size, tour). Part 2 restructures the review and finding screens, and adds one engine stage that writes short titles and one-line summaries into the review document; it waits for the owner's picks on the prototype.

**Tech Stack:** React 19, WXT (MV3 side panel), plain CSS in `src/screens/panel.css`, Vitest with jsdom, Playwright end-to-end against the fake service.

**Spec:** the prototype at https://claude.ai/artifact/MhxVq27MRcGt6q56UKZoNC (its Requirements tab, FR-001 to FR-016). Its sources are in `docs/design/panel-redesign/`: `gen.py` holds every screen's exact wording and structure, `theme.css` holds the tokens and the new `.ap-*` rules, `build-brief.md` lists the screens and where each leads.

## Global Constraints

- Everything in `/Users/moxie/Projects/airlock-reviews-step2/.superpowers/sdd/2026-11-11-step-4-notes-and-extensions-pack/global-constraints.md` still holds (nothing touches GitHub without the person's click; no real post in the build; text from a review is only ever rendered as text; no deletes by shell command; commit trailer).
- The panel holds no `img`, `a` or `script` element (the hardening tests check this). Icons are inline `svg` elements or CSS backgrounds.
- The content script (`entrypoints/github.content.ts` and `src/page/**`) is not touched: its 15,360-byte bound stays.
- Every screen works from 320 to 420 px wide with no sideways scrolling. Buttons are at least 32 px high at the Default size, 40 in pinned bars.
- A kind or a state is always a word; colour is a second cue only.
- Wording is plain and short, as in `docs/design/panel-redesign/gen.py`. Where a sentence there differs from today's panel, the prototype's sentence wins.
- Focus: a sheet traps focus and returns it to its opener on close, as `Sheet.tsx` does today. Escape closes.
- Work in `/Users/moxie/Projects/airlock-reviews-panel` (branch `feature/panel-redesign`). Never build or run tests in `/Users/moxie/Projects/airlock-reviews`: the owner loads the extension from that folder.

## Review Focus

1. The size setting at Largest in a 320 px panel: nothing overflows sideways, sheets still fit, pinned bars still show their buttons.
2. The stored size cannot be read (storage error, a value that is not one of the four): the panel opens at Default and says nothing.
3. The tour appears while a dismiss or post sheet is open, or the review goes away under it (a push, the service away): it must not trap the person or cover a sheet.
4. Settings opened while a review runs, offline, or not paired: each row still makes sense and nothing throws.
5. A person who never finishes the tour (closes the panel on step 2): it shows again next time, from step 1, and never after Skip or Done.

---

## Part 1: the same whichever option is picked

### Task 1: Size setting and tour flag in the store, applied at start-up

**Files:**
- Modify: `packages/extension/src/state/settings.ts`, `packages/extension/entrypoints/sidepanel/main.tsx`
- Create: `packages/extension/src/state/size.ts`
- Test: `packages/extension/test/state/settings.test.ts`, `packages/extension/test/state/size.test.ts`

**Interfaces (produces):**
- `export type Size = 's' | 'm' | 'l' | 'xl'`; `export const SIZES: readonly Size[]`; `export const SIZE_SCALE: Record<Size, number> = { s: 0.9, m: 1, l: 1.15, xl: 1.3 }`; `export const SIZE_LABEL: Record<Size, string> = { s: 'Small', m: 'Default', l: 'Large', xl: 'Largest' }`.
- `applySize(size: Size, root?: HTMLElement): void` sets `root.style.zoom` to the scale and `root.dataset.size` to the size (root defaults to `document.documentElement`).
- `readSizeHint(storage?: Pick<Storage, 'getItem'>): Size` and `writeSizeHint(size, storage?)`: a copy in the panel page's `localStorage` under `airlock.size`, read before the first paint; any error or unknown value gives `'m'`.
- `SettingsStore` gains `getSize(): Promise<Size>` (unknown or missing gives `'m'`), `setSize(size: Size): Promise<void>`, `getTourSeen(): Promise<boolean>`, `setTourSeen(): Promise<void>`. Keys `airlock.size`, `airlock.tourSeen`.
- `main.tsx`: applies `readSizeHint()` before rendering, then reads the store; when the store's value differs it applies that and rewrites the hint.

Tests: each of the four sizes applies its scale; a bad stored value gives Default; a throwing `localStorage` gives Default; the store round-trips size and the tour flag; start-up applies the hint first and the store's value second.

### Task 2: Settings replaces "Packs and settings"

**Files:**
- Create: `packages/extension/src/screens/Settings.tsx`, `packages/extension/src/screens/ServiceInfo.tsx`
- Modify: `packages/extension/src/screens/Packs.tsx` (becomes "Packs and learned lines": the packs of this repository and the learned lines only), `Frame.tsx`, `PanelScreen.tsx`, `panel.css`, `src/panel/App.tsx`
- Test: `packages/extension/test/screens/settings.test.tsx`, the existing Packs, frame and panel-screen tests, `e2e/flow.spec.ts`
- Docs: `docs/guide/install.md` wherever it names the Packs button or screen

The header's one button reads **Settings** with a small inline gear (`aria-hidden`). It opens the Settings screen beside the kept panel body, exactly as Packs opens today (`kept`, `inert`, focus back to the button on Back).

Settings screen, in this order (wording from `gen.py`, `settings()`):
- **Display**: "Text and button size", a four-part control (Small, Default, Large, Largest; `role="radiogroup"`), a preview holding one finding row and two buttons, and "Changes everything in the panel: text, buttons and spacing. Saved on this computer." Choosing a size applies it at once, stores it, and writes the hint. A size that cannot be stored is undone and says "Airlock could not save that setting."
- **On GitHub**: "Notes in the diff", "Private notes under the lines of Files changed. Only you see them.", the existing switch and its failure line.
- **Reviews**: "Default depth" (the existing control), and a row "Packs and learned lines" with a count line ("2 packs for this repository · 4 lines learned"; "Open a pull request to see its packs." when there is none) that opens the Packs screen. Back from Packs returns to Settings.
- **Help**: "Show the tour again" (Task 3), and a row "Service" with a one-line state ("Running · paired · Claude found · GitHub signed in", each part from what is known; "Checking…" while it is read) that opens a Service screen holding today's Service, Pairing and GitHub page sections unchanged, with Check again.

Nothing shown on today's "Packs and settings" screen is removed; it is only moved. Tests: every row renders in each panel state (ready, running, review, offline, not paired); the size control changes `zoom` and survives a remount; Back restores focus; the screens hold no `img`, `a` or `script`.

### Task 3: The tour

**Files:**
- Create: `packages/extension/src/screens/Tour.tsx`
- Modify: `Sheet.tsx` (a bottom-sheet variant: `.sheet.bottom`), `PanelScreen.tsx`, `panel.css`, `src/panel/App.tsx`
- Test: `packages/extension/test/screens/tour.test.tsx`, `e2e/flow.spec.ts`

Three steps in a bottom sheet over the review, wording from `gen.py`, `tour()`:
1. "Start at the top": "The verdict says whether this can merge. Under it, each finding is one line. Tap a line for the short version; the detail is folded below it."
2. "Three things you can do with a finding": Copy fix prompt "copies instructions for your coding agent."; Comment on GitHub "shows you the exact text and where it goes: on the line, or in the review summary. It posts only when you press Post."; Dismiss "hides the finding here and teaches Airlock. Nothing goes to GitHub."
3. "Notes and size": "Open findings also appear as private notes under their lines on GitHub's Files changed page. Settings changes the text and button size, and shows this tour again."

"Step n of 3", three dots (the current one also said in words for a screen reader), Skip and Next on steps 1 and 2, Done on step 3. It opens by itself the first time a finished review is on screen and no dismiss or post sheet is open, when `getTourSeen()` is false. Skip, Done and Escape call `setTourSeen()`; closing the panel mid-tour does not. "Show the tour again" in Settings closes Settings and opens the tour at step 1 over whatever screen is there. If the review leaves the screen while the tour is open, the tour closes without marking it seen.

Tests: opens once with the first review; never after Skip, Done or Escape; again after a panel closed on step 2; not over an open sheet (it waits for the sheet to close); replay from Settings; focus trapped and returned.

---

## Part 2: after the owner's picks (outlined; detailed when the picks are in)

- **Task 4, summaries in the review document.** Shared contract: optional `short` (at most 60 characters) and `gist` (at most 200) on a finding, optional `brief.inShort` (at most 200). Engine: a last stage, `summary`, one request on the fast model, writes them for every finding shown; text from the pull request is material, the output is validated and plain text; a failure is a note, never a stage error. Panel fallback when absent: the title cut at a word, the first sentence of `happens`.
- **Task 5, the review screen.** Verdict strip (words, one sentence, counts by kind, one meta line), rows, and the rest behind three tabs or folds (pick `c-split`). Pinned bar: one fix prompt for every fix, and Select.
- **Task 6, the finding screen.** Summary, What to do, folded evidence, position and previous/next in the top row, pinned actions with captions (pick `c-actions`); the filled button follows the kind.
- **Task 7, the sheets.** Comment preview leads with where the comment goes; the dismiss sheet leads with what happens and that nothing goes to GitHub; both become bottom sheets.
- **Task 8, start and progress screens, after a push, the guide, the end-to-end flow.**
