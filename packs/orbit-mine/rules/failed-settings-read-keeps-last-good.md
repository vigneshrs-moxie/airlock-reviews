---
id: failed-settings-read-keeps-last-good
title: A failed settings read keeps the last good value
paths: ["app/src/lib/**/*.ts", "app/src/app/api/**/route.ts"]
severityFloor: fix
sourcePrs: [193, 194]
origin: "past_review_comment_mining.md section 5 rule 35 (secondary evidence, PR #194 review fixes)"
---
When a job or sweep reads its settings and the read fails, it keeps the last good settings or skips the run; it does not fall back to a default that changes behaviour, such as treating a hold as off. Status lines that report the setting refresh when it changes.

Why it matters: one failed read would otherwise switch off a safeguard for a whole sweep, so work is assigned or sent at a time the office had chosen to hold it.
