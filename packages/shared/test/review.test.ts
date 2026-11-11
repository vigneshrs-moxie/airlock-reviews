import { describe, expect, it } from 'vitest';
import { CandidateSchema, ReviewDocumentSchema, SeveritySchema, VerdictLabelSchema } from '@airlock/shared';
import { candidate, minimalDocument } from '../src/testing.js';

describe('review document schema', () => {
  it('accepts a minimal valid document', () => {
    expect(ReviewDocumentSchema.parse(minimalDocument()).schemaVersion).toBe(1);
  });
  it('rejects a severity outside the four words', () => {
    expect(() => SeveritySchema.parse('critical')).toThrow();
  });
  it('rejects a candidate with an empty quote', () => {
    expect(() => CandidateSchema.parse({ ...candidate(), quote: '' })).toThrow();
  });
  it('rejects a candidate with an empty happens', () => {
    expect(() => CandidateSchema.parse({ ...candidate(), happens: ' ' })).toThrow();
  });
  it('allows the incomplete verdict label', () => {
    expect(VerdictLabelSchema.parse('incomplete')).toBe('incomplete');
  });
});
