---
id: applied-migration-not-edited
title: A migration that is already on a shared branch is never edited
paths: ["app/prisma/migrations/**"]
severityFloor: fix
sourcePrs: [173]
origin: "orbit_repo_rules_inventory.md section 6 rule 6; past_review_comment_mining.md section 5 rule 33 (process history, PR #173)"
---
A `migration.sql` that already exists on `main` or `staging` is not modified; a correction goes in a new migration. Renumbering or editing a migration that has never been merged or applied anywhere shared is fine, and the pull request should say so.

Why it matters: an environment that already ran the old version never runs the new one, so staging and production quietly end up with different schemas.

Compare with the checksum per migration in `app/src/lib/migrations/ledger.ts`, which reports a migration as edited since applied.
