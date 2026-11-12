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

Before the panel sends the token, it asks whatever answers on Airlock's port to prove it already holds the same token, without the token itself being sent. A proof is good for one second, so each action you take is checked again. If something else is listening on the port while Airlock is stopped, the panel shows the Pair screen saying "The service could not show that it holds this panel's token, so the token was not sent. If you replaced the token, paste the new one. If you did not, another program may be answering on Airlock's port." and sends nothing. `npm run service -- status` makes the same check.

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

Airlock never writes to GitHub. It posts nothing, approves nothing and merges nothing.

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
