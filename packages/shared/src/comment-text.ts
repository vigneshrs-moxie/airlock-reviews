// No dependency on zod, so code that must stay dependency-free can import this module by path.
import { dropBlankLetters } from './fix-prompt.js';
import type { Finding } from './review.js';
import { visibleText } from './visible-text.js';
import { SEVERITY_WORD } from './words.js';

export const COMMENT_MAX = 4000;
export const SUMMARY_MAX = 4000;
export const POST_MAX_ITEMS = 30;
export const REVIEW_BODY_MAX = 60000;

// A name: `@` then letters, digits and `- _ . /`; trailing punctuation is left outside it.
const NAME_CHARS = '[\\p{L}\\p{N}._/-]*';
// The `@` may follow anything but an ASCII letter or digit (after `_` it can still notify: `_x_@bob` is `<em>x</em>@bob`).
const MENTION_ANYWHERE = new RegExp(`(?<![A-Za-z0-9])@(?=[\\p{L}\\p{N}])${NAME_CHARS}`, 'gu');
const TRAILING = /[._/-]+$/;
// Every numeric character reference, decimal or hexadecimal, with or without its `;`, and `&commat;`.
const CHARACTER_REFERENCE = /&#(?:x([0-9a-f]+)|([0-9]+));?|&commat;?/gi;

/** The text as a browser would read its character references; one that names no character is left as it was. */
function decodeReferences(text: string): string {
  return text.replace(CHARACTER_REFERENCE, (whole, hex: string | undefined, decimal: string | undefined) => {
    if (hex === undefined && decimal === undefined) return '@';
    const code = hex === undefined ? Number.parseInt(decimal as string, 10) : Number.parseInt(hex, 16);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
    return String.fromCodePoint(code);
  });
}

/**
 * Every `@name` (`@login` or `@org/team`) in text the person typed or changed, once each, in order, with the `@`,
 * wherever it stands: inside backticks, fences or HTML too, and with the `@` or the name written as character references
 * (`&#64;`, `&#x40;`, `&commat;`, `&#98;`). It does not read Markdown, so it over-reports on purpose (a name inside code
 * is reported although GitHub would not notify). Text Airlock drafts needs no such warning: see `commentBody`.
 */
export function mentionsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of decodeReferences(text).matchAll(MENTION_ANYWHERE)) {
    const name = match[0].replace(TRAILING, '');
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * The names the preview warns about. An item's list is empty when its body is Airlock's own, and every name in it
 * otherwise. The review body's list is empty only when the summary and every comment placed in the summary are
 * Airlock's own text; once the person typed or changed any of them, it is every name in the whole review body, since
 * what they typed can change how the drafted text around it reads.
 */
export function postMentions(
  items: { body: string; isDefault: boolean; inSummary: boolean }[],
  summary: { text: string; isDefault: boolean },
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

/**
 * Text taken from a pull request, as prose that cannot notify anyone whatever stands around it: hidden characters out,
 * `&` and `<` as entities (no tag, comment or entity is live), every backslash doubled (none escapes what follows),
 * every `~` and `$` escaped and every line's leading white space dropped (no line can open a fence, a code block or
 * math), every backtick an apostrophe (no code span), and then a space after every `@` that is directly followed by a
 * letter or digit (`@alice` becomes `@ alice`), so no `@` stands directly before a name.
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

/**
 * The comment drafted from a finding. It is built from prose parts (through `plainProse`), paths in code spans and
 * fenced code parts only, joined by blank lines. Prose holds no backtick, so the only backticks are those spans and
 * fences, each written whole here; and no `@` in prose stands directly before a letter or digit. So text taken from
 * the pull request cannot notify anyone (proven against a Markdown renderer in the tests).
 */
export function commentBody(f: Finding): string {
  const parts = [`**${SEVERITY_WORD[f.severity]}: ${oneLine(f.title)}**`, plainProse(f.happens), plainProse(f.why)];
  const change = seen(f.suggestedChange).trim();
  if (change.includes('\n')) parts.push(`Suggested change:\n${fencedBlock(change)}`);
  else if (change !== '') parts.push(`Suggested change: ${plainProse(change)}`);
  if (f.connected.length > 0) {
    parts.push(`Connected: ${f.connected.map((c) => `${place(c.path, c.line)} (${oneLine(c.role)})`).join(', ')}`);
  }
  return parts.filter((part) => part !== '').join('\n\n');
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
