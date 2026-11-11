---
id: decisions-recorded-with-code
title: A decision the code depends on is recorded in the same pull request
paths: ["app/src/lib/feedback/**", "app/src/app/api/feedback/**", "app/prisma/migrations/**/migration.sql", "**/docs/**"]
severityFloor: note
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 48"
---
A decision the code depends on is written as `docs/decisions/YYYY-MM-DD-short-title.md` in the same pull request. A Portal Feedback behaviour or access change updates `docs/portal-feedback/README.md`, including its migration table and access section, and a new environment flag appears in its table.

Why it matters: the next person to change the code reads the docs first, and a decision that lives only in a comment or a chat is undone by accident.

Compare with `docs/decisions/README.md`.
