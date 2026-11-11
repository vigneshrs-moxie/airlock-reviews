---
id: overdue-work-held-not-sent-late
title: Scheduled work that is long overdue is held, not sent late
paths: ["app/src/lib/**/*.ts", "app/src/app/api/**/route.ts"]
severityFloor: fix
sourcePrs: [99, 100, 174]
origin: "past_review_comment_mining.md section 5 rule 9 (C6)"
---
When a cron or scheduler selects rows whose time has passed (`publishAt <= now`, `dueAt <= now`), check what it does after the feature, the entity or the cron has been off for a while. Work that is well past its time goes back to draft or needs review and tells the owner why; it is not sent late.

Why it matters: switching a feature back on would otherwise release a backlog, so a notice about a closure on Monday reaches people on Thursday.

Compare with `app/src/lib/announcements/scheduler.ts`, which returns announcements more than 30 minutes overdue to draft.
