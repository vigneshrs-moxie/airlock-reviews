import type { Finding } from '@airlock/shared';
import { fingerprint } from '../../src/anchor/fingerprint.js';

/** A finding as an earlier review stored it: a fix at src/a.ts line 2, with its fingerprint made from its fields. */
export function earlierFinding(over: Partial<Finding> = {}): Finding {
  const base: Omit<Finding, 'fingerprint'> = {
    id: 'c_00000001', source: { pack: 'core', lens: 'correctness', ruleId: null }, cohortId: 'k1', severity: 'fix',
    title: 'Totals ignore the discount', path: 'src/a.ts', quote: 'const total = price * qty;', lineHint: 2,
    happens: 'The discount is lost.', why: 'Nothing applies it.', suggestedChange: 'Apply the discount.', connected: [],
    wouldBeWrongIf: 'A caller applies it.', confidence: 'high',
    anchor: { status: 'in-diff', startLine: 2, endLine: 2, comment: { line: 2, startLine: null } },
    checked: 'Read both callers.', bucket: 'top', rank: 1, status: null,
  };
  const f = { ...base, ...over };
  return { ...f, fingerprint: over.fingerprint ?? fingerprint(f) };
}
