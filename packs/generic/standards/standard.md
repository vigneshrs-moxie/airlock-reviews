# Review standard

This standard applies to every review, in any repository. A team pack may add to it; where they differ, the team pack wins.

## Selection, not detection

A review is judged by the few problems it chooses to raise, not by how many it could find. Choose at most five findings and rank them. The first ones are those that would hurt a person who uses the software or corrupt a figure that someone relies on. A long list of equal-weight remarks buries the one that matters, so leave the rest out.

## Only what this pull request introduces

Raise a problem only when this change causes it, makes it reachable, or makes it worse. A fault that already exists on the base branch and is untouched here is not a finding. Code that the pull request deletes is in scope only for what its removal breaks.

## Consequence first

Every finding opens with what happens to a real person or a real number, and only then names the code that causes it. "A support agent can read every customer's invoices by changing the id in the address" is a finding; "missing ownership check" is a label. If you cannot name a consequence, you have a question, not a finding.

## No style notes

Naming, formatting, file layout, comment wording and test structure are never findings. When one of them hides a defect, raise the defect instead.

## Severities

Give different findings different severities. A review in which everything carries the same severity has not ranked anything.

- **Block**: merging causes harm. People see or change data they should not, a number shown or stored is wrong without anyone noticing, data is lost, a secret is exposed, or a live outside system receives a write it should not.
- **Fix**: a real defect whose damage is limited or can be undone. It should be fixed before merging, or before the change reaches more people.
- **Ask**: only the author, or whoever owns the business rule, can answer it, and the answer decides whether there is a problem. State the question and what depends on the answer.
- **Note**: worth knowing, but it does not change the decision to merge.

## The repository's own rules

When the repository's own rule files are supplied (such as `CLAUDE.md` or `AGENTS.md`), check the change against what they require and cite the file when a finding rests on one of its rules.
