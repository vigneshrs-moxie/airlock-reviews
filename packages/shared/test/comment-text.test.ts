import { describe, expect, it } from 'vitest';
import {
  COMMENT_MAX, POST_MAX_ITEMS, REVIEW_BODY_MAX, SUMMARY_MAX, candidate, checkCommentText, commentBody, mentionsIn,
  plainProse, summaryBody, type Finding,
} from '@airlock/shared';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    ...candidate(), anchor: { status: 'in-diff', startLine: 12, endLine: 12 }, fingerprint: 'fp1', checked: '',
    bucket: 'top', rank: 1, status: 'new', ...over,
  };
}

/** A finding with the same text in every field a comment is built from. */
function everywhere(text: string): Finding {
  return finding({
    title: text, happens: text, why: text, suggestedChange: text,
    connected: [{ path: text, line: 3, role: text, quote: 'q' }, { path: 'b.ts', line: null, role: text, quote: 'q' }],
  });
}

describe('limits', () => {
  it('are the agreed numbers', () => {
    expect([COMMENT_MAX, SUMMARY_MAX, POST_MAX_ITEMS, REVIEW_BODY_MAX]).toEqual([4000, 4000, 30, 60000]);
  });
});

describe('plainProse', () => {
  it('drops hidden characters and blank letters, and neutralises & < \\ and backticks', () => {
    expect(plainProse('Za​p⠀ a&b <i> c\\d `e`')).toBe("Zap a&amp;b &lt;i> c\\\\d 'e'");
    expect(plainProse('&#64;ann &commat;bob')).toBe('&amp;#64;ann &amp;commat;bob');
  });
  it('puts every @name in backticks, whatever comes before it', () => {
    expect(plainProse('hi @alice, @org/team-1. And a@b.com path/@zed @@wes é@ann @a@b')).toBe(
      'hi `@alice`, `@org/team-1`. And a`@b.com` path/`@zed` @`@wes` é`@ann` `@a``@b`');
    expect(plainProse('mail me @ home, @-x, @')).toBe('mail me @ home, @-x, @');
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
  it('writes a one-line suggested change as prose and the connected places in order', () => {
    const body = commentBody(finding({
      severity: 'block',
      connected: [
        { path: 'src/a.ts', line: 4, role: 'caller', quote: 'x' },
        { path: 'src/`b`.ts', line: null, role: 'test', quote: 'y' },
      ],
    }));
    expect(body.startsWith('**Block: ')).toBe(true);
    expect(body).toContain('\n\nSuggested change: Round to cents before returning.');
    expect(body.endsWith("\n\nConnected: `src/a.ts:4` (caller), `src/'b'.ts` (test)")).toBe(true);
  });
  it('puts a suggested change with line breaks in a fence of its own, label on its own line, blank lines around', () => {
    const body = commentBody(finding({
      suggestedChange: 'Ask @alice\n```\ncode\n```\nthen @bob', connected: [{ path: 'a.ts', line: 1, role: 'caller', quote: 'q' }],
    }));
    expect(body).toContain('\n\nSuggested change:\n````\nAsk @alice\n```\ncode\n```\nthen @bob\n````\n\nConnected: `a.ts:1` (caller)');
    expect(mentionsIn(body)).toEqual([]);
  });
  it('keeps @names, chains of names, joined roles, escapes and HTML from notifying anyone', () => {
    const probes = [
      'Ping @alice and @acme/core, but `@bob` is not code here, mail a@b.com too.',
      '@a@b@c@d@e@f@g@h@i@j',
      'a ` b', '`@bob', 'see \\`@alice` now', 'ping \\@alice now', '\\\\`@x`',
      '<div>\nhi `@alice`\n</div>', '<!-- @hidden -->', '&#64;ann &#x40;ann &commat;bob',
      'path/@zed and @@wes and é@ann', '~~~\n@x\n~~~', '```\n@y\n```',
    ];
    for (const text of probes) {
      expect(mentionsIn(commentBody(everywhere(text))), text).toEqual([]);
    }
    const joined = commentBody(finding({ connected: [
      { path: 'p1', line: 1, role: 'a ` b', quote: 'q' }, { path: 'p2', line: 2, role: '@bob', quote: 'q' },
    ] }));
    expect(joined).toContain("(a ' b)");
    expect(mentionsIn(joined)).toEqual([]);
  });
  it('drops hidden characters from every part', () => {
    const body = commentBody(finding({ title: 'Za​p', happens: 'Look⠀ here', suggestedChange: 'a​\nb' }));
    expect(body).toContain('**Fix: Zap**');
    expect(body).not.toMatch(/[​⠀]/);
  });
  it('never lets generated text notify anyone (300 strings)', () => {
    const pieces = ['@name', '@a', '`', '``', '```', '````', '\\', '<div>', '<!--', '-->', '&#64;', '\n', '\n\n', ' ', 'x', 'é', '/', '@'];
    let seed = 12345;
    const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    for (let i = 0; i < 300; i += 1) {
      const text = Array.from({ length: 1 + (next() % 14) }, () => pieces[next() % pieces.length]).join('');
      expect(mentionsIn(commentBody(everywhere(text))), JSON.stringify(text)).toEqual([]);
    }
  });
});

describe('checkCommentText', () => {
  it('accepts ordinary text and refuses empty text, 4,001 characters and hidden characters, each with its sentence', () => {
    expect(checkCommentText('Looks wrong to me.')).toBeNull();
    expect(checkCommentText('a'.repeat(4000))).toBeNull();
    expect(checkCommentText(' \n\t ')).toBe('The text is empty.');
    expect(checkCommentText('a'.repeat(4001))).toBe('The text is 1 character longer than the 4000 allowed.');
    expect(checkCommentText('a'.repeat(4010))).toBe('The text is 10 characters longer than the 4000 allowed.');
    expect(checkCommentText('a'.repeat(11), 10)).toBe('The text is 1 character longer than the 10 allowed.');
    const hidden = 'The text has a hidden character; remove it.';
    for (const text of ['hi​there', 'ㅤ', 'hi⠀there', 'a͏b', 'a\uD800b']) expect(checkCommentText(text), text).toBe(hidden);
  });
});

describe('mentionsIn', () => {
  it('finds @a and @org/team outside code and none inside a closed fence or span', () => {
    expect(mentionsIn('cc @a and (@org/team-1), @a again')).toEqual(['@a', '@org/team-1']);
    expect(mentionsIn('```\n@x\n```\n~~~\n@y\n~~~\n`@z` and ``@w ` @v``')).toEqual([]);
    expect(mentionsIn('mail a@b.com, x_@y')).toEqual([]);
    expect(mentionsIn('@start')).toEqual(['@start']);
  });
  it('errs towards reporting', () => {
    expect(mentionsIn('```\n@x\n')).toEqual(['@x']);
    expect(mentionsIn('`@x')).toEqual(['@x']);
    expect(mentionsIn('see \\`@alice` now')).toEqual(['@alice']);
    expect(mentionsIn('\\\\`@safe` now')).toEqual([]);
    expect(mentionsIn('<div title="@x">@y</div><!-- @z -->')).toEqual(['@x', '@y', '@z']);
    expect(mentionsIn('path/@zed @@wes é@ann')).toEqual(['@zed', '@wes', '@ann']);
  });
});

describe('summaryBody', () => {
  it('is the summary alone when every comment is inline', () => {
    expect(summaryBody([], 'Two things.')).toBe('Two things.');
  });
  it('lists comments not on a changed line under their place', () => {
    expect(summaryBody([
      { path: 'src/a.ts', line: 3, body: '**Fix: A**' },
      { path: 'src/b.ts', line: null, body: '**Ask: B**' },
    ], 'Overall.')).toBe([
      'Overall.', 'Not on a changed line:', '`src/a.ts:3`\n**Fix: A**', '`src/b.ts`\n**Ask: B**',
    ].join('\n\n'));
    expect(summaryBody([{ path: 'a.ts', line: 1, body: 'x' }], '')).toBe('Not on a changed line:\n\n`a.ts:1`\nx');
  });
});
