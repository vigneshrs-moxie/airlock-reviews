---
id: sibling-pages-share-filter-pattern
title: A page keeps the filter and URL pattern its sibling pages use
paths: ["app/src/app/(authenticated)/**", "app/src/components/**"]
severityFloor: ask
sourcePrs: [145, 146, 150]
origin: "past_review_comment_mining.md section 5 rule 18 (C15)"
---
When one page changes how a filter or selection is held (for example moving it from a URL parameter such as `?team=` to state in the browser), while sibling pages keep the old pattern, point out the difference and ask whether the selection should survive a reload, a shared link and a change of month or period.

Why it matters: a manager who moves between sibling pages expects the same choice to stick, and a link they send a colleague should open the same view.
