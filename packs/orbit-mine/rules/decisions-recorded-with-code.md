---
id: decisions-recorded-with-code
title: A decision the change relies on is written down in the same pull request
paths: ["app/src/lib/feedback/**", "app/src/app/api/feedback/**", "app/src/env.ts", "app/src/lib/feature-catalog.ts", "app/prisma/migrations/**/migration.sql"]
severityFloor: note
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 48"
---
Look in the changed files for three things. An added comment that cites a decision ("per decision 23", "D-020", "decided with ops") needs a matching `docs/decisions/YYYY-MM-DD-short-title.md` in the repository or in this diff. A change to Portal Feedback behaviour or access under `app/src/lib/feedback/` or `app/src/app/api/feedback/` needs `docs/portal-feedback/README.md` in the diff, including its migration table when a feedback migration is added. A new flag in `app/src/env.ts` that Portal Feedback reads needs a row in that README's flag table.

Why it matters: the next person to change the code reads the docs first, and a decision that lives only in a comment is undone by someone who never saw it.

Compare with `docs/decisions/README.md`.
