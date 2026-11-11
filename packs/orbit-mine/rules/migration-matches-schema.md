---
id: migration-matches-schema
title: The SQL migration and the Prisma model agree field by field
paths: ["app/prisma/schema.prisma", "app/prisma/migrations/**/migration.sql"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 3"
---
For each table and column the migration adds or changes, the hand-written model in `schema.prisma` matches it: the mapped name (`@map`, `@@map`), the type, nullability, the default, the foreign key's delete behaviour, and the names of unique indexes and constraints the SQL declares.

Why it matters: Prisma trusts the model, so a mismatch is an error on the first query that touches the field, in front of whoever opened the page.

Compare with the `TalentRatingFreeze` model and `app/prisma/migrations/0140_talent_rating_freezes/migration.sql`, which name their constraints the same way.
