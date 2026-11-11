import { minimalDocument, type Dismissal, type Finding, type PrSummary, type ReviewDocument } from '@airlock/shared';
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
    kind: 'review', pr, latest: { document, dismissals: opts.dismissals ?? [] }, stale: opts.stale ?? false,
    ...(opts.busy === undefined ? {} : { busy: opts.busy }), ...(opts.notice === undefined ? {} : { notice: opts.notice }),
  };
}
