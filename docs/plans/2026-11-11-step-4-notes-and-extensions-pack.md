# Airlock Step 4: Private Notes in the Diff and the Extensions Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On GitHub's Files changed page each open finding shows as a private note under its line, seen only in this browser, and pressing it opens the finding in the panel. And pull requests to the supervisor-built Chrome extension repositories are reviewed with their own pack, built on the team's extension review kit.

**Architecture:** The note is drawn by the content script from a list the panel sends; the content script still has no network, no storage and no dependencies, and every note lives in a closed shadow root so the page's own scripts and styles do not reach it. For the pack, the engine's kit sync stops being about one repository: a pack's manifest names the kit it attaches, and the new `extensions` pack names the extension review kit, with lens briefs and code checks that are Airlock's own.

**Tech Stack:** As steps 1 to 3. `MutationObserver` and shadow DOM in the content script; nothing new on the engine side.

**Spec:** `docs/design/2026-11-10-airlock-design.md` (sections 2 "In the diff", 6.1 last paragraph, 8, 10 step 4, 11 first item). Pick made on the prototype: a private note under the line (not a highlight). Facts about GitHub's two Files changed views: `docs/reference/chrome-notes.md`.

## Global Constraints

- Everything in the constraints of steps 1 to 3 still holds.
- The content script makes no network request, reads and writes no storage, imports nothing with dependencies, and stays under 15 kB built. It changes GitHub's page only by inserting its own note rows and its one style element, and removes them when the page moves on. It never edits, hides or moves an element GitHub made, and never touches a form field.
- A note's text is set with `textContent` inside a closed shadow root. No string from a review reaches `innerHTML`, an attribute that is interpreted (`href`, `src`, `style`, event attributes) or a selector.
- Notes are private: nothing about them is sent anywhere, and they are never posted. Posting stays the person's click in the panel (step 3).
- A selector that finds nothing is reported to the panel by name, as in step 2; notes that cannot be placed are counted and said, never silently dropped.
- Nothing from the extension review kit is copied into this repository. Its files are downloaded at review time through `gh` (reads) and cached by commit, exactly as the team kit is. Lens briefs and code checks in `packs/extensions/` are Airlock's own words and code.
- A kit named by a pack manifest must be `<owner>/<name>` in the form the engine already checks for repositories, and its file paths must be relative paths without `..`; the manifest is read from this repository's `packs/` folder, never from a pull request.

## Review Focus

1. **GitHub re-renders the diff.** Files load as the person scrolls, a file is collapsed and opened, the view switches between unified and split, a soft navigation moves to another tab of the pull request. Expected: each note is under its line once, comes back after a re-render, and is gone when the page is no longer that pull request's Files changed view. Owned by Task 4.
2. **The line is not on the page.** A finding outside the diff, a file GitHub has not loaded, a line inside folded context. Expected: no note is forced anywhere; the panel says how many notes are shown and how many are waiting for their line. Owned by Tasks 4 and 5.
3. **A page that fights back.** A pull request whose file names or code hold markup, or a page script that looks for Airlock's elements. Expected: text only, inside a closed shadow root; the page can at most remove a note, which is put back on the next change. Owned by Task 4.
4. **The newer Files changed view.** Its selectors are still unconfirmed. Expected: where they match, notes are placed; where they do not, the panel names the missing selectors and jump-to-line keeps working. Owned by Tasks 4 and 5.
5. **A kit that cannot be fetched.** No network, no access to the kit repository, a kit whose listed file was renamed. Expected: the newest cached copy is used and the document says it is stale; with none cached, the review of an extension repository fails before any model call with a sentence naming the kit; other repositories are unaffected. Owned by Task 2.

---

### Task 1: Facts before building (done by the controller)

The five extension repositories, with their default branches (all `main`), as GitHub lists them on 2026-11-11: `Moxie-Pest-Control-Phoenix/scheduling-tool-suite`, `termites-tool-suite`, `moxie-click-to-dial`, `isales-audit-tool`, `TI-route-snapshot`. The kit is `Moxie-Pest-Control-Phoenix/moxie-ext-review-kit`; the files a reviewer's judgement rests on are under `skills/ext-review/`: `standard.md`, `conventions.md`, `lens-rules.md`, `calibration.md`, `register.md`, `fieldroutes.md`. Its `SKILL.md`, `lenses.md`, `asks.md`, templates, agents and scripts are not fetched. Add these facts to `docs/reference/chrome-notes.md`'s sibling, `docs/reference/extension-kit-notes.md`, with the layout of one extension repository (its top-level files and where the manifest, the background script, content scripts and Apps Script files are), read through `gh`.

### Task 2: A pack names its kit

**Files:**
- Modify: `packages/engine/src/packs/kit-sync.ts`, `packs/load.ts`, `packs/types.ts`, `pipeline/packs.ts`, `packs/raj-standard/pack.yaml`; tests beside them

**Interfaces — Produces:**

