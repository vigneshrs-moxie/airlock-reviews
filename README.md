# Airlock

Reviews a pull request in a panel beside the GitHub page, so that what matters is fixed at PR #1 before the senior reviewer sees PR #2. Generic rules for any repository, and a stronger Orbit mode for `moxie-portal`.

Status: design approved on 2026-11-10; build in progress.

- Design: [docs/design/2026-11-10-airlock-design.md](docs/design/2026-11-10-airlock-design.md)
- Build plans: `docs/plans/`

It runs on one Mac: a local service with a checkout of the repository does the review, and a Chrome extension is its screen. Nothing is written to GitHub until you click Post.
