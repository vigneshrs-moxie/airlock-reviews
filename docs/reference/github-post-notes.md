# Posting to GitHub and merging by machine: what was checked before step 3

Checked on 2026-11-11 on this Mac (`gh` 2.102.0, git 2.50.1). Nothing here was learned by writing to GitHub: the build never posts. Where a fact could only be had by posting, it is listed under "Not confirmed" and the code treats it as something GitHub may refuse.

## Creating a review

From GitHub's REST documentation, "Create a review for a pull request" (`POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`):

| Field | What the documentation says |
|---|---|
| `commit_id` | The commit to review. Defaults to the pull request's latest commit when left out. Airlock always sends the reviewed head. |
| `body` | The review's text. Required when `event` is `COMMENT` or `REQUEST_CHANGES`. |
| `event` | `APPROVE`, `REQUEST_CHANGES` or `COMMENT`. Left out, the review stays pending (not submitted). Airlock always sends `COMMENT`. |
| `comments[]` | `path` and `body` are required. `line` and `side` place a comment on a line of the diff (`RIGHT` for added and context lines, `LEFT` for deleted ones); `start_line` and `start_side` make it cover a range. `position` is the older way and is not used. |

Status codes: 200 with the review (`id`, `html_url`, `state`, `submitted_at`), 403, and 422 ("Validation failed, or the endpoint has been spammed"). Creating a review sends notifications. Creating content quickly can meet GitHub's secondary rate limits, which is one reason Airlock never retries.

The single-comment endpoint (`POST .../pulls/{n}/comments`) says of `line`: "The line of the blob in the pull request diff that the comment applies to", and of `commit_id` that a commit other than the latest may leave the comment outdated. So a comment's line must be a line the diff shows, and Airlock refuses to post from a review of an older commit.

## How `gh api` reports an HTTP error

Measured with a read of a pull request number that does not exist:

```
$ gh api repos/<owner>/<repo>/pulls/999999
exit code: 1
standard output: {"message":"Not Found","documentation_url":"...","status":"404"}
standard error:  gh: Not Found (HTTP 404)
```

So a refusal by GitHub is: exit code 1, a JSON body on standard output with `message` (and, for validation failures, an `errors` list), and `(HTTP <status>)` at the end of the first line of standard error. An exit code other than 0 with no `(HTTP <status>)` on standard error (a cut connection, a timeout, DNS) is not a refusal: GitHub may or may not have acted.

## Not confirmed (needs a real post, which the build does not make)

- Whether the author of a pull request may submit a `COMMENT` review with inline comments on their own pull request. GitHub's interface allows it and the documentation does not forbid it; approving or requesting changes on one's own pull request is what GitHub refuses. If it is refused, the panel shows GitHub's sentence and nothing is posted.
- The exact wording of the 422 for a line that is not part of the diff. The engine only places a comment inline on a line its own diff shows as added or context, and a refusal moves nothing: the person can put that comment in the summary and post again.

To look at on the first real post: that the review appears once, with each inline comment on its line, and that `Open on GitHub` leads to it.

## The merge git makes by itself

Measured in a throwaway repository (a branch and its base both change the same line; the merge commit resolves it by hand and also changes another file):

- `git merge-tree --write-tree --no-messages <parent 1> <parent 2>` prints the id of a tree on its first line. With conflicts the exit code is 1, the files that conflicted follow on later lines, and the tree holds those files with conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`). A clean merge exits 0 and prints only the tree id.
- An argument that is not a commit also exits 1, with a message and no tree id. So exit code 0 or 1 is an answer only when the first line is a full object id that `git cat-file -t` calls a tree.
- `git commit-tree <tree> -p <parent 1> -m <text>` with the author, the committer and both dates fixed gives the same commit id every time, and creates no ref.
- `git diff <that commit> <the merge commit>` shows exactly what was done by hand: the conflict markers removed and the chosen lines added, and the other file's hand-made change. Files git merged by itself do not appear.
