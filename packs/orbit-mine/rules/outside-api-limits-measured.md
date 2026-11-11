---
id: outside-api-limits-measured
title: New calls to an outside service state its real limits and share of the quota
paths: ["app/src/lib/integrations/**", "app/src/lib/email/**", "app/src/lib/**/email.ts", "app/src/lib/queries/**", "app/src/lib/calls/**", "app/src/lib/task-distribution/**", "app/src/lib/fabric.ts"]
severityFloor: fix
sourcePrs: [99, 100, 174]
origin: "past_review_comment_mining.md section 5 rules 6 and 8 (C5)"
---
When a change adds or increases calls to an outside service (Resend, Power BI or Fabric, ClickUp, GitHub, FieldRoutes, TalkDesk, Paylocity), the pull request states the account's real rate limit and current usage, names the other features that share the same key (staging shares production keys), uses a batch endpoint where one exists, and handles rate-limit and quota errors. A code comment or description that calls a limit "assumed" or "to be verified" is replaced by the measured figure before merge.

Why it matters: the limit belongs to the whole account, so a new feature that spends it can make unrelated emails or syncs fail for everyone.

Compare with the batch sending and the documented 10-requests-per-second team limit in `app/src/lib/announcements/email.ts`.
