# Review standard

This standard applies to every review, in any repository. A team pack may add to it; where they differ, the team pack wins.

## Write for a reader with ten minutes

The person reading the review will act on the top of the list and probably stop there. Write for that reader. Return at most five findings, ordered so that the first is the one they would most regret skipping. Ordering is the work: a problem that leaves a customer's record wrong or shows one person another's data goes above a problem that only slows a page down. Anything that would not change what the reader does next stays out of the list, even when it is true.

## The scope is this change

The reader is deciding about this pull request, not about the whole codebase. A problem belongs in the review when the change creates it, exposes it to new callers, or makes it worse. A weakness that was already on the base branch and that this change does not touch is out of scope. For deleted code, the only question is what stops working without it.

## Open with the outcome

The first sentence of a finding tells the reader what someone will experience: a person, a team, a report, a bill. The code comes after, as the reason. "Two orders placed in the same second share an invoice number, so one customer is billed for the other's goods" gives the reader something to weigh; "race condition in invoice numbering" does not. When no outcome can be named, write it as a question for the author.

## Leave taste alone

Do not comment on names, formatting, folder layout, comment style or how tests are arranged. If one of these hides a bug, write about the bug.

## Severity: what has to happen before this merges

Pick the severity by asking what the author must do next. Where findings differ in weight, let the levels show it, so the reader can see where to start.

- **Block**: the pull request must not merge as it is. Merging would destroy records, push an unintended write into a live outside system, leak a password or key, let someone open or edit records that belong to someone else, or put a wrong figure in front of people with nothing to flag it.
- **Fix**: the author should change the code first, but the damage would be bounded or reversible if it slipped through, for example a bug on one screen or a retry that fails loudly.
- **Ask**: the author or the owner of the business rule has to answer a question first; whether there is a problem depends on their answer. Put the question and say which way each answer goes.
- **Note**: nothing has to happen before merging. Use it for context the author will want later.

## The repository's own rules

When the repository's own rule files are supplied (such as `CLAUDE.md` or `AGENTS.md`), check the change against what they require and cite the file when a finding rests on one of its rules.
