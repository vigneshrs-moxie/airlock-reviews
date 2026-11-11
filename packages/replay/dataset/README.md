# Replay dataset

`cases.json` is the ground truth for replaying Airlock on past pull requests in `Moxie-Pest-Control-Phoenix/moxie-portal`. Each case pins a pull request to the exact commits a senior human reviewer saw and lists the problems he raised. Running Airlock at those commits and comparing its findings with the known problems measures how much of a real reviewer's work it would have caught.

It holds three kinds of case:

- `positive`: the reviewer raised problems on GitHub.
- `secondary`: the revert of #14, plus three pull requests whose review happened off GitHub and whose fixes are described in the PR body.
- `negative`: clean approvals, used as a noise check. Approval without comment is weak evidence that nothing was wrong.

Source: `research_notes/AI code review extension research/past_review_comment_mining.md`, checked against GitHub. Load it with `loadCases()`, which validates every record, and select cases with `pickCases()`.

## Case fields

| Field | Meaning |
|---|---|
| `id` | `pr<number>`. |
| `repo` | `owner/name` on GitHub. |
| `pr` | Pull request number. |
| `title` | Pull request title on GitHub. |
| `kind` | `positive`, `secondary` or `negative`. |
| `reviewedAt` | When the reviewer first reviewed. For a negative case it is the approval; for a secondary case with no GitHub review it is the merge date, which can be later than the review. |
| `headSha` | The commit the reviewer reviewed: the review's `commit_id`, or for secondary cases the commit before the review fixes. |
| `baseSha` | The true merge-base of `headSha` and the base branch as it stood at review time, so `git diff baseSha headSha` is the change he saw. |
| `lines` | Additions plus deletions between `baseSha` and `headSha`, from GitHub's compare API. Null when the API caps the file list at 300 and the total is unknown (#171). |
| `known` | The problems the reviewer raised. Empty for negative cases. |

## Known-problem fields

| Field | Meaning |
|---|---|
| `id` | The label in the notes (`C13`, `R-c`), otherwise `<case id>-<n>`. Unique across the whole file. |
| `path`, `line` | Where the comment was attached, at `headSha`. `line` is GitHub's `original_line`, the end line of a range. Both are null for a request in a review body; secondary cases give the file the fix changed and a null line. |
| `summary` | One neutral sentence giving the underlying problem as cause plus consequence. It does not use the reviewer's phrasing or propose the fix. A judge compares a tool's findings with this sentence. |
| `comment` | The reviewer's own words. For secondary cases with no reviewer text on GitHub, it is the author's sentence describing the fix. |
| `reviewerSeverity` | The outcome, not the tag. `change` means code changed because of it; a tagged `[ASK]` or a question that led to a change is still `change`. `question` means he asked and no change followed. `note` means it was accepted as a known limitation. |
| `crossFile` | True when seeing the problem needs a second file besides `path`. |
| `defect` | Optional; `loadCases` fills it in as true when absent. False for a pure question with no underlying code defect, so scoring can report recall over all known problems and over real defects only. |

## Caveats

- `baseSha` is the true merge-base, so it can differ from what GitHub reports for the pull request. A pull request whose recorded base is out of date gets its files and line figures from GitHub against that stale base. #209 is an example: GitHub says 535 lines, but at review time the diff was 428.
- #125 has more than one merge-base with the base branch. A local `git diff baseSha...headSha` picks one of them, so it can differ from GitHub's diff. `git diff baseSha headSha`, two dots, uses the recorded base.
