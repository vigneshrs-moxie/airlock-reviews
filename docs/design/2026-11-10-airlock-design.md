# Airlock design

Date: 2026-11-10. Status: draft for Vignesh's approval. Nothing is built yet.

Airlock reviews a pull request in a panel beside the GitHub page, so that what matters is fixed at PR #1 (fork branch to organisation branch) before Raj sees PR #2 (organisation branch to staging). It works on any repository with generic rules, and switches to a much stronger Orbit mode for `moxie-portal`.

Research behind this design: `/Users/moxie/reports/AI code review extension research.md`.
Prototype of the panel: https://claude.ai/artifact/JgsShYvBE2XJeQjhX6P7Hc

## 1. What success looks like

1. On a replay of nine past pull requests where Raj found 26 problems, at least half of those problems appear in Airlock's top five for their pull request, with the rules that were written from that pull request withheld.
2. On eight pull requests Raj approved with no comment, Airlock shows at most one finding per pull request that Vignesh would call wrong.
3. A Standard review of a typical PR #1 (579 changed lines, 11 files) returns a verdict in about ten minutes. This is a target until measured.
4. After the first version is in use, every comment Raj still writes at PR #2 is counted as a miss and becomes a rule or a calibration entry.

## 2. Decisions already made

| Decision | Choice |
|---|---|
| Who uses it | Vignesh alone, on his Mac |
| Where the engine runs | Its own local service with a checkout of the repository; the Chrome extension is its screen |
| Login and billing | His Claude login through the Claude Agent SDK, as Starbase does; no API key |
| GitHub access | The `gh` login already on the Mac; no token in the browser |
| When a review starts | When he clicks Run review |
| Depth | Standard by default, Quick for small pull requests, Deep by hand |
| Orbit rules | Raj's `moxie-review-kit` loaded as it is, plus a separate pack Vignesh owns; findings from both in one ranked list, each labelled with its source |
| How many findings | Top five ranked as what Raj would most likely raise, then every other finding that held up under "Also found", then a log of dropped ones |
| Main action on a finding | Copy a fix prompt, for one finding or all selected |
| Dismissing | Wrong, Intended or Not now; Wrong and Intended are saved to his pack and used from the next review |
| GitHub writes | Nothing is written until he clicks Post; Post publishes straight away after a preview; Airlock never approves or merges |
| In the diff | A private note under the line, visible only to him (built last, see section 10) |
| Local lint, types, tests | Not run by Airlock in the first version |
| Name | Product "Airlock"; repository `airlock-reviews`, private, under `vigneshrs-moxie` |

## 3. The parts

```
Chrome extension (side panel + page script)
        |  localhost only, paired with a token
        v
Airlock service (starts at login)  ----  gh  ---->  GitHub (read; write only on Post)
        |
        v
Review engine  ---- Claude Agent SDK ---->  Claude (read-only tools)
        |
        +-- mirror clone and two worktrees per review: the PR head and its base
        +-- rule packs: Raj's standard (synced), Vignesh's pack, Generic
        +-- store: reviews, findings, dismissals, timings (~/.airlock)
        +-- replay harness: runs the engine on past pull requests and scores it
```

