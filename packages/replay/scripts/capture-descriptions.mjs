// Writes packages/replay/dataset/descriptions.json: each case's pull request title and description as they stood when
// the senior reviewer reviewed it. GitHub keeps every version of a description; this picks the last one written at or
// before the case's `reviewedAt`. It only reads (one GraphQL query per case, no mutation). Run it again when a case is
// added:  node packages/replay/scripts/capture-descriptions.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dataset = fileURLToPath(new URL('../dataset/', import.meta.url));
const raw = JSON.parse(readFileSync(`${dataset}cases.json`, 'utf8'));
const cases = Array.isArray(raw) ? raw : raw.cases;

const query = (owner, name, number) => `query {
  repository(owner: "${owner}", name: "${name}") {
    pullRequest(number: ${number}) {
      title body
      userContentEdits(first: 100) { nodes { createdAt editedAt diff } }
      timelineItems(first: 100, itemTypes: [RENAMED_TITLE_EVENT]) { nodes { ... on RenamedTitleEvent { createdAt previousTitle currentTitle } } }
    }
  }
}`;

const out = {};
for (const c of cases) {
  const [owner, name] = c.repo.split('/');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name) || !Number.isInteger(c.pr)) throw new Error(`bad case ${c.id}`);
  const reply = JSON.parse(execFileSync('gh', ['api', 'graphql', '-f', `query=${query(owner, name, c.pr)}`], { encoding: 'utf8', maxBuffer: 50e6 }));
  const pr = reply.data.repository.pullRequest;
  const versions = pr.userContentEdits.nodes
    .map((e) => ({ at: e.editedAt ?? e.createdAt, text: e.diff ?? '' }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const editedAfter = versions.filter((v) => v.at > c.reviewedAt).length;
  const atReview = versions.filter((v) => v.at <= c.reviewedAt).at(-1);
  // No version after the review: the description today is the one that was reviewed.
  const body = editedAfter === 0 ? pr.body : atReview ? atReview.text : null;
  if (body === null) throw new Error(`${c.id}: the description was edited after the review and no earlier version is recorded`);
  const renames = pr.timelineItems.nodes.filter((e) => e.createdAt > c.reviewedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const title = renames.length > 0 ? renames[0].previousTitle : pr.title;
  out[c.id] = { title, body, editedAfterReview: editedAfter, renamedAfterReview: renames.length };
}
writeFileSync(`${dataset}descriptions.json`, `${JSON.stringify(out, null, 2)}\n`);
console.log(Object.entries(out).map(([id, d]) => `${id}: ${d.body.length} characters${d.editedAfterReview ? `, ${d.editedAfterReview} later edit(s) left out` : ''}`).join('\n'));
