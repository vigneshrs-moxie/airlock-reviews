// No dependency on zod, so code that must stay dependency-free can import this module by path.
import { dropBlankLetters } from './fix-prompt.js';
import type { Finding } from './review.js';
import { visibleText } from './visible-text.js';
import { SEVERITY_WORD } from './words.js';

export const COMMENT_MAX = 4000;
export const SUMMARY_MAX = 4000;
export const POST_MAX_ITEMS = 30;
export const REVIEW_BODY_MAX = 60000;

// An `@` as typed, or written as `&#64;` or `&#x40;` (any case, leading zeros, `;` or not; the digits are read as far as
// they go, as a browser reads them, so `&#645;` is not an `@`) or as `&commat;`.
const AT = /@|&(?:#(?:x0*40(?![0-9a-f])|0*64(?![0-9]))|commat);?/iy;
// One character of a name as typed (a letter, a digit, `.`, `_`, `/` or `-`), or a reference standing in its place:
// numeric, or one of the named references whose value is such characters.
const NAME_UNIT = /[\p{L}\p{N}._/-]|&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));?|&(fjlig|sol|period|lowbar|UnderBar);/uy;
const NAMED: Record<string, string> = { fjlig: 'fj', sol: '/', period: '.', lowbar: '_', UnderBar: '_' };
const NAME_CHAR = /^[\p{L}\p{N}._/-]$/u;
const STARTS_NAME = /^[\p{L}\p{N}]/u;
const CANDIDATE = /[@&]/g;

/** The characters of the name unit that starts at `at`, and where it ends, or null when none starts there. */
function nameUnitAt(text: string, at: number): { chars: string; end: number } | null {
  NAME_UNIT.lastIndex = at;
  const match = NAME_UNIT.exec(text);
  if (match === null) return null;
  const [whole, hex, decimal, named] = match;
  const end = at + whole.length;
  if (named !== undefined) return { chars: NAMED[named] as string, end };
  if (hex === undefined && decimal === undefined) return { chars: whole, end };
  const code = hex === undefined ? Number.parseInt(decimal as string, 10) : Number.parseInt(hex, 16);
  if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return null;
  const chars = String.fromCodePoint(code);
  return NAME_CHAR.test(chars) ? { chars, end } : null;
}

/**
 * Every `@name` (`@login` or `@org/team`) in text the person typed or changed, once each, in order, with the `@`. A name
 * is reported for every `@`, typed or written as a reference, whose next character is a letter or digit, whatever
 * stands before it and wherever it stands: inside backticks, fences or HTML too. The name's own characters may be
 * references too (`@&#98;ob`, `@&fjlig;ord`, `@org&sol;team`); trailing `. _ / -` are left outside it. It does not read
 * Markdown, so it over-reports on purpose: a name inside code, or the end of an email address (`a@b.com` gives
 * `@b.com`), is reported although GitHub would not notify. Text Airlock drafts needs no such warning: see
 * `commentBody`. It runs in time linear in the text's length.
 */
export function mentionsIn(text: string): string[] {
  const found = new Set<string>();
  CANDIDATE.lastIndex = 0;
  for (let next = CANDIDATE.exec(text); next !== null; next = CANDIDATE.exec(text)) {
    AT.lastIndex = next.index;
    const at = AT.exec(text);
    if (at === null) continue;
    let end = next.index + at[0].length;
    let name = '';
    for (let unit = nameUnitAt(text, end); unit !== null; unit = nameUnitAt(text, end)) {
      if (name === '' && !STARTS_NAME.test(unit.chars)) break;
      name += unit.chars;
      end = unit.end;
    }
    let keep = name.length;
    while (keep > 0 && '._/-'.includes(name.charAt(keep - 1))) keep -= 1;
    if (keep > 0) found.add(`@${name.slice(0, keep)}`);
    CANDIDATE.lastIndex = end;
  }
  return [...found];
}

/**
 * The names the preview warns about. An item's list is empty when its body is Airlock's own, and every name in it
 * otherwise. The review body's list is empty only when the summary and every comment placed in the summary are
 * Airlock's own text; once the person typed or changed any of them, it is every name in the whole review body, since
 * what they typed can change how the drafted text around it reads.
 */
