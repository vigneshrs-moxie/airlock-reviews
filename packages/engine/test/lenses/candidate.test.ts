import type { Source } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LensOutputSchema, MAX_CANDIDATES_PER_LENS, acceptCandidates } from '../../src/lenses/candidate.js';

const source: Source = { pack: 'core', lens: 'boundary', ruleId: null };

const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  severity: 'fix',
  title: 'A paused plan is charged',
  path: 'src/plans/charge.ts',
  quote: 'if (plan.active) charge(plan);',
  lineHint: 12,
  happens: 'A member who paused their plan is charged on the renewal date.',
  why: 'The charge job checks `active` but a paused plan stays active.',
  suggestedChange: 'Skip plans whose pausedUntil is in the future.',
  connected: [{ path: 'src/plans/pause.ts', quote: 'plan.pausedUntil = until;', role: 'the pause is stored here' }],
  wouldBeWrongIf: 'The job query already filters paused plans.',
  confidence: 'high',
  ...over,
});

describe('acceptCandidates', () => {
  it('builds a full candidate with an id, the source and the cohort', () => {
    const r = acceptCandidates([raw()], source, 'k1');
    expect(r.questions).toEqual([]);
    expect(r.dropped).toEqual([]);
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0]!;
    expect(c.id).toMatch(/^c_[0-9a-f]{8}$/);
    expect(c).toMatchObject({ source, cohortId: 'k1', severity: 'fix', path: 'src/plans/charge.ts', lineHint: 12, confidence: 'high' });
    expect(c.connected).toEqual([
      { path: 'src/plans/pause.ts', line: null, quote: 'plan.pausedUntil = until;', role: 'the pause is stored here' },
    ]);
  });

  it('gives a missing confidence the value medium and a missing line hint null', () => {
    const { confidence: _c, lineHint: _l, ...rest } = raw();
    const r = acceptCandidates([rest], source, null);
    expect(r.candidates[0]).toMatchObject({ confidence: 'medium', lineHint: null, cohortId: null });
  });

  it('keeps six candidates and drops the seventh with stage schema', () => {
    const list = Array.from({ length: 7 }, (_, i) => raw({ title: `Fault ${i}` }));
    const r = acceptCandidates(list, source, 'k1');
    expect(MAX_CANDIDATES_PER_LENS).toBe(6);
    expect(r.candidates.map((c) => c.title)).toEqual(['Fault 0', 'Fault 1', 'Fault 2', 'Fault 3', 'Fault 4', 'Fault 5']);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]).toMatchObject({
      stage: 'schema', reason: 'more than 6 candidates from one lens', refutation: null,
      candidate: { title: 'Fault 6', source, cohortId: 'k1' },
    });
  });

  it('counts the limit after validation, so an invalid candidate does not take a place', () => {
    const list = [raw({ quote: '' }), ...Array.from({ length: 6 }, (_, i) => raw({ title: `Fault ${i}` }))];
    const r = acceptCandidates(list, source, 'k1');
    expect(r.candidates).toHaveLength(6);
    expect(r.dropped).toEqual([]);
    expect(r.questions).toHaveLength(1);
  });

  it('turns a candidate with no quote into a question', () => {
    const { quote: _q, ...rest } = raw({ title: 'Is the pause checked?' });
    const r = acceptCandidates([rest], source, 'k2');
    expect(r.candidates).toEqual([]);
    expect(r.questions).toEqual([{ text: 'Is the pause checked?', cohortId: 'k2', source }]);
  });

  it('keeps the valid candidates when one among them is invalid', () => {
    const r = acceptCandidates([raw({ title: 'One' }), raw({ title: 'Two', happens: '  ' }), raw({ title: 'Three' })], source, 'k1');
    expect(r.candidates.map((c) => c.title)).toEqual(['One', 'Three']);
    expect(r.questions.map((q) => q.text)).toEqual(['Two']);
  });

  it('drops a candidate whose severity is outside the four words, at stage schema with the reason, never as a question', () => {
    const r = acceptCandidates([raw({ severity: 'critical', title: 'Too loud' })], source, 'k1');
    expect(r.candidates).toEqual([]);
    expect(r.questions).toEqual([]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]).toMatchObject({
      stage: 'schema', refutation: null, reason: 'the severity "critical" is not block, fix, ask or note',
      candidate: { title: 'Too loud', path: 'src/plans/charge.ts', quote: 'if (plan.active) charge(plan);', cohortId: 'k1', source },
    });
    expect(r.dropped[0]!.candidate.id).toMatch(/^c_[0-9a-f]{8}$/);
  });

  // The review's three inputs: a full Block candidate with one word in the wrong case, or a line hint that is not whole.
  it.each([
    ['confidence "High"', { confidence: 'High' }, { confidence: 'high', severity: 'block', lineHint: 18 }],
    ['severity "Block"', { severity: 'Block', confidence: 'high' }, { severity: 'block', lineHint: 18 }],
    ['line hint 18.5', { lineHint: 18.5 }, { severity: 'block', lineHint: null }],
  ])('keeps a full candidate with %s', (_name, over, expected) => {
    const full = raw({ severity: 'block', title: 'Any member can redeem another voucher', lineHint: 18, ...over });
    const r = acceptCandidates([full], source, 'k1');
    expect(r.questions).toEqual([]);
    expect(r.dropped).toEqual([]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ title: 'Any member can redeem another voucher', quote: 'if (plan.active) charge(plan);', ...expected });
  });

  it('trims and lower-cases severity and confidence before checking them', () => {
    const r = acceptCandidates([raw({ severity: '  FIX ', confidence: ' Low' })], source, 'k1');
    expect(r.candidates[0]).toMatchObject({ severity: 'fix', confidence: 'low' });
  });

  it('drops a candidate with a quote and a consequence but no title or no why, saying what is missing', () => {
    const r = acceptCandidates([raw({ title: ' ' }), raw({ title: 'No cause', why: '' }), raw({ title: 'Odd', confidence: 'sure' })], source, 'k1');
    expect(r.questions).toEqual([]);
    expect(r.candidates).toEqual([]);
    expect(r.dropped.map((d) => [d.candidate.title, d.reason])).toEqual([
      ['(missing)', 'it has no title'],
      ['No cause', 'it does not say why'],
      ['Odd', 'the confidence "sure" is not high, medium or low'],
    ]);
  });

  it('uses what happens as the question when there is no title', () => {
    const { title: _t, ...rest } = raw({ quote: '' });
    const r = acceptCandidates([rest], source, 'k1');
    expect(r.questions.map((q) => q.text)).toEqual(['A member who paused their plan is charged on the renewal date.']);
  });

  it('ignores an invalid candidate with neither a title nor what happens', () => {
    const r = acceptCandidates([{ severity: 'fix', quote: 'x' }, 'not an object', null], source, 'k1');
    expect(r).toEqual({ candidates: [], dropped: [], questions: [] });
  });

  it('keeps the candidate and drops a connected place without its own quote', () => {
    const good = { path: 'src/b.ts', quote: 'save(plan);', role: 'saved here' };
    const r = acceptCandidates([raw({ title: 'Loose', connected: [{ path: 'src/a.ts', role: 'here' }, good] })], source, 'k1');
    expect(r.questions).toEqual([]);
    expect(r.candidates[0]!.connected).toEqual([{ ...good, line: null }]);
  });

  it('drops a connected place without a path or with a blank quote', () => {
    const r = acceptCandidates([raw({ connected: [{ quote: 'x', role: 'r' }, { path: 'src/a.ts', quote: '  ', role: 'r' }, 'junk'] })], source, 'k1');
    expect(r.questions).toEqual([]);
    expect(r.candidates[0]!.connected).toEqual([]);
  });

  it('gives a connected place without a role an empty role', () => {
    const r = acceptCandidates([raw({ connected: [{ path: 'src/a.ts', quote: 'x = 1;' }] })], source, 'k1');
    expect(r.candidates[0]!.connected).toEqual([{ path: 'src/a.ts', quote: 'x = 1;', role: '', line: null }]);
  });

  it.each([
    ['connected', { connected: [] }],
    ['suggestedChange', { suggestedChange: '' }],
    ['wouldBeWrongIf', { wouldBeWrongIf: '' }],
  ])('keeps a candidate with no %s', (key, expected) => {
    const rest = raw();
    delete rest[key];
    const r = acceptCandidates([rest], source, 'k1');
    expect(r.questions).toEqual([]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject(expected);
  });

  it.each(['quote', 'happens'])('turns a candidate with a blank %s into a question', (key) => {
    const missing = raw({ title: 'Asked' });
    delete missing[key];
    const blank = raw({ [key]: '   ', title: 'Asked' });
    const r = acceptCandidates([missing, blank], source, 'k1');
    expect(r.candidates).toEqual([]);
    expect(r.dropped).toEqual([]);
    expect(r.questions).toHaveLength(2);
  });

  it.each([['title', 'it has no title'], ['path', 'it names no file'], ['why', 'it does not say why']])(
    'drops a candidate with a blank %s at stage schema', (key, reason) => {
      const missing = raw();
      delete missing[key];
      const blank = raw({ [key]: '   ' });
      const r = acceptCandidates([missing, blank], source, 'k1');
      expect(r.candidates).toEqual([]);
      expect(r.questions).toEqual([]);
      expect(r.dropped.map((d) => [d.stage, d.reason])).toEqual([['schema', reason], ['schema', reason]]);
    },
  );

  it('never reuses an id already taken', () => {
    const taken = new Set<string>();
    const ids = Array.from({ length: 50 }, () => acceptCandidates([raw()], source, null, taken).candidates[0]!.id);
    expect(new Set(ids).size).toBe(50);
    expect(taken.size).toBe(50);
  });
});

