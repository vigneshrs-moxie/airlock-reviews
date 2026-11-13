# Installing Airlock

About two minutes. You need Node 24, Git, the `claude` command signed in, and `gh` signed in to GitHub.

## 1. Build

In the `airlock-reviews` folder:

```
npm install
npm run build
npm run build -w @airlock/extension
```

## 2. Start the service

```
npm run service
```

Leave that terminal open. It prints `Airlock service is listening on 127.0.0.1:4611.`

To have it start by itself at login instead, run `npm run service:install` once. To undo that, `npm run service:uninstall`.

## 3. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Press **Load unpacked** and choose the folder `packages/extension/.output/chrome-mv3`. The folder chooser does not show `.output`, because its name starts with a dot: press Cmd+Shift+. in the chooser to show hidden folders, or press Cmd+Shift+G and paste the folder's full path.
4. Pin Airlock from the puzzle-piece menu so its button is in the toolbar.

After loading, Airlock's card on `chrome://extensions` should show no **Errors** button.

## 4. Pair the panel with the service

1. Open any pull request on GitHub and press the Airlock button. The panel opens beside the page and asks for a pairing token.
2. In a second terminal, in the `airlock-reviews` folder, run `npm run service -- token`. The token is the last line it prints, 64 characters; copy that line. Copying everything the command printed works too.
3. Paste it into the panel and press **Pair**.

You do this once. The token stays on this Mac.

Before the panel sends the token, it asks whatever answers on Airlock's port to prove it already holds the same token, without the token itself being sent. The proof names the port, so a proof Airlock gave on another port does not count. A proof is good for one second: an action within a second of the last check is not checked again, and any action after that is. Pairing, and following a running review, always check first.

If something else is listening on the port while Airlock is stopped, the panel never sends it the token. What you see depends on how that program answers:

- If it answers like Airlock but cannot give the proof, the panel shows the Pair screen saying "The service could not show that it holds this panel's token, so the token was not sent. If you replaced the token, paste the new one. If you did not, another program may be answering on Airlock's port."
- If it refuses the panel (HTTP 401), the panel shows the Pair screen without that sentence.
- If it answers with an error and a sentence of its own, the panel shows that sentence, as text. Any other answer gives "Airlock got a reply from its service that it does not understand."

The panel shows this when it next loads; until then the screen you had stays. If you press a button meanwhile, the panel shows it at once instead: the Pair screen as above, or the sentence as a notice on the screen you are on. `npm run service -- status` makes the same check.

### Replacing the token

If the token may have been seen by someone else, make a new one:

```
npm run service -- token --new
```

It prints the new token as its last line. Within a second the old token stops working, for the panel and for anyone else who has it: there is no need to restart the service, and the extension stays paired. The panel asks for the new token with the Pair screen and the sentence above, because the service now proves a token the panel does not have:

- On the start screen or a review, within a few seconds.
- During a review that is running, the review carries on to its end (it was started with the old token and is not cut off); the panel asks a few seconds after it finishes. Any new request needs the new token.
- On the Problem screen, or with the panel closed, at the next thing you do: Retry, **Review this pull request**, or opening the panel.

Paste the new token and press **Pair**.

## 5. Review a pull request

Open a pull request and press the Airlock button.

**Start.** The panel shows the pull request (its repository, number, files and lines changed), then:

- **Depth**: Quick, Standard or Deep. The line under it says what the chosen depth does. The panel starts on the default depth from Settings, or on the depth Airlock suggests for this pull request.
- **Packs**: the rule packs this review will use. Press the row to see them and switch one off; at least one stays on.

Press **Review this pull request** at the bottom. It runs on your Claude login; nothing is posted to GitHub.

**While it runs.** The panel names the step it is on, with a bar and "Step 4 of 15" (just "Step 4" when it cannot tell how many steps there will be, for example on a review that was already running when you opened the panel). Under it: the time so far, and the files and groups once Airlock has mapped the change. **Show the steps** lists every step as Done, Now or Next. **What it has found so far** shows what the pull request does and the files in reading order, as they arrive. A review cannot be stopped from the panel yet.

**The review.** At the top: the verdict, one sentence, and the open findings counted by kind ("1 blocking", "2 to fix", "1 question"…). What limits the review stays in sight under that, never behind a tab: a review that did not finish says so, with the errors; on a first review the fold **About this review**, with its count, holds what the reviewer was not shown and the review's notes; on a re-review the notes are printed there. Then three tabs:

- **Findings**: one line per finding: its kind (Block, Fix, Ask or Note), a short title and its place. **Also found** folds the less important ones.
- **The change**: what the pull request does in short, then folds: what it does in full, questions for the author, whose call it is, what to check after merging, text for your pull request (with **Copy**), and the files in reading order.
- **More**: when and how deep it was reviewed, with which packs; **Review again**; what was dismissed (with **Restore**); the timing; and **Dropped: n**, the findings the reviewer threw away and why.

