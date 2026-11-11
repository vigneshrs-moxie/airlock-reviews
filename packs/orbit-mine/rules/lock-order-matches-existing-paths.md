---
id: lock-order-matches-existing-paths
title: New transactions lock rows in the same order as existing paths
paths: ["app/src/lib/**/*.ts", "app/src/app/api/**/route.ts"]
severityFloor: fix
sourcePrs: [99, 100, 174]
origin: "past_review_comment_mining.md section 5 rule 4 (C3)"
---
When a change adds a transaction that locks or updates two or more tables or rows, find every existing path that touches the same rows and compare the order. Flag a new path that takes the locks in the opposite order to an existing one.

Why it matters: two requests that lock in opposite orders can deadlock, so a person's click fails at random while a bulk operation runs.

Compare with the announcements code, which uses one order everywhere: the announcement row, then the recipient row.
