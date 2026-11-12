import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
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
    expect(plainProse('Za\u200Bp\u2800 a&b <i> c\\d `e`')).toBe("Zap a&amp;b &lt;i> c\\\\d 'e'");
    expect(plainProse('&#64;ann &commat;bob')).toBe('&amp;#64;ann &amp;commat;bob');
    expect(plainProse('~~~ and ~x~')).toBe('\\~\\~\\~ and \\~x\\~');
    expect(plainProse('a\n    b\n\t c\n  ~~~')).toBe('a\nb\nc\n\\~\\~\\~');
  });
  it('puts every @name in backticks, whatever comes before it', () => {
    expect(plainProse('hi @alice, @org/team-1. And a@b.com path/@zed @@wes \u00E9@ann @a@b')).toBe(
      'hi `@alice`, `@org/team-1`. And a`@b.com` path/`@zed` @`@wes` \u00E9`@ann` `@a``@b`');
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
    expect(liveNames(body)).toEqual([]);
  });
  it('drops hidden characters from every part', () => {
    const body = commentBody(finding({ title: 'Za\u200Bp', happens: 'Look\u2800 here', suggestedChange: 'a\u200B\nb' }));
    expect(body).toContain('**Fix: Zap**');
    expect(body).not.toMatch(/[\u200B\u2800]/);
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
    for (const text of ['hi\u200Bthere', '\u3164', 'hi\u2800there', 'a\u034Fb', 'a\uD800b']) expect(checkCommentText(text), text).toBe(hidden);
  });
});

