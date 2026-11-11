---
id: tokens-read-only-expiring-revocable
title: API tokens stay read-only, expire, and can be revoked by an admin
paths: ["app/src/app/api/feedback/**", "app/src/app/api/mcp/**", "app/src/mcp/**", "app/src/lib/feedback/**", "app/src/app/api/**/tokens/**", "app/src/middleware.ts"]
severityFloor: block
sourcePrs: [142, 152, 165, 166, 167, 168, 171, 172, 203, 204]
origin: "past_review_comment_mining.md section 5 rule 23 (C19); orbit_repo_rules_inventory.md section 6 rule 33"
---
A long-lived credential such as a feedback API token has a capped lifetime (7, 30 or 90 days, never "no expiry"), only its hash is stored, an admin can revoke anyone's token, and its scope is no wider than its holder needs. Tokens and the MCP endpoint stay read-only: no non-GET handler under `api/feedback/v1/`, no MCP tool that writes, no new write scope, and the middleware admits a token only for GET on the v1 routes and POST on the MCP endpoint.

Why it matters: a credential that never runs out, or that only its owner can cancel, stays usable long after its owner has left or it has been copied somewhere it should not be.

Compare with the lifetime choices in `app/src/app/api/feedback/tokens/route.ts` and the token decision in `app/src/middleware.ts`.
