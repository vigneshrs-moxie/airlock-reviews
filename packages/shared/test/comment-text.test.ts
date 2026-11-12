import { describe, expect, it } from 'vitest';
import {
  COMMENT_MAX, POST_MAX_ITEMS, REVIEW_BODY_MAX, SUMMARY_MAX, candidate, checkCommentText, commentBody, mentionsIn,
  quietMentions, summaryBody, type Finding,
} from '@airlock/shared';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    ...candidate(), anchor: { status: 'in-diff', startLine: 12, endLine: 12 }, fingerprint: 'fp1', checked: '',
    bucket: 'top', rank: 1, status: 'new', ...over,
  };
}

describe('limits', () => {
  it('are the agreed numbers', () => {
    expect([COMMENT_MAX, SUMMARY_MAX, POST_MAX_ITEMS, REVIEW_BODY_MAX]).toEqual([4000, 4000, 30, 60000]);
  });
});

describe('commentBody', () => {
  it('gives the severity word and title first and leaves out empty parts', () => {
    const body = commentBody(finding({ suggestedChange: '', connected: [] }));
    expect(body.split('\n')[0]).toBe('**Fix: Total is not rounded**');
    expect(body).toBe([
      '**Fix: Total is not rounded**',
      'The sum is returned with floating point error.',
      'Customers see a total like 0.30000000000000004.',
    ].join('\n\n'));
  });
  it('writes the suggested change and the connected places in order', () => {
    const body = commentBody(finding({
      severity: 'block',
      connected: [
        { path: 'src/a.ts', line: 4, role: 'caller', quote: 'x' },
        { path: 'src/b.ts', line: null, role: 'test', quote: 'y' },
      ],
    }));
    expect(body.startsWith('**Block: ')).toBe(true);
    expect(body).toContain('\n\nSuggested change: Round to cents before returning.');
    expect(body.endsWith('\n\nConnected: `src/a.ts:4` (caller), `src/b.ts` (test)')).toBe(true);
    expect(body.indexOf('Suggested change')).toBeLessThan(body.indexOf('Connected'));
  });
  it('puts @names from a finding in backticks and leaves an @ inside a code span alone', () => {
    const body = commentBody(finding({ happens: 'Ping @alice and @acme/core, but `@bob` stays, mail a@b.com too.' }));
    expect(body).toContain('Ping `@alice` and `@acme/core`, but `@bob` stays, mail a@b.com too.');
    expect(mentionsIn(body)).toEqual([]);
    expect(commentBody(finding({ title: 'Tell @carol' }))).toContain('**Fix: Tell `@carol`**');
  });
  it('drops hidden characters and keeps a fenced quote fenced', () => {
    const body = commentBody(finding({ title: 'Za​p', happens: 'Look⠀ here:\n```js\n@dave();\n```\nend' }));
    expect(body).toContain('**Fix: Zap**');
    expect(body).not.toMatch(/[​⠀]/);
    const lines = body.split('\n');
    const open = lines.findIndex((l) => l.startsWith('````'));
    expect(open).toBeGreaterThan(0);
    expect(lines.slice(open + 1).includes('````')).toBe(true);
    expect(mentionsIn(body)).toEqual([]);
  });
});

describe('checkCommentText', () => {
  it('accepts ordinary text and refuses empty text, 4,001 characters and a zero-width space, each with its sentence', () => {
    expect(checkCommentText('Looks wrong to me.')).toBeNull();
    expect(checkCommentText('a'.repeat(4000))).toBeNull();
    expect(checkCommentText(' \n\t ')).toBe('The text is empty.');
    expect(checkCommentText('a'.repeat(4001))).toBe('The text is 1 character longer than the 4000 allowed.');
    expect(checkCommentText('a'.repeat(4010))).toBe('The text is 10 characters longer than the 4000 allowed.');
    expect(checkCommentText('a'.repeat(11), 10)).toBe('The text is 1 character longer than the 10 allowed.');
    expect(checkCommentText('hi​there')).toBe('The text has a hidden character; remove it.');
  });
});

describe('mentionsIn and quietMentions', () => {
  it('mentionsIn finds @a and @org/team outside code and none inside a fence', () => {
    expect(mentionsIn('cc @a and (@org/team-1), @a again')).toEqual(['@a', '@org/team-1']);
    expect(mentionsIn('```\n@x\n```\n~~~\n@y\n~~~\n`@z` and ``@w ` @v``')).toEqual([]);
    expect(mentionsIn('```\n@x\n')).toEqual([]);
    expect(mentionsIn('mail a@b.com, x_@y, path/@z, @@w')).toEqual([]);
    expect(mentionsIn('@start')).toEqual(['@start']);
  });
  it('quietMentions puts every @name outside code in backticks and is idempotent', () => {
    const cases = [
      'hi @a and @org/team.\n```\n@no\n```\nthen @b',
      'a stray ` backtick @c and `@d` and ``x`y @e``',
      'x`@f',
      '`@g` ` @h',
      '@a@b',
    ];
    for (const text of cases) {
      const once = quietMentions(text);
      expect(mentionsIn(once)).toEqual([]);
      expect(quietMentions(once)).toBe(once);
    }
    expect(quietMentions('hi @a and @org/team.\n```\n@no\n```\nthen @b'))
      .toBe('hi `@a` and `@org/team`.\n```\n@no\n```\nthen `@b`');
    expect(quietMentions('no mentions a@b.com')).toBe('no mentions a@b.com');
  });
});

describe('summaryBody', () => {
  it('is the summary alone when every comment is inline', () => {
    expect(summaryBody(2, [], 'Two things.')).toBe('Two things.');
  });
  it('lists comments not on a changed line under their place', () => {
    expect(summaryBody(1, [
      { path: 'src/a.ts', line: 3, body: '**Fix: A**' },
      { path: 'src/b.ts', line: null, body: '**Ask: B**' },
    ], 'Overall.')).toBe([
      'Overall.', 'Not on a changed line:', '`src/a.ts:3`\n**Fix: A**', '`src/b.ts`\n**Ask: B**',
    ].join('\n\n'));
    expect(summaryBody(0, [{ path: 'a.ts', line: 1, body: 'x' }], '')).toBe('Not on a changed line:\n\n`a.ts:1`\nx');
  });
});