describe('mentionsIn', () => {
  it('reports every @name wherever it stands, once each, in order', () => {
    expect(mentionsIn('cc @a and (@org/team-1), @a again')).toEqual(['@a', '@org/team-1']);
    expect(mentionsIn('`@z` ```\n@x\n``` <div title="@y">@w</div><!-- @v -->')).toEqual(['@z', '@x', '@y', '@w', '@v']);
    expect(mentionsIn('mail a@b.com, x_@y')).toEqual([]);
    expect(mentionsIn('@start')).toEqual(['@start']);
    expect(mentionsIn('path/@zed @@wes \u00E9@ann')).toEqual(['@zed', '@wes', '@ann']);
    expect(mentionsIn('see \\`@alice` now')).toEqual(['@alice']);
  });
  it('reads the written forms of @', () => {
    expect(mentionsIn('&#64;a &#x40;b &#X040;c &#0064;d &commat;e &COMMAT;f &#64g')).toEqual(['@a', '@b', '@c', '@d', '@e', '@f', '@g']);
    expect(mentionsIn('&#645;h &#x405;i')).toEqual([]);
  });
  it('is not a judge of commentBody: it over-reports names inside code', () => {
    expect(mentionsIn(commentBody(finding({ happens: 'Ask @alice' })))).toEqual(['@alice']);
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
  it('two bodies that are each safe stay safe when joined', () => {
    const b1 = commentBody(finding({ happens: 'see\n~~~' }));
    const b2 = commentBody(finding({ suggestedChange: '~~~\n@bob' }));
    expect(liveNames(b1)).toEqual([]);
    expect(liveNames(b2)).toEqual([]);
    expect(liveNames(summaryBody([{ path: 'a.ts', line: 1, body: b1 }, { path: 'b.ts', line: null, body: b2 }], ''))).toEqual([]);
  });
});

/** What a Markdown renderer (CommonMark with tables, strikethrough and raw HTML on) would show as ordinary text with a live @name. */
const md = new MarkdownIt('commonmark', { html: true }).enable(['table', 'strikethrough']);
function liveNames(text: string): string[] {
  const found: string[] = [];
  const visit = (tokens: ReturnType<typeof md.parse>): void => {
    for (const token of tokens) {
      if (token.type === 'code_inline' || token.type === 'fence' || token.type === 'code_block') continue;
      if (token.children !== null) visit(token.children);
      else if (token.content !== '') for (const m of token.content.matchAll(/@[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu)) found.push(m[0]);
    }
  };
  visit(md.parse(text, {}));
  return found;
}

describe('commentBody against a Markdown renderer', () => {
  const probes = [
    'Ping @alice and @acme/core, but `@bob` is not code here, mail a@b.com too.',
    '@a@b@c@d@e@f@g@h@i@j', 'a ` b', '`@bob', 'see \\`@alice` now', 'ping \\@alice now', '\\\\`@x`',
    '<div>\nhi `@alice`\n</div>', '<div>\n```\n@bob\n```\n</div>', '<!-- @hidden -->',
    '&#64;ann &#x40;ann &commat;bob', 'path/@zed and @@wes and \u00E9@ann', '~~~\n@x\n~~~', '```\n@y\n```',
    '~~~', '~~~\n@bob\nend', 'x\n   ~~~ js', 'a\n~~~~\nthen @bob', '~~~\n`\n\n@bob\n\n`',
    '`a\n\n@bob\n\n`', '# `a\n@bob `', '- `a\n- @bob `', '    @indented', '\t@tabbed', '| `a | @bob ` |\n|---|---|\n| x | y |',
    '- a\n  ```\n  b\n@bob\n  ```', '`\n@bob\n```\n`', '`a\\` @bob `b`',
  ];
  it('leaves no live @name for every probe of the reviews, in every field', () => {
    for (const text of probes) {
      expect(liveNames(commentBody(everywhere(text))), text).toEqual([]);
      expect(liveNames(commentBody(finding({ happens: text, suggestedChange: text }))), text).toEqual([]);
      expect(liveNames(commentBody(finding({ happens: '~~~', suggestedChange: text }))), text).toEqual([]);
      expect(liveNames(commentBody(finding({ happens: text, suggestedChange: `~~~\n${text}` }))), text).toEqual([]);
      expect(liveNames(commentBody(finding({ why: text, suggestedChange: `\`\n\n${text}\n\n\`` }))), text).toEqual([]);
    }
  });
  it('sees a live name in text that is not safe (the check can fail)', () => {
    expect(liveNames('hello @bob')).toEqual(['@bob']);
    expect(liveNames('`@bob`\n\n```\n@x\n```')).toEqual([]);
  });
  it('leaves no live @name for 500 generated findings, and none when two bodies are joined', () => {
    const pieces = [
      '@name', '@org/team', '@a', '`', '``', '```', '````', '~~~', '\\', '<div>', '</div>', '<!--', '-->', '&#64;', '&commat;',
      '    ', '\t', '>', '- ', '1. ', '|', '*', '_', '[x](y)', '\n', '\n\n', ' ', 'x', 'Ab', '/', '@',
    ];
    let seed = 987654321;
    const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed >>> 4; };
    const text = (): string => Array.from({ length: 1 + (next() % 14) }, () => pieces[next() % pieces.length]).join('');
    for (let i = 0; i < 500; i += 1) {
      const f = finding({
        title: text(), happens: text(), why: text(), suggestedChange: i % 2 === 0 ? text() : `${text()}\n${text()}`, quote: text(), path: text(),
        connected: [{ path: text(), line: next() % 2 === 0 ? 3 : null, role: text(), quote: text() }, { path: text(), line: null, role: text(), quote: text() }],
      });
      const body = commentBody(f);
      expect(liveNames(body), JSON.stringify(f)).toEqual([]);
      const other = commentBody(finding({ happens: text(), suggestedChange: `${text()}\n${text()}` }));
      expect(liveNames(summaryBody([{ path: f.path, line: 2, body }, { path: text(), line: null, body: other }], '')), JSON.stringify(f)).toEqual([]);
    }
  });
});

describe('the Markdown renderer', () => {
  it('is used by tests only: no file under packages/*/src mentions it', () => {
    const packages = fileURLToPath(new URL('../../', import.meta.url));
    const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = `${dir}/${name}`;
      if (name === 'node_modules' || name === 'dist' || name === '.output' || name === '.wxt') return [];
      return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : [];
    });
    const offenders = readdirSync(packages).flatMap((pkg) => {
      const src = `${packages}${pkg}/src`;
      try { statSync(src); } catch { return []; }
      return sources(src).filter((file) => readFileSync(file, 'utf8').includes('markdown-it'));
    });
    expect(offenders).toEqual([]);
  });
});
