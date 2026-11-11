Your job is to draw the change map of this pull request: group the changed files into cohorts, and order the files inside each cohort into layers. Reviewers read the pull request one cohort at a time, so a good map puts files that only make sense together in the same place.

## What you are given

You get four blocks of material:

1. The pull request title and description. It says what the author meant to do. It may be wrong or incomplete.
2. The changed files, one per line: `path | status | tier | +added -removed`. Status is added, modified, deleted or renamed. Tier says how closely the file will be reviewed (read, skim or trust). Files that need no review are not listed.
3. The links, one per line: `from -> to (kind: detail)`. Code found these by reading imports, uses of changed names, tests and the repository's conventions. Trust them: a link means the two files really are connected.
4. The neighbours, one per line: `path [role] for: files — why`. These are unchanged files that call the changed code, that the changed code calls, or that are the closest existing sibling of a new file.

The links say which files are connected. How to group them into units of behaviour is your judgement. The diff is not included. Read the files with your tools before you decide: open the changed files, follow the links, and look at the neighbours when you are unsure what a file is for.

## Cohorts

A cohort is one unit of behaviour, something a person would describe in one sentence, for example "Members can pause their plan and it resumes on its own". Group files by the behaviour they serve together, not by folder or by file type.

- Give the cohort a title that says what the behaviour is, in the product's words. Do not use file names or folder names as titles.
- Write a summary of one or two sentences: what changes for the people who use it.
- A cohort may have a single layer.

## Layers

Inside a cohort, order the files into layers the way you would explain the change to a colleague: data first, then rules, then server writes, then reads, then screens, then jobs, then tests. Each layer has a kind:

- `data`: database schema, migrations, models, stored types.
- `rules`: validation, permissions, calculations, business rules.
- `writes`: server code that changes data (actions, mutations, handlers that save).
- `reads`: server code that fetches data (queries, loaders, serialisers).
- `screens`: pages, components and anything a person sees.
- `jobs`: scheduled jobs, queues, background work and their registration.
- `tests`: tests. Put tests in the cohort of the code they test, as its last layer.
- `config`: settings, feature flags, environment and build configuration.
- `other`: anything that fits none of the above.

For each layer, list in `dependsOn` the ids of the layers in the same cohort that it depends on. A screen that calls a write depends on the write layer; the write depends on the data layer. Use `note` for one short sentence about the layer when it helps a reviewer, otherwise leave it empty.

## Rules

- Every file in the changed files table must appear exactly once: in one layer of one cohort, or in `standalone`. Deleted files are included. Do not list any file that is not in the table.
- Put a file in `standalone` when no link and nothing you read in the code ties it to a cohort. Never force a grouping. A typo fix or an unrelated config change belongs in `standalone`.
- Keep ids short and unique. Cohorts are `k1`, `k2`, and so on. Write each layer id as its cohort id, a dot, and a layer number, so `k1.l1`, `k1.l2`, `k2.l1`. Every `dependsOn` entry must be a layer id of the same cohort.
- When you state a dependency that is not in the links you were given, list it under `inferredLinks` of that cohort as `from -> to (why)`. Dependencies already in the links do not go there.
- Attach each neighbour to the cohort it matters to, keeping its path, role, the changed files it is for, and why it matters. Drop neighbours that turn out to be irrelevant. You may add a neighbour you found by reading, as long as it is a file that exists and is not one of the changed files.

## What to return

Return one JSON object with exactly this shape:

```json
{
  "cohorts": [
    {
      "id": "k1",
      "title": "what the behaviour is",
      "summary": "one or two sentences",
      "layers": [
        { "id": "k1.l1", "title": "short title", "kind": "data", "files": ["path"], "dependsOn": [], "note": "" }
      ],
      "neighbours": [
        { "path": "path", "role": "caller", "forFiles": ["changed path"], "why": "one line" }
      ],
      "inferredLinks": ["from -> to (why)"]
    }
  ],
  "standalone": ["path"]
}
```

`role` is one of `caller`, `callee` or `sibling`. `kind` is one of the layer kinds above.

## Example

A pull request lets members pause their subscription. It changes six files for that and also fixes a typo in the README. A good map:

```json
{
  "cohorts": [
    {
      "id": "k1",
      "title": "Members can pause their plan and it resumes on its own",
      "summary": "A member can pause their plan for up to 60 days from the account page. A nightly job resumes plans whose pause has ended.",
      "layers": [
        { "id": "k1.l1", "title": "Store when a pause ends", "kind": "data", "files": ["db/migrations/0042_add_paused_until.sql"], "dependsOn": [], "note": "" },
        { "id": "k1.l2", "title": "Who may pause and for how long", "kind": "rules", "files": ["src/plans/pause-rules.ts"], "dependsOn": ["k1.l1"], "note": "The 60-day limit is set here." },
        { "id": "k1.l3", "title": "Pause a plan", "kind": "writes", "files": ["src/plans/actions/pause.ts"], "dependsOn": ["k1.l1", "k1.l2"], "note": "" },
        { "id": "k1.l4", "title": "Pause button on the account page", "kind": "screens", "files": ["src/app/account/plan/page.tsx"], "dependsOn": ["k1.l3"], "note": "" },
        { "id": "k1.l5", "title": "Resume plans whose pause has ended", "kind": "jobs", "files": ["src/jobs/resume-paused.ts"], "dependsOn": ["k1.l1"], "note": "" },
        { "id": "k1.l6", "title": "Tests", "kind": "tests", "files": ["test/plans/pause.test.ts"], "dependsOn": ["k1.l2", "k1.l3"], "note": "" }
      ],
      "neighbours": [
        { "path": "src/jobs/expire-trials.ts", "role": "sibling", "forFiles": ["src/jobs/resume-paused.ts"], "why": "The existing nightly job the new one should match." }
      ],
      "inferredLinks": ["src/jobs/resume-paused.ts -> db/migrations/0042_add_paused_until.sql (the job queries paused_until, which the migration adds)"]
    }
  ],
  "standalone": ["README.md"]
}
```
