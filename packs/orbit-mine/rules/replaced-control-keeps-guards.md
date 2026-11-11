---
id: replaced-control-keeps-guards
title: A replaced control keeps the conditions the old one had
paths: ["app/src/app/(authenticated)/**", "app/src/components/**"]
severityFloor: fix
sourcePrs: [145, 146, 150]
origin: "past_review_comment_mining.md section 5 rule 17 (C14)"
---
When a change removes or replaces a control (a toggle, a filter, a button group), list the conditions under which the old control hid itself, disabled itself or refused, and check that the replacement keeps each of them.

Why it matters: without the old guard, people get an empty or misleading option, such as a filter button that leads to a list with nobody in it.

Compare with `showTeams` in `app/src/components/talents/detailed-scores-table.tsx`, which shows the team buttons only when both sides have rated people.
