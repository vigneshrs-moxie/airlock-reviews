# Airlock Step 3: Posting, Re-review after a Push, Merge Reviews and Learned Lines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the side panel the person can post chosen findings to the pull request as one GitHub review after seeing the exact text; review only what a push changed and see which earlier findings are fixed, still open or moved; get a review of a merge's hand-made conflict resolutions; and see and remove learned lines under Packs. The pairing token is hardened first, because from this step it can cause a GitHub write.

**Architecture:** The engine gains three things: the line of each finding that GitHub accepts a comment on, a re-review mode that continues from a stored review, and a merge mode that diffs the committed merge against the merge git makes by itself. The service gains a two-step post (a preview the service stores, then a post that sends exactly that preview through `gh`), post records, a learned-lines list with removal, and a proof that it holds the token. The panel gains the post sheet, the re-review screens and the learned list. The contract for all of it is added to `@airlock/shared` first so three lanes can build in parallel.

**Tech Stack:** As steps 1 and 2 (Node 24 ESM, TypeScript, zod 4, `node:http`, Vitest, WXT with React 19, Playwright). Git 2.38 or later for `git merge-tree --write-tree` (this Mac has 2.50.1). WebCrypto in the panel for the proof.

**Spec:** `docs/design/2026-11-10-airlock-design.md` (sections 2, 5 stage 2, 5.4, 6.2, 7, 8, 10 step 3, 11). Facts about GitHub's API and what could not be confirmed without posting: `docs/reference/github-post-notes.md` (Task 1). Picks made on the prototype: Post publishes straight away after a preview (no draft review).

## Global Constraints

- Everything in the constraints of steps 1 and 2 still holds, except the one sentence this step replaces: step 2's "nothing writes to GitHub" becomes the next four lines.
- **One GitHub write exists in the whole repository:** `gh api --method POST repos/<repo>/pulls/<number>/reviews --input -`, made by one function, `sendReview` in `packages/service/src/posts/github.ts`, with `event` the literal `'COMMENT'`. No code can send `APPROVE` or `REQUEST_CHANGES`, leave a pending review, edit, delete or resolve anything, merge, close or label. A test fails if any other file passes `--method`, `-X`, `-f` or `-F` to `gh`, or if `sendReview`'s payload can carry another event.
- **That call is made only inside `POST /posts`, only for a preview the service itself stored in the last 10 minutes,** and what is sent is that stored preview, byte for byte. The request to post carries a preview id and nothing else.
- **No test, implementer or controller posts to a real pull request.** `gh` is a fake exec, or a fake `gh` executable on a temporary PATH. The first real post is the person's own click after the build.
- **Nothing is retried.** A post whose outcome is not known is recorded as unknown and the person is told to look at the pull request.
- The two post routes and the learned-removal route require an `Origin` header that equals the paired origin (present, not merely "when present").
- Text built from a finding passes through `visibleText` and has every `@name` put in backticks, so a comment drafted from pull request text notifies no one unless the person removes the backticks. Text the person typed is refused, not cleaned, when it holds hidden characters. A comment and the summary are each at most 4,000 characters; a post holds at most 30 comments.
- A finding is marked Fixed only by the rules of Task 4: never because a model said so without a quoted line that code found at the head commit.
- The trust line holds in the new prompts: everything from the pull request and everything a model wrote reaches a model only as material.
- The panel renders every string as text. The only links are GitHub addresses built by code, or a posted review's address that the contract's schema accepted for this repository and pull request.

## Review Focus

1. **Posting twice.** Two clicks, two panels on the same pull request, a second try after a timeout. Expected: one review on GitHub; a finding already posted on this pull request (under its fingerprint or any alias) is shown as Posted and is refused by the preview; an unknown outcome blocks those findings until the person says it was not posted. Owned by Task 6.
2. **The pull request moved between the review and the post.** New commits, or it was closed or merged. Expected: refused with a sentence, nothing sent. Owned by Task 6.
3. **GitHub says no.** A line that is not part of the diff (422), no permission (403), a secondary rate limit, a cut connection. Expected: for a refusal, nothing was posted (one call, one review) and GitHub's reason is shown with the texts kept; for a cut connection, "could not tell", never a second attempt. Owned by Tasks 6 and 9.
4. **History was rewritten, or the base was merged in, before a re-review.** Expected: everything is reviewed again and the document says why; earlier findings are still recognised. Owned by Task 4.
5. **The quoted code is gone but the problem is not.** The author moved the faulty line to another file. Expected: not Fixed; Still open or Moved with its new place. Owned by Task 4.

