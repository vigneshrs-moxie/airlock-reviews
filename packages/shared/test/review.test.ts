import { describe, expect, it } from 'vitest';
import {
  CandidateSchema, FindingSchema, ReviewDocumentSchema, SeveritySchema, VerdictLabelSchema, candidate, minimalDocument,
} from '@airlock/shared';

describe('review document schema', () => {
  it('accepts a minimal valid document', () => {
    expect(ReviewDocumentSchema.parse(minimalDocument()).schemaVersion).toBe(1);
  });
  it('rejects a severity outside the four words', () => {
    expect(() => SeveritySchema.parse('critical')).toThrow();
  });
  it.each(['title', 'path', 'quote', 'happens', 'why'] as const)('rejects a candidate with a blank %s', (field) => {
    expect(() => CandidateSchema.parse({ ...candidate(), [field]: '' })).toThrow();
    expect(() => CandidateSchema.parse({ ...candidate(), [field]: '  \n\t ' })).toThrow();
  });
  it('allows the incomplete verdict label', () => {
    expect(VerdictLabelSchema.parse('incomplete')).toBe('incomplete');
  });
  it('a stored review without comment, fixed or previous still parses, and with them keeps them', () => {
    const doc = minimalDocument();
    const parsed = ReviewDocumentSchema.parse(doc);
    expect(parsed.fixed).toBeUndefined();
    expect(parsed.previous).toBeUndefined();
    const f = { ...candidate(), anchor: { status: 'in-diff' as const, startLine: 1, endLine: 1 }, fingerprint: 'fp', checked: '',
      bucket: 'top' as const, rank: 1, status: 'new' as const };
    expect(FindingSchema.parse(f).anchor.comment).toBeUndefined();
    const withComment = { ...f, anchor: { ...f.anchor, comment: { line: 5, startLine: null } } };
    expect(FindingSchema.parse(withComment).anchor.comment).toEqual({ line: 5, startLine: null });
    expect(FindingSchema.parse({ ...f, anchor: { ...f.anchor, comment: null } }).anchor.comment).toBeNull();
    const next = ReviewDocumentSchema.parse({ ...doc, fixed: [f], previous: { reviewId: 'r_0123456789', headSha: 'a'.repeat(40) } });
    expect(next.fixed).toHaveLength(1);
    expect(next.previous?.headSha).toBe('a'.repeat(40));
  });
});
