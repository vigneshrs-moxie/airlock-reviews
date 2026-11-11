---
id: restored-drafts-revalidated
title: A restored draft is checked against what the server holds now
paths: ["app/src/components/**", "app/src/app/(authenticated)/**", "app/src/lib/actions/**"]
severityFloor: fix
sourcePrs: [170, 177]
origin: "past_review_comment_mining.md section 5 rule 34 (secondary evidence, PR #177 review fixes)"
---
When a form restores a draft or cached input from local storage, it checks the draft against the server's current state before using it: the person is still on the list, the values have not been changed elsewhere since, and a second open tab cannot overwrite the first.

Why it matters: a stale draft can write old ratings over newer ones, or block a submit with a card the person can no longer see.