export function postMentions(
  items: { body: string; isDefault: boolean; inSummary: boolean }[],
  summary: { isDefault: boolean },
  reviewBody: string,
): { items: string[][]; reviewBody: string[] } {
  const allDefault = summary.isDefault && items.every((item) => !item.inSummary || item.isDefault);
  return {
    items: items.map((item) => (item.isDefault ? [] : mentionsIn(item.body))),
    reviewBody: allDefault ? [] : mentionsIn(reviewBody),
  };
}

/** Hidden characters and blank letters dropped, every kind of line break a line feed. */
function seen(value: string): string {
  const { text } = visibleText(value.replace(/\r\n|[\r\u0085\u2028\u2029]/g, '\n'));
  return dropBlankLetters(text).text;
}

// An `@` directly followed by a letter or digit, in any script.
const AT_BEFORE_NAME = /@(?=[\p{L}\p{N}])/gu;
// A `#` directly followed by a digit: GitHub links `#12` and `owner/repo#12` to that issue or pull request.
const HASH_BEFORE_NUMBER = /#(?=[0-9])/g;
// The `#`s that start a line, before a digit: with the space put after them they would make a heading.
const HASHES_OPENING_LINE = /^#+(?=[0-9])/gm;

/**
 * Text taken from a pull request, as prose that cannot notify anyone whatever stands around it: hidden characters out,
 * `&` and `<` as entities (no tag, comment or entity is live), every backslash doubled (none escapes what follows),
 * every `~` and `$` escaped and every line's leading white space dropped (no line can open a fence, a code block or
 * math), every backtick an apostrophe (no code span), and then a space after every `@` that is directly followed by a
 * letter or digit (`@alice` becomes `@ alice`), so no `@` stands directly before a name, and after every `#` that is
 * directly followed by a digit (`#12` becomes `# 12`), so the text makes no reference to another issue or pull request;
 * where such `#`s start a line the first is escaped (`#12` becomes `\# 12`), so the line is not made a heading.
 */
export function plainProse(value: string): string {
  return seen(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/\\/g, '\\\\')
    .replace(/~/g, '\\~')
    .replace(/\$/g, '\\$')
    .replace(/^[ \t]+/gm, '')
    .replace(/`/g, "'")
    .replace(AT_BEFORE_NAME, '@ ')
    .replace(HASHES_OPENING_LINE, (hashes) => `\\${hashes} `)
    .replace(HASH_BEFORE_NUMBER, '# ')
    .trim();
}

const oneLine = (value: string): string => plainProse(seen(value).replace(/\s+/g, ' '));

/** Code (a quote, a multi-line change) in a fenced block: fences on their own lines, longer than any backtick run inside. */
function fencedBlock(value: string): string {
  const text = seen(value).trim();
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * A path (it comes from the pull request) in a code span, its own backticks turned into apostrophes and its line breaks
 * into spaces, so the span is one backtick, some text and one backtick. A path with nothing left is the plain words
 * `(no path)`, never an empty span (two backticks in a row).
 */
function place(path: string, line: number | null): string {
  const text = seen(path).replace(/\s+/g, ' ').replace(/`/g, "'").trim();
  if (text === '') return '(no path)';
  return `\`${line === null ? text : `${text}:${line}`}\``;
}

/** The last line of a drafted comment that had to be cut to fit in COMMENT_MAX characters. */
export const CUT_NOTE = '(Cut to fit; the full finding is in Airlock.)';

/** Length in characters (code points), as COMMENT_MAX counts them. */
const chars = (text: string): number => [...text].length;
const firstChars = (text: string, n: number): string => (n <= 0 ? '' : [...text].slice(0, n).join(''));

/**
 * Rendered prose cut to at most `room` characters. It never ends in white space or a backslash, so it cannot escape or
 * join what follows it; everything else in prose is safe at any cut (it holds no backtick, no live `<` or `&`, and no
 * `@` or `#` directly before a name or a number, and cutting adds no character).
 */
const cutProse = (prose: string, room: number): string => firstChars(prose, room).replace(/[\s\\]+$/u, '');

/** One part of a drafted comment, and how to cut it to fit in `room` characters ('' when nothing of it fits). */
interface Part { text: string; cut: (room: number) => string }

const prosePart = (lead: string, prose: string): Part => ({
  text: `${lead}${prose}`,
  cut: (room) => {
    const kept = cutProse(prose, room - chars(lead));
    return kept === '' ? '' : `${lead}${kept}`;
  },
});

