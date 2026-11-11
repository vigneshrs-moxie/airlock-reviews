---
id: cron-budget-below-interval
title: A cron stops before its next run starts and scopes its people queries on purpose
paths: ["app/src/app/api/{**/cron,cron/**,*/{warm,sync,process,distribute},*/{sync,process}-*,*/*-{sweep,reminders}}/route.ts"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 28 and section 4.8"
---
A new cron keeps a run budget below its schedule interval so two runs never overlap, gates office-facing work on business hours in each office's own time zone, and does not rely on crons running on staging (they do not). Because a cron has no viewer, its people queries run inside `withoutScope` with a reason and are limited to the entities that have the feature on.

Why it matters: overlapping runs repeat the same work, and an unscoped query in a job acts on offices that never switched the feature on.

Compare with `RUN_BUDGET_MS` in `app/src/app/api/announcements/process/route.ts`.