---

## File structure

```
docs/reference/github-post-notes.md         what GitHub's API accepts; what stays unconfirmed until the first real post
packages/shared/src/comment-text.ts         commentBody, summaryBody, checkCommentText, mentionsIn (no zod)
packages/shared/src/api.ts                  post, learned and proof schemas; additions to PrSummary, StartReviewBody, LatestReply, Hello
packages/shared/src/review.ts               Anchor.comment, ReviewDocument.fixed, ReviewDocument.previous
packages/engine/src/anchor/comment-line.ts  the line a GitHub comment can sit on
packages/engine/src/rereview/range.ts       which range a re-review covers, and why
packages/engine/src/rereview/carry.ts       earlier findings: still open, moved, vanished
packages/engine/src/rereview/fixed.ts       the check that a vanished finding is fixed
packages/engine/prompts/fixed-check.md
packages/engine/src/shape/merge-range.ts    the mechanical merge and the range against it
packages/service/src/posts/preview.ts       building and holding previews
packages/service/src/posts/github.ts        sendReview: the one write
packages/service/src/posts/records.ts       post records per pull request
packages/service/src/learned.ts             list and remove learned lines
packages/service/src/proof.ts               the hello proof
packages/extension/src/client/proof.ts      checking the proof before the token is sent
packages/extension/src/screens/PostSheet.tsx, PostedMark.tsx, FixedList.tsx, LearnedList.tsx
```

---

### Task 1: Facts before building (done by the controller on 2026-11-11; results in `docs/reference/github-post-notes.md`)

Write `docs/reference/github-post-notes.md`: the request body of "Create a review for a pull request" as GitHub documents it (`commit_id`, `body`, `event`, `comments[]` with `path`, `line`, `side`, `start_line`, `start_side`, `body`), its status codes, that it sends notifications and is subject to secondary rate limits, and how `gh api` reports an HTTP error (exit code, where the status and the JSON body go), measured with a read that is known to fail (a `GET` of a pull request number that does not exist). List what cannot be confirmed without posting and is therefore handled as a refusal at run time: whether an author may submit a `COMMENT` review on their own pull request, and the exact wording of the refusal for a line outside the diff. Confirm on this Mac, in a throwaway repository made by the script, that `git merge-tree --write-tree` gives a tree with conflict markers and exit code 1 for a conflicting merge and exit code 0 for a clean one, and that `git commit-tree` with fixed author, committer and dates gives the same commit id twice.

### Task 2: The contract

**Files:**
- Modify: `packages/shared/src/review.ts`, `api.ts`, `index.ts`; `packages/engine/src/pipeline/review.ts` (one inert optional field); `packages/extension/e2e/fake-service.ts` (accept and ignore the new fields)
- Create: `packages/shared/src/comment-text.ts`; tests beside the existing ones

**Interfaces — Produces:**

```ts
// review.ts (all optional, so stored reviews still parse)
AnchorSchema:          comment?: { line: number; startLine: number | null } | null
ReviewDocumentSchema:  fixed?: Finding[]                                  // earlier findings a re-review found fixed; never in the verdict or the lists
                       previous?: { reviewId: string; headSha: string }   // the review this one continues

// engine ReviewRequest
since?: { reviewId: string }

// comment-text.ts
const COMMENT_MAX = 4000, SUMMARY_MAX = 4000, POST_MAX_ITEMS = 30, REVIEW_BODY_MAX = 60000;
function commentBody(f: Finding): string;
function summaryBody(inlineCount: number, inSummary: { path: string; line: number | null; body: string }[], summary: string): string;
function checkCommentText(text: string, max?: number): string | null;   // null when it can be posted, else one sentence
function mentionsIn(text: string): string[];                            // @names outside code spans and fences
function quietMentions(text: string): string;                           // every @name outside code put in backticks

// api.ts
PreviewIdSchema  /^pv_[0-9a-f]{16}$/        PostIdSchema  /^post_[0-9a-f]{12}$/
PostItemSchema          { fingerprint, body?: string, placement?: 'inline' | 'summary' }
PostPreviewBodySchema   { repo, number, reviewId, items: PostItem[] (1..30, distinct fingerprints), summary?: string }
PostPreviewItemSchema   { fingerprint, title, path, line: number | null, startLine: number | null,
                          placement: 'inline' | 'summary', whySummary: string | null, body: string, mentions: string[] }
PostPreviewReplySchema  { previewId, headSha, viewer: string, items: PostPreviewItem[], summary: string, reviewBody: string, expiresAt: string }
PostBodySchema          { previewId }
PostRecordSchema        { id, repo, number, reviewId, headSha, postedAt: string, outcome: 'posted' | 'unknown',
                          githubReviewId: number | null, url: string | null,
                          items: { fingerprint, aliases: string[], placement: 'inline' | 'summary' }[] }
ForgetPostBodySchema    { repo, number, id }
LatestReplySchema       gains posts: PostRecord[] (default [])
PrSummarySchema         gains state: 'open' | 'closed' | 'merged' (default 'open'),
                              lastReview: { reviewId, headSha, createdAt, depth } | null (default null)
StartReviewBodySchema   gains since?: 'last'
HelloSchema             gains proof?: string (64 hex)
LearnedLineSchema       { pack: PackId, packTitle, kind: 'wrong' | 'product-knowledge', date, repo: string | null, text,
                          key: Fingerprint, appliesHere: boolean, removable: boolean }
LearnedReplySchema      { lines: LearnedLine[], cap: number }
RemoveLearnedBodySchema { repo, pack: PackId, kind, key }
RemoveLearnedReplySchema { removed: boolean, note: string | null }
```

