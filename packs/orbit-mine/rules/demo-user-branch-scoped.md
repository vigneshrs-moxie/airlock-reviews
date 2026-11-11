---
id: demo-user-branch-scoped
title: An OR branch that adds demo users back carries its own scope clause
paths: ["app/src/**/*.{ts,tsx}"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 11 (demo users) and section 4.2"
---
People queries filter out `isDevUser`, and when an `OR` branch re-admits demo profiles, that branch has its own entity or scope clause instead of relying on the other branch's.

Why it matters: an unscoped `OR` branch returns demo or real profiles from every office to a viewer who should see only their own.

Compare with the demo-profile handling in `app/src/lib/actions/talent-ratings.ts` and `app/src/lib/view-as.ts`.
