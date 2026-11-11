import { describe, expect, it } from 'vitest';
import {
  CandidateSchema, ReviewDocumentSchema, SeveritySchema, VerdictLabelSchema, candidate, minimalDocument,
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
});
