---
id: feature-seed-arizona-only
title: A new feature is seeded for every entity but switched on for Arizona Operations only
paths: ["app/prisma/migrations/**/migration.sql", "app/src/lib/feature-catalog.ts"]
severityFloor: fix
sourcePrs: [99, 100, 174]
origin: "past_review_comment_mining.md section 5 rule 5 (C4)"
---
A migration that seeds a new gated feature writes one `entity_features` row for every entity, with `enabled` true only where the entity is Arizona Operations (`e.name = 'Arizona Operations'`), and `ON CONFLICT DO NOTHING`. The key's `V1_DEFAULTS` entry is `false`, so entities created later start with it off.

Why it matters: a seed that switches the feature on everywhere launches it to every office at once, before anyone there has agreed to use it.

Compare with `app/prisma/migrations/0121_more_gated_features/migration.sql` and the feature row in `0141_announcements`.