Rules: `PostRecord.url`, when not null, must match `https://github.com/<repo>/pull/<number>#pullrequestreview-<digits>` for the record's own repository and number (a `superRefine`). `commentBody` is, in this order and with empty parts left out: a first line `**<severity word>: <title>**`; what happens; why; `Suggested change: <text>`; `Connected: ` followed by each connected place as `` `<path>:<line>` (<role>) ``. Every part goes through `visibleText` and `quietMentions`; a part that holds a line starting with a code fence is kept as text by fencing it with a longer fence, as the fix prompt's `fenced` does. `summaryBody` is the summary, then, when some comments are placed in the summary, a heading line `Not on a changed line:` and each of them under `` `<path>:<line>` `` (or the path alone). `checkCommentText` refuses: only white space; over the maximum (it says by how many characters); any character `visibleText` would drop.

- [ ] **Step 1: Write the failing tests**

```ts
it('a stored review without comment, fixed or previous still parses', () => {});
it('commentBody gives the severity word and title first and leaves out empty parts', () => {});
it('commentBody puts @names from a finding in backticks and leaves an @ inside a code span alone', () => {});
it('commentBody drops hidden characters and keeps a fenced quote fenced', () => {});
it('checkCommentText refuses empty text, 4,001 characters and a zero-width space, each with its sentence', () => {});
it('mentionsIn finds @a and @org/team outside code and none inside a fence', () => {});
it('a post record address for another repository or pull request is refused by the schema', () => {});
it('a preview body with two items of one fingerprint, or 31 items, is refused', () => {});
it('LatestReply without posts and PrSummary without state parse with their defaults', () => {});
```

- [ ] **Step 2–5:** Run (FAIL), implement, `npm run check` and `npm run e2e` (PASS), commit `Add the contract for posting, re-review and learned lines`.

### Task 3: The line a comment can sit on

**Files:**
- Create: `packages/engine/src/anchor/comment-line.ts`, `test/anchor/comment-line.test.ts`
- Modify: the anchor stage, so every finding and candidate it anchors carries `anchor.comment`

**Interfaces — Produces:** `function commentLine(file: FileDiff | undefined, startLine: number | null, endLine: number | null): { line: number; startLine: number | null } | null`

