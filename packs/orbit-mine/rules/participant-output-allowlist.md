---
id: participant-output-allowlist
title: Data for a participant is an allowlist, and every output uses the same projection
paths: ["app/src/lib/feedback/**", "app/src/components/feedback/**", "app/src/app/(authenticated)/feedback/**", "app/src/app/api/feedback/**", "app/src/lib/**/*-markdown.ts"]
severityFloor: block
sourcePrs: [142, 152, 165, 166, 167, 168, 171, 172, 203, 204]
origin: "past_review_comment_mining.md section 5 rule 24 (C20, C22); orbit_repo_rules_inventory.md section 6 rule 32"
---
When records are serialised for a less privileged audience (a reporter, a reviewer, a participant), each record kind has an explicit list of the fields that audience may see; stripping one known field from the full record is not enough. Every output for that audience (the page, the JSON API, the history, exports and copy buttons) uses the same projection, and a new event kind or field stays hidden until it is added to the list.

Why it matters: internal notes, severity, other reviewers' decisions or resolution details otherwise reach a reporter through whichever output was forgotten.

Compare with the per-kind participant allowlist in `app/src/lib/feedback/timeline.ts` and the participant projection used by `app/src/lib/feedback/ticket-markdown.ts`.
