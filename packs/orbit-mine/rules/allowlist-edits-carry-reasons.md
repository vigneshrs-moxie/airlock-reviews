---
id: allowlist-edits-carry-reasons
title: Additions to a guard test's allowlist carry a reason that is true
paths: ["app/src/lib/features-routes.test.ts", "app/src/lib/no-hardcoded-offices.test.ts", "app/src/lib/visible-ids-literal.test.ts", "app/src/lib/team-side-consistency.test.ts", "app/src/lib/people-models.test.ts", "app/src/app/api/cron-methods.test.ts", "app/src/lib/entities/operator-guards.test.ts", "app/src/lib/announcements/release-guard.test.ts", "app/src/lib/announcements/schema-sync.test.ts", "app/src/lib/migrations/tracing.test.ts", "app/src/lib/calls/dashboard-cache.test.ts", "**/trufflehog-exclude.txt"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 20 and section 3.5"
---
An entry added to an exemption or allowlist in one of the structural guard tests (`DELIBERATELY_UNGOVERNED`, `ALLOWED`, `GUARDED`, `READS` and similar), or to the secret scanner's `.github/trufflehog-exclude.txt`, states its reason beside it, and the reviewer checks that reason against the code it exempts rather than taking it as context. A guard whose check is loosened (a pattern narrowed, a file list shortened) is treated the same way.

Why it matters: an exemption whose reason is no longer true switches the guard off for exactly the case it was built to catch, as when a page marked "not shown to anyone" was in fact linked for every admin.

Compare with the reasons kept beside each entry in `app/src/lib/features-routes.test.ts` and `app/src/lib/no-hardcoded-offices.test.ts`.