At the bottom, when something is to be fixed, **Copy fix prompt for the n fixes** copies one prompt for every open Block and Fix, for your coding agent. **Select** lets you tick findings, then **Copy fix prompt (n)** or **Comment on GitHub (n)**.

**A finding.** Press a line. The finding opens with its kind, short title and place (**Show in diff** shows it on the Files changed page), a summary, and **What to do**. The detail is folded below: **What happens**, **Why it matters**, **The code**, **Also involves**, **How sure is this**. Folds you open stay open as you move with the arrows at the top. **Review** goes back. Three buttons stay at the bottom, each with a line under it:

- **Copy fix prompt**: puts a prompt for your coding agent on the clipboard.
- **Comment on GitHub**: shows you the exact comment and where it goes before anything is sent (next section).
- **Dismiss**: hides the finding here and teaches Airlock. Nothing is sent to GitHub. Choose why: **The finding is mistaken** or **The code is right for a reason Airlock could not know** saves one line, which Airlock reads in every later review of this repository (you see and can edit it first); **Hide it on this pull request only** saves nothing. Bring a finding back under **More**, **Dismissed**.

Short titles and summaries are written by a step near the end of each review. A review made before this version has none: its lines show the title cut to about 60 characters, and a finding's summary is the first sentence of What happens, until you review again.

**The tour.** The first time a review is on screen, three short steps show what the screen holds. **Skip** or **Done** ends it for good; **Settings**, **Show the tour again** shows it again.

**Settings** (top right): **Text and button size** (Small, Default, Large, Largest; saved on this computer), **Notes in the diff**, **Default depth**, **Packs and learned lines**, **Show the tour again**, and **Service** (whether the service, Claude and GitHub are ready, and the pairing).

Airlock writes to GitHub only when you press the post button described below, and then only comments. It never approves, never requests changes and never merges.

## Notes in the diff

While a review is on screen, each open finding also appears as a note on the pull request's **Files changed** page, under the line it is about. A note shows the finding's severity and title, and an **Open in Airlock** button that opens the finding in the panel. A finding you dismiss loses its note; restore it and the note comes back. Notes are drawn only on a page that shows the commit the review is of: once the page shows newer commits, the older review's notes are taken off until you review again.

- Notes are private to this browser. Airlock draws them on the page itself: nothing about them is sent to the service or to GitHub, and they are never posted. Only the post button posts anything.
- To turn them off, press **Settings** at the top of the panel and switch off **Notes in the diff**. Switch it on again to bring them back.
- A line under the verdict says how many notes are on the page, for example "4 notes shown in the diff". "<n> shown, <m> waiting for their lines to load" means that m findings' lines are not on the page yet: GitHub loads files as you scroll, a file may be collapsed, or the line is in folded context or outside the diff. Each note appears when its line does; Airlock never puts a note anywhere else. At most 60 notes are shown, and the line then adds "(the first 60 findings)".
- GitHub's newer Files changed view is not fully known to Airlock yet, so notes may not appear there. When Airlock still cannot place them after a minute, the panel says "Notes cannot be shown on this version of GitHub's page (…). Show in diff still works.", naming the parts of the page it could not find.
- If the GitHub page was opened before the commit the review is of (you reviewed a push without reloading the page), the panel says "The GitHub page was opened before the commit this review is of, so the notes are hidden until you reload it." Press **Reload the GitHub tab** and the notes appear.
- If Airlock could not check which commit the page shows (for example, the service was not running when the page loaded), the panel says "Airlock could not check which commit the GitHub page shows, so the notes are hidden until you reload it." Press **Reload the GitHub tab** to try again.

## Posting comments

1. Open a finding and press **Comment on GitHub**. Or press **Select** in the bar at the bottom of the review, tick several findings and press **Comment on GitHub (n)**. One post holds at most 30 comments.
2. The sheet says first **Where it goes**, for each comment: **On the line** (it shows in Files changed, next to the code), or **In the review summary**, with the reason when GitHub cannot place it on a line. You can tick **Put in the summary instead**.
3. Under **The exact text** are each comment, the summary, and the review's own text as it will be posted. You can edit any comment and the summary; after an edit, press **Update preview** to see the exact text again.
4. A line names the GitHub account it posts as ("Posts as … on …, as a comment." or "…, as n comments in one review."): the account `gh` is signed in as when the preview is made. It also says "Airlock never approves, requests changes or merges." and "Nothing has been sent yet."
5. Press **Post comment** (or **Post n comments**), or **Cancel**. Nothing is posted until you press it.

