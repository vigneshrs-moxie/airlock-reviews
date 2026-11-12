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

If something else is listening on the port while Airlock is stopped, the panel never sends it the token. What you see depends on how that program answers. If it answers like Airlock but cannot give the proof, the panel shows the Pair screen saying "The service could not show that it holds this panel's token, so the token was not sent. If you replaced the token, paste the new one. If you did not, another program may be answering on Airlock's port." If it answers some other way, the panel shows "Airlock got a reply from its service that it does not understand." when it next loads, and until then the screen you had stays. `npm run service -- status` makes the same check.

### Replacing the token

If the token may have been seen by someone else, make a new one:

```
npm run service -- token --new
```

It prints the new token as its last line. Within a second the old token stops working, for the panel and for anyone else who has it: there is no need to restart the service, and the extension stays paired. The panel asks for the new token with the Pair screen and the sentence above, because the service now proves a token the panel does not have:

- On Ready or a review, within a few seconds.
- During a review that is running, the review carries on to its end (it was started with the old token and is not cut off); the panel asks a few seconds after it finishes. Any new request needs the new token.
- On the Problem screen, or with the panel closed, at the next thing you do: Retry, Review, or opening the panel.

Paste the new token and press **Pair**.

## 5. Review a pull request

Open a pull request, press the Airlock button, choose a depth, and press **Review**. The panel shows what the pull request does while the findings are still being checked, then the verdict and up to five findings.

- Press a finding to read it, then **Jump to line** to see it on the Files changed page.
- **Copy fix prompt** puts a prompt for a coding agent on the clipboard, for one finding or for the ones you ticked.
- **Dismiss** hides a finding. Wrong and Intended also save one line to your rule pack, which the reviewer follows from the next review on. You see and can edit that line before it is saved.

Airlock writes to GitHub only when you press the post button described next, and then only comments. It never approves, never requests changes and never merges.

## Posting comments

1. Open a finding and press **Post comment**. Or tick several findings and press **Post selected (n)** above the list. One post holds at most 30 comments.
2. The **Post to GitHub** sheet shows each comment, the summary, and "The review's own text, as it will be posted:". It says "This is the exact text. Nothing has been sent yet." It also names the GitHub account the comments will be posted as ("Posts as …"): the account `gh` is signed in as when the preview is made.
3. You can edit any comment and the summary. A comment GitHub cannot place on a line goes in the summary, and the sheet says why. You can also tick **Put in the summary instead**. After an edit, press **Update preview** to see the exact text again.
4. Press **Post n comments to GitHub**. Nothing is posted until you press it.

Airlock posts them as one review with the **Comment** action, as the sheet says, under your own GitHub name. When it is done, the sheet says "Posted n comments." with **Open on GitHub**, and each finding shows **Posted**. A finding that is already posted cannot be posted again.

In the text Airlock writes, a name gets a space after the `@` (`@ carol`), so GitHub notifies no one. If a comment or the summary you typed names someone, the sheet warns you with "GitHub notifies them unless the name is inside code."

Airlock refuses to post, and says why, when the pull request is closed or merged, or has new commits since the review. After new commits, review the push first (see the next section), then post. It also refuses, and sends nothing, when `gh` is signed in as another account than the one the preview named; open the preview again to post as the account `gh` is signed in as now.

A post can take up to about two minutes when another post to the same pull request is in flight (from a second panel, for example): Airlock sends one at a time. The sheet then says "Waiting to hear whether GitHub accepted the comments…", and when the wait is over it shows what Airlock's record says.

If the panel cannot reach the service when you press the post button, the sheet says "Airlock could not reach its service, so nothing was sent." Nothing went to GitHub; press the button again once the service answers.

### The first time you post

1. The comment should appear once, on its line, as one review with the **Comment** action.
2. Whether GitHub lets you post a Comment review on your own pull request was not tried while Airlock was built. If GitHub refuses, the panel shows GitHub's sentence and nothing is posted.
3. That the comments Airlock drafts notify nobody was checked with a Markdown renderer, not on GitHub. After your first post, check that nobody was notified.

### "Not known whether this was posted"

Sometimes Airlock gets no clear answer from GitHub, for example when the connection drops. It then cannot tell whether the comments went up. The sheet says "Airlock could not tell whether GitHub accepted the comments. Look at the pull request before posting again." and those findings show **Not known whether this was posted**. Airlock never tries again by itself, and you cannot post those findings again while the mark is there.

What to do:

1. Press **Open the pull request** and look for the comments.
2. If they are there, leave the mark as it is.
3. If they are not there, press **It was not posted**, in the sheet or on the finding. The panel asks "Forget this record? Only do this after looking at the pull request." Press **It was not posted** again, or **Keep** to leave it. Nothing is forgotten before Airlock has asked GitHub, as the next paragraph says.

Airlock then asks GitHub first. If GitHub has the review after all, the panel says "GitHub has this review: it was posted. Nothing was forgotten." and the findings show **Posted**. If GitHub cannot be asked, it says "Airlock could not ask GitHub whether this review exists, so the record was kept." Otherwise the record is forgotten and you can post those findings again.