Rules: only the new side counts (added and context lines of the file's hunks, by their new line numbers). `line` is the last line of the anchored range that is such a line; `null` when none is, when the file is binary, deleted or has no hunks, or when the range is null. `startLine` is the first line of the range when it differs from `line` and every line from it to `line` lies in the same hunk; otherwise `null`.

- [ ] **Step 1: Write the failing tests**

```ts
it('a range inside one hunk gives its last line and its first line', () => {});
it('a single line gives that line and no start line', () => {});
it('a range that runs past the end of a hunk gives the last line inside it and no start line', () => {});
it('a range spanning two hunks gives the last in-hunk line and no start line', () => {});
it('a context line counts, a deleted line does not', () => {});
it('outside every hunk, a binary file, a deleted file and an unanchored finding give null', () => {});
it('the pipeline document carries anchor.comment on every finding', async () => {});
```

- [ ] **Step 2–5:** Run (FAIL), implement, `npm run check` (PASS), commit `Record the line of each finding that GitHub accepts a comment on`.

### Task 4: Re-review after a push

**Files:**
- Create: `packages/engine/src/rereview/range.ts`, `carry.ts`, `fixed.ts`, `packages/engine/prompts/fixed-check.md`, tests under `test/rereview/`
- Modify: `pipeline/review.ts`, `intake/workspace.ts`, the select stage's input, `render/terminal.ts`, `cli-args.ts` and `cli.ts` (`--since last|<review id>`)

**Interfaces — Produces:**

```ts
type RereviewPlan =
  | { kind: 'push'; baseSha: string; headSha: string }                       // only what was pushed
  | { kind: 'everything'; reason: 'rewritten' | 'base-merged-in' }           // the whole pull request again
function planRereview(exec: Exec, mirror: string, prev: ReviewDocument, pr: PrInfo): Promise<RereviewPlan>;
function carryOver(prev: ReviewDocument, files: FileDiff[], read: (path: string) => Promise<string | null>):
  Promise<{ open: Finding[]; vanished: Finding[] }>;
function confirmFixed(runner: AgentRunner, ctx: LensContext, vanished: Finding[]):
  Promise<{ fixed: Finding[]; open: Finding[]; errors: StageError[] }>;
```

Rules:
- `since` must name a stored review of the same repository and number; otherwise the review fails before any model call with `There is no stored review <id> of this pull request.` When the pull request's head is that review's head it fails with `Nothing was pushed since the last review.`
- **Range.** When the earlier head is an ancestor of the new head and no commit pushed since is a merge that brings the base branch in, the range is the earlier head to the new head, `kind: 'rereview'`. When the earlier head is not an ancestor (`rewritten`) or such a merge was pushed (`base-merged-in`; but see Task 5 for a push that is exactly one such merge), the whole pull request is reviewed as on a first review and `document.notes` says which and why in one sentence. `document.previous` is set in every case.
- **Earlier findings, by code.** Each finding of the earlier review is looked for at the new head by its quote, with the anchoring function the anchor stage uses, in its file or in the file it was renamed to: found on the same lines, `still-open`; found on other lines, `moved` with the new anchor and comment line; not found, vanished. The earlier review's `fixed` list is not carried.
- **A finding raised again is the same finding.** A new finding whose fingerprint or alias equals the fingerprint or an alias of a carried one is dropped at stage `merge` with `mergedInto` the carried one, which gains its fingerprint as an alias.
- **Vanished findings.** For each vanished `block` or `fix` finding, one request (role `challenge`, read tools on both worktrees, at every depth) answers `fixed` with a quoted line at the head that now prevents the consequence, or `still-open` with the path and a quote of where the problem now is. `fixed` is accepted only when code finds that quote at the head; the finding then goes to `document.fixed` with status `fixed` and the reason in `checked`. `still-open` whose quote code finds becomes `moved` with the new anchor, its old fingerprint kept as an alias. Anything else (a quote not found, a failed request) leaves the finding `still-open` with anchor status `not-found` and adds a stage error; it is never fixed. A vanished `ask` or `note` finding goes to `fixed` with `checked` saying `The quoted code is gone; not checked further.`
- **Together.** New findings have status `new`. Carried open findings join them before selection, so the top five and the verdict are over everything still open; `fixed` findings are in neither. The self-review text and the terminal output show each finding's status and a `Fixed since the last review` section.
- When a first review is asked for (no `since`), nothing changes and every status stays `null`.

- [ ] **Step 1: Write the failing tests**

```ts
it('plans a push range when the earlier head is an ancestor', async () => {});
it('plans everything, rewritten, when the earlier head is no longer in the branch', async () => {});
it('plans everything, base-merged-in, when a pushed commit merges the base branch', async () => {});
it('fails before any model call for an unknown review id and for an unchanged head', async () => {});
it('a quote on the same lines is still open, on other lines moved, in a renamed file moved', async () => {});
it('a new finding with a carried fingerprint or alias is merged into the carried one', async () => {});
it('a vanished fix finding is fixed only when the quoted evidence is found at the head', async () => {});
it('a vanished finding the check places elsewhere becomes moved and keeps its old fingerprint as an alias', async () => {});
it('a failed check leaves the finding open, adds a stage error and never marks it fixed', async () => {});
it('a vanished note is fixed without a request and says it was not checked further', async () => {});
it('the verdict counts carried open findings and ignores fixed ones', async () => {});
it('the fixed check runs at quick depth', async () => {});
it('nothing from the pull request is outside a material block in the fixed-check request', async () => {});
it('a review without since is unchanged: no previous, no fixed, every status null', async () => {});
```

- [ ] **Step 2–5:** Run (FAIL), implement, `npm run check` (PASS), commit `Review only what was pushed and say what became of the earlier findings`.

### Task 5: A merge's conflict resolutions

**Files:**
- Create: `packages/engine/src/shape/merge-range.ts`, `test/shape/merge-range.test.ts` (real git in a temporary repository)
- Modify: `pipeline/review.ts` (the sync-merge path), the brief and lens material (one shape note), `rereview/range.ts`

**Interfaces — Produces:**

```ts
type MergeRange =
  | { kind: 'by-hand'; baseSha: string; headSha: string; files: number }   // baseSha is the mechanical merge, as a commit in the mirror
  | { kind: 'nothing-by-hand' }
  | { kind: 'unsupported'; reason: string };
function mergeRange(exec: Exec, mirror: string, range: ReviewRange): Promise<MergeRange>;
```

Rules: applies where the range is a sync merge today (every commit in it is a merge). With exactly one merge commit of exactly two parents, the engine makes the merge git would make by itself (`git merge-tree --write-tree --no-messages` of the two parents; the tree's id is the first line of its output, and exit code 0 or 1 is an answer only when that line is the id of a tree, because a bad argument also exits 1) and compares its tree with the committed merge's tree. Equal: `nothing-by-hand`; the document's brief says `This pull request only merges <base> into the branch. Git merged it without conflicts and nothing was changed by hand.`, no lens runs, there is no stage error, and the verdict is the stage's clean one. Different: the mechanical tree is committed in the mirror with `git commit-tree` (first parent as its parent, fixed author, committer and dates, no ref), and the review runs on that commit to the merge commit with `kind: 'sync-merge'`. Every model stage is told once, as a fixed instruction sentence with the branch names as material: the base side is what git produced by itself, with conflict markers where it could not decide; the head side is what was committed; review whether each resolution keeps what both sides intended, and treat anything else changed by hand as a change to review. Any other shape (several merges, an octopus merge) is `unsupported` and keeps today's stage error and `incomplete`, with the reason. A re-review whose pushed commits are exactly one merge of the base branch uses this range instead of reviewing everything.

- [ ] **Step 1: Write the failing tests**

```ts
it('a clean merge with nothing changed by hand reviews nothing and is not incomplete', async () => {});
it('a conflict resolved by hand gives a range whose diff is only the resolution', async () => {});
it('a line changed by hand in a file without conflict is in the range', async () => {});
it('the mechanical commit has the same id on a second run and no ref points at it', async () => {});
it('two merges in the range, and an octopus merge, stay incomplete with the reason', async () => {});
it('the shape sentence reaches the brief and every lens request, with branch names only as material', async () => {});
it('a re-review whose push is one merge of the base reviews its resolutions and carries the earlier findings', async () => {});
```

- [ ] **Step 2–5:** Run (FAIL), implement, `npm run check` (PASS), commit `Review what was changed by hand in a merge`.

### Task 6: Posting through the service

**Files:**
- Create: `packages/service/src/posts/preview.ts`, `github.ts`, `records.ts`; tests `test/posts/*.test.ts`, including one that runs a fake `gh` executable
- Modify: `routes.ts`, `http.ts` (a route may require an Origin), the route-table test

**Interfaces — Produces:**

```ts
function buildPreview(deps, body: PostPreviewBody): Promise<PostPreviewReply>;     // stores it; 10 minutes; at most 20 kept
function sendReview(exec: Exec, repo: string, number: number,
  payload: { commit_id: string; event: 'COMMENT'; body: string; comments: { path: string; line: number; side: 'RIGHT'; start_line?: number; start_side?: 'RIGHT'; body: string }[] }):
  Promise<{ kind: 'posted'; id: number; url: string } | { kind: 'refused'; status: number; message: string } | { kind: 'unknown'; message: string }>;
function postsFor(home: string, repo: string, number: number): Promise<PostRecord[]>;
```

Routes: `POST /posts/preview` `PostPreviewBody` → `PostPreviewReply`; `POST /posts` `PostBody` → `PostRecord`; `POST /posts/forget` `ForgetPostBody` → `{ forgotten: boolean }`; `GET /reviews/latest` gains `posts`.

Rules:
- **Preview.** The review must be stored and be for that repository and number (404). Each fingerprint must be a finding of it, under its fingerprint or an alias, that is not in `fixed` (404), not dismissed (409) and not in a post record of this pull request, posted or unknown (409, naming the title). A comment is inline when the finding has `anchor.comment` and the item did not ask for the summary; otherwise it is in the summary and `whySummary` says why (`The line is not part of the diff GitHub shows.` or `You chose the summary.`). The body is the item's own text when given (refused with `checkCommentText`'s sentence) or `commentBody(finding)`. The summary is the given one (checked the same way) or `Review notes from Airlock: <n> comments.` `reviewBody` is `summaryBody(...)` and must fit `REVIEW_BODY_MAX`. `viewer` is the stored review's.
- **Post.** In one queue per pull request: take the preview (404 `This preview has expired. Open the preview again.`); read the pull request through `gh` (a read): it must be open (409) and its head must be the preview's head (409 `The pull request has new commits since this review. Review the push, then post.`); check again that none of its findings has a record; write the record with outcome `unknown`; call `sendReview` once. Posted: the record becomes `posted` with GitHub's id and address. Refused (GitHub answered with a status): the record is removed, the preview is kept for another 10 minutes, and the reply is that status mapped to 502 with `GitHub refused the comments: <its message>. Nothing was posted.` Unknown (a timeout, no status): the record stays `unknown` and the reply is 504 `Airlock could not tell whether GitHub accepted the comments. Look at the pull request before posting again.`
- **Forget** removes a record only when its outcome is `unknown`.
- `sendReview` passes the payload as JSON on standard input, never as arguments; reads GitHub's reply with a schema; and takes the status and message of a refusal from `gh`'s output as Task 1 recorded it, cleaned with `visibleText` and cut to 300 characters.
- The log gets one line per post: repository, number, how many comments and the outcome. Never a comment's text.

- [ ] **Step 1: Write the failing tests**

```ts
it('the preview places a finding inline at its comment line and one without a comment line in the summary, saying why', async () => {});
it('the preview uses the edited text and refuses hidden characters, empty text and 4,001 characters', async () => {});
it('the preview refuses a finding that is dismissed, fixed, unknown to the review, or already posted under an alias', async () => {});
it('post sends exactly the stored preview: commit, COMMENT, body and comments, as JSON on standard input', async () => {});
it('post is refused when the head moved, and when the pull request is closed or merged, without calling GitHub', async () => {});
it('two posts of one preview at once send one review', async () => {});
it('a refusal by GitHub removes the record, keeps the preview and says nothing was posted', async () => {});
it('a timeout leaves an unknown record, blocks those findings, and is never retried', async () => {});
it('forget removes an unknown record and refuses a posted one', async () => {});
it('an expired preview and an unknown preview id are refused', async () => {});
it('the post routes refuse a request without an Origin header even with the token', async () => {});
it('no file but posts/github.ts gives gh a write flag, and its event can only be COMMENT', async () => {});
it('with a fake gh on the PATH, the real exec sends the documented arguments and body', async () => {});
it('the log line of a post holds no comment text', async () => {});
```

- [ ] **Step 2–5:** Run (FAIL), implement, `npm run check` (PASS), commit `Post chosen findings as one review, after a stored preview`.

### Task 7: Re-review and learned lines through the service

**Files:**
- Create: `packages/service/src/learned.ts`, `test/learned.test.ts`
- Modify: `routes.ts`, `dismissals.ts` (the cap), `runs.ts` (a re-review is its own run key), tests

Routes: `GET /pr` gains `state` and `lastReview`; `POST /reviews` accepts `since: 'last'`; `GET /learned?repo=` → `LearnedReply`; `POST /learned/remove` `RemoveLearnedBody` → `RemoveLearnedReply`.

Rules: `since: 'last'` uses the newest stored review of that pull request: none is 409 `There is no earlier review of this pull request.`; when `/pr`'s head is its head, 409 `Nothing was pushed since the last review.`; otherwise the engine is given `since` with that review's id, and its depth and packs unless the body names others. `/learned` lists the learned lines of every pack chosen for the repository, newest first, each with whether it applies to this repository (the Generic rule from step 2's fix round) and whether it can be removed (never a line of the team kit). Removal runs in the dismissals queue, removes exactly the line whose key matches, and clears the learned link of a dismissal that wrote it (the finding stays dismissed); a line no longer there gives `removed: false` and a note. A dismissal that would write line 301 of one kind into one pack is refused with 409 `<pack title> already holds 300 learned lines of this kind. Remove some under Packs first.`

- [ ] **Step 1: Write the failing tests**

```ts
it('/pr reports the state and the last stored review, or null', async () => {});
it('since last starts the engine with that review id, depth and packs', async () => {});
it('since last is refused with no earlier review and with an unchanged head', async () => {});
it('/learned lists lines of the chosen packs with appliesHere and removable', async () => {});
it('remove deletes exactly the keyed line and clears the dismissal link, leaving the finding dismissed', async () => {});
it('remove of a line edited by hand says so and changes nothing', async () => {});
it('a kit line cannot be removed', async () => {});
it('the 301st line of a kind is refused and nothing is written', async () => {});
```

- [ ] **Step 2–5:** Run (FAIL), implement, `npm run check` (PASS), commit `Start a re-review and list and remove learned lines through the service`.

### Task 8: The token, before it can post

**Files:**
- Create: `packages/service/src/proof.ts`, `packages/extension/src/client/proof.ts`, tests
- Modify: `packages/service/src/http.ts`, `config.ts`, `cli.ts` (`token --new`, `status`), `packages/extension/src/client/service.ts`, `state/machine.ts`, `e2e/fake-service.ts`, `docs/guide/install.md`

Rules:
- `GET /hello?nonce=<32 hex>` adds `proof`: the HMAC-SHA256, in hex, of `airlock-hello:<nonce>` keyed with the token's characters. Without a nonce the reply is as before. A malformed nonce is 400.
- The panel never sends the token to an address that has not just proved it holds it: before the first request with the token after the panel opens, after any network failure or 401, and on every periodic check, it asks `hello` with a fresh random nonce and checks the proof with its stored token. On the Pair screen it checks with the pasted token before calling `/pair`. A wrong or missing proof shows `Something else is answering on Airlock's port. The token was not sent.` and sends nothing.
- `status` makes the same check before sending the token.
- `npm run service -- token --new` replaces the token file (0600, written whole) and prints the new token once. A running service that fails a token comparison re-reads the file, at most once a second, and compares again, so the old token stops working without a restart. The paired origin is kept. The panel then shows Pair.
- The install guide gains a short section on replacing the token.

- [ ] **Step 1: Write the failing tests**

```ts
it('hello with a nonce returns the proof for the token and without one returns none', async () => {});
it('the client sends no Authorization header until a proof has matched', async () => {});
it('a wrong proof shows the sentence and the token never leaves the panel', async () => {});
it('pairing checks the pasted token against the proof before calling pair', async () => {});
it('status does not send the token to a port that cannot prove it', async () => {});
it('token --new makes the old token fail and the new one work without a restart', async () => {});
it('a flood of wrong tokens re-reads the file at most once a second', async () => {});
```

- [ ] **Step 2–5:** Run (FAIL), implement, `npm run check` and `npm run e2e` (PASS), commit `Prove the service holds the token before the panel sends it, and replace a token`.

### Task 9: Posting from the panel

**Files:**
- Create: `packages/extension/src/screens/PostSheet.tsx`, `PostedMark.tsx`, tests
- Modify: `FindingDetail.tsx`, `Verdict.tsx`, `PanelScreen.tsx` (the sheet's draft is held there, like the dismiss sheet's), `client/service.ts`, `state/reduce.ts`, `state/machine.ts`

Rules:
- A finding's detail has `Post comment`; the selection bar has `Post selected (<n>)`. Both are disabled, with the reason beside them, when the review is of an older commit, the pull request is closed or merged, the panel is offline, or (for one finding) it is already posted. A posted finding shows `Posted` and `Open on GitHub`; one in an unknown record shows `Not known whether this was posted`.
- The sheet opens with the service's preview. It shows who it posts as and where (`<repo>#<number>`), then each comment: where it goes (`On <path>, line <n>` or `In the summary: <whySummary>`), its text in an editable field with a character count and `checkCommentText`'s sentence when it fails, a `Put in the summary instead` choice for inline ones, and `Mentions <names>: they will be notified.` when the text mentions someone. Then the summary field, and the fixed sentence `Airlock posts these as one review with the Comment action. It never approves or requests changes.`
- After any edit the main button reads `Update preview` and asks the service for a new preview with the texts as typed; only an unedited preview shows `Post <n> comments to GitHub`. So what is posted is always what the service last showed.
- Posted: the sheet shows `Posted <n> comments.` with `Open on GitHub`, and the findings are marked. Refused: the service's sentence is shown and every text is kept. Unknown: the sentence, with `Open the pull request` and `It was not posted` (which forgets the record).
- The draft survives going offline and coming back; the sheet cannot be closed while a post is in flight; a second press while one is in flight does nothing.
- Every string is rendered as text. `Open on GitHub` uses only the record's address, which the contract accepted.

- [ ] **Step 1: Write the failing tests**

```ts
it('Post comment opens the sheet with the service preview for that finding', async () => {});
it('Post selected sends the ticked findings and skips posted ones', async () => {});
it('an edit turns the button into Update preview and Post is not offered until the preview is fresh', async () => {});
it('the text sent for preview is exactly the field value', async () => {});
it('a mention shows the notice with the names', async () => {});
it('a refusal keeps every text and shows the sentence', async () => {});
it('an unknown outcome offers It was not posted, which forgets the record', async () => {});
it('posting is disabled with its reason on a stale review, a closed pull request and offline', async () => {});
it('a second press during a post sends nothing and the sheet cannot be closed', async () => {});
it('markup in a comment text or a title is shown as characters', async () => {});
```

- [ ] **Step 2–5:** Run (FAIL), implement, `npm run check` (PASS), commit `Post findings from the panel after a preview`.

### Task 10: Re-review in the panel

**Files:**
- Create: `packages/extension/src/screens/FixedList.tsx`, tests
- Modify: `Verdict.tsx`, `FindingCard.tsx`, `BriefBlock.tsx`, `Ready.tsx`, `state/machine.ts`, `client/service.ts`

Rules: when the pull request's head is not the head of the review on screen, the banner reads `New commits since this review.` with `Review the push` (starts a review with `since: 'last'`) and `Review everything again`. A document with `previous` shows one line under the verdict, `Review of the push <short earlier head> to <short head>`, or the note that says why everything was reviewed again; each finding card shows `New`, `Still open` or `Moved`; a collapsed section `Fixed since the last review (<n>)` lists `document.fixed` with each one's title, path and the reason it counts as fixed. Fixed findings cannot be ticked, posted or dismissed. Posted marks and dismissals follow a finding across reviews by its fingerprint and aliases. A merge review's brief has the heading `A merge of <base>: only what was changed by hand was reviewed`. `document.notes` is shown under the verdict when present.

- [ ] **Step 1: Write the failing tests**

```ts
it('a moved head shows the banner with both buttons, and Review the push starts with since last', async () => {});
it('a re-review document shows the push line and a status on every card', async () => {});
it('fixed findings are listed collapsed with their reason and offer no actions', async () => {});
it('a posted finding stays marked in the next review under an alias', async () => {});
it('the everything-again note is shown when the branch was rewritten', async () => {});
it('a merge review shows its heading', async () => {});
```

- [ ] **Step 2–5:** Run (FAIL), implement, `npm run check` (PASS), commit `Show a re-review: what is new, still open, moved and fixed`.

### Task 11: Learned lines under Packs

**Files:**
- Create: `packages/extension/src/screens/LearnedList.tsx`, tests
- Modify: `Packs.tsx`, `client/service.ts`

Rules: under each pack, its learned lines, newest first: the date, `Wrong` or `Product fact`, the text, and `Applies to this repository` or `Only for <repo>`. A removable line has `Remove`, which asks in place (`Remove this line? The reviewer stops following it from the next review.` with `Remove` and `Keep`), then shows the service's note. The team kit's pack says `Managed by the team; not edited here.` An empty pack says `Nothing learned yet.` The count against the cap is shown when a kind holds over 250 lines.

- [ ] **Step 1: Write the failing tests**

```ts
it('lists the lines of each pack newest first with their kind and where they apply', async () => {});
it('Remove asks in place, then removes and shows the note', async () => {});
it('a kit line has no Remove', async () => {});
it('a refusal from the service is shown and the line stays', async () => {});
it('markup in a learned line is shown as characters', async () => {});
```

- [ ] **Step 2–5:** Run (FAIL), implement, `npm run check` (PASS), commit `Show and remove learned lines under Packs`.

### Task 12: Together (done by the controller)

Extend the end-to-end flow against the fake service: preview, edit, update, post, the posted mark; a refusal; a re-review with one fixed and one moved finding; removing a learned line. Run a real re-review and a real merge review with the engine's command on past Orbit pull requests (reads only), in a throwaway `AIRLOCK_HOME`. Update `docs/guide/install.md` (posting, after a push, replacing the token). Then the whole-branch review on the most capable model, one fix wave, one scoped re-review. **No real post is made.** The hand-over lists the first real post as the person's to make and what to look at when making it (the two unconfirmed facts in Task 1).

## Order and lanes

Task 1, then Task 2 (every lane depends on it). Then three lanes in their own worktrees: engine (3, 4, 5, in that order), service (6, 8, then 7 once Task 4 is merged in), panel (9, 10, 11, which need only the shared package and the fake service). Task 12 after all three are merged.
