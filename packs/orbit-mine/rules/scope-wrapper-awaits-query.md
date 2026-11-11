---
id: scope-wrapper-awaits-query
title: A scope wrapper awaits the query inside it and states a true reason
paths: ["app/src/**/*.{ts,tsx}"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 11 and section 2.1 (app/src/test/README.md)"
---
A query run inside `withoutScope("reason", ...)` or a similar wrapper is awaited inside the callback, because Prisma queries are lazy and a returned promise runs after the wrapper has ended. The reason string describes what this query actually does.

Why it matters: a query that escapes its wrapper runs under the wrong scope rules, and a reason that does not match the query hides an unscoped read from the next reviewer.

Compare with the `withoutScope` examples in `app/src/test/README.md` and `app/src/lib/scope-context.ts`.
