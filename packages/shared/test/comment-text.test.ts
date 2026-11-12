import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import {
  COMMENT_MAX, POST_MAX_ITEMS, REVIEW_BODY_MAX, SUMMARY_MAX, candidate, checkCommentText, commentBody, mentionsIn,
  plainProse, postMentions, summaryBody, type Finding,
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

/** The summary the service writes when the person did not type one. */
const defaultSummary = (n: number): string => `Review notes from Airlock: ${n} comment${n === 1 ? '' : 's'}.`;

describe('limits', () => {
  it('are the agreed numbers', () => {
    expect([COMMENT_MAX, SUMMARY_MAX, POST_MAX_ITEMS, REVIEW_BODY_MAX]).toEqual([4000, 4000, 30, 60000]);
  });
});

describe('plainProse', () => {
  it('drops hidden characters and blank letters, and neutralises & < \\ ~ $ and backticks', () => {
    expect(plainProse('Za\u200Bp\u2800 a&b <i> c\\d `e`')).toBe("Zap a&amp;b &lt;i> c\\\\d 'e'");
    expect(plainProse('&#64;ann &commat;bob')).toBe('&amp;#64;ann &amp;commat;bob');
    expect(plainProse('~~~ and ~x~')).toBe('\\~\\~\\~ and \\~x\\~');
    expect(plainProse('a\n    b\n\t c\n  ~~~')).toBe('a\nb\nc\n\\~\\~\\~');
    expect(plainProse('$x$ and\n$$\ny\n$$ \\$')).toBe('\\$x\\$ and\n\\$\\$\ny\n\\$\\$ \\\\\\$');
  });
  it('breaks every @name with a space after the @, whatever comes before it, and leaves no backtick', () => {
    expect(plainProse('hi @alice, @org/team-1. And a@b.com path/@zed @@wes \u00E9@ann @a@b@c @\u00E9t\u00E9 @1 `@x`')).toBe(
      "hi @ alice, @ org/team-1. And a@ b.com path/@ zed @@ wes \u00E9@ ann @ a@ b@ c @ \u00E9t\u00E9 @ 1 '@ x'");
    expect(plainProse('mail me @ home, @-x, @_y, @')).toBe('mail me @ home, @-x, @_y, @');
    expect(plainProse('$@alice$')).toBe('\\$@ alice\\$');
    expect(plainProse('@a\u200B@b')).toBe('@ a@ b');
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
  it('writes a path that is empty once cleaned as plain words, never as an empty code span', () => {
    for (const path of ['', '  ', '\u200B', '\u2800', '\n']) {
      const body = commentBody(finding({ connected: [{ path, line: null, role: 'r', quote: 'q' }, { path, line: 7, role: 's', quote: 'q' }] }));
      expect(body.endsWith('\n\nConnected: (no path) (r), (no path) (s)'), JSON.stringify(path)).toBe(true);
    }
    expect(commentBody(finding({ connected: [{ path: '`', line: null, role: 'r', quote: 'q' }] }))).toContain("Connected: `'` (r)");
    expect(commentBody(finding({ connected: [{ path: 'a\nb', line: 2, role: 'r', quote: 'q' }] }))).toContain('Connected: `a b:2` (r)');
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
    expect(mentionsIn('@start')).toEqual(['@start']);
    expect(mentionsIn('path/@zed @@wes \u00E9@ann')).toEqual(['@zed', '@wes', '@ann']);
    expect(mentionsIn('see \\`@alice` now')).toEqual(['@alice']);
  });
  it('reports a name in a code span, a fence, an HTML comment and a script block', () => {
    expect(mentionsIn('use `@bob` here')).toEqual(['@bob']);
    expect(mentionsIn('```\n@bob\n```')).toEqual(['@bob']);
    expect(mentionsIn('<!-- @bob -->')).toEqual(['@bob']);
    expect(mentionsIn('<script>\n@bob\n</script>')).toEqual(['@bob']);
  });
  it('reports a name after an underscore, which can close emphasis', () => {
    expect(mentionsIn('_x_@bob')).toEqual(['@bob']);
    expect(mentionsIn('__init__@bob')).toEqual(['@bob']);
    expect(mentionsIn('mail x_@y')).toEqual(['@y']);
  });
  it('reads every written form of @ and of the letters of a name', () => {
    expect(mentionsIn('&#64;a &#x40;b &#X040;c &#0064;d &commat;e &COMMAT;f &#64g')).toEqual(['@a', '@b', '@c', '@d', '@e', '@f', '@g']);
    expect(mentionsIn('@&#98;ob')).toEqual(['@bob']);
    expect(mentionsIn('&#64;&#98;&#111;&#98;')).toEqual(['@bob']);
    expect(mentionsIn('&#x40;bob')).toEqual(['@bob']);
    expect(mentionsIn('&commat;bob')).toEqual(['@bob']);
    expect(mentionsIn('&#x00040;&#X62;ob &#0000064;&#x0062&#111b')).toEqual(['@bob']);
    expect(mentionsIn('&#645;h &#x405;i &#1114112;j &#xD800;k')).toEqual([]);
  });
  it('reports nothing for an address and for text with no @', () => {
    expect(mentionsIn('mail a@b.com')).toEqual([]);
    expect(mentionsIn('nothing to see here')).toEqual([]);
    expect(mentionsIn('a space: @ alice')).toEqual([]);
  });
  it('is not a judge of commentBody: names in its prose are broken, but a name inside a code part is over-reported', () => {
    expect(mentionsIn(commentBody(finding({ happens: 'Ask @alice', suggestedChange: '' })))).toEqual([]);
    expect(mentionsIn(commentBody(finding({ suggestedChange: 'x\n@alice' })))).toEqual(['@alice']);
  });
});

describe('postMentions', () => {
  const quiet = commentBody(finding({ happens: 'Ask @alice', suggestedChange: 'x = 1\n// @bob' }));
  it('gives empty lists when everything is Airlock\'s own text', () => {
    const reviewBody = summaryBody([{ path: 'a.ts', line: 1, body: quiet }], defaultSummary(2));
    expect(postMentions(
      [{ body: quiet, isDefault: true, inSummary: false }, { body: quiet, isDefault: true, inSummary: true }],
      { text: defaultSummary(2), isDefault: true }, reviewBody,
    )).toEqual({ items: [[], []], reviewBody: [] });
  });
  it('lists every name in the review body once the person typed the summary, a default body\'s code part too', () => {
    const summary = 'Use this:\n```';
    const reviewBody = summaryBody([{ path: 'a.ts', line: 1, body: quiet }], summary);
    expect(postMentions([{ body: quiet, isDefault: true, inSummary: true }], { text: summary, isDefault: false }, reviewBody))
      .toEqual({ items: [[]], reviewBody: ['@bob'] });
  });
  it('lists an edited comment\'s own names, and the review body\'s too when that comment is in the summary', () => {
    const edited = 'I agree, ask @carol.';
    const reviewBody = summaryBody([], defaultSummary(1));
    expect(postMentions([{ body: edited, isDefault: false, inSummary: false }], { text: defaultSummary(1), isDefault: true }, reviewBody))
      .toEqual({ items: [['@carol']], reviewBody: [] });
    const withIt = summaryBody([{ path: 'a.ts', line: 1, body: edited }], defaultSummary(1));
    expect(postMentions([{ body: edited, isDefault: false, inSummary: true }], { text: defaultSummary(1), isDefault: true }, withIt))
      .toEqual({ items: [['@carol']], reviewBody: ['@carol'] });
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
  it('writes a path that is empty once cleaned as plain words', () => {
    expect(summaryBody([{ path: '\u200B', line: null, body: 'x' }, { path: ' ', line: 4, body: 'y' }], ''))
      .toBe('Not on a changed line:\n\n(no path)\nx\n\n(no path)\ny');
  });
  it('two bodies that are each safe stay safe when joined', () => {
    const b1 = commentBody(finding({ happens: 'see\n~~~' }));
    const b2 = commentBody(finding({ suggestedChange: '~~~\n@bob' }));
    expect(liveNames(b1)).toEqual([]);
    expect(liveNames(b2)).toEqual([]);
    expect(liveNames(summaryBody([{ path: 'a.ts', line: 1, body: b1 }, { path: 'b.ts', line: null, body: b2 }], ''))).toEqual([]);
  });
});

/**
 * What a Markdown renderer (CommonMark with tables, strikethrough and raw HTML on, and once more with autolinks on) would
 * show as text with an `@` directly followed by a letter or digit: every token but code, raw HTML included.
 */
const renderers = [
  new MarkdownIt('commonmark', { html: true }).enable(['table', 'strikethrough']),
  new MarkdownIt('commonmark', { html: true, linkify: true }).enable(['table', 'strikethrough', 'linkify']),
];
function liveNames(text: string): string[] {
  const found: string[] = [];
  const visit = (tokens: ReturnType<(typeof renderers)[number]['parse']>): void => {
    for (const token of tokens) {
      if (token.type === 'code_inline' || token.type === 'fence' || token.type === 'code_block') continue;
      if (token.children !== null) visit(token.children);
      else if (token.content !== '') for (const m of token.content.matchAll(/@[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu)) found.push(m[0]);
    }
  };
  for (const md of renderers) visit(md.parse(text, {}));
  return [...new Set(found)];
}

/** A small seeded generator, so every run tries the same cases. */
function generator(start: number) {
  let seed = start;
  const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed >>> 4; };
  const pieces = [
    '@name', '@org/team', '@a', '@a@b@c', '\u00E9@\u00E9t\u00E9', '`', '``', '```', '````', '~~~', '\\', '<div>', '</div>', '<!--',
    '-->', '<script>', '&#64;', '&commat;', '    ', '\t', '>', '- ', '1. ', '|', '*', '_', '[x](y)', '[x]', '[x]: y', '\n', '\n\n',
    ' ', 'x', 'Ab', '/', '@', '$', '\n$$\n', 'www.example.com/@bob', 'https://example.com/@bob', '===', '---', '#', "'",
  ];
  const paths = ['', ' \t ', '\u200B', '`', '\n', 'src/a.ts'];
  const text = (): string => {
    const body = Array.from({ length: 1 + (next() % 14) }, () => pieces[next() % pieces.length]).join('');
    const edge = next() % 4;
    return `${edge === 1 ? '@' : ''}${body}${edge === 2 ? '@' : ''}`;
  };
  const path = (): string => (next() % 2 === 0 ? (paths[next() % paths.length] as string) : text());
  const line = (): number | null => (next() % 2 === 0 ? 3 : null);
  const oneFinding = (i: number): Finding => finding({
    title: text(), happens: text(), why: text(), suggestedChange: i % 2 === 0 ? text() : `${text()}\n${text()}`, quote: text(), path: path(),
    connected: [{ path: path(), line: line(), role: text(), quote: text() }, { path: path(), line: line(), role: text(), quote: text() }],
  });
  return { next, path, line, oneFinding };
}

const SEEDS = [987654321, 1, 2, 3, 42, 4242, 65537, 99991, 123456789, 2147483647];

describe('commentBody against a Markdown renderer', () => {
  const probes = [
    'Ping @alice and @acme/core, but `@bob` is not code here, mail a@b.com too.',
    '@a@b@c@d@e@f@g@h@i@j', 'a ` b', '`@bob', 'see \\`@alice` now', 'ping \\@alice now', '\\\\`@x`',
    '<div>\nhi `@alice`\n</div>', '<div>\n```\n@bob\n```\n</div>', '<!-- @hidden -->',
    '&#64;ann &#x40;ann &commat;bob', 'path/@zed and @@wes and \u00E9@ann', '~~~\n@x\n~~~', '```\n@y\n```',
    '~~~', '~~~\n@bob\nend', 'x\n   ~~~ js', 'a\n~~~~\nthen @bob', '~~~\n`\n\n@bob\n\n`',
    '`a\n\n@bob\n\n`', '# `a\n@bob `', '- `a\n- @bob `', '    @indented', '\t@tabbed', '| `a | @bob ` |\n|---|---|\n| x | y |',
    '- a\n  ```\n  b\n@bob\n  ```', '`\n@bob\n```\n`', '`a\\` @bob `b`',
    '$@alice$', '$$\n@alice\n$$', '_x_@bob', '<script>\n@bob', 'www.example.com/@bob', 'http://`@carol.com`',
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
  it('leaves no live @name for an empty, blank or hidden path next to a chain of names (the second re-review\'s cases)', () => {
    const connected = (...places: [string, number | null, string][]): Finding =>
      finding({ connected: places.map(([path, line, role]) => ({ path, line, role, quote: 'q' })) });
    expect(liveNames(commentBody(connected(['', null, '@a@b'])))).toEqual([]);
    expect(liveNames(commentBody(connected(['  ', null, '@a@b'])))).toEqual([]);
    expect(liveNames(commentBody(connected(['\u200B', null, 'x @alice@bob y'])))).toEqual([]);
    expect(liveNames(commentBody(connected(['', null, 'r'], ['x', 1, '@a@b'])))).toEqual([]);
    const body = commentBody(finding({ title: 'see @a@b', path: '\u200B' }));
    expect(liveNames(summaryBody([{ path: '\u200B', line: null, body }], ''))).toEqual([]);
    expect(liveNames(summaryBody([{ path: '\u200B', line: null, body }], defaultSummary(1)))).toEqual([]);
  });
  it('sees a live name in text that is not safe (the check can fail)', () => {
    expect(liveNames('hello @bob')).toEqual(['@bob']);
    expect(liveNames('<div>\n@bob\n</div>')).toEqual(['@bob']);
    expect(liveNames('`` (`@a``@b`)')).toEqual(['@b']);
    expect(liveNames('`@bob`\n\n```\n@x\n```')).toEqual([]);
  });
  for (const seed of SEEDS) {
    it(`leaves no live @name in 500 generated findings, seed ${seed}`, () => {
      const { oneFinding } = generator(seed);
      for (let i = 0; i < 500; i += 1) {
        const f = oneFinding(i);
        expect(liveNames(commentBody(f)), JSON.stringify(f)).toEqual([]);
      }
    }, 120_000);
  }
});

describe('summaryBody of default bodies against a Markdown renderer', () => {
  for (const seed of SEEDS) {
    it(`leaves no live @name for 500 reviews of two to four default bodies with the default summary, seed ${seed}`, () => {
      const { next, path, line, oneFinding } = generator(seed);
      for (let i = 0; i < 500; i += 1) {
        const inSummary = Array.from({ length: 2 + (next() % 3) }, (_, k) => ({ path: path(), line: line(), body: commentBody(oneFinding(i + k)) }));
        const body = summaryBody(inSummary, defaultSummary(inSummary.length + (next() % 3)));
        expect(liveNames(body), JSON.stringify(inSummary)).toEqual([]);
      }
    }, 120_000);
  }
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
