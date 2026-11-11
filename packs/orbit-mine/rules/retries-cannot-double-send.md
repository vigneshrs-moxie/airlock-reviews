---
id: retries-cannot-double-send
title: A retried or batched send cannot reach anyone twice
paths: ["app/src/lib/integrations/**", "app/src/lib/email/**", "app/src/lib/**/email.ts", "app/src/lib/calls/**", "app/src/lib/task-distribution/**", "app/src/lib/announcements/**"]
severityFloor: fix
sourcePrs: [99, 100, 142, 152, 165, 166, 167, 168, 171, 172, 174, 203, 204]
origin: "past_review_comment_mining.md section 5 rule 7 (C5, C18); orbit_repo_rules_inventory.md section 6 rule 35 (unknown outcomes)"
---
When sends or outside writes are batched or retried, the idempotency key covers exactly the unit that is retried (one key per request for a batch, not per item), and the sent record is written before the call. An outcome that is unknown (a timeout or a server error after the provider may have accepted) is not retried automatically.

Why it matters: a retry after a timeout otherwise posts the same note, comment or email a second time to a customer or a colleague.

Compare with the unique key and the never-retried `claimed` and `unknown` rows in `app/src/lib/calls/note-post-ledger.ts`, and the ClickUp comment ledger written before the post.
