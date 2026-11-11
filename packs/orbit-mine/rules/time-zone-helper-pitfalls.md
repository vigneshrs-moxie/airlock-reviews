---
id: time-zone-helper-pitfalls
title: Arizona-time values and FieldRoutes timestamps are read the way their helpers require
paths: ["app/src/lib/**/*.ts", "app/src/app/**/*.{ts,tsx}"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 39"
---
Values returned by `app/src/lib/tz.ts` are shifted dates and are read with the `getUTC*` methods only. Timestamps sent to or read from the FieldRoutes API use `FIELDROUTES_API_TIMEZONE` (Pacific) for every branch. A day boundary that spans offices in other zones goes through `app/src/lib/zoned-time.ts` with `YYYY-MM-DD` strings, and formatting passes an explicit `timeZone`.

Why it matters: reading a shifted date with local getters, or a FieldRoutes time as Arizona time, moves calls, visits and deadlines to the wrong hour or day in reports people act on.

Compare with the module notes in `app/src/lib/tz.ts`, `app/src/lib/zoned-time.ts` and `app/src/lib/calls/fieldroutes-notes.ts`.
