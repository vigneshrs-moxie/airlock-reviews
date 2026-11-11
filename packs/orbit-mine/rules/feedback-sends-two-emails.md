---
id: feedback-sends-two-emails
title: Portal Feedback sends its two emails and no others
paths: ["app/src/lib/feedback/**", "app/src/app/api/feedback/**"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 34"
---
Portal Feedback emails only on a new submission (to the recipients list) and to the reporter when their ticket is finished. Comments, mentions, watching, reviews and grants send no email, and a mention grants access only when a tech user writes it in a shared comment.

Why it matters: an extra notification path mails people who never asked for it, and a mention that grants access by accident opens a ticket to someone it was not shared with.

Compare with the email section of `docs/portal-feedback/README.md` and `resolveMentions` in `app/src/lib/feedback/mentions.ts`.
