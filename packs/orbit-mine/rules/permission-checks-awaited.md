---
id: permission-checks-awaited
title: Asynchronous permission checks are awaited
paths: ["app/src/lib/actions/**", "app/src/app/api/**/route.ts", "app/src/lib/**/access.ts"]
severityFloor: block
sourcePrs: [193, 194, 220]
origin: "past_review_comment_mining.md section 5 rule 36 (secondary evidence, PR #193 commit and PR #220 review fixes)"
---
Every call to an asynchronous permission helper (`canView`, `assertCanActOn`, `requireFeature` and similar) is awaited, and a check whose result is used in a condition is the awaited value, not the promise.

Why it matters: a promise is always truthy, so an un-awaited check lets everyone through while the code looks guarded.