```ts
interface KitRef { repo: string; ref?: string; files: string[]; datedStandards?: string[] }   // in pack.yaml under `kit:`
function syncKit(exec: Exec, kit: KitRef, opts?: { ref?: string }): Promise<SyncedKit>;       // cached at <home>/kit/<repo slug>/<sha>/
```

Rules: `raj-standard`'s manifest gains `kit:` with today's repository, three files and `calibration.md` as its dated standard, and behaves exactly as before (same standards attached, same hold-out handling, same helper check). The cache moves to one folder per kit repository; a copy in the old place is ignored. A pack without `kit` is untouched. The replay's `kitDir` and `kitSha` keep working for the pack whose kit they stand in for; with two kit packs selected they apply to the first and the other is synced normally. Validation as in the Global Constraints; a manifest that fails it is a pack error naming the file.

- [ ] **Step 1: Write the failing tests**

```ts
it("raj-standard attaches the same three standards as before, now from its manifest's kit", async () => {});
it('two packs with different kits are cached side by side by repository and commit', async () => {});
it('a kit repository that is not owner/name, and a file path with .. or a leading slash, are refused', async () => {});
it('when the kit cannot be fetched the newest cached copy is used and marked stale', async () => {});
it('with no cache the review fails before any model call and names the kit', async () => {});
it('only reads are made: every gh call is a GET of a commit or a file', async () => {});
it('a dated standard named by the manifest counts as recorded decisions for the challenger', async () => {});
```

- [ ] **Step 2–5:** Run (FAIL), implement, `npm run check` (PASS), commit `Let a pack's manifest name the kit it attaches`.

### Task 3: The Extensions pack

**Files:**
- Create: `packs/extensions/pack.yaml`, `packs/extensions/lenses/{security,data,office,quality}.md`, `packages/engine/src/facts/extension-checks.ts`, tests `packages/engine/test/facts/extension-checks.test.ts` and `test/packs/extensions-pack.test.ts`
- Modify: the facts stage, so a pack can name the checks it runs; `docs/guide/install.md` (which repositories use which pack)

Rules:
- The manifest: id `extensions`, title `Extensions`, the five repositories of Task 1, one stage rule (`default`, stage `other`), the kit of Task 1 with `calibration.md` as its dated standard, the four lenses, and tiers written from the layout Task 1 recorded: the manifest, background and content scripts, anything that sends data out (Apps Script receivers, fetch wrappers, configuration) are read; popups, options pages and styles are skimmed; tests, changelogs and documentation are trusted.
- The four lens briefs are written for Airlock's lenses, in the style of the existing briefs, each under 60 lines: what the lens follows across files (a permission from the manifest to the code that uses it; a value from the page it was scraped from to where it is written; an office name from configuration to every place that assumes one office; a version from the manifest to the changelog and the release), what a finding needs, and which of the attached standards it leans on. They point at the kit's files by name and quote nothing from them.
- Code checks, as facts for the lenses (none of them is a finding by itself): the manifest's permissions and host permissions before and after, with any that were added; a host permission of `<all_urls>` or a bare scheme wildcard; a changed manifest version without a changed changelog, and the reverse; `eval`, `new Function`, or a script or fetch address that is not `https`; `innerHTML`, `outerHTML` or `insertAdjacentHTML` given something other than a literal; a file over 500 kB or an archive added to the repository. Each check reads the head worktree with the engine's safe reader and never runs the extension's code.
- The pack is selected only for those five repositories; the person's Orbit pack and the team kit's pack are not.

- [ ] **Step 1: Write the failing tests**

```ts
it('the pack loads, names five repositories, four lenses and its kit, and every lens file exists', async () => {});
it('an extension repository gets extensions and generic, and an Orbit repository does not get extensions', async () => {});
it('reports a host permission added to the manifest, with the old and new lists', async () => {});
it('reports all_urls and a bare scheme wildcard', async () => {});
it('reports a version change without a changelog change, and a changelog change without a version change', async () => {});
it('reports eval, new Function and a non-https address, and not the same words inside a comment or a test file', async () => {});
it('reports innerHTML given a variable and not innerHTML given a literal', async () => {});
it('a manifest that is not valid JSON is a fact saying so, not a crash', async () => {});
it('no lens brief shares a sentence of eight words or more with a kit file (checked against a synced kit when one is cached; skipped otherwise)', async () => {});
```

- [ ] **Step 2–5:** Run (FAIL), implement, `npm run check` (PASS), commit `Add the Extensions pack on the team's extension review kit`.

### Task 4: Notes on the page

**Files:**
- Create: `packages/extension/src/page/notes.ts`, `page/note-view.ts`; tests; fixtures for both views with lazy loading
- Modify: `page/protocol.ts`, `page/selectors.ts`, `entrypoints/github.content.ts`, `e2e/jump.spec.ts` (or a new `notes.spec.ts`)

**Interfaces — Produces:**

