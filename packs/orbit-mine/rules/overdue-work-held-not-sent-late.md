---
id: overdue-work-held-not-sent-late
title: Scheduled work that is long overdue is held, not sent late
paths: ["app/src/lib/**/*.ts", "app/src/app/api/{**/cron,cron/**,*/{warm,sync,process,distribute},*/{sync,process}-*,*/*-{sweep,reminders}}/route.ts"]
severityFloor: fix
sourcePrs: [99, 100, 174]
origin: "past_review_comment_mining.md section 5 rule 9 (C6)"
---
When a cron or scheduler selects rows whose time has passed (`publishAt <= now`, `dueAt <= now`), check what it does after the feature, the entity or the cron has been off for a while. Work that is well past its time goes back to draft or needs review and tells the owner why; it is not sent late.

Why it matters: when a feature or job comes back after a pause, everything queued in the meantime goes out at once, and people receive reminders for meetings already held and deadlines already gone.

Compare with `app/src/lib/announcements/scheduler.ts`, which returns announcements more than 30 minutes overdue to draft.
