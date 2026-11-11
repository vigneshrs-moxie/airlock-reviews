---
id: scope-axis-fits-operation
title: Each scope call uses the axis that fits the operation
paths: ["app/src/**/*.{ts,tsx}"]
severityFloor: block
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 12"
---
Read the axis argument at every new `scopeWhere` and `assertInScope` call: lists of people's records use `people`; pickers and writes for rating, observing and evaluating use `act`; role and template administration uses `assertInScope(..., "people")`; org-chart edits use `act` on purpose.

Why it matters: the wrong axis silently narrows a write to a manager's downline, so a lead cannot rate someone they should, or widens a read to the whole office, so a manager sees records outside their team.

Compare with the axis choices in `app/src/lib/actions/people-relations.ts` and the notes in `app/src/lib/scope.ts`.
