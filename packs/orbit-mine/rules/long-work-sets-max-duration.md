---
id: long-work-sets-max-duration
title: A route that does long work sets maxDuration like its siblings
paths: ["app/src/app/api/**/route.ts"]
severityFloor: fix
sourcePrs: [99, 100, 174]
origin: "past_review_comment_mining.md section 5 rule 2 (C2); orbit_repo_rules_inventory.md section 6 rule 28 (maxDuration)"
---
A route handler that starts long work (a drain, a bulk send, a sync, a backfill or a cron run) exports `maxDuration`, and the value matches the sibling routes that run the same work. A second route that calls an existing long operation needs the same limit as the first one.

Why it matters: without it the platform stops the function at its default limit, the work ends halfway, and the people it was meant to reach are skipped without any error.

Compare with `export const maxDuration` in `app/src/app/api/announcements/process/route.ts`, `app/src/app/api/tasks/distribute/route.ts` and `app/src/app/api/db/migrate/route.ts`.
