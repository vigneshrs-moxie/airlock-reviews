# Airlock · build brief

Hi-fi prototype. Drawn from the idea alone; no repository was read.

## Based on

- `reports/AI code review extension research.md`
- `research_notes/AI code review extension research/moxie-review-kit-copy/skills/moxie-review/SKILL.md`
- `research_notes/AI code review extension research/moxie-review-kit-copy/skills/moxie-review/profile.md`
- `research_notes/AI code review extension research/moxie-review-kit-copy/skills/moxie-review/orbit.md`
- `research_notes/AI code review extension research/moxie-review-kit-copy/skills/moxie-review/calibration.md`
- `research_notes/AI code review extension research/chrome_extension_github_integration.md`
- `research_notes/AI code review extension research/past_review_comment_mining.md`

## Screens

- **Ready** (laptop, screen) `github.com/…/moxie-portal/pull/231` → packs, running
- **Running** (laptop, screen) `github.com/…/moxie-portal/pull/231` → packs, verdict
- **Verdict** (laptop, screen) `github.com/…/moxie-portal/pull/231` → dropped, finding-1, finding-2, finding-3, finding-4, finding-5, packs, post-all, pushed
- **Finding 1** (laptop, screen) `github.com/…/moxie-portal/pull/231` → dismiss, finding-1, finding-2, packs, post-1
- **Finding 2** (laptop, screen) `github.com/…/moxie-portal/pull/231` → dismiss, finding-1, finding-2, finding-3, packs, post-2
- **Finding 3** (laptop, screen) `github.com/…/moxie-portal/pull/231` → dismiss, finding-2, finding-3, finding-4, packs, post-3
- **Finding 4** (laptop, screen) `github.com/…/moxie-portal/pull/231` → dismiss, finding-3, finding-4, finding-5, packs, post-4
- **Finding 5** (laptop, screen) `github.com/…/moxie-portal/pull/231` → dismiss, finding-4, finding-5, packs
- **After a push** (laptop, screen) `github.com/…/moxie-portal/pull/231` → finding-1, finding-2, finding-3, finding-4, finding-5, packs, verdict2
- **Ready for PR #2** (laptop, screen) `github.com/…/moxie-portal/pull/231` → finding-1, finding-2, finding-3, finding-4, finding-5, packs
- **Packs and settings** (laptop, screen) `github.com/…/moxie-portal/pull/231` → offline
- **Service not running** (laptop, screen) `github.com/…/moxie-portal/pull/231` → verdict
- **Dismiss** (laptop, overlay) ``
- **Post preview** (laptop, overlay) ``
- **Post preview** (laptop, overlay) ``
- **Post preview** (laptop, overlay) ``
- **Post preview** (laptop, overlay) ``
- **Post all selected** (laptop, overlay) ``
- **Dropped findings** (laptop, overlay) ``

## Requirements

- Airlock opens as a panel beside any GitHub pull request and says which stage the PR is at.
- The Orbit pack switches on by itself for moxie-portal and can be switched off. Every other repo gets the generic rules.
- Three depths: Quick, Standard and Deep. Standard is the default, and small PRs run Quick.
- While it runs, the panel shows each step in words, and shows what the PR does and which files to read before the findings are ready.
- A verdict in words, then at most five ranked findings. Each has a severity word, what happens to a real person, the file and line, and which pack raised it.
- Every other finding that held up is under Also found. Dropped ones are listed with the reason.
- Opening a finding jumps the GitHub page to its line.
- A fix prompt can be copied for one finding or for all selected ones.
- A finding can be dismissed as Wrong, Intended or Not now. Wrong and Intended are saved to your pack and used from the next review.
- The brief holds the claims check, questions, checks for staging and the self-review text for the PR body.
- Nothing is written to GitHub until you click Post, and you see the exact text first.
- One comment or all selected can be posted in one go. Airlock never approves or merges.
- When the PR has new commits, the panel offers to re-review only what changed.
- Each earlier finding is marked Fixed or Still open, and the verdict is updated.
- Raj's standard is loaded as it is and kept in step with his repo. Your pack is separate, and everything learned from dismissals can be undone.
- If the service on this Mac is not running, the panel says so and how to start it.

## Decisions

- How does a finding show up in the diff?
- What does Post do?
- When does a review start?

## Questions to settle

- Lint, type-check and tests are not run by Airlock in the first version. That is how I read your answer; say if you meant it should run them.
- The diff markers come after the panel in the build order, whichever option you pick.
- Review times shown here are targets until the first real runs are measured.
