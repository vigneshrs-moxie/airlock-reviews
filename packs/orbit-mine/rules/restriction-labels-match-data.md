---
id: restriction-labels-match-data
title: Text that promises a restriction matches the data behind it
paths: ["app/src/components/**", "app/src/lib/**/mentions.ts", "app/src/lib/feedback/**", "app/src/app/(authenticated)/**"]
severityFloor: ask
sourcePrs: [142, 152, 165, 166, 167, 168, 171, 172, 203, 204]
origin: "past_review_comment_mining.md section 5 rule 25 (C22, C23)"
---
When interface text promises a restriction ("only what a reporter may read", "private to you"), check that the data behind that control honours it. When an identity or a field is hidden on one surface, check that new pickers, mention lists, comments and summaries do not show it, or ask whether showing it there is intended.

Why it matters: people trust the label, so a copy or a picker that reveals more than it says exposes information the person meant to keep back.
