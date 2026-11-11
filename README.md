# Airlock

Reviews a pull request in a panel beside the GitHub page, so that what matters is fixed at PR #1 before the senior reviewer sees PR #2. Generic rules for any repository, and a stronger Orbit mode for `moxie-portal`.

Status: the engine and the replay (step 1 of four) are built; the service and the side panel (step 2) are in review.

- Design: [docs/design/2026-11-10-airlock-design.md](docs/design/2026-11-10-airlock-design.md)
- Build plans: `docs/plans/`

It runs on one Mac: a local service with a checkout of the repository does the review, and a Chrome extension is its screen. Nothing is written to GitHub until you click Post.

## Run a review from the terminal

You need Node 24, the `claude` command signed in (reviews run on that login, never on an API key) and `gh` signed in to GitHub.

```
npm install
npm run build
npm run airlock -- review Moxie-Pest-Control-Phoenix/moxie-portal#146
```

A pull request's address works in place of `owner/name#number`. The review reads the pull request through `gh`, fetches the code into Airlock's own copy under `~/.airlock` (never your working checkouts), and prints the verdict, up to five findings, what else it found and what it dropped. It writes nothing to GitHub.

| Option | What it does |
|---|---|
| `--depth quick\|standard\|deep` | Quick is one pass with no challenge; Standard is the default; Deep adds a second pass per layer. |
| `--packs a,b` | Use only these rule packs, by id (`raj-standard`, `orbit-mine`, `generic`). |
| `--model <id>`, `--sweep-model <id>`, `--effort low\|medium\|high` | The model for every stage, a cheaper one for the rule sweep, and how hard they work. |
| `--combine no-read-tier` | One combined lens request for groups with no closely read file (cheaper, off by default). |
| `--base <sha> --head <sha>` | Review exactly this range. |
| `--json <file>` | Also save the review document. |

`npm run airlock -- help` prints the same list. A review of a typical pull request costs about $0.40 to $0.55 per changed file at list prices and takes a few minutes.

## Replay: measure it against past reviews

The replay runs the reviewer on past `moxie-portal` pull requests at the commits a senior reviewer saw, with the rules written from each pull request withheld, and scores what it found against what he raised. It uses real model usage, so run it on purpose.

```
npm run airlock-replay -- run --cases small --run my-run
npm run airlock-replay -- report replay-work/my-run
```

`--cases` takes `all`, `positive`, `negative`, `small` or a list of case ids; `--parallel 2` reviews two pull requests at once. A run that stops (a usage limit, Ctrl-C) continues when the same command is run again. Results land in `replay-work/<run>/` (not in git): `report.md` is the one to read. The cases and how they were chosen are in [packages/replay/dataset/README.md](packages/replay/dataset/README.md).

## Rule packs

`packs/` holds the rules a review uses. `raj-standard` attaches the team's review kit, downloaded at review time and never copied here. `orbit-mine` is your own pack: rules, code checks and what dismissals taught it (`learned/`). `generic` is used for every repository.
