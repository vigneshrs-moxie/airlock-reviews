---
id: control-keyed-where-enforced
title: A control is stored under the same entity it is enforced under
paths: ["app/src/lib/actions/**", "app/src/app/api/**/route.ts", "app/src/lib/**/*.ts"]
severityFloor: fix
sourcePrs: [141, 143, 149, 173]
origin: "past_review_comment_mining.md section 5 rule 16 (C13)"
---
When a control (a freeze, a lock, a setting, a cut-off) is saved under the acting admin's entity but checked against the affected person's entity, flag the mismatch. Check the case of an admin in a parent entity, that the entities an admin picks are validated on the server against the admin's own subtree, and that a write covering several entities is one transaction.

Why it matters: an admin in a parent office can switch the control on, see it reported as on, and the people in the child office carry on as if nothing happened.

Compare with `app/src/lib/actions/talent-rating-freeze.ts`, where each rating is locked by the rated person's entity and the freeze lists the entities it covers.
