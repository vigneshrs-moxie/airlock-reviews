# Installing Airlock

About two minutes. You need Node 24, the `claude` command signed in, and `gh` signed in to GitHub.

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
3. Press **Load unpacked** and choose the folder `packages/extension/.output/chrome-mv3`.
4. Pin Airlock from the puzzle-piece menu so its button is in the toolbar.

## 4. Pair the panel with the service

1. Open any pull request on GitHub and press the Airlock button. The panel opens beside the page and asks for a pairing token.
2. In a second terminal, in the `airlock-reviews` folder, run `npm run service -- token` and copy what it prints.
3. Paste it into the panel and press **Pair**.

You do this once. The token stays on this Mac.

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
| "already paired with another copy of the extension" | Run `npm run service -- unpair`, then pair again. |
| `Airlock could not reach the GitHub page` | Press **Reload the GitHub tab** in the panel. This happens after the extension itself is reloaded. |
| A jump says "Asked GitHub to show…" and nothing is marked | GitHub's page changed in a way Airlock does not recognise yet. The Packs screen lists which parts it could not find. |
| The service will not start: port in use | Another copy is running. `npm run service -- status` shows it. |

Where things are kept: `~/.airlock` (reviews, dismissals, the pairing token, the service log). Learned lines are plain text under `packs/<your pack>/learned/` in this repository, so you can read, edit or delete them.
