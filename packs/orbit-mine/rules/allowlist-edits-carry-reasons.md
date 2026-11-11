---
id: allowlist-edits-carry-reasons
title: Additions to exemption lists and allowlists carry a reason that is true
paths: ["app/src/lib/**/*.test.ts", "app/src/app/api/**/*.test.ts", "app/src/lib/phase1.ts", "app/src/lib/evaluator.ts", "app/src/middleware.ts", "**/trufflehog-exclude.txt"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 20"
---
An addition to `DELIBERATELY_UNGOVERNED`, an `ALLOWED` or `GUARDED` set in a guard test, `PHASE1_ALLOWED_PREFIXES`, `EVALUATOR_ALLOWED_PREFIXES`, the middleware allowlist or `.github/trufflehog-exclude.txt` states its reason, and the reviewer checks that reason against the code rather than taking it as context.

Why it matters: an exemption whose reason is no longer true switches off the guard for exactly the case it was built to catch, as when a page marked "not shown to anyone" was in fact linked for every admin.

Compare with the reasons kept beside each entry in `app/src/lib/features-routes.test.ts`.