Airlock posts them as one review with the **Comment** action, as the sheet says, under your own GitHub name. When it is done, the sheet says "Posted n comments." with **Open on GitHub**, and each finding shows **Posted**. A finding that is already posted cannot be posted again.

In the text Airlock writes, a name gets a space after the `@` (`@ carol`), so GitHub notifies no one. If a comment or the summary you typed names someone, the sheet warns you with "GitHub notifies them unless the name is inside code."

Airlock refuses to post, and says why, when the pull request is closed or merged, or has new commits since the review. After new commits, review the push first (see the next section), then post. It also refuses, and sends nothing, when `gh` is signed in as another account than the one the preview named; open the preview again to post as the account `gh` is signed in as now.

A post can take a while when GitHub is slow, or when another post to the same pull request is in flight (from a second panel, for example): Airlock sends one at a time. The panel first waits up to 75 seconds for the service's answer; meanwhile the sheet is locked and shows no new sentence. If no answer comes, the panel then reads Airlock's record of the post every 5 seconds for up to 90 seconds more, and only then does the sheet say "Waiting to hear whether GitHub accepted the comments…". When a record appears, the sheet shows what it says. If none appears, the sheet says "Airlock could not learn what happened to this post. Look at the pull request before posting again." So the whole wait can reach almost three minutes.

If the panel cannot reach the service when it checks the service just before sending the post, the sheet says "Airlock could not reach its service, so nothing was sent." Nothing went to GitHub; press the button again once the service answers. The panel skips that check when it last checked less than a second before. If the service stops answering in that second, the panel cannot tell whether the post was sent: it waits the 90 seconds above, then says "Airlock could not learn what happened to this post. Look at the pull request before posting again."

### The first time you post

1. The comment should appear once, on its line, as one review with the **Comment** action.
2. Whether GitHub lets you post a Comment review on your own pull request was not tried while Airlock was built. If GitHub refuses, the panel shows GitHub's sentence and nothing is posted.
3. That the comments Airlock drafts notify nobody was checked with a Markdown renderer, not on GitHub. After your first post, check that nobody was notified.

### "Not known whether this was posted"

Sometimes Airlock gets no clear answer from GitHub, for example when the connection drops. It then cannot tell whether the comments went up. The sheet says "Airlock could not tell whether GitHub accepted the comments. Look at the pull request before posting again." and those findings show **Not known whether this was posted**. Airlock never tries again by itself, and you cannot post those findings again while the mark is there.

What to do:

1. Press **Open the pull request** and look for the comments.
2. If they are there, leave the mark as it is.
3. If they are not there, press **It was not posted**, in the sheet or on the finding. The panel asks "Forget this record? Only do this after looking at the pull request." Press **It was not posted** again, or **Keep** to leave it. Airlock asks GitHub before it forgets the record, as the next paragraph says.

Airlock then asks GitHub for a review by the same account, at the same commit, with the same text and the same comments on the same lines, that is not already the record of another post. If GitHub has exactly one, the panel says "GitHub has this review: it was posted. Nothing was forgotten." and the findings show **Posted**. If it has more than one, the panel says "GitHub has more than one review that could be this post. Look at the pull request; the record was kept." If GitHub cannot be asked, it says "Airlock could not ask GitHub whether this review exists, so the record was kept." Otherwise the record is forgotten and you can post those findings again.

A record made by an earlier version of Airlock may lack what GitHub is asked about. A record without the review's text or account is forgotten without asking GitHub; one without the comments is matched by its account, commit and text alone.

## After a push

When the pull request has new commits since its review, the panel says "New commits since this review." with two buttons:

- **Review the push** reviews only what changed since the last review. It is shown only when Airlock has an earlier review of this pull request to start from.
- **Review everything again** reviews the whole pull request again, from the start.

After **Review the push**, the top of the review counts what changed **Since the last review** ("1 fixed", "2 still open", "1 new"), and a line says what was reviewed, for example "Review of the push 1a2b3c4 to 5d6e7f8". Each finding has a word on its line:

- **New**: found in this review.
- **Still open**: found before, and still there.
- **Moved**: found before, and the same problem is now in another place. The line shows the new place.
- **Fixed**: found before, and no longer there. These are folded under **Fixed since the last review**, each with how it was confirmed.

A Block or Fix finding is marked Fixed only when Airlock finds, at the new commit, the line of code that fixes it, never on a model's word alone. When it cannot tell, the finding stays open. An Ask or Note whose code is gone is marked Fixed with "The quoted code is gone; not checked further."

Sometimes Airlock reviews the whole pull request again instead, for example when the branch was rewritten. A sentence under the verdict says why, and it is the only line there.

