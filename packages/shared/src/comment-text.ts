// No dependency on zod, so code that must stay dependency-free can import this module by path.
import { BLANK_LETTERS } from './fix-prompt.js';
import type { Finding } from './review.js';
import { visibleText } from './visible-text.js';
import { SEVERITY_WORD } from './words.js';

export const COMMENT_MAX = 4000;
export const SUMMARY_MAX = 4000;
export const POST_MAX_ITEMS = 30;
export const REVIEW_BODY_MAX = 60000;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_LINE = /^\s*(`{3}|~{3})/m;
// An `@` that starts the text or follows something that is not a letter, digit, `_`, `/` or `@`, then a login or `org/team`.
const NAME = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const MENTION = new RegExp(`(?<![\\p{L}\\p{N}_/@])@${NAME}(?:/${NAME})?`, 'gu');

interface Segment { code: boolean; text: string }

/** Splits text into the parts GitHub shows as code (fenced blocks and backtick spans) and the rest. */
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
        out.push({ code: true, text: block });
        block = '';
        fence = null;
      }
      continue;
    }
    const open = FENCE_OPEN.exec(bare);
    const marks = open?.[1];
    if (open !== null && marks !== undefined && !(marks[0] === '`' && (open[2] ?? '').includes('`'))) {
      flush();
      fence = { char: marks[0] ?? '`', length: marks.length };
      block = line;
    } else {
      plain += line;
    }
  }
  if (fence !== null) out.push({ code: true, text: block });
  flush();
  return out;
}

/** The backtick spans of a run of ordinary lines: a run of N backticks to the next run of exactly N. */
function spans(text: string): Segment[] {
  const out: Segment[] = [];
  const runs = [...text.matchAll(/`+/g)];
  let from = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const open = runs[i];
    if (open === undefined || open.index < from) continue;
    const close = runs.slice(i + 1).find((run) => run[0].length === open[0].length);
    if (close === undefined) continue;
    if (open.index > from) out.push({ code: false, text: text.slice(from, open.index) });
    const end = close.index + close[0].length;
    out.push({ code: true, text: text.slice(open.index, end) });
    from = end;
  }
  if (from < text.length) out.push({ code: false, text: text.slice(from) });
  return out;
}

/** Every `@name` (`@login` or `@org/team`) outside code spans and fenced blocks, once each, in order. */
export function mentionsIn(text: string): string[] {
  const found: string[] = [];
  for (const part of segments(text)) {
    if (part.code) continue;
    for (const match of part.text.matchAll(MENTION)) if (!found.includes(match[0])) found.push(match[0]);
  }
  return found;
}

/** One pass: every `@name` found in the text as it stands is put in backticks. */
function quietOnce(text: string): string {
  const parts = segments(text);
  // A delimiter no stray backtick run has (a stray one would pair with ours and bend a span), so ours pairs only with itself.
  const stray = new Set<number>();
  for (const part of parts) if (!part.code) for (const run of part.text.match(/`+/g) ?? []) stray.add(run.length);
  let size = 1;
  while (stray.has(size)) size += 1;
  const tick = '`'.repeat(size);
  return parts.map((part) => {
    if (part.code) return part.text;
    return part.text.replace(MENTION, (name, offset: number, whole: string) => {
      // A space keeps the delimiter from joining a stray backtick next to it.
      const before = offset > 0 && whole[offset - 1] === '`' ? ' ' : '';
      const after = whole[offset + name.length] === '`' ? ' ' : '';
      return `${before}${tick}${name}${tick}${after}`;
    });
  }).join('');
}

/**
 * The text with every `@name` outside code put in backticks, so GitHub notifies no one. A name next to another (`@a@b`)
 * only shows once the first is wrapped, so it goes again until none is left; text with none left comes back unchanged.
 */
export function quietMentions(text: string): string {
  let current = text;
  for (let pass = 0; pass < 8 && mentionsIn(current).length > 0; pass += 1) current = quietOnce(current);
  return current;
}

/** Hidden characters and blank letters dropped, every kind of line break a line feed. */
function seen(value: string): string {
  const { text } = visibleText(value.replace(/\r\n|[\r\u0085\u2028\u2029]/g, '\n'));
  return text.replace(BLANK_LETTERS, '');
}

function oneLine(value: string): string {
  return quietMentions(seen(value).replace(/[\s\u0085]+/g, ' ').trim());
}

/** Several lines, blank lines out; a part with a code fence in it is fenced again, longer, so it stays text. */
function manyLines(value: string): string {
  const text = seen(value).split('\n').filter((line) => line.trim() !== '').join('\n');
  if (!FENCE_LINE.test(text)) return quietMentions(text);
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** Text in a code span, whatever backticks it holds. */
function codeSpan(value: string): string {
  const text = seen(value).replace(/\s+/g, ' ').trim();
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const tick = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${tick}${pad}${text}${pad}${tick}`;
}

const place = (path: string, line: number | null): string => codeSpan(line === null ? path : `${path}:${line}`);

/** The comment drafted from a finding. Text taken from the pull request cannot notify anyone: every `@name` is in backticks. */
export function commentBody(f: Finding): string {
  const parts = [`**${SEVERITY_WORD[f.severity]}: ${oneLine(f.title)}**`, manyLines(f.happens), manyLines(f.why)];
  const change = manyLines(f.suggestedChange);
  if (change !== '') parts.push(`Suggested change: ${change}`);
  if (f.connected.length > 0) {
    parts.push(`Connected: ${f.connected.map((c) => `${place(c.path, c.line)} (${oneLine(c.role)})`).join(', ')}`);
  }
  return parts.filter((part) => part !== '').join('\n\n');
}

/**
 * The review's own text: the summary, then the comments that could not go on a changed line, each under its place.
 * `inlineCount` is how many comments go inline; it does not change the text.
 */
export function summaryBody(
  _inlineCount: number, inSummary: { path: string; line: number | null; body: string }[], summary: string,
): string {
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
  if (visibleText(text).removed > 0) return 'The text has a hidden character; remove it.';
  return null;
}
