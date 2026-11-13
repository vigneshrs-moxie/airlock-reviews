import type { Finding } from '@airlock/shared';

/**
 * How long a shown title may be, and a shown summary, in characters with the ellipsis. Characters are code points, as
 * zod counts them for `short` and `gist` (an emoji is one character).
 */
export const SHORT_TITLE_MAX = 60;
export const GIST_MAX = 200;

const present = (text: string | undefined): text is string => text !== undefined && text.trim() !== '';

/**
 * `text` with its runs of white space made single spaces; when that is longer than `max` characters, cut at the last
 * word that fits, with `…` at the end, `max` characters at most in all. A first word longer than `max - 1` is cut inside
 * the word. Commas, colons, full stops and dashes left at the cut are dropped. Counts code points.
 */
export function cutAtWord(text: string, max: number): string {
  const plain = text.replace(/\s+/g, ' ').trim();
  const chars = [...plain];
  if (chars.length <= max) return plain;
  const room = max - 1;
  const head = chars.slice(0, room);
  // The cut already falls between two words when the next character is a space.
  let end = chars[room] === ' ' ? room : head.lastIndexOf(' ');
  if (end <= 0) end = room;
  const kept = head.slice(0, end).join('').replace(/[\s,;:.\-–—]+$/u, '');
  return `${kept === '' ? head.join('') : kept}…`;
}

/** The finding's title as the panel shows it: the summary stage's `short`, else the title cut at a word to at most 60 characters. */
export function shortTitle(finding: Pick<Finding, 'title' | 'short'>): string {
  return present(finding.short) ? finding.short.trim() : cutAtWord(finding.title, SHORT_TITLE_MAX);
}

/** Words whose full stop does not end a sentence: abbreviations, written without their last full stop. */
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'vs', 'etc']);

/** Whether the full stop at `at` ends an abbreviation ("e.g.", "vs.") or a single capital letter ("J."), not a sentence. */
function abbreviationAt(text: string, at: number): boolean {
  const word = text.slice(0, at).split(' ').at(-1)?.replace(/^[("'“‘[]+/u, '') ?? '';
  return ABBREVIATIONS.has(word.toLowerCase()) || /^\p{Lu}$/u.test(word);
}

/**
 * The first sentence of `text`: up to the first `.`, `!` or `?` followed by a space or the end, passing over the full stop
 * of "e.g.", "i.e.", "vs.", "etc." and a single capital letter; the whole text when there is none.
 */
function firstSentence(text: string): string {
  for (const end of text.matchAll(/[.!?](?=\s|$)/gu)) {
    if (end[0] === '.' && abbreviationAt(text, end.index)) continue;
    return text.slice(0, end.index + 1);
  }
  return text;
}

/** The finding in one paragraph: the summary stage's `gist`, else the first sentence of `happens`, at most 200 characters. */
export function gistOf(finding: Pick<Finding, 'happens' | 'gist'>): string {
  return present(finding.gist) ? finding.gist.trim() : cutAtWord(firstSentence(finding.happens.replace(/\s+/g, ' ').trim()), GIST_MAX);
}
