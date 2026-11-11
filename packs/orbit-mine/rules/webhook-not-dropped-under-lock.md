---
id: webhook-not-dropped-under-lock
title: A webhook that arrives during a run is not lost
paths: ["app/src/lib/integrations/**", "app/src/app/api/**/webhook/**"]
severityFloor: fix
sourcePrs: [142, 152, 165, 166, 167, 168, 171, 172, 203, 204]
origin: "past_review_comment_mining.md section 5 rule 22 (C18)"
---
When a webhook handler answers 200 but skips the work because a lock is held, the event must still be picked up: mark the resource for the next run, and lock per resource rather than globally. A manual "Sync now" path takes the same lock as the scheduled one.

Why it matters: the sender does not resend after a 200, so the change it reported is lost, or two runs on the same link post the same thing twice.

Compare with the per-link lock and the pick-up-next-run marker in `app/src/lib/integrations/clickup/`.
