---
id: outside-values-not-assumed-fixed
title: Values from a spreadsheet or the lakehouse are not assumed to be a fixed set
paths: ["app/src/components/**", "app/src/lib/queries/**", "app/src/lib/actions/**", "app/src/app/(authenticated)/**"]
severityFloor: ask
sourcePrs: [106, 127, 128]
origin: "past_review_comment_mining.md section 5 rule 13 (C9)"
---
When logic branches on a string that comes from a spreadsheet, the Fabric lakehouse or another outside source (a status, a stage, a category), ask whether the set of values is fixed and what the code does with a value it does not know. An unknown value should land somewhere visible, not in the wrong bucket.

Why it matters: a status someone types differently in the source sheet would otherwise be shown or counted as the wrong thing, and the people reading the page would not know.
