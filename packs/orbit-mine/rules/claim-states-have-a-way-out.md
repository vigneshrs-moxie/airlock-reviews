---
id: claim-states-have-a-way-out
title: Every in-between state of outbound work has a way out
paths: ["app/src/lib/**/*.ts", "app/src/app/api/**/route.ts", "app/prisma/migrations/**/migration.sql"]
severityFloor: fix
sourcePrs: [99, 100, 174]
origin: "past_review_comment_mining.md section 5 rule 1 (C2); orbit_repo_rules_inventory.md section 6 rule 28 (claims and stale-claim recovery)"
---
When a change adds a status for queued or outbound work (pending, claimed, sending, sent, failed), every state that is not final must have a way out: a claim older than a set time goes back to pending or to a failed state, retries are capped, and a run that is cut off cannot leave a row claimed forever. Screens and counts must not show a stuck row as "pending" indefinitely.

Why it matters: a send that is cut off halfway otherwise means one person never gets the message and nobody can see that it happened.

Compare with the stale-claim handling in `app/src/lib/announcements/email.ts` and the stored reminder counter in `app/src/app/api/scorecards/sign-reminders/route.ts`.
