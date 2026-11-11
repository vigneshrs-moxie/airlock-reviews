---
id: company-names-and-sign-in-flows
title: Company names are spelled exactly, and sign-in changes are checked through the invite flow
paths: ["app/src/app/login/**", "app/src/auth.ts", "app/src/auth.config.ts", "app/src/lib/sign-in-policy.ts", "app/src/lib/email/**", "app/src/lib/onboarding/**", "app/src/components/onboarding/**", "app/src/components/admin/**", "app/src/app/api/employees/onboard/**"]
severityFloor: fix
sourcePrs: [59, 62]
origin: "past_review_comment_mining.md section 5 rule 30 (R-a)"
---
Check company and office names in text people read against their exact spelling (for example "Joshua's", with the apostrophe). When sign-in rules or allowed domains change, check the invite and onboarding flows that depend on them, not only the login page.

Why it matters: a misspelled company name on the sign-in or invite screen looks wrong to a new office on its first day, and a sign-in change that skips the invite flow can leave invited people unable to get in.
