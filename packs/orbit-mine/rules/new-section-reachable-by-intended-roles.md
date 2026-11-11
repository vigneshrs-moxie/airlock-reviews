---
id: new-section-reachable-by-intended-roles
title: A new section is reachable by the departments and roles it is meant for
paths: ["app/src/lib/nav.ts", "app/src/middleware.ts", "app/src/lib/phase1.ts", "app/src/lib/evaluator.ts", "app/src/lib/auth-permissions.ts", "app/src/app/(authenticated)/**/layout.tsx"]
severityFloor: fix
sourcePrs: [13, 14, 15, 16, 17, 18, 20]
origin: "past_review_comment_mining.md section 5 rule 29 (R-c, the revert of #14); orbit_repo_rules_inventory.md section 6 rule 22 (lockdown lists)"
---
When a change adds a nav entry, a route group or a section, check that the gates on the route (the middleware, the layout, the department and role checks) admit every department and role meant to use it, in every mode: while `NEXT_PUBLIC_PHASE_1` is on, a page non-admins must reach is in `PHASE1_ALLOWED_PREFIXES`, each sibling path separately, and in the evaluator list if evaluators should see it.

Why it matters: admins pass every lockdown, so testing as an admin shows the page working while the people it was built for are redirected away.

Compare with `PHASE1_ALLOWED_PREFIXES` in `app/src/lib/phase1.ts` and `EVALUATOR_ALLOWED_PREFIXES` in `app/src/lib/evaluator.ts`.
