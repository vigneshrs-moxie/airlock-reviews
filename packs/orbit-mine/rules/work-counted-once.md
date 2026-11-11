---
id: work-counted-once
title: Totals over link tables and parent-child records count each piece of work once
paths: ["app/src/lib/**/*.ts", "app/prisma/migrations/**/migration.sql"]
severityFloor: fix
sourcePrs: [142, 152, 165, 166, 167, 168, 171, 172, 203, 204]
origin: "past_review_comment_mining.md section 5 rule 27 (C24)"
---
When a query sums over a link table whose rows carry a role (target, shipped, related) or over parent and child records, check that each piece of work is counted once: pick one role, and count either the children or the parent when both carry points.

Why it matters: the same work counted twice inflates what a release or a team appears to have delivered, and plans built on that figure are wrong.

Compare with the release points query in `app/src/lib/feedback/releases.ts`.
