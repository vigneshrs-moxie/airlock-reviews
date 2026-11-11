---
id: next-server-client-boundaries
title: Client components stay clear of server modules, and route handlers declare how they run
paths: ["app/src/app/**/*.{ts,tsx}", "app/src/components/**/*.tsx"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 41"
---
A `"use client"` file does not import modules that import `db`, `@/lib/auth`, `@/lib/features` or server values from `@/env`; rules shared by both sides live in pure modules such as `feature-catalog.ts` and `phase1.ts`. A new route handler that touches the database exports `runtime = "nodejs"` and `dynamic = "force-dynamic"`, and work after the response runs inside `after()`.

Why it matters: a server import in a client file can break the build or ship server code to the browser, and a detached promise after the response is killed by the platform, so the follow-up work silently never happens.

Compare with the note at the top of `app/src/lib/feature-catalog.ts` and the `after()` call in `app/src/app/api/observations/route.ts`.
