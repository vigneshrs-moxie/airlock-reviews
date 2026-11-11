---
id: outside-lookup-has-time-limit
title: A layout or page that awaits an outside lookup has a time limit and a fallback
paths: ["app/src/app/**/layout.tsx", "app/src/app/**/page.tsx"]
severityFloor: fix
sourcePrs: [77, 109, 126]
origin: "past_review_comment_mining.md section 5 rule 11 (C8)"
---
When a layout, page or server component awaits a lookup in an outside system, the wait has a time limit and a fallback (a generic line, an empty state), so the page still renders when the system is slow or hangs.

Why it matters: a layout wraps every page beneath it, so one slow dependency freezes a whole section of Orbit for everyone using it.

Compare with `app/src/app/(authenticated)/call-activity/layout.tsx`, which waits at most five seconds for the Power BI refresh time and then shows the generic line.
