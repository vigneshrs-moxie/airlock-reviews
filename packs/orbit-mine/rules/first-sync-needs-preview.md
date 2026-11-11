---
id: first-sync-needs-preview
title: A sync that can overwrite another system starts with a preview, and its ledgers survive a relink
paths: ["app/src/lib/integrations/**", "app/src/app/api/integrations/**", "app/prisma/migrations/**/migration.sql"]
severityFloor: block
sourcePrs: [142, 152, 165, 166, 167, 168, 171, 172, 203, 204]
origin: "past_review_comment_mining.md section 5 rule 26 (C21)"
---
When a sync can overwrite fields in an outside system and has no stored baseline for a record, its first run for that record happens only when a person triggers it after a preview, never from a nightly job or a webhook. "Already sent" ledgers are keyed on stable business identity (for example ticket plus task), not on a link row id that unlinking and relinking recreate.

Why it matters: an unattended first run can replace work someone wrote in the other system, and a relink can post every comment and file again.

Compare with `app/src/lib/integrations/clickup/planner.ts`, where the first sync of a hand-linked task runs only from "Sync now" after the preview.
