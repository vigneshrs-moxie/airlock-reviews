---
id: people-model-registration-true
title: A new people-bearing model is registered with a true note on how its reads are bounded
paths: ["app/src/lib/people-models.ts", "app/prisma/schema.prisma"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 10"
---
A model with a foreign key to `Profile` is added to `PEOPLE_BEARING_MODELS` with a comment saying how each read of it is bounded, and the queries in the pull request bear that comment out.

Why it matters: the scope check is off in production, so an unbounded read of a new people table shows one office's people to another without any warning.

Compare with the existing entries and their comments in `app/src/lib/people-models.ts`.
