import { minimalDocument, type Dismissal, type Finding, type PostRecord, type PrSummary, type ReviewDocument } from '@airlock/shared';
import type { PanelState } from '../../src/state/reduce';
import { prSummary } from './fixtures';

export type ReviewState = Extract<PanelState, { kind: 'review' }>;

/** A finding in the top list at rank `n`; ids and fingerprints are made from `n`. */
export function finding(n: number, over: Partial<Finding> = {}): Finding {
  return {
    id: `c_${String(n).padStart(8, '0')}`,
    source: { pack: 'generic', lens: 'correctness', ruleId: null },
    cohortId: null, severity: 'fix', title: `Problem ${n}`, path: `src/file${n}.ts`, quote: `code ${n};`, lineHint: n * 10,
    happens: `Happens ${n}.`, why: `Why ${n}.`, suggestedChange: `Change ${n}.`, connected: [], wouldBeWrongIf: '',
    confidence: 'high', anchor: { status: 'in-diff', startLine: n * 10, endLine: n * 10 + 1 },
    fingerprint: String(n).padStart(16, '0'), checked: `Checked ${n}.`, bucket: 'top', rank: n, status: 'new', ...over,
  };
}

export const also = (n: number, over: Partial<Finding> = {}): Finding => finding(n, { bucket: 'also', rank: null, severity: 'note', ...over });

export function dismissal(f: Finding, over: Partial<Dismissal> = {}): Dismissal {
  return {
    fingerprint: f.fingerprint, findingId: f.id, reviewId: 'r_0000000001', reason: 'wrong', text: '',
    at: '2026-11-11T00:00:00.000Z', learned: null, ...over,
  };
}

export interface ReviewOptions {
  dismissals?: Dismissal[];
  posts?: PostRecord[];
  stale?: boolean;
  busy?: boolean;
  notice?: string;
  doc?: Partial<ReviewDocument>;
  pr?: Partial<PrSummary>;
}

export function reviewState(findings: Finding[], opts: ReviewOptions = {}): ReviewState {
  const pr = prSummary({ packs: [{ id: 'generic', title: 'Generic' }, { id: 'orbit', title: 'Orbit' }], ...opts.pr });
  const base = minimalDocument();
  const document: ReviewDocument = {
    ...base, id: 'r_0000000001', pr: { ...base.pr, headSha: pr.headSha }, packs: [{ id: 'generic', version: 'v1' }],
    verdict: { label: 'approve-after-fixes', sentence: 'Two things to fix.', counts: { block: 0, fix: 2, ask: 0, note: 0 } },
    findings, ...opts.doc,
  };
  return {
    kind: 'review', pr, latest: { document, dismissals: opts.dismissals ?? [], posts: opts.posts ?? [] }, stale: opts.stale ?? false,
    ...(opts.busy === undefined ? {} : { busy: opts.busy }), ...(opts.notice === undefined ? {} : { notice: opts.notice }),
  };
}

/** The engine's notes for a re-review that reviewed the whole pull request again (`everythingNote` in packages/engine/src/rereview/notes.ts). */
export const EVERYTHING_AGAIN_NOTES = [
  'The branch was rewritten since the last review (its earlier head aaaaaaa is no longer part of it), so the whole pull request was reviewed again.',
  'A commit pushed since the last review merges the base branch main in, so the whole pull request was reviewed again.',
  'The last review did not finish, so everything was reviewed again.',
  'The pull request now targets main; the last review was against develop, so everything was reviewed again.',
  'The last review covered a range given by hand, so everything was reviewed again.',
];

/** The brief the engine writes for each kind of merge review (packages/engine/src/pipeline/review.ts). */
const MERGE_BRIEFS = {
  'by-hand': 'This branch only merges its target branch into itself, so only conflict resolutions need review.',
  'nothing-by-hand': 'This pull request only merges main into the branch. Git merged it without conflicts and nothing was changed by hand.',
  'not-reviewed': 'This branch only merges its target branch into itself, so only conflict resolutions need review.',
} as const;

/**
 * A first review of a pull request that only merges `main` in, of one kind (`mergeReview`); `undefined` is a document
 * stored before the field existed. One that could not be reviewed is Incomplete, with the shape stage's error.
 */
export function mergeDocument(kind: ReviewDocument['mergeReview']): ReviewDocument {
  const base = minimalDocument();
  return {
    ...base, id: 'r_000000000m',
    range: { baseSha: 'e'.repeat(40), headSha: base.pr.headSha, kind: 'sync-merge' },
    brief: { whatItDoes: [MERGE_BRIEFS[kind ?? 'by-hand']], claims: [] },
    ...(kind === undefined ? {} : { mergeReview: kind }),
    ...(kind === 'not-reviewed' ? {
      verdict: { label: 'incomplete' as const, sentence: 'The review did not finish: a stage failed.', counts: { block: 0, fix: 0, ask: 0, note: 0 } },
      stageErrors: [{ stage: 'shape', cohortId: null, message: 'This pull request only merges another branch in. Airlock did not review it: 2 changed files were not looked at. It holds two merges.' }],
    } : {}),
  };
}
