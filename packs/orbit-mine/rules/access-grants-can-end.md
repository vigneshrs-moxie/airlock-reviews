---
id: access-grants-can-end
title: Access granted by a related row ends when that row is no longer current
paths: ["app/src/lib/**/access.ts", "app/src/lib/**/*-access.ts", "app/src/lib/feedback/**", "app/src/app/api/feedback/**"]
severityFloor: block
sourcePrs: [142, 152, 165, 166, 167, 168, 171, 172, 203, 204]
origin: "past_review_comment_mining.md section 5 rule 19 (C16)"
---
When access is granted because a related row exists (a review request, a grant, a participant or watcher row), the check filters that row by its status or revocation so that superseded, declined or revoked rows grant nothing, and there is a way to remove the grant.

Why it matters: someone picked by mistake, or replaced, would otherwise keep reading the ticket, its shared thread and its screenshots for good.

Compare with `relationsFor` and `participantAccessWhere` in `app/src/lib/feedback/access.ts`, which count only open requests and requests the person decided.
