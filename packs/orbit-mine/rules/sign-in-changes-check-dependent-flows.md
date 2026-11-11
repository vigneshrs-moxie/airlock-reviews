---
id: sign-in-changes-check-dependent-flows
title: A change to who may sign in is checked through the invite and onboarding flows that depend on it
paths: ["app/src/app/login/**", "app/src/auth.ts", "app/src/auth.config.ts", "app/src/lib/sign-in-policy.ts", "app/src/lib/onboarding/**", "app/src/components/onboarding/**", "app/src/app/api/employees/onboard/**"]
severityFloor: fix
sourcePrs: [59, 62]
origin: "past_review_comment_mining.md section 5 rule 30 (R-a), second half"
---
When sign-in rules or allowed domains change, the invite and onboarding flows that rely on them are checked too, not only the login page: an invited person from the changed domain can accept the invite, finish onboarding and sign in, and a person the change should keep out still cannot.

Why it matters: a sign-in change that is only tried on the login page can leave invited people unable to get in, or let in people it was meant to refuse, and nobody notices until a new starter is locked out.
