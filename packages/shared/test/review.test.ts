import { describe, expect, it } from 'vitest';
import {
  CandidateSchema, FindingSchema, ReviewDocumentSchema, SeveritySchema, VerdictLabelSchema, candidate, minimalDocument, rereviewCovered,
  type ReviewDocument,
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
    expect(() => ReviewDocumentSchema.parse({ ...doc, previous: { reviewId: 'x', headSha: 'a'.repeat(40) } })).toThrow();
    expect(() => ReviewDocumentSchema.parse({ ...doc, previous: { reviewId: 'r_0123456789', headSha: 'zz' } })).toThrow();
  });
});

describe('what a re-review covered', () => {
  const EARLIER = 'a'.repeat(40);
  const doc = (range: ReviewDocument['range']['kind'], covered?: 'push' | 'merge' | 'everything', baseSha = EARLIER) => ({
    range: { baseSha, headSha: 'b'.repeat(40), kind: range },
    previous: { reviewId: 'r_0123456789', headSha: EARLIER, ...(covered === undefined ? {} : { covered }) },
  });

  it('is the field, whatever the range and the notes say', () => {
    expect(rereviewCovered(doc('rereview', 'push'))).toBe('push');
    expect(rereviewCovered(doc('sync-merge', 'merge'))).toBe('merge');
    // A pull request of only merges reviewed again in full is a merge range too: the field says what it was.
    expect(rereviewCovered(doc('sync-merge', 'everything'))).toBe('everything');
    expect(rereviewCovered(doc('full', 'everything'))).toBe('everything');
    expect(ReviewDocumentSchema.parse({ ...minimalDocument(), ...doc('sync-merge', 'merge') }).previous?.covered).toBe('merge');
    expect(() => ReviewDocumentSchema.parse({ ...minimalDocument(), previous: { ...doc('full').previous, covered: 'all' } })).toThrow();
  });

  it('is inferred from the range for a document stored before the field: a merge, a push from the earlier head, or everything', () => {
    expect(rereviewCovered(doc('sync-merge'))).toBe('merge');
    expect(rereviewCovered(doc('rereview'))).toBe('push');
    // Where the range starts decides it, as the terminal did: a range from the earlier head is the push.
    expect(rereviewCovered(doc('full'))).toBe('push');
    expect(rereviewCovered(doc('full', undefined, 'c'.repeat(40)))).toBe('everything');
  });

  it('is null for a first review', () => {
    expect(rereviewCovered({ range: doc('sync-merge').range })).toBeNull();
    expect(rereviewCovered(minimalDocument())).toBeNull();
  });
});