One repository, four packages: `shared` (the review document's types and schema), `engine`, `service`, `extension`. TypeScript on Node 24, tests with Vitest.

- **Engine** is a library with a command-line entry. It takes a repository, a pull request number and options, and returns one review document. It knows nothing about Chrome.
- **Service** is a small local server around the engine: start a review, stream its progress, serve stored reviews, record dismissals, post comments through `gh`.
- **Extension** shows what the service sends and drives the GitHub page (jump to a line, highlight it, later the private notes). It holds no keys and talks only to the service.

## 4. Reviewing connected code together (cohorts)

This is the idea Vignesh asked for by name. CodeRabbit calls it cohorts and layers: it clusters related changes into groups, orders each group in the order someone would explain the change (schema, then the logic that depends on it, then the call sites, then the screens, then the tests), and attaches summaries and findings to line ranges. Its documentation presents this mainly as a way to read a pull request; it does not say the groups drive the findings. Airlock uses the groups for both.

The reason is in Raj's own comments. His findings are mostly about connections: a control stored under one entity and enforced under another, a picker that is filtered while the save is not, a new cron that lacks what its sibling has. None of those is visible in one file. His calibration log records the same thing from the other side: on a 43,000-line pull request, a second pass with one agent per layer found two fixes and three questions that the lens pass had missed.

### 4.1 The change map

Before any lens runs, the engine builds a change map of the pull request.

1. **Links found by code, not by the model.** For every changed file the engine records what it imports, what it exports, and which exported names changed. It then searches the head worktree for uses of those names. It adds links that follow from the repository's conventions: a migration to the `schema.prisma` models it creates, a model to the files that query it, a page to its server actions, an action to its queries, a feature key to its seed and its route guard, a cron route to its entry in `vercel.json` and the middleware allowlist, a test to the file it tests. Convention links come from the active pack, so Generic mode has only imports, exports and name uses.
2. **Neighbours.** Unchanged files that call changed code, or that changed code calls, are attached as neighbours. So is the closest existing sibling of each new route, action, cron, migration or serialiser, because nine of Raj's 24 comments compare new code with its sibling.
3. **Cohorts.** A mapper agent reads the links, the pull request description and the code, and groups the changes into cohorts. A cohort is one unit of behaviour, for example "Asking for and approving a swap". Inside a cohort the files are ordered into layers in explanation order: data, rules, server writes, reads, screens, jobs, tests. Each layer names what it depends on. Changes with no clear relationship go into a "Standalone changes" group; the mapper is told not to force a grouping.
4. **A check on the mapper.** Every changed file must land in exactly one cohort or in Standalone, and every dependency the mapper states must match a link found in step 1 or be marked as the mapper's inference. The engine fails the stage and retries once if a file is missing.

### 4.2 How the change map is used

- **Lenses review a cohort, not a file.** Each lens gets the whole cohort: every changed file in it in full, its neighbours, and the layer order. Its instructions are to follow each value and each permission across the layers, from the form to the database row to the email, and to say where the chain breaks.
- **Findings can name more than one place.** A finding has one primary line and a list of connected places, each with a one-line role ("the picker is filtered here", "the save is not checked here").
- **Seams get their own pass.** After the cohort passes, one pass looks only at what crosses cohorts and at whole-pull-request questions: the claims in the description, release order, shared limits.
- **Large pull requests are split by cohort, never by size.** One pull request in ten at PR #1 is over 16,000 lines. Each cohort is reviewed in its own context, in parallel, so related files always stay together.
- **The panel reads in cohort order.** The Files tab becomes a change map: cohorts, then layers, then files, each with its tier (read, skim, trust) and its findings. Clicking a layer jumps to its first file. Every finding shows its cohort and its connected places.
- **The replay scores it.** Findings that need two files to see are counted separately, so the effect of the change map is measured.

## 5. The review pipeline

| # | Stage | What it does | Uses the model |
|---|---|---|---|
| 1 | Intake | Reads the pull request through `gh`, works out the stage from head and base, fetches into a mirror clone, creates head and base worktrees, computes the diff locally with git | No |
| 2 | Shape | Detects special shapes: a sync merge of `staging` (review only the conflict resolutions), a stacked pull request (diff against the previous head), a re-review (diff from the last reviewed commit) | No |
| 3 | Facts | Sorts files into read, skim and trust by path rules; drops lock files and generated files; runs the pack's code checks (section 6.3) | No |
| 4 | Change map | Section 4.1 | Yes, one agent |
| 5 | Brief | What the pull request does in five lines or fewer; a table of the description's claims; shown in the panel as soon as it is ready | Yes |
| 6 | Lenses | One agent per lens per cohort, in parallel; each returns at most six candidates | Yes |
| 7 | Rule sweep | For each changed file, one call that carries only the pack rules whose paths match that file | Yes |
| 8 | Anchor | Turns each candidate's quoted code into exact lines at the head commit and checks them against the diff's hunks | No |
| 9 | Challenge | One agent per Block or Fix candidate tries to refute it (section 5.2) | Yes |
| 10 | Select | Merges duplicates, ranks, picks the top five, writes the verdict | Yes, one call |
| 11 | Store | Saves the review document, timings and token use | No |

Quick depth runs stages 1 to 5 and one combined lens with no challenge stage. Deep adds a second pass per layer inside each cohort, after stage 9, as Raj's calibration entry of 30 October prescribes.

### 5.1 What a candidate must contain

A lens may only return a candidate that has all of these: the file, an exact quotation of the code at the primary line, what happens to a real person, what the code does that causes it, a suggested change, connected places, the rule or lens it came from, and what would prove it wrong. A candidate without a quotation and a concrete consequence is returned as a question, not a finding. The model's own confidence score is recorded but never used to filter, because the research found such scores close to random.

### 5.2 The challenge stage

The challenger works through a fixed list and stops at the first that holds: the code cannot be reached; the fault is already on the base branch (it reads the base worktree); it is guarded elsewhere; it is documented intent, including Vignesh's product-knowledge entries and Raj's calibration log; it is real but smaller than rated. It removes a finding only when it can state the refutation with a file and line. Doubt is not enough. "Depends on a decision" turns the finding into an Ask. Every removal is stored with its reason and shown in the Dropped log.

### 5.3 Selecting and the verdict

Selection follows Raj's standard: rank by harm to a real person or a real number, use distinct severities, no style notes. Severities are Block, Fix, Ask and Note, as his kit defines them. The verdict depends on whose pull request it is and its stage. On Vignesh's own PR #1: "Not ready", "Ready for PR #2" or "Split first". On someone else's: "Request changes", "Approve after fixes" or "Approve" as words for him to act on; Airlock itself never submits an approval.

### 5.4 Re-review after a push

Each finding gets a fingerprint from its rule or lens, its file and its quoted code with whitespace removed. On a re-review the engine diffs the last reviewed commit against the new head, reviews only the cohorts the push touched, and marks each earlier finding Fixed, Still open or Moved (the same code, now on a different line). A finding is Fixed only when its quoted code is gone and the challenger confirms the consequence no longer holds.

## 6. Rule packs

A pack is a folder: a short manifest, standard files in Markdown, rule files, code checks, and what was learned from dismissals.

### 6.1 The three packs

- **Raj's standard.** Read from `Moxie-Pest-Control-Phoenix/moxie-review-kit` through `gh` at the start of each review and cached by commit. Files used: `profile.md`, `orbit.md`, `calibration.md`, and the four lens descriptions in `SKILL.md`. Never edited by Airlock. At sync, the engine checks that each helper `orbit.md` names still exists in `moxie/main`, as that file asks, and tells the lenses which ones are gone.
- **Vignesh's pack.** Lives in this repository under `packs/orbit-mine/`. It starts with the sibling check, the rules mined from Raj's past comments, and the rules from the Orbit inventory that are not already in Raj's kit. Each rule has an id, the paths it applies to, a severity floor, the rule in one or two sentences, and where it came from.
- **Generic.** Built in. Lenses for correctness, security and permissions, and data and error handling. It reads the repository's own `CLAUDE.md`, `AGENTS.md` and similar files and treats them as rules to check against.

Which pack runs is chosen by repository, with a switch in the panel. `moxie-portal` gets Raj's standard, Vignesh's pack and Generic. Everything else gets Generic. An Extensions pack, built from the `/ext-review` rules, comes later.

### 6.2 What is learned

- A **Wrong** dismissal writes a dated line to `learned/wrong.md` in his pack: what was flagged and why it was wrong.
- An **Intended** dismissal writes a dated line to `learned/product-knowledge.md`: the product fact the model did not know.
- Both are given to the lenses and to the challenger from the next review. Both are plain files in git, so every entry can be read, edited and undone.
- **Not now** hides the finding on that pull request only and writes nothing.

### 6.3 Code checks in the Orbit pack

These run in stage 3 without the model and feed the lenses as facts: a migration without a matching `schema.prisma` edit; a `FEATURES` key without a seeding migration, or a seed that is not limited to Arizona Operations; a new cron route missing from `vercel.json` or the middleware allowlist, or without `maxDuration`; `$queryRawUnsafe` outside tests; a literal `'all'` in a scope check; an edit to a guard test's allowlist. Migration numbering is left to CI, as Raj's calibration log asks.

## 7. Safety

- **Read-only by construction.** Review agents get only Read, Grep and Glob, limited to the two worktrees and the pack folders. No shell, no network, no writes.
- **The pull request cannot rewrite the rules.** Rule files are read from the base branch, never from the head. Everything from the pull request (title, description, code, comments) is given to the model as material to review, marked as such.
- **Nothing leaves without a click.** The only GitHub writes are the comments he posts, through `gh`, after seeing the exact text.
- **The service listens on this Mac only**, on one fixed port, and answers only the paired extension.
- **Worktrees are Airlock's own.** It never touches his working checkouts under `~/Projects`.

## 8. The service and the extension

The service keeps a small set of routes: start a review; stream its progress; fetch the latest review for a pull request; dismiss a finding; preview and post comments; list and undo learned entries; report its own status. Progress is streamed, so the brief and the change map appear while findings are still being challenged.

The extension is a Manifest V3 side panel built with WXT. A page script handles jump-to-line and the highlight on both versions of GitHub's Files changed page. The private notes under the line come last, because they depend on GitHub's page structure, which changed in January 2026 and has no stable contract.

## 9. Testing

- **Unit tests** for everything that does not use the model: the diff parser, the link finder, the change map check, anchoring, fingerprints, rule matching, selection limits.
- **The replay** is the acceptance test. It runs the engine at the commit Raj first reviewed, compares Airlock's findings with his comments using a judge that answers one question ("is this the same underlying problem?"), and reports per stage which known problems survived mapping, lenses, challenge and selection.
- **Held out by pull request.** When replaying a pull request, the rules and calibration entries written from it are withheld. Without this the replay would only measure memory.
- **Models.** The replay runs once with Fable 5.2 and once with Opus 5.5 on the lenses and the challenger, and records catch rate, wrong findings, time and token use for each.

## 10. Build order

1. **Engine and replay, in a terminal.** Stages 1 to 11, the three packs, the replay harness and its report. Done when the replay meets criteria 1 and 2 in section 1, or shows plainly why it does not.
2. **Service and side panel.** The brief, the change map, findings, jump-to-line, the fix prompt, dismissals.
3. **Posting, re-review after a push, learning from dismissals shown under Packs.**
4. **Private notes in the diff, and the Extensions pack.**

Each step gets its own build plan when it starts. Step 1's plan is written first, and the later plans will use what the replay shows.

## 11. To test early, because the research could not confirm them

- The selectors for GitHub's newer Files changed view, on a signed-in page.
- Whether an author can post a review with inline comments on their own pull request, and how a comment on a line outside the diff is refused.
- Whether Chrome lets the side panel call a local address without a prompt.
- The Agent SDK's option names for read-only tools and structured output on the installed version.
- Real time and token use per stage, from the first replay runs.

## 12. Not in the first version

Running lint, type-check or tests. Starting a review automatically. Sending a fix to Starbase. Use by anyone else. A hosted version.
