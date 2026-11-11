---
id: feature-checked-beyond-layout
title: API routes, actions, jobs and pages of a gated feature check it themselves
paths: ["app/src/app/api/**/route.ts", "app/src/lib/actions/**", "app/src/app/(authenticated)/**/page.tsx"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 19"
---
A layout's `requireFeature` does not cover API routes, server actions or background jobs: those call `isFeatureEnabled` for the feature and routes answer 404 when it is off. Because layouts and pages render in parallel, a page that queries the feature's tables awaits `requireFeature` as its first step.

Why it matters: otherwise an office that has the feature switched off can still read or change its data through the API, or a page queries a table before the gate has refused it.

Compare with `announcementsOff` in `app/src/lib/announcements/admin-route.ts` and the checks in `app/src/lib/announcements/release-guard.test.ts`.