describe('LensOutputSchema', () => {
  it('accepts candidates with missing fields so one bad candidate does not void the rest', () => {
    const parsed = LensOutputSchema.safeParse({ candidates: [{}, { title: 'x', lineHint: null }, raw()], questions: ['Why?'] });
    expect(parsed.success).toBe(true);
  });

  it('rejects an answer without questions', () => {
    expect(LensOutputSchema.safeParse({ candidates: [] }).success).toBe(false);
  });

  it('sends the model enums for severity and confidence and a whole number for the line hint', () => {
    const json = z.toJSONSchema(LensOutputSchema, { target: 'draft-7' }) as unknown as {
      properties: { candidates: { items: { properties: Record<string, Record<string, unknown>> } } };
    };
    const props = json.properties.candidates.items.properties;
    expect(props.severity).toMatchObject({ enum: ['block', 'fix', 'ask', 'note'] });
    expect(props.confidence).toMatchObject({ enum: ['high', 'medium', 'low'] });
    expect(JSON.stringify(props.lineHint)).toContain('"integer"');
  });

  it('accepts a severity or confidence in another case or with spaces', () => {
    const parsed = LensOutputSchema.safeParse({ candidates: [raw({ severity: ' Block', confidence: 'HIGH' })], questions: [] });
    expect(parsed.success && parsed.data.candidates[0]).toMatchObject({ severity: 'block', confidence: 'high' });
  });
});
