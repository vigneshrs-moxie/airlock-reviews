import { candidate } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import { fingerprint } from '../../src/anchor/fingerprint.js';

describe('fingerprint', () => {
  it('ignores whitespace and changes with the path', () => {
    const c = candidate();
    const a = fingerprint({ source: c.source, path: 'a.ts', quote: 'let x = 1;' });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint({ source: c.source, path: 'a.ts', quote: '  let   x=1;\n' })).toBe(a);
    expect(fingerprint({ source: c.source, path: 'b.ts', quote: 'let x = 1;' })).not.toBe(a);
  });

  it('uses the rule id when present, else the lens', () => {
    const base = { pack: 'p', lens: 'security', ruleId: null };
    const q = { path: 'a.ts', quote: 'x' };
    expect(fingerprint({ source: { ...base, ruleId: 'r1' }, ...q })).not.toBe(fingerprint({ source: base, ...q }));
    expect(fingerprint({ source: { ...base, ruleId: 'r1', lens: 'other' }, ...q })).toBe(fingerprint({ source: { ...base, ruleId: 'r1' }, ...q }));
  });
});
