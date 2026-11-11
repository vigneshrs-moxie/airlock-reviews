---
id: migration-locks-and-transactions
title: A migration fits the migrate endpoint's transaction and timeouts
paths: ["app/prisma/migrations/**/migration.sql"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 5"
---
The migrate endpoint runs each migration inside a transaction with a 240-second statement timeout and a 30-second lock timeout, so `CREATE INDEX CONCURRENTLY` only works in a file that manages its own transaction, and a statement that waits for a busy lock fails. Flag a migration that takes a heavy lock on a large table (`calls`, `profiles`, `portal_feedback`, `metric_snapshots`): a type change, `ADD COLUMN ... NOT NULL DEFAULT`, a new `NOT NULL` or `CHECK` that must scan, or an unbatched `UPDATE` backfill.

Why it matters: the migration fails after the deploy, so code that needs it errors for everyone until someone applies it by hand, or the lock stalls the pages that read the table.

Compare with `app/src/app/api/db/migrate/route.ts` and the transaction handling in `app/src/lib/migrations/ledger.ts`.