/** The parts of the comment drafted from a finding, in order, empty ones left out. */
function draftedParts(f: Finding): Part[] {
  const titleLead = `**${SEVERITY_WORD[f.severity]}: `;
  const title = oneLine(f.title);
  const parts: Part[] = [
    {
      text: `${titleLead}${title}**`,
      cut: (room) => {
        const kept = cutProse(title, room - chars(titleLead) - 2);
        return kept === '' ? '' : `${titleLead}${kept}**`;
      },
    },
    prosePart('', plainProse(f.happens)),
    prosePart('', plainProse(f.why)),
  ];
  const change = seen(f.suggestedChange).trim();
  if (change.includes('\n')) {
    const lead = 'Suggested change:\n';
    const whole = fencedBlock(change);
    // The fence of the whole change is at least as long as the fence of any piece of it.
    const fence = whole.indexOf('\n');
    parts.push({
      text: `${lead}${whole}`,
      cut: (room) => {
        const kept = firstChars(change, room - chars(lead) - 2 * fence - 2).trim();
        return kept === '' ? '' : `${lead}${fencedBlock(kept)}`;
      },
    });
  } else if (change !== '') {
    parts.push(prosePart('Suggested change: ', plainProse(change)));
  }
  if (f.connected.length > 0) {
    const lead = 'Connected: ';
    const places = f.connected.map((c) => `${place(c.path, c.line)} (${oneLine(c.role)})`);
    parts.push({
      text: `${lead}${places.join(', ')}`,
      // Whole places only: a code span is never cut.
      cut: (room) => {
        let kept = '';
        for (const p of places) {
          const next = kept === '' ? `${lead}${p}` : `${kept}, ${p}`;
          if (chars(next) > room) break;
          kept = next;
        }
        return kept;
      },
    });
  }
  return parts.filter((part) => part.text !== '');
}

/**
 * The comment drafted from a finding. It is built from prose parts (through `plainProse`), paths in code spans and
 * fenced code parts only, joined by blank lines. Prose holds no backtick, so the only backticks are those spans and
 * fences, each written whole here; and no `@` in prose stands directly before a letter or digit, nor `#` before a digit.
 * So text taken from the pull request cannot notify anyone or reference another issue (proven against a Markdown
 * renderer in the tests). A comment that would be longer than COMMENT_MAX is cut to fit: the parts that fit are kept
 * whole, the first that does not is cut (prose at a character, a fenced change inside its fence, the connected places
 * at a whole place), the rest are left out, and the last line is CUT_NOTE. So every drafted comment can be posted.
 */
export function commentBody(f: Finding): string {
  const parts = draftedParts(f);
  const whole = parts.map((part) => part.text).join('\n\n');
  if (chars(whole) <= COMMENT_MAX) return whole;
  const budget = COMMENT_MAX - chars(`\n\n${CUT_NOTE}`);
  const kept: string[] = [];
  let used = 0;
  for (const part of parts) {
    const gap = kept.length === 0 ? 0 : 2;
    const room = budget - used - gap;
    const fits = chars(part.text) <= room;
    const piece = fits ? part.text : part.cut(room);
    if (piece !== '') {
      kept.push(piece);
      used += gap + chars(piece);
    }
    if (!fits) break;
  }
  return [...kept, CUT_NOTE].join('\n\n');
}

/**
 * The review's own text: the summary, then the comments that could not go on a changed line, each under its place.
 * With the default summary and untouched `commentBody` bodies it notifies no one. Once the person typed the summary or
 * changed a body, it is their text, and the preview lists every name in it (`postMentions`).
 */
export function summaryBody(inSummary: { path: string; line: number | null; body: string }[], summary: string): string {
  const parts = [summary.trim()];
  if (inSummary.length > 0) {
    parts.push('Not on a changed line:', ...inSummary.map((item) => `${place(item.path, item.line)}\n${item.body}`));
  }
  return parts.filter((part) => part !== '').join('\n\n');
}

/** Why text cannot be posted as it stands, in one sentence, or null when it can. Text the person typed is refused, not cleaned. */
export function checkCommentText(text: string, max: number = COMMENT_MAX): string | null {
  if (text.trim() === '') return 'The text is empty.';
  const over = [...text].length - max;
  if (over > 0) return `The text is ${over} character${over === 1 ? '' : 's'} longer than the ${max} allowed.`;
  if (visibleText(text).removed > 0 || dropBlankLetters(text).removed > 0 || /\p{Cs}/u.test(text)) {
    return 'The text has a hidden character; remove it.';
  }
  return null;
}
