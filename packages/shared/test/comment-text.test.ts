import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import {
  COMMENT_MAX, CUT_NOTE, POST_MAX_ITEMS, REVIEW_BODY_MAX, SUMMARY_MAX, candidate, checkCommentText, commentBody, mentionsIn,
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
    expect(plainProse('&#64;ann &commat;bob')).toBe('&amp;# 64;ann &amp;commat;bob');
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
  it('breaks every # directly before a digit with a space, so no reference to an issue or pull request is made', () => {
    expect(plainProse('see #12, acme/widgets#3, # 4, #x, ##5, x#6 and &#64;')).toBe(
      'see # 12, acme/widgets# 3, # 4, #x, ## 5, x# 6 and &amp;# 64;');
    // At the start of a line it would be a heading: the first `#` is escaped, so it is shown as it is written.
    expect(plainProse('#7 at the start')).toBe('\\# 7 at the start');
    expect(plainProse('one\n#12 two\n  ##3 three\n# 4 four')).toBe('one\n\\# 12 two\n\\## 3 three\n# 4 four');
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

describe('commentBody of a finding too long to post as drafted', () => {
  const tail = `\n\n${CUT_NOTE}`;
  const chars = (text: string): number => [...text].length;
  it('says how it was cut', () => {
    expect(CUT_NOTE).toBe('(Cut to fit; the full finding is in Airlock.)');
  });
  it('leaves a body of 4,000 characters or fewer as it is', () => {
    const f = finding({ suggestedChange: '', connected: [] });
    const head = commentBody(f);
    const exact = finding({ ...f, why: 'w'.repeat(COMMENT_MAX - chars(head) + chars(f.why)) });
    expect(chars(commentBody(exact))).toBe(COMMENT_MAX);
    expect(commentBody(exact)).not.toContain(CUT_NOTE);
    const over = commentBody(finding({ ...f, why: `${exact.why}w` }));
    expect(chars(over)).toBeLessThanOrEqual(COMMENT_MAX);
    expect(over.endsWith(tail)).toBe(true);
  });
  it('cuts a long multi-line suggested change inside its fence, which stays closed', () => {
    const change = Array.from({ length: 400 }, (_, i) => `line ${i} @bob \`x\``).join('\n');
    const body = commentBody(finding({ suggestedChange: change, connected: [{ path: 'a.ts', line: 1, role: 'caller', quote: 'q' }] }));
    expect(chars(body)).toBeLessThanOrEqual(COMMENT_MAX);
    expect(body.startsWith('**Fix: Total is not rounded**\n\n')).toBe(true);
    expect(body).toContain('\n\nSuggested change:\n```\nline 0 @bob `x`\n');
    expect(body.endsWith(`\n\`\`\`${tail}`)).toBe(true);
    expect(body).not.toContain('Connected:');
    expect(checkCommentText(body)).toBeNull();
    expect(liveNames(body)).toEqual([]);
    expect(lastParagraph(body)).toBe(CUT_NOTE);
  });
  it('cuts a long title, a long one-line change and long prose, and keeps every part that fits whole', () => {
    const title = commentBody(finding({ title: `Ask @carol about #12 ${'and more '.repeat(600)}` }));
    expect(chars(title)).toBeLessThanOrEqual(COMMENT_MAX);
    expect(title.startsWith('**Fix: Ask @ carol about # 12 and more')).toBe(true);
    expect(title).toMatch(/[a-z]\*\*\n\n\(Cut to fit; the full finding is in Airlock\.\)$/);

    const oneLine = commentBody(finding({ suggestedChange: `Round it ${'please '.repeat(700)}`, connected: [] }));
    expect(oneLine).toMatch(/\n\nSuggested change: Round it [a-z ]*[a-z]\n\n\(Cut to fit; the full finding is in Airlock\.\)$/);
    expect(oneLine).toContain('Customers see a total like 0.30000000000000004.');

    const connected = Array.from({ length: 200 }, (_, i) => ({ path: `src/file-${i}.ts`, line: i + 1, role: 'caller', quote: 'q' }));
    const many = commentBody(finding({ connected }));
    expect(chars(many)).toBeLessThanOrEqual(COMMENT_MAX);
    expect(many).toMatch(/\n\nConnected: `src\/file-0\.ts:1` \(caller\)(, `src\/file-\d+\.ts:\d+` \(caller\))*\n\n\(Cut/);
    expect(many.endsWith(tail)).toBe(true);
  });
  it('never ends a cut part in a backslash or white space, and counts characters, not UTF-16 units', () => {
    const slashes = commentBody(finding({ happens: 'a\\'.repeat(3000) }));
    expect(slashes).toMatch(/[^\\]\n\n\(Cut/);
    expect(slashes.endsWith(tail)).toBe(true);
    const astral = commentBody(finding({ why: '\u{1F600}'.repeat(5000) }));
    expect(chars(astral)).toBeLessThanOrEqual(COMMENT_MAX);
    expect(astral.length).toBeGreaterThan(COMMENT_MAX);
    expect(checkCommentText(astral)).toBeNull();
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
    expect(mentionsIn('@a@b@c, then @a.')).toEqual(['@a', '@b', '@c']);
  });
  it('reports a name in a code span, a fence, an HTML comment and a script block', () => {
    expect(mentionsIn('use `@bob` here')).toEqual(['@bob']);
    expect(mentionsIn('```\n@bob\n```')).toEqual(['@bob']);
    expect(mentionsIn('<!-- @bob -->')).toEqual(['@bob']);
    expect(mentionsIn('<script>\n@bob\n</script>')).toEqual(['@bob']);
  });
  it('reports a name whatever stands before the @: an underscore, a letter, a digit, an address', () => {
    expect(mentionsIn('_x_@bob')).toEqual(['@bob']);
    expect(mentionsIn('__init__@bob')).toEqual(['@bob']);
    expect(mentionsIn('mail x_@bob')).toEqual(['@bob']);
    expect(mentionsIn('9@bob')).toEqual(['@bob']);
    expect(mentionsIn('mail a@b.com')).toEqual(['@b.com']);
  });
  it('reports a name after a reference that a renderer may leave as text (the third re-review\'s cases)', () => {
    expect(mentionsIn('\\&#98;@bob')).toEqual(['@bob']);
    expect(mentionsIn('&#00000098;@bob')).toEqual(['@bob']);
    expect(mentionsIn('&#x0000062;@bob')).toEqual(['@bob']);
    expect(mentionsIn('Thanks \\&#97;@alice')).toEqual(['@alice']);
    expect(mentionsIn('&#98;@bob')).toEqual(['@bob']);
  });
  it('reads every written form of @ and of the characters of a name', () => {
    expect(mentionsIn('&#64;a &#x40;b &#X040;c &#0064;d &commat;e &COMMAT;f &#64g')).toEqual(['@a', '@b', '@c', '@d', '@e', '@f', '@g']);
    expect(mentionsIn('@&#98;ob')).toEqual(['@bob']);
    expect(mentionsIn('&#64;&#98;&#111;&#98;')).toEqual(['@bob']);
    expect(mentionsIn('&#x40;bob')).toEqual(['@bob']);
    expect(mentionsIn('&commat;bob')).toEqual(['@bob']);
    expect(mentionsIn('&#x00040;&#X62;ob &#0000064;&#x0062&#111b')).toEqual(['@bob']);
    expect(mentionsIn('@&fjlig;ord &commat;&fjlig;ell')).toEqual(['@fjord', '@fjell']);
    expect(mentionsIn('@org&sol;team @a&period;b @c&lowbar;d @e&UnderBar;f @g&sol;')).toEqual(['@org/team', '@a.b', '@c_d', '@e_f', '@g']);
    expect(mentionsIn('&#645;h &#x405;i &#1114112;j &#xD800;k')).toEqual([]);
  });
  it('decodes a reference only where a name character would stand', () => {
    expect(mentionsIn('@&sol;x @&period;y @&#x2F;z')).toEqual([]);
    expect(mentionsIn('@b&#32;ob @c&amp;d')).toEqual(['@b', '@c']);
    expect(mentionsIn('@a&#64;b')).toEqual(['@a', '@b']);
  });
  it('reports nothing for text with no @ directly before a letter or digit', () => {
    expect(mentionsIn('nothing to see here')).toEqual([]);
    expect(mentionsIn('a space: @ alice, @-x, @_y, @')).toEqual([]);
  });
  it('is not a judge of commentBody: names in its prose are broken, but a name inside a code part is over-reported', () => {
    expect(mentionsIn(commentBody(finding({ happens: 'Ask @alice', suggestedChange: '' })))).toEqual([]);
    expect(mentionsIn(commentBody(finding({ suggestedChange: 'x\n@alice' })))).toEqual(['@alice']);
  });
  it('runs in time linear in the text: 60,000 characters of the worst cases each take well under 500 ms', () => {
    const n = REVIEW_BODY_MAX;
    const many = Array.from({ length: n / 8 }, (_, i) => `@n${i.toString(36).padStart(5, '0')}`).join(' ');
    const cases = [
      `@a${'.'.repeat(n - 3)}b`, `@a${'.'.repeat(n - 2)}`, `@a${'/-_.'.repeat(n / 4)}`, `&#${'0'.repeat(n - 2)}`,
      `@${'&#0'.repeat(n / 3)}`, '@&#'.repeat(n / 3), '&#64;'.repeat(n / 5), `@${'&#98;'.repeat(n / 5)}`, many,
    ];
    for (const text of cases) {
      const started = performance.now();
      mentionsIn(text);
      expect(performance.now() - started, text.slice(0, 20)).toBeLessThan(500);
    }
    expect(mentionsIn(many)).toHaveLength(n / 8);
  });
});

describe('postMentions', () => {
  const quiet = commentBody(finding({ happens: 'Ask @alice', suggestedChange: 'x = 1\n// @bob' }));
  it('gives empty lists when everything is Airlock\'s own text', () => {
    const reviewBody = summaryBody([{ path: 'a.ts', line: 1, body: quiet }], defaultSummary(2));
    expect(postMentions(
      [{ body: quiet, isDefault: true, inSummary: false }, { body: quiet, isDefault: true, inSummary: true }],
      { isDefault: true }, reviewBody,
    )).toEqual({ items: [[], []], reviewBody: [] });
  });
  it('lists every name in the review body once the person typed the summary, a default body\'s code part too', () => {
    for (const summary of ['Use this:\n```', '~~~', '<script>', 'Use this:\n~~~', '<style>']) {
      const reviewBody = summaryBody([{ path: 'a.ts', line: 1, body: quiet }], summary);
      expect(postMentions([{ body: quiet, isDefault: true, inSummary: true }], { isDefault: false }, reviewBody), summary)
        .toEqual({ items: [[]], reviewBody: ['@bob'] });
    }
  });
  it('lists the names in the person\'s summary when every comment is inline and default', () => {
    const summary = 'Thanks @dave, see `@erin`.';
    const reviewBody = summaryBody([], summary);
    expect(postMentions([{ body: quiet, isDefault: true, inSummary: false }], { isDefault: false }, reviewBody))
      .toEqual({ items: [[]], reviewBody: mentionsIn(summary) });
    expect(mentionsIn(summary)).toEqual(['@dave', '@erin']);
  });
  it('lists an edited comment\'s own names, and the review body\'s too when that comment is in the summary', () => {
    const edited = 'I agree, ask @carol.';
    const reviewBody = summaryBody([], defaultSummary(1));
    expect(postMentions([{ body: edited, isDefault: false, inSummary: false }], { isDefault: true }, reviewBody))
      .toEqual({ items: [['@carol']], reviewBody: [] });
    const withIt = summaryBody([{ path: 'a.ts', line: 1, body: edited }, { path: 'b.ts', line: null, body: quiet }], defaultSummary(2));
    expect(postMentions(
      [{ body: edited, isDefault: false, inSummary: true }, { body: quiet, isDefault: true, inSummary: true }], { isDefault: true }, withIt,
    )).toEqual({ items: [['@carol'], []], reviewBody: ['@carol', '@bob'] });
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

/** What the renderers would show as text, outside code, with a `#` directly followed by a digit: a reference GitHub would link. */
function liveReferences(text: string): string[] {
  const found: string[] = [];
  const visit = (tokens: ReturnType<(typeof renderers)[number]['parse']>): void => {
    for (const token of tokens) {
      if (token.type === 'code_inline' || token.type === 'fence' || token.type === 'code_block') continue;
      if (token.children !== null) visit(token.children);
      else if (token.content !== '') for (const m of token.content.matchAll(/#[0-9]+/g)) found.push(m[0]);
    }
  };
  for (const md of renderers) visit(md.parse(text, {}));
  return [...new Set(found)];
}

/** The text of the last block when it is a paragraph at the top level, else null: what follows a cut part is not swallowed by it. */
function lastParagraph(text: string): string | null {
  const tokens = (renderers[0] as (typeof renderers)[number]).parse(text, {});
  const open = tokens[tokens.length - 3];
  return open?.type === 'paragraph_open' && open.level === 0 ? (tokens[tokens.length - 2]?.content ?? null) : null;
}

/** A small seeded generator, so every run tries the same cases. */
function generator(start: number) {
  let seed = start;
  const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed >>> 4; };
  const pieces = [
    '@name', '@org/team', '@a', '@a@b@c', '\u00E9@\u00E9t\u00E9', '`', '``', '```', '````', '~~~', '\\', '<div>', '</div>', '<!--',
    '-->', '<script>', '&#64;', '&commat;', '    ', '\t', '>', '- ', '1. ', '|', '*', '_', '[x](y)', '[x]', '[x]: y', '\n', '\n\n',
    ' ', 'x', 'Ab', '/', '@', '$', '\n$$\n', 'www.example.com/@bob', 'https://example.com/@bob', '===', '---', '#', "'",
    '#1', '#12', 'acme/widgets#3', '7', '&#35;4', 'GH#5',
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
  /** A finding whose every field may be thousands of characters long, so its drafted comment has to be cut. */
  const long = (): string => Array.from({ length: 1 + (next() % 300) }, () => text()).join('');
  const longFinding = (i: number): Finding => finding({
    title: long(), happens: long(), why: long(), suggestedChange: i % 2 === 0 ? long() : `${long()}\n${long()}`, path: path(),
    connected: Array.from({ length: next() % 40 }, () => ({ path: next() % 3 === 0 ? long() : path(), line: line(), role: text(), quote: 'q' })),
  });
  return { next, path, line, oneFinding, longFinding };
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
  it('makes no heading of a line that starts with # and a number, and no live reference, in every field', () => {
    const cases = ['#1 is the issue', '##12 twice', 'a\n#3 on a line', 'a\n   ###45 indented', '#6', '#7\n#8'];
    const headings = (text: string): number =>
      renderers.reduce((n, md) => n + md.parse(text, {}).filter((t) => t.type === 'heading_open').length, 0);
    for (const text of cases) {
      for (const f of [everywhere(text), finding({ happens: text, why: text, suggestedChange: text })]) {
        const body = commentBody(f);
        expect(headings(body), text).toBe(0);
        expect(liveReferences(body), text).toEqual([]);
      }
    }
    // The check can fail.
    expect(headings('# 1 heading')).toBe(2);
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
  it('sees a live reference in text that is not safe, and none in code', () => {
    expect(liveReferences('see #12 and acme/widgets#3')).toEqual(['#12', '#3']);
    expect(liveReferences('`#12`\n\n```\n#3\n```')).toEqual([]);
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
        expect(liveReferences(commentBody(f)), JSON.stringify(f)).toEqual([]);
      }
    }, 120_000);
  }
  for (const seed of SEEDS) {
    it(`cuts 60 generated long findings to fit, closed, with no live @name or reference, seed ${seed}`, () => {
      const { longFinding } = generator(seed);
      let cut = 0;
      for (let i = 0; i < 60; i += 1) {
        const f = longFinding(i);
        const body = commentBody(f);
        const what = JSON.stringify(f).slice(0, 300);
        expect([...body].length, what).toBeLessThanOrEqual(COMMENT_MAX);
        expect(checkCommentText(body), what).toBeNull();
        expect(liveNames(body), what).toEqual([]);
        expect(liveReferences(body), what).toEqual([]);
        if (body.endsWith(`\n\n${CUT_NOTE}`)) {
          cut += 1;
          expect(lastParagraph(body), what).toBe(CUT_NOTE);
        }
      }
      expect(cut).toBeGreaterThan(10);
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
        expect(liveReferences(body), JSON.stringify(inSummary)).toEqual([]);
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
