---
id: external-writes-gated
title: Writes to another system are off by default and need an exact value to switch on
paths: ["app/src/lib/integrations/**", "app/src/lib/calls/**", "app/src/lib/task-distribution/**", "app/src/env.ts"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 35"
---
A write to FieldRoutes, ClickUp or any other outside system sits behind an environment gate that is off by default and switches on only for one exact value (as `FIELDROUTES_NOTES_DRY_RUN === "false"` or `CLICKUP_SYNC_WRITES === "on"` do); anything else runs as a recorded dry run. Each write has a timeout and bounded retries and respects the provider's rate limit. The GitHub and Fabric clients stay read-only, and non-production deployments do not run the GitHub or ClickUp sync.

Why it matters: a gate that treats a typo or an unset value as "on" writes into the CRM or ClickUp from staging or a laptop, and those changes reach real customers and colleagues.

Compare with the writer in `app/src/lib/integrations/clickup/deps.ts` and the gates described in `app/src/env.ts`.
