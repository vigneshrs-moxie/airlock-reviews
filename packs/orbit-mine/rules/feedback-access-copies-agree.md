---
id: feedback-access-copies-agree
title: Every copy of the feedback access rule changes together
paths: ["app/src/lib/feedback/**", "app/src/app/api/feedback/**", "app/src/mcp/**"]
severityFloor: block
sourcePrs: [142, 152, 165, 166, 167, 168, 171, 172, 203, 204]
origin: "orbit_repo_rules_inventory.md section 6 rule 31; past_review_comment_mining.md section 5 rule 19 (C16, copies of the rule)"
---
A change to who can read or act on a ticket updates every copy of the rule together: `access.ts`, `review-access.ts`, the raw SQL in `tracker-sql.ts`, `watchers.ts`, `mentions.ts`, `participants.ts`, `recipients.ts`, the participant DTOs, the list filters and the pickers. A new route under `app/src/app/api/feedback/[id]/` goes through `ticketRequest`, and an unknown ticket and an unreadable ticket both answer 404.

Why it matters: when one copy lags, a person can find a ticket in a list or a picker that the ticket page would refuse them, and read part of it there.

Compare with the access checklist in `docs/portal-feedback/README.md` and `ticketRequest` in `app/src/lib/feedback/api.ts`.
