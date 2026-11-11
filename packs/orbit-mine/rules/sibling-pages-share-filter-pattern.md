---
id: sibling-pages-share-filter-pattern
title: A page keeps the filter and URL pattern its sibling pages use
paths: ["app/src/app/(authenticated)/**", "app/src/components/**"]
severityFloor: ask
sourcePrs: [145, 146, 150]
origin: "past_review_comment_mining.md section 5 rule 18 (C15)"
---
When one page holds a filter or selection differently from its sibling pages (in the address, in browser state, or not kept at all), point out the difference and ask whether the selection should survive a reload, a shared link and a change of period.

Why it matters: a manager who moves between sibling pages expects the same choice to stick, and a link they send a colleague should open the same view.
