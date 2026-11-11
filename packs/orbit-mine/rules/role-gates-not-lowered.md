---
id: role-gates-not-lowered
title: Roles are added to the hierarchy and gates are not lowered to admit them
paths: ["app/src/lib/auth.ts", "app/src/lib/auth-permissions.ts", "app/src/lib/api-auth.ts", "app/src/app/api/**/route.ts", "app/src/lib/actions/**"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 25"
---
Capability is checked with `requireRole` or `ROLE_HIERARCHY`, and a new role is added to `ROLE_HIERARCHY`. Evaluators are member level and are admitted by name (`authenticateApiRequest(min, { alsoAllow: "evaluator" })`), never by lowering a gate to `member`. Role grants stay within `canGrantRole`: no one grants `admin` or `evaluator` without being an admin, and no one changes their own role.

Why it matters: lowering a gate to let one role in also lets every member in, and a loosened grant rule lets a manager promote themselves.

Compare with `app/src/lib/api-auth.ts` and `canGrantRole` in `app/src/lib/auth-permissions.ts`.
