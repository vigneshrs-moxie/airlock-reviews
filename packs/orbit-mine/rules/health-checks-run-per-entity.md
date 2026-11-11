---
id: health-checks-run-per-entity
title: Warnings and empty-data checks run per entity and name the entity
paths: ["app/src/lib/**/*.ts", "app/src/app/api/**/route.ts"]
severityFloor: fix
sourcePrs: [77, 108, 109, 126, 129, 130, 131, 134]
origin: "past_review_comment_mining.md section 5 rules 12 and 15 (C7, C11, C12)"
---
A warning, alarm or "no data" check runs over each entity's own people, not over the whole company, and its log line names the entity, the count of people and the period. A constant, dataset or key named after one office (`ARIZONA_*`) is not used for every office, and a "how to check on staging" step must also work for an office other than Arizona.

Why it matters: when the next office goes live, its figures can all be blank while Arizona's keep the warning quiet, so nobody learns that the new office sees nothing.

Compare with `app/src/lib/queries/field-collection-rate.ts`, where the missing-figures warning runs per office after the last-month fallback.
