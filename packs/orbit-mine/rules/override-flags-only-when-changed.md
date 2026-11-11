---
id: override-flags-only-when-changed
title: Manual override flags are set only for fields that actually changed
paths: ["app/src/lib/actions/**", "app/src/app/api/employees/**"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 27"
---
A manual edit to a person's manager or department sets `managerOverride` or `departmentOverride` only for the field whose value changed, and builds the patch through `buildHierarchyPatch` so unchanged fields are left out.

Why it matters: an override permanently stops the Paylocity sync for that field, so a save that sets it needlessly leaves the person's record frozen while HR's changes are ignored.

Compare with `buildHierarchyPatch` in `app/src/lib/actions/people-relations.ts`.
