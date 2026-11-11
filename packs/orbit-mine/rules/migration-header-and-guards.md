---
id: migration-header-and-guards
title: A migration opens with a header and is safe to run twice
paths: ["app/prisma/migrations/**/migration.sql"]
severityFloor: note
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 7"
---
A new migration starts with a comment that says what it does and why, whether it is additive or changes data, the deploy order when that matters, and a `Rollback:` line. DDL uses `IF NOT EXISTS`, seed inserts use `ON CONFLICT DO NOTHING`, and data updates give the same result when run a second time.

Why it matters: the header is the only rollback record the team keeps, and a migration that fails on a second run blocks the next deploy for everyone.

Compare with the headers of `app/prisma/migrations/0140_talent_rating_freezes/migration.sql` and `0156`.
