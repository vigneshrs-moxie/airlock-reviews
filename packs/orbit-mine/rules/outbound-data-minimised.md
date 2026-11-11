---
id: outbound-data-minimised
title: Only shared content leaves Orbit for an outside system
paths: ["app/src/lib/integrations/**", "app/src/app/api/integrations/**"]
severityFloor: block
sourcePrs: [142, 152, 165, 166, 167, 168, 171, 172, 203, 204]
origin: "past_review_comment_mining.md section 5 rule 21 (C18)"
---
When a change sends Orbit content to an outside system, list the kinds of data that go (internal notes, attachments, screenshots, customer names or phone numbers). By default only shared content is sent and attachments are not, and the change accepts that deleting something in Orbit does not delete the outside copy.

Why it matters: an internal note or a customer's screenshot copied into a tool like ClickUp is read by people Orbit never meant to show it to, and it stays there after Orbit deletes it.

Compare with `app/src/lib/integrations/clickup/comments.ts`, which sends shared comments only and no attachments.