When the push is only a merge (usually of the base branch), the line says what was reviewed of it:

- "Review of the merge pushed since 1a2b3c4: only what was changed by hand was reviewed." when the merge had changes made by hand, and those were reviewed.
- "The push only merged another branch in; git merged it without conflicts and nothing was changed by hand." when there was nothing to review. It names no branch, because Airlock cannot always be sure which branch the push merged.
- No such line when Airlock could not review the merge. A note under the verdict says only that the push merges the base branch in, the verdict is Incomplete, and the error under it says why.

A first review of a pull request that only merges its base branch in says the same in the heading above what it does.

Findings you posted or dismissed keep that mark in the new review.

## Which packs a repository gets

Airlock picks the packs for a pull request by its repository, ignoring letter case:

- **Orbit** (`Moxie-Pest-Control-Phoenix/moxie-portal` and `vigneshrs-moxie/moxie-portal-vrs`): your pack, the team's standard (downloaded from the team's review kit at review time), and Generic.
- **The supervisors' Chrome extensions** (`scheduling-tool-suite`, `termites-tool-suite`, `moxie-click-to-dial`, `isales-audit-tool` and `TI-route-snapshot` under `Moxie-Pest-Control-Phoenix`): Extensions and Generic. Extensions downloads the tech team's extension review kit (`moxie-ext-review-kit`) at review time, as the team's standard does. If neither GitHub nor an earlier copy can supply it, the review stops before any model is asked, and the panel says "Airlock could not review this pull request: The review kit could not be fetched from Moxie-Pest-Control-Phoenix/moxie-ext-review-kit and none is cached:" followed by GitHub's reason. Check that `gh` is signed in and can read that repository, then press **Retry**. When only a refresh fails, the earlier copy is used, and a question in the review says the date of that copy. Lines you save on these repositories go to `packs/extensions/learned/`, never to the team's standard or to Generic.
- **Any other repository**: Generic only.

## What Airlock learned

When you dismiss a finding as mistaken, or as right for a reason Airlock could not know, Airlock saves one line to a rule pack, and the reviewer follows it from the next review on. To see these lines, press **Settings** at the top of the panel, then **Packs and learned lines**. Under **Packs for this repository**, each pack lists its lines, newest first. Each line shows its date, its kind (**Wrong** or **Product fact**), and whether it applies to this repository.

To take a line out:

1. Press **Remove** under it.
2. The panel asks "Remove this line? The reviewer stops following it from the next review." Press **Remove** again, or **Keep** to leave it.

The finding you dismissed stays dismissed. Lines of the team's own pack say "Managed by the team; not edited here." and have no Remove button. The Extensions pack also downloads a kit, but its learned lines are yours, with Remove like any other pack's. If the connection drops while a line is being removed, the panel says "Airlock got no answer from its service, so it cannot tell whether the line was removed. The list below is read again." and shows the lines as they are now. If the panel cannot reach the service when it checks the service just before sending the removal, it says "Airlock could not reach its service, so nothing was removed." under the line, which stays.

The lines are plain text files, so you can also edit them by hand (see the end of this guide). If a line you edited no longer reads as a learned line, Airlock skips that one line and still uses the rest of the pack.

## If something is off

| What you see | What to do |
|---|---|
| `Not running` in the panel | Start the service: `npm run service`. The panel reconnects by itself. |
| `Not paired` | Run `npm run service -- token` and paste the token. |
| "The service could not show that it holds this panel's token, so the token was not sent." | If you just ran `npm run service -- token --new`, paste the new token. Otherwise run `npm run service -- status`: another program may hold the port while Airlock is stopped. |
| "already paired with another copy of the extension" | Run `npm run service -- unpair`, then pair again. |
| `Airlock could not reach the GitHub page` | Press **Reload the GitHub tab** in the panel. This happens after the extension itself is reloaded, or on a tab that was open before Airlock was loaded. |
| A jump says "Asked GitHub to show…" and nothing is marked | GitHub's page changed in a way Airlock does not recognise yet. In **Settings**, **Service** lists which parts it could not find, under GitHub page. |
| The service will not start: "Port 4611 is already in use" | Another copy of Airlock is running. `npm run service -- status` shows it. |
| "Port 4611 is in use by another program." | Something else holds the port. Stop that program, then start Airlock again. Started at login, Airlock tries again by itself every 30 seconds. |

Where things are kept: `~/.airlock` (reviews, dismissals, the pairing token, and the service log when the service starts at login; started with `npm run service`, it logs to that terminal instead). Learned lines are plain text under `packs/<your pack>/learned/` in this repository, so you can read, edit or delete them. A line saved on a repository with no pack of its own is kept in `packs/generic/learned/` and applies to that repository only.
