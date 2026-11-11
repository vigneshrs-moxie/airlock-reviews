---
id: server-validates-and-recomputes
title: The server validates input and derives scores, totals and actors itself
paths: ["app/src/app/api/**/route.ts", "app/src/lib/actions/**"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 42"
---
A new route parses its body with Zod (`parseBody` or `safeParse`) and bounds its sizes, and ids are checked as UUIDs before a lookup. Scores, totals, statuses, author ids, approver ids and entity ids are derived on the server, never taken from the request.

Why it matters: a request that supplies its own score or author can record a rating someone did not give, or an action in someone else's name.

Compare with the server-side score recalculation in `app/src/app/api/observations/route.ts` and the validation helpers in `app/src/lib/feedback/api.ts`.
