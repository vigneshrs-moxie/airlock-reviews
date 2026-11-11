---
id: value-lists-match-sql-checks
title: A value list kept in both SQL and TypeScript changes in both places
paths: ["app/prisma/migrations/**/migration.sql", "app/src/lib/**/*.ts"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 9"
---
When a `CHECK (col IN (...))` constraint or a Postgres enum has a TypeScript twin (a constant array or a union type), both change in the same pull request and hold the same values.

Why it matters: a value the code allows but the database rejects fails the save in front of the person who chose it, and a value the database allows but the code does not know shows up as blank or wrong.

Compare with `app/src/lib/announcements/schema-sync.test.ts`, which pins the announcement value sets to their SQL checks.
