---
id: access-changes-have-refusal-tests
title: Access and scope changes come with refusal tests, and the visibility baseline changes only on purpose
paths: ["app/src/lib/scope*.ts", "app/src/lib/**/access.ts", "app/src/lib/feedback/tracker-sql.ts", "app/src/test/visibility/**"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 43"
---
A change to scope, access or tracker SQL comes with a DB test under `app/src/test/` that uses both fixture entities and includes a refusal for the other office and for a lower role, and the pull request says the DB tests were run and how, because CI does not run them. `__baselines__/visibility.json` changes only with a stated, intended change to who sees what.

Why it matters: a baseline re-recorded to make a failing test pass hides a visibility leak from every later review.

Compare with `app/src/test/visibility/baseline.dbtest.ts` and the guidance in `app/src/test/README.md`.
