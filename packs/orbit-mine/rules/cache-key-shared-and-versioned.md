---
id: cache-key-shared-and-versioned
title: A page and its warm-up job build the cache key in one place, and a new shape bumps its version
paths: ["app/src/lib/**/*.ts", "app/src/app/**/*.{ts,tsx}"]
severityFloor: fix
sourcePrs: []
origin: "orbit_repo_rules_inventory.md section 6 rule 40"
---
Cached data uses `getCached` with an explicit key, not `unstable_cache`. The page and the cron that warms it import the same key builder and fetcher from one shared module. When the cached payload's shape changes, the key's version is bumped, past both sides' versions after a merge.

Why it matters: a warm-up job that builds a different key warms nothing, so the first person each morning waits for a slow page, and a reused key serves the old shape to new code, which then breaks on it.

Compare with `app/src/lib/calls/dashboard-cache.ts` and `getCached` in `app/src/lib/cache.ts`.
