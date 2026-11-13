# Airlock panel, simpler · build brief

Hi-fi prototype. Drawn from airlock-reviews on main.

## Based on

- `packages/extension/src/screens/panel.css`
- `packages/extension/src/screens/Frame.tsx`
- `packages/extension/src/screens/Verdict.tsx`
- `packages/extension/src/screens/FindingDetail.tsx`
- `packages/extension/src/screens/PostSheet.tsx`
- `packages/extension/src/screens/DismissSheet.tsx`
- `packages/extension/src/screens/Ready.tsx`
- `packages/extension/src/screens/Packs.tsx`
- `packages/extension/brand/logo.svg`

## Screens

- **Review** (phone, screen) `Side panel, beside the pull request` → f1, f2, f3, f4, f5, f6, f7, post-many, settings
- **Start a review** (phone, screen) `Side panel, before a review` → packs, running, settings
- **Reviewing** (phone, screen) `Side panel, while a review runs` → home, ready, settings
- **Review after a push** (phone, screen) `Side panel, after new commits` → f1, f2, f3, f4, f8, settings
- **Finding: Tests pass without testing the safety rules** (phone, screen) `Side panel` → dismiss-f1, f2, more-f1, post-f1
- **Finding: No proof the checks work on a real page** (phone, screen) `Side panel` → dismiss-f2, f1, f3, more-f2, post-f2
- **Finding: A second office may call from the wrong number** (phone, screen) `Side panel` → dismiss-f3, f2, f4, more-f3, post-f3
- **Finding: The button also shows in read-only fields** (phone, screen) `Side panel` → dismiss-f4, f3, f5, more-f4, post-f4
- **Finding: Numbers with an extension lose it** (phone, screen) `Side panel` → dismiss-f5, f4, f6, more-f5, post-f5
- **Finding: Manifest and CHANGELOG disagree on the version** (phone, screen) `Side panel` → dismiss-f6, f5, f7, more-f6, post-f6
- **Finding: An unused helper is left in content.js** (phone, screen) `Side panel` → dismiss-f7, f6, more-f7, post-f7
- **Finding: The new test page ships inside the extension** (phone, screen) `Side panel` → dismiss-f8, more-f8, post-f8
- **Comment preview** (phone, overlay) ``
- **Dismiss** (phone, overlay) ``
- **More actions** (phone, overlay) `` → dismiss-f1, post-f1
- **Comment preview** (phone, overlay) ``
- **Dismiss** (phone, overlay) ``
- **More actions** (phone, overlay) `` → dismiss-f2, post-f2
- **Comment preview** (phone, overlay) ``
- **Dismiss** (phone, overlay) ``
- **More actions** (phone, overlay) `` → dismiss-f3, post-f3
- **Comment preview** (phone, overlay) ``
- **Dismiss** (phone, overlay) ``
- **More actions** (phone, overlay) `` → dismiss-f4, post-f4
- **Comment preview** (phone, overlay) ``
- **Dismiss** (phone, overlay) ``
- **More actions** (phone, overlay) `` → dismiss-f5, post-f5
- **Comment preview** (phone, overlay) ``
- **Dismiss** (phone, overlay) ``
- **More actions** (phone, overlay) `` → dismiss-f6, post-f6
- **Comment preview** (phone, overlay) ``
- **Dismiss** (phone, overlay) ``
- **More actions** (phone, overlay) `` → dismiss-f7, post-f7
- **Comment preview** (phone, overlay) ``
- **Dismiss** (phone, overlay) ``
- **More actions** (phone, overlay) `` → dismiss-f8, post-f8
- **Comment preview, several** (phone, overlay) ``
- **Tour, step 1 of 3** (phone, overlay) `` → tour2
- **Tour, step 2 of 3** (phone, overlay) `` → tour3
- **Tour, step 3 of 3** (phone, overlay) ``
- **Settings** (phone, screen) `Side panel` → packs, tour1
- **Packs and learned lines** (phone, screen) `Side panel`

## Requirements

- The first screenful answers "can this merge, and what do I do": the verdict in words, one sentence, and counts by kind.
- Each finding is one row: its kind as a word, a title of at most 60 characters, and its place. No body text in the list.
- Everything else in the review (what the change does, questions, whose call, checks after merge, notes, dismissed, timing) sits out of the way with a count, and nothing shown today is removed.
- A finding opens on a summary of one or two sentences and What to do. What happens, why, the code, what else is involved and how sure it is are folded below.
- After a push, the top says how many were fixed, are still open and are new, and each row says New or Still open.
- Copy fix prompt, Comment on GitHub and Dismiss stay pinned at the bottom, each with a line saying what it does. The filled button follows the kind: copy for a fix, comment for a question.
- Before anything is sent, the comment preview says where the comment goes: on the line, or in the review summary and why. It shows the exact text and the account it posts as.
- The dismiss sheet says nothing goes to GitHub, offers the three reasons, and shows the line Airlock will remember when one is saved.
- From the review, one button copies a single fix prompt for every fix. Select turns on checkboxes to copy or comment on several.
- Settings has a size control with four steps that changes text, buttons and spacing together, saved on this computer.
- Notes in the diff, the default depth, packs and learned lines, and the service's state move into Settings. The header holds one button.
- A three-step tour shows once, with the first finished review. Skip ends it for good. Settings shows it again.
- Each review ends with a step that writes, in plain words for someone who does not read the code: a short title and a one-line summary for every finding, and one sentence on what the change does. If that step fails the review still finishes and the panel shows cut-down text.
- The text posted to GitHub is the full finding, not the summary.
- Every screen works from 320 to 420 wide with no sideways scrolling. Buttons are at least 32 high, 40 in the pinned bars, at the Default size.
- Kind is always a word (Block, Fix, Ask, Note); colour is a second cue only.

## Decisions

- How is the rest of the review kept out of the way?
- How are a finding's actions shown?
- Who writes the short titles and one-line summaries?

## Questions to settle

- Does the tour show with the first finished review (drawn here) or as soon as the panel is paired?
- Is "Dismiss" the right word, given one of its three reasons only hides the finding on this pull request?
