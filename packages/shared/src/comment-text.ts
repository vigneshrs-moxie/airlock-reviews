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
const MENTION_IN_PROSE = new RegExp(`@(?=[\\p{L}\\p{N}])${NAME_CHARS}`, 'gu');
// For text the person typed: the `@` may follow anything but an ASCII letter, digit or `_`.
const MENTION_ANYWHERE = new RegExp(`(?<![A-Za-z0-9_])@(?=[\\p{L}\\p{N}])${NAME_CHARS}`, 'gu');
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const TRAILING = /[._/-]+$/;

interface Segment { code: boolean; text: string }

/** The backtick runs of a run of ordinary lines that can open or close a span: those not escaped by a backslash. */
function runsOf(text: string): { index: number; length: number }[] {
  const runs: { index: number; length: number }[] = [];
  for (const match of text.matchAll(/`+/g)) {
    let slashes = 0;
    while (text[match.index - 1 - slashes] === '\\') slashes += 1;
    if (slashes % 2 === 0) runs.push({ index: match.index, length: match[0].length });
  }
  return runs;
}

/** The backtick spans of a run of ordinary lines: a run of N backticks to the next run of exactly N. An unclosed one protects nothing. */
function spans(text: string): Segment[] {
  const out: Segment[] = [];
  const runs = runsOf(text);
  let from = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const open = runs[i];
    if (open === undefined || open.index < from) continue;
    const close = runs.slice(i + 1).find((run) => run.length === open.length);
    if (close === undefined) continue;
    if (open.index > from) out.push({ code: false, text: text.slice(from, open.index) });
    const end = close.index + close.length;
    out.push({ code: true, text: text.slice(open.index, end) });
    from = end;
  }
  if (from < text.length) out.push({ code: false, text: text.slice(from) });
  return out;
}

/** Splits text into closed fenced blocks and backtick spans (code) and everything else. An unclosed fence protects nothing. */
function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let plain = '';
  const flush = (): void => {
    if (plain !== '') out.push(...spans(plain));
    plain = '';
  };
  let fence: { char: string; length: number } | null = null;
  let block = '';
  for (const line of text.split(/(?<=\n)/)) {
    const bare = line.replace(/\n$/, '');
    if (fence !== null) {
      block += line;
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(bare);
      if (close?.[1] !== undefined && close[1][0] === fence.char && close[1].length >= fence.length) {
        flush();
        out.push({ code: true, text: block });
        block = '';
        fence = null;
      }
      continue;
    }
    const open = FENCE_OPEN.exec(bare);
    const marks = open?.[1];
    if (open !== null && marks !== undefined && !(marks[0] === '`' && (open[2] ?? '').includes('`'))) {
      fence = { char: marks[0] ?? '`', length: marks.length };
      block = line;
    } else {
      plain += line;
    }
  }
  if (fence !== null) plain += block; // never closed: what follows is not protected
  flush();
  return out;
}

/**
 * Every `@name` (`@login` or `@org/team`) in text the person typed or kept, outside closed code spans and fenced blocks,
 * once each, in order. It errs towards reporting: names in HTML and after a backslash-escaped backtick are reported.
 */
export function mentionsIn(text: string): string[] {
  const found: string[] = [];
  for (const part of segments(text)) {
    if (part.code) continue;
    for (const match of part.text.matchAll(MENTION_ANYWHERE)) {
      const name = match[0].replace(TRAILING, '');
      if (!found.includes(name)) found.push(name);
    }
  }
  return found;
}

/** Hidden characters and blank letters dropped, every kind of line break a line feed. */
function seen(value: string): string {
  const { text } = visibleText(value.replace(/\r\n|[\r\u0085\u2028\u2029]/g, '\n'));
  return dropBlankLetters(text).text;
}

/**
 * Text taken from a pull request, as prose that cannot notify anyone: hidden characters out, `&` and `<` as entities
 * (no tag, comment or entity is live), every backslash doubled (none escapes what follows), every backtick an
 * apostrophe, and then every `@name` in backticks, so the only backticks left are the pairs that hold a name.
 */
export function plainProse(value: string): string {
  return seen(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, "'")
    .replace(MENTION_IN_PROSE, (match) => {
      const name = match.replace(TRAILING, '');
      return `\`${name}\`${match.slice(name.length)}`;
    })
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

/** A path (it comes from the pull request) in a code span, its own backticks turned into apostrophes. */
function place(path: string, line: number | null): string {
  const text = seen(line === null ? path : `${path}:${line}`).replace(/\s+/g, ' ').replace(/`/g, "'").trim();
  return `\`${text}\``;
}

/**
 * The comment drafted from a finding. It is built from prose parts (through `plainProse`) and fenced code parts only,
 * joined by blank lines, so text taken from the pull request cannot notify anyone.
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
 * The summary is the person's own text; each body is a comment body.
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
