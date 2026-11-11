import { describe, expect, it } from 'vitest';
import { candidate, fixPrompt, minimalDocument, type Finding } from '@airlock/shared';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    ...candidate(), anchor: { status: 'in-diff', startLine: 12, endLine: 12 }, fingerprint: 'fp1', checked: '',
    bucket: 'top', rank: 1, status: 'new', ...over,
  };
}

describe('fixPrompt', () => {
  const doc = minimalDocument();
  it('numbers the findings in the given order and names path and line', () => {
    const a = finding({ id: 'a', title: 'First problem', path: 'src/a.ts', severity: 'block' });
    const b = finding({ id: 'b', title: 'Second problem', path: 'src/b.ts', anchor: { status: 'in-diff', startLine: 30, endLine: 31 } });
    const text = fixPrompt(doc, [b, a]);
    expect(text).toContain('acme/widgets');
    expect(text).toContain('feature/totals');
    expect(text).toContain('Add totals');
    expect(text.indexOf('1. Second problem')).toBeGreaterThan(-1);
    expect(text.indexOf('2. First problem')).toBeGreaterThan(text.indexOf('1. Second problem'));
    expect(text).toContain('src/b.ts:30');
    expect(text).toContain('Block');
    expect(text).toContain('Fix');
    expect(text).toContain('What happens');
    expect(text).toContain('Why');
    expect(text).toContain('Suggested change');
    expect(text).toContain('Check first');
    expect(text).toContain('Callers already round the result.');
  });
  it('fences a quote that itself contains three backticks', () => {
    const text = fixPrompt(doc, [finding({ quote: 'const s = "```js\\nx\\n```";' })]);
    expect(text).toContain('````\nconst s = "```js');
    expect(text).toContain('```";\n````');
  });
  it('says outside the changed lines for an outside-diff anchor', () => {
    const withLine = fixPrompt(doc, [finding({ anchor: { status: 'outside-diff', startLine: 40, endLine: 40 } })]);
    expect(withLine).toContain('src/total.ts:40 (outside the changed lines)');
    const noLine = fixPrompt(doc, [finding({ anchor: { status: 'outside-diff', startLine: null, endLine: null } })]);
    expect(noLine).toContain('src/total.ts (outside the changed lines)');
    const notFound = fixPrompt(doc, [finding({ anchor: { status: 'not-found', startLine: null, endLine: null } })]);
    expect(notFound).toContain('src/total.ts');
    expect(notFound).not.toContain('outside the changed lines');
  });
  it('lists connected places and leaves out empty sections', () => {
    const text = fixPrompt(doc, [finding({
      wouldBeWrongIf: '',
      connected: [{ path: 'src/caller.ts', line: 5, role: 'calls total', quote: 'total()' }],
    })]);
    expect(text).toContain('Also involves');
    expect(text).toContain('src/caller.ts:5');
    expect(text).toContain('calls total');
    expect(text).not.toContain('Check first');
  });
  it('closes with the instructions and never throws on an empty list', () => {
    const text = fixPrompt(doc, []);
    expect(text).toContain('acme/widgets');
    expect(text).toContain('No findings were selected');
    const full = fixPrompt(doc, [finding()]);
    expect(full).toContain('one line per item');
    expect(full).toContain('test that would have caught it');
  });
});
