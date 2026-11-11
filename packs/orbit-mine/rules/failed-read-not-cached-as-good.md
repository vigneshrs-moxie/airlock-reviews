---
id: failed-read-not-cached-as-good
title: A failed outside read is not cached like a good result
paths: ["app/src/lib/**/*.ts", "app/src/app/api/**/route.ts"]
severityFloor: note
sourcePrs: [77, 108, 109, 126, 129, 130, 131, 134]
origin: "past_review_comment_mining.md section 5 rule 10 (C7, C12)"
---
When the result of an outside read (Power BI, Fabric, a sync) is cached or stored, a failed, timed-out or partial result is not stored as if it were good: it gets a short expiry or a retry, and the screen says the figure is missing. Rate it as a fix unless the pull request already lists it under known limitations, in which case it is a note.

Why it matters: one slow moment at warm-up otherwise leaves an office looking at blank figures for hours, or for a whole day, with nothing telling anyone to look again.

Compare with `app/src/lib/productivity-report/fetch.ts`, where a result saved without SLA figures expires after 10 minutes.
