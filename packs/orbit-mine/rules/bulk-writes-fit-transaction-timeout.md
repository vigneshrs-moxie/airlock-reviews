---
id: bulk-writes-fit-transaction-timeout
title: Row-by-row writes in a transaction fit its timeout at the largest office
paths: ["app/src/lib/**/*.ts", "app/src/app/api/**/route.ts"]
severityFloor: fix
sourcePrs: [99, 100, 174]
origin: "past_review_comment_mining.md section 5 rule 3 (C3)"
---
When a transaction writes rows one at a time in a loop, estimate the row count at the largest office against the transaction timeout (Prisma's default is 5 seconds). Prefer one set-based statement; if a sibling operation over the same rows sets an explicit timeout, this one needs it too.

Why it matters: at a large office the transaction rolls back on timeout, so nobody receives the update and the screen may still say it was done.

Compare with `app/src/lib/announcements/notify-reset.ts`, which replaced a per-recipient loop with one statement and a 30-second timeout matching publish.