```ts
// protocol.ts (plain validation, no zod)
type NotesMessage = { type: 'airlock:notes'; pr: { repo: string; number: number };
  notes: { id: string; anchorId: string; line: number; severity: 'block' | 'fix' | 'ask' | 'note'; title: string }[] };   // at most 60; title at most 200
type ClearNotesMessage = { type: 'airlock:notes-clear' };
type NotesReply = { placed: number; waiting: number; view: View | null; missing: string[] };
type NoteOpenMessage = { type: 'airlock:note-open'; id: string };        // content script to the extension
function createNotes(doc: Document, send: (m: NoteOpenMessage) => void): { set(m: NotesMessage): NotesReply; clear(): void; stop(): void };
```

Rules: a note is one table row inserted directly after the row of its line (found by the view's named selectors, new side), holding one cell that spans the row, holding one host element with a closed shadow root. Inside: the severity word, the title, and a button `Open in Airlock`. Colours come from GitHub's own custom properties with fixed fallbacks, so both themes read. The row carries `data-airlock-note` with the note's id and is never placed twice. A `MutationObserver` on the files container (changes batched to one pass per 200 ms, and only while notes are waiting or were removed) places waiting notes when their line appears and puts back a note GitHub's re-render removed. Notes are cleared on a clear message, on a notes message for another pull request, and when the page stops being that pull request's Files changed view (the existing soft-navigation hook). The reply counts what is placed and what is waiting and names selectors that match nothing. A message that fails validation is ignored and answered with an error the panel shows.

- [ ] **Step 1: Write the failing tests**

```ts
it('places one note row under the line in the classic view and in the newer view fixture', () => {});
it('a second message with the same notes adds nothing; a changed list adds and removes exactly the difference', () => {});
it('a note whose line is not on the page waits and is placed when the file loads', async () => {});
it('a note removed by a re-render is put back once', async () => {});
it('switching to split view keeps one note per line spanning the row', async () => {});
it('leaving the Files changed view, or a message for another pull request, removes every note', () => {});
it('a title with markup is shown as characters and nothing of it is in the page DOM outside the shadow root', () => {});
it('Open in Airlock sends the note id and nothing else', () => {});
it('61 notes, a title of 201 characters, a line of 0 and an unknown severity are refused', () => {});
it('the built content script is under 15 kB and imports no dependency', () => {});
it('no GitHub element is changed: the page without Airlock rows is identical before and after', () => {});
```

- [ ] **Step 2–5:** Run (FAIL), implement, `npm run check` and `npm run e2e` (PASS), commit `Show each finding as a private note under its line`.

### Task 5: Notes from the panel

**Files:**
- Modify: `packages/extension/src/state/machine.ts`, `state/settings.ts`, `state/jump.ts` (the shared tab messaging), `screens/Packs.tsx` (the setting), `screens/Verdict.tsx` (the notes line), `entrypoints/background.ts`; tests

Rules: when a review is on screen, the setting is on (default on) and the tab shows that pull request's Files changed view, the panel sends the notes for every open finding that has a line: not dismissed, not fixed, top five and also found alike. It sends again when the review, the dismissals, the setting or the tab's address change, and a clear message when there is no review on screen, the setting is off or the review is of an older commit (a note on a moved line would mislead). Under the verdict one line says what happened: `<n> notes shown in the diff`, `<n> shown, <m> waiting for their lines to load`, or `Notes cannot be shown on this version of GitHub's page (<missing selector names>). Jump to line still works.` A tab with no page script gets the reload sentence and button from step 2, once. `Open in Airlock` on a note opens that finding's detail in the panel; when the panel is closed the worker opens it for that tab (inside the click) and leaves the id in `chrome.storage.session` for at most 30 seconds, which the panel reads and clears as it starts. The worker still makes no network request.

- [ ] **Step 1: Write the failing tests**

```ts
it('sends notes for open findings with a line and leaves out dismissed, fixed and unanchored ones', async () => {});
it('sends again after a dismissal and after a restore', async () => {});
it('clears the notes when the setting is turned off, when the review is stale and when the panel shows no review', async () => {});
it('sends nothing to a tab that is not that pull request', async () => {});
it('shows the placed and waiting counts, and the missing selectors when the view is not recognised', async () => {});
it('a note-open message opens that finding and ignores an id that is not in the review', async () => {});
it('with the panel closed the worker opens it and the pending id is read once and expires after 30 seconds', async () => {});
```

- [ ] **Step 2–5:** Run (FAIL), implement, `npm run check` and `npm run e2e` (PASS), commit `Send the review's notes to the page and open a finding from its note`.

### Task 6: Together (done by the controller)

Extend the end-to-end flow: a review on screen puts notes on the fixture page, a dismissal removes one, `Open in Airlock` opens the finding. Run one real Standard review of a past pull request of an extension repository with the engine's command (reads only, throwaway `AIRLOCK_HOME`) and read it against what the team's review of that pull request found. Update `docs/guide/install.md`. Then the whole-branch review on the most capable model, one fix wave, one scoped re-review. The hand-over lists what only a signed-in page can show: the notes and the jump on GitHub's newer view.

## Order and lanes

Task 1, then two lanes in their own worktrees: engine and packs (2, then 3), extension (4, then 5). Task 6 after both are merged.
