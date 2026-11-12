# Replay after step 1: what was measured, and what was not

Written 2026-11-11. The replay runs Airlock on past `moxie-portal` pull requests at the commits the senior reviewer saw, withholds the rules that were written from each pull request, and has a judge compare its findings with the problems he raised. The bar set in the design: at least half of his known problems in Airlock's top five, and clean pull requests not given wrong blocking findings.

## The answer in short

| Question | Answer |
|---|---|
| Are at least half of the known problems in the top five? | Yes on what was run: 6 of 9 (67%), from five pull requests. The other 17 known problems were not re-run after the fixes. |
| Do clean pull requests stay clean? | Not measured after the fixes. Before them: no Block on any of eight clean pull requests, but five of the eight got a Fix, which still need a person to say right or wrong. |
| What does a review cost? | $1.70 to $7.10 at list price for these five; about $0.40 to $0.55 per changed file once there are several files. |
| How long does it take? | 1 to 7.5 minutes each at Standard depth. |

## What was run

One run, `opus-small-2`, on the final engine (branch `build/step-1-engine-replay` at 3f690a2): Opus 5.5 for every stage, Standard depth, default settings, two pull requests at a time. It covered the five small positive cases. This was a decision to save time and usage: the full set (21 cases, the three largest pull requests included) would have taken 6 to 8 hours.

| Pull request | Lines | Known problems | In top five | Cost (list) | Time |
|---|---|---|---|---|---|
| #129 collection rate beside reservice | 1,103 | 3 | 3 | $5.94 | 5 min 3 s |
| #146 remove duplicate team filter | 42 | 2 | 2 | $1.68 | 1 min 12 s |
| #128 damage popup | 318 | 1 | 1 | $3.37 | 2 min 57 s |
| #94 copy role templates | 1,285 | 1 | 0 | $4.27 | 3 min 57 s |
| #59 Mission and Joshua's sign-in | 806 | 2 | 0 | $7.08 | 7 min 26 s |
| Total | | 9 | 6 | $22.33 | 12 min 52 s (two at a time) |

Other figures from the same run: 4 of the 5 real defects (leaving out pure questions) were in the top five; 3 of the 5 problems that need a second file to see were in the top five; no review had a failed stage; 17 duplicate findings were merged before the challenge instead of being listed several times.

## What was missed

- **#94**: the five-outcome limit check was rewritten so its boundary reads differently although the behaviour is the same. No lens raised it. It is a readability point, the kind the lenses are told not to fill a review with.
- **#59**, both problems: the company's name written without its possessive in three places, and that the path from inviting a person to their first sign-in was not shown to work for the new domains. No lens raised either. The rules written from this pull request were withheld, as the test requires; with them in place (as they now are for every later pull request) both are covered by rules in `packs/orbit-mine/rules/`.

## What this does not show

- **The earlier, wider run is not comparable.** Before the fix round, 14 cases were run (`opus-standard`): 7 of 10 known problems in the top five, and the clean-case result in the table above. That run's judge could see where each finding was placed and its reviews read today's descriptions, both of which the fix round corrected. On the five pull requests above it scored the same 6 of 9, at $23.70.
- **The three largest pull requests (#100, #126, #171) and #143 were not run on the final engine.** They hold 17 of the 26 known problems. The duplicate findings that showed on large pull requests are what the new merge stage is for; on #59 it merged 11.
- **The clean pull requests were not re-run.** The five Fix findings on clean cases from the earlier run are in `replay-work/opus-standard/report.md` on this Mac (not in git), under "Findings on clean pull requests", for a right-or-wrong mark.
- **The team's rule sheet could not be withheld.** It was written after these reviews, so these numbers may be better than real use. The real test is the next pull requests the senior reviewer comments on: every comment he still writes at PR #2 is a miss to turn into a rule.

## Running more

```
npm run build
npm run airlock-replay -- run --cases positive --run <a new id> --parallel 2     # all nine positives
npm run airlock-replay -- run --cases negative --run <the same id> --parallel 2  # the eight clean ones
npm run airlock-replay -- report replay-work/<id>
```

A run stopped by a usage limit or Ctrl-C continues when the same command is run again. From the per-file cost above, the full set is about $300 to $400 at list price.
