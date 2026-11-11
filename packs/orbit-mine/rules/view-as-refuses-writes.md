---
id: view-as-refuses-writes
title: Writes under view-as are refused or record the real person
paths: ["app/src/app/api/**/route.ts", "app/src/lib/actions/**"]
severityFloor: fix
sourcePrs: [141, 142, 143, 149, 152, 165, 166, 167, 168, 171, 172, 173, 203, 204]
origin: "past_review_comment_mining.md section 5 rule 20 (C17); orbit_repo_rules_inventory.md section 6 rule 26"
---
Every new non-GET route handler and server action decides what happens when an admin is viewing as someone else (`auth.isImpersonating`): it refuses the write before any lookup, or it records the real person as the actor. It never saves the viewed person as the author, approver or decider. Under Portal Feedback and announcements administration the refusal is required.

Why it matters: otherwise an admin can approve, comment or decide in another person's name and nothing shows that it was not them.

Compare with `viewAsRefusal` in `app/src/lib/feedback/view-as.ts`, `{ mutating: true }` on `ticketRequest` in `app/src/lib/feedback/api.ts`, and `viewAsRefused` in `app/src/lib/announcements/admin-route.ts`.
