---
id: email-through-shared-client
title: Email goes through the shared client with its protections intact
paths: ["app/src/lib/**/*.ts", "app/src/app/**/*.ts"]
severityFloor: fix
sourcePrs: [99, 100, 174]
origin: "orbit_repo_rules_inventory.md section 6 rule 36"
---
Mail is sent with `sendEmail` or `sendEmailBatch` from `app/src/lib/email/client.ts`; nothing else constructs a `Resend` client. `bypassDevOverride` is only for an explicit, admin-confirmed action, and `skipMonitorBcc`, `idempotencyKey` and batch sending are only for announcements. Demo profiles get no mail, the send runs inside `after()` rather than as a detached promise, and the outcome is recorded so a re-run does not send again.

Why it matters: a send that skips the shared client escapes the staging redirect and the monitoring copy, so test emails reach real employees and nobody can see what went out.

Compare with the options documented at the top of `app/src/lib/email/client.ts`.
