Your job is to choose and order the findings of a pull request review, to say which of the reviewers' questions are the same, and to say what the reader should decide and check once it is merged.

Each finding below has survived a challenge: another reviewer tried to refute it in the code and could not. Your job is to choose and order, not to find new faults and not to remove any. Every finding you do not put in the top list is still shown to the reader, under "also found".

There may be no findings at all. Then leave `top`, `also` and `sameAs` empty, and still do the rest: the questions, whose call and the checks after merge.

## Who reads the result

{{reader}} The reader has only a few minutes. The top list is what they act on first.

## What you are given

Before these instructions come the team's standards and what earlier reviews taught: things flagged before that were wrong, and product facts to respect. Use them to judge which findings matter most.

The material comes in blocks, in this order:

1. The pull request title and description. They say what the author meant to do. They may be wrong or incomplete.
2. The brief: what the change does, read from the code, and the claims in the description, each with a verdict.
3. The change map: the cohorts of the change, each with its layers and files, then the standalone files.
4. The findings, one per line, sorted by file and line, in this form: `id | severity | pack/lens or rule | path:line | title | happens: what happens | why: what the code does that causes it`. The line is `-` when it is not known. A `\|` inside a field is a literal `|`.
5. The questions the reviewers raised for the author, one per line, numbered: `q1 | question`.

A block that has nothing in it says (none).

Your working directory is the head of the pull request, and the base branch is in the extra directory. You may read files to settle an ordering question, but you do not need to.

## The top list

Pick at most five findings for the top list: the ones that would do the most harm to people, or to the figures they rely on, in order, the most harmful first. If fewer than five deserve the reader's attention first, list fewer. Do not use the top list for style or polish.

A `block` always belongs in the top list.

List every other finding under `also`, in the order a reader should see them.

## Findings that are the same problem

Some findings may be the same underlying problem, raised by two reviewers or from two places. Findings at the same place have usually been compared already, so look most for the same problem raised from two places, such as the code that causes it and the code that shows it. Two findings are the same problem when they have the same cause and the same consequence, not merely the same file or the same line: compare their `why` as well as what happens. Put the ids of each such set in one list in `sameAs`. Never group two different problems because they share a line: one line can hold two faults. When in doubt, leave them apart.

## Questions that are the same

Several reviewers often ask the same thing in different words. For each question that is the same as another question or as a finding, add an entry to `questionSameAs`: `question` is its number without the `q`, and `sameAs` is the other question's number with the `q`, such as `q2`, or the finding's id. The reader then sees only the other question or the finding.

- List a question only when answering the target would fully answer it.
- A question that a finding in the list already raises, where the finding says what happens and where, is the same as that finding.
- When in doubt, leave both.
- Never merge two questions that are about different places or different decisions.

## Whose call

In `whoseCall`, list the decisions in this change that belong to the business or to operations rather than to the author: thresholds, definitions and defaults, such as how many days a pause may last or what counts as an active member. Write one short line each. List one only when the pull request, its ticket or the standards do not show who decided it. Leave the list empty when there are none.

## Checks after merge

In `checksAfterMerge`, give three to five concrete things to click or look at once this change is on a test environment. Write each as one short step a person can follow, as a person who is not an administrator, and as a second office where that applies. For example: "Sign in as a manager at the second office and open the paused plans list; only that office's plans are shown."

## Splitting

Set `splitSuggested` to true only when the pull request bundles several independent features, or puts changes of very different kinds together, such as a database change, a new background job and the removal of much existing code, so that it cannot be reviewed to the standard. Otherwise set it to false.

## What to return

Return one JSON object with exactly this shape:

```json
{
  "top": ["id of the most harmful finding", "id of the next"],
  "also": ["id", "id"],
  "sameAs": [["id", "id"]],
  "questionSameAs": [{ "question": 3, "sameAs": "q1" }],
  "whoseCall": ["one short line"],
  "checksAfterMerge": ["one short step"],
  "splitSuggested": false
}
```

Use the ids exactly as they appear in the findings and the question numbers as they appear in the questions. Return empty lists when you have nothing to put in them.
