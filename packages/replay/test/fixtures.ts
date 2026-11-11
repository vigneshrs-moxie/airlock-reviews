import { candidate, minimalDocument } from '@airlock/shared';
import type { Candidate, Dropped, Finding, ReviewDocument } from '@airlock/shared';
import type { KnownProblem, ReplayCase } from '../src/index.js';

export function problem(over: Partial<KnownProblem> = {}): KnownProblem {
  return {
    id: 'K1',
    path: 'src/total.ts',
    line: 12,
    summary: 'The total is summed without rounding, so customers see floating point noise.',
    comment: 'this needs rounding',
    reviewerSeverity: 'change',
    crossFile: false,
    defect: true,
    ...over,
  };
}

export function replayCase(over: Partial<ReplayCase> = {}): ReplayCase {
  return {
    id: 'pr1',
    repo: 'acme/widgets',
    pr: 1,
    title: 'Add totals',
    titleAtReview: 'Add totals (as reviewed)',
    bodyAtReview: 'Adds the totals row, as the description read when it was reviewed.',
    kind: 'positive',
    reviewedAt: '2026-10-30T00:00:00Z',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    lines: 120,
    known: [problem()],
    ...over,
  };
}

export function raw(id: string, over: Partial<Candidate> = {}): Candidate {
  return { ...candidate(), id, ...over };
}

export function finding(id: string, bucket: 'top' | 'also', over: Partial<Finding> = {}): Finding {
  return {
    ...raw(id),
    anchor: { status: 'in-diff', startLine: 12, endLine: 12 },
    fingerprint: `fp-${id}`,
    checked: 'Read the caller.',
    bucket,
    rank: bucket === 'top' ? 1 : null,
    status: null,
    ...over,
  };
}

export function dropped(id: string, stage: Dropped['stage'], reason = 'Not a problem.', over: Partial<Candidate> = {}): Dropped {
  return { candidate: raw(id, over), stage, reason, refutation: null };
}

export function doc(over: Partial<ReviewDocument> = {}): ReviewDocument {
  return { ...minimalDocument(), ...over };
}
