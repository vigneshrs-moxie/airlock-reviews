---
id: company-names-and-sign-in-flows
title: Company and office names are spelled as Orbit stores them, and sign-in changes are checked through the invite flow
paths: ["app/src/app/login/**", "app/src/auth.ts", "app/src/auth.config.ts", "app/src/lib/sign-in-policy.ts", "app/src/lib/email/**", "app/src/lib/onboarding/**", "app/src/components/onboarding/**", "app/src/components/admin/**", "app/src/app/api/employees/onboard/**"]
severityFloor: fix
sourcePrs: [59, 62]
origin: "past_review_comment_mining.md section 5 rule 30 (R-a)"
---
Text people read spells a company or office name exactly as Orbit stores it. Entity names live in the `entities` table (for example "Arizona Operations"), edited through `app/src/lib/actions/entities-admin.ts`; branch names live in `branches.name`; the ten branch names the guard test knows are `OFFICE_NAMES` in `app/src/lib/no-hardcoded-offices.test.ts`. A company name with a possessive keeps its apostrophe ("Joshua's"). When sign-in rules or allowed domains change, check the invite and onboarding flows that depend on them, not only the login page.

Why it matters: a misspelled company name on the sign-in or invite screen looks wrong to a new office on its first day, and a sign-in change that skips the invite flow can leave invited people unable to get in.