## After a push

When the pull request has new commits since its review, the panel says "New commits since this review." with two buttons:

- **Review the push** reviews only what changed since the last review. It is shown only when Airlock has an earlier review of this pull request to start from.
- **Review everything again** reviews the whole pull request again, from the start.

After **Review the push**, a line under the verdict says what was reviewed, for example "Review of the push 1a2b3c4 to 5d6e7f8". Each finding has a word on its card:

- **New**: found in this review.
- **Still open**: found before, and still there.
- **Moved**: found before, and the same problem is now in another place. The card shows the new place.
- **Fixed**: found before, and no longer there. These are folded under **Fixed since the last review (n)**, each with the reason.

A Block or Fix finding is marked Fixed only when Airlock finds, at the new commit, the line of code that fixes it, never on a model's word alone. When it cannot tell, the finding stays open. An Ask or Note whose code is gone is marked Fixed with "The quoted code is gone; not checked further."

Sometimes Airlock reviews the whole pull request again instead, for example when the branch was rewritten. A sentence under the verdict says why, and it is the only line there.

When the push is only a merge (usually of the base branch), the line says what was reviewed of it:

- "Review of the merge pushed since 1a2b3c4: only what was changed by hand was reviewed." when the merge had changes made by hand, and those were reviewed.
- "The push only merged another branch in; git merged it without conflicts and nothing was changed by hand." when there was nothing to review. It names no branch, because Airlock cannot always be sure which branch the push merged.
- No line when Airlock could not review the merge. The verdict is Incomplete, and the error under it says why.

A first review of a pull request that only merges its base branch in says the same in the heading above what it does.

Findings you posted or dismissed keep that mark in the new review.

## Which packs a repository gets

Airlock picks the packs for a pull request by its repository, ignoring letter case:

- **Orbit** (`Moxie-Pest-Control-Phoenix/moxie-portal` and `vigneshrs-moxie/moxie-portal-vrs`): your pack, the team's standard (downloaded from the team's review kit at review time), and Generic.
- **The supervisors' Chrome extensions** (`scheduling-tool-suite`, `termites-tool-suite`, `moxie-click-to-dial`, `isales-audit-tool` and `TI-route-snapshot` under `Moxie-Pest-Control-Phoenix`): Extensions and Generic. Extensions downloads the tech team's extension review kit (`moxie-ext-review-kit`) at review time, as the team's standard does. If neither GitHub nor an earlier copy can supply it, the review stops before any model is asked and says so. Lines you save on these repositories go to `packs/extensions/learned/`.
- **Any other repository**: Generic only.

## What Airlock learned

When you dismiss a finding as Wrong or Intended, Airlock saves one line to a rule pack, and the reviewer follows it from the next review on. To see these lines, press **Packs** at the top of the panel. Under **Packs for this repository**, each pack lists its lines, newest first. Each line shows its date, its kind (**Wrong** or **Product fact**), and whether it applies to this repository.

To take a line out:

1. Press **Remove** under it.
2. The panel asks "Remove this line? The reviewer stops following it from the next review." Press **Remove** again, or **Keep** to leave it.

The finding you dismissed stays dismissed. Lines of the team's own pack say "Managed by the team; not edited here." and have no Remove button. If the connection drops while a line is being removed, the panel says "Airlock got no answer from its service, so it cannot tell whether the line was removed. The list below is read again." and shows the lines as they are now.

The lines are plain text files, so you can also edit them by hand (see the end of this guide). If a line you edited no longer reads as a learned line, Airlock skips that one line and still uses the rest of the pack.

## If something is off

| What you see | What to do |
|---|---|
| `Not running` in the panel | Start the service: `npm run service`. The panel reconnects by itself. |
| `Not paired` | Run `npm run service -- token` and paste the token. |
| "The service could not show that it holds this panel's token, so the token was not sent." | If you just ran `npm run service -- token --new`, paste the new token. Otherwise run `npm run service -- status`: another program may hold the port while Airlock is stopped. |
| "already paired with another copy of the extension" | Run `npm run service -- unpair`, then pair again. |
| `Airlock could not reach the GitHub page` | Press **Reload the GitHub tab** in the panel. This happens after the extension itself is reloaded, or on a tab that was open before Airlock was loaded. |
| A jump says "Asked GitHub to show…" and nothing is marked | GitHub's page changed in a way Airlock does not recognise yet. The Packs screen lists which parts it could not find. |
| The service will not start: "Port 4611 is already in use" | Another copy of Airlock is running. `npm run service -- status` shows it. |
| "Port 4611 is in use by another program." | Something else holds the port. Stop that program, then start Airlock again. Started at login, Airlock tries again by itself every 30 seconds. |

Where things are kept: `~/.airlock` (reviews, dismissals, the pairing token, and the service log when the service starts at login; started with `npm run service`, it logs to that terminal instead). Learned lines are plain text under `packs/<your pack>/learned/` in this repository, so you can read, edit or delete them. A line saved on a repository with no pack of its own is kept in `packs/generic/learned/` and applies to that repository only.
