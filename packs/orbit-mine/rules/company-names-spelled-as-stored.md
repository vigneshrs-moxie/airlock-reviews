---
id: company-names-spelled-as-stored
title: Company and office names in text people read are spelled as Orbit stores them
paths: ["app/src/app/login/**", "app/src/lib/sign-in-policy.ts", "app/src/lib/email/**", "app/src/lib/onboarding/**", "app/src/components/onboarding/**", "app/src/components/admin/**"]
severityFloor: fix
sourcePrs: [59, 62]
origin: "past_review_comment_mining.md section 5 rule 30 (R-a), first half"
---
Text people read spells a company or office name exactly as Orbit stores it, letter for letter and with its punctuation. Entity names live in the `entities` table, edited through `app/src/lib/actions/entities-admin.ts`; branch names live in `branches.name`; the branch names the guard test knows are `OFFICE_NAMES` in `app/src/lib/no-hardcoded-offices.test.ts`. A name typed into a label, a message or an email is checked against those, or better, read from them.

Why it matters: a misspelled company name on a sign-in, invite or welcome screen looks wrong to the people of that office on their first day, and it tells them nobody checked.
