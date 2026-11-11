import type { Candidate, ReviewDocument } from './review.js';

/** A valid candidate for tests; override fields with a spread. */
export function candidate(): Candidate {
  return {
    id: 'c1',
    source: { pack: 'core', lens: 'correctness', ruleId: null },
    cohortId: null,
    severity: 'fix',
    title: 'Total is not rounded',
    path: 'src/total.ts',
    quote: 'return a + b;',
    lineHint: 12,
    happens: 'The sum is returned with floating point error.',
    why: 'Customers see a total like 0.30000000000000004.',
    suggestedChange: 'Round to cents before returning.',
    connected: [],
    wouldBeWrongIf: 'Callers already round the result.',
    confidence: 'medium',
  };
}

/** A valid, mostly empty review document for tests. */
export function minimalDocument(): ReviewDocument {
  return {
    schemaVersion: 1,
    id: 'review-1',
    createdAt: '2026-11-10T00:00:00.000Z',
    pr: {
      repo: 'acme/widgets', number: 1, title: 'Add totals', body: '', author: 'alice', viewer: 'bob',
      baseRef: 'main', headRef: 'feature/totals', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
      isFork: false, additions: 1, deletions: 0, changedFiles: 1, url: 'https://github.com/acme/widgets/pull/1',
      stage: 'pr1',
    },
    range: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), kind: 'full' },
    depth: 'standard',
    packs: [],
    models: { main: 'claude-opus-5-5', challenger: 'claude-opus-5-5', sweep: 'claude-haiku-5-5', effort: 'high' },
    files: [],
    facts: [],
    map: { cohorts: [], standalone: [], links: [] },
    brief: { whatItDoes: [], claims: [] },
    verdict: { label: 'approve', sentence: 'Nothing found.', counts: { block: 0, fix: 0, ask: 0, note: 0 } },
    findings: [],
    questions: [],
    dropped: [],
    candidates: [],
    whoseCall: [],
    checksAfterMerge: [],
    selfReviewText: '',
    stageErrors: [],
    timings: [],
  };
}
