---
id: feature-route-prefixes-complete
title: A gated feature maps every path it owns, and prefixes do not nest
paths: ["app/src/lib/feature-catalog.ts", "app/src/app/(authenticated)/**/layout.tsx", "app/src/lib/features-routes.test.ts"]
severityFloor: block
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 18"
---
A new route folder for a gated feature has its own prefix in `ROUTE_FEATURES`, including sibling paths such as `/calibration-p2` (a prefix covers only itself and paths under it, never a longer name), a `layout.tsx` that calls `requireFeature` with the same key the route map names, and an entry in `GOVERNED_PREFIXES` in the guard test.

Why it matters: a sibling path left out of the map is open to every office and role, including offices that never switched the feature on.

Compare with `ROUTE_FEATURES` and `featureForPath` in `app/src/lib/feature-catalog.ts`.
