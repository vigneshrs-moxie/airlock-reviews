import type { Finding } from '@airlock/shared';

/** How long a shown title may be, in characters, ellipsis included. */
export const SHORT_TITLE_MAX = 60;
/** How long a shown summary may be, in characters, ellipsis included. */
export const GIST_MAX = 200;

const present = (text: string | undefined): text is string => text !== undefined && text.trim() !== '';

/**
 * `text` when it has at most `max` characters; otherwise cut at the last word that fits, with an ellipsis, `max`
 * characters at most in all. A first word longer than `max` is cut inside the word. Counts code points.
 */
function cutAtWord(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const room = max - 1;
  const head = chars.slice(0, room);
  // The cut already falls between two words when the next character is a space.
  let end = /\s/.test(chars[room] ?? '') ? room : head.findLastIndex((c) => /\s/.test(c));
  if (end <= 0) end = room;
  return `${head.slice(0, end).join('').replace(/[\s,;:–—-]+$/u, '')}…`;
}

/** The finding's title as the panel shows it: the summary stage's `short`, else the title cut at a word to about 60 characters. */
export function shortTitle(finding: Pick<Finding, 'title' | 'short'>): string {
  return present(finding.short) ? finding.short : cutAtWord(finding.title, SHORT_TITLE_MAX);
}

/** The first sentence of `text`: up to the first `.`, `!` or `?` followed by a space or the end; the whole text when there is none. */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = /[.!?](?=\s|$)/u.exec(trimmed);
  return end === null ? trimmed : trimmed.slice(0, end.index + 1);
}

/** The finding in one paragraph: the summary stage's `gist`, else the first sentence of `happens`, at most 200 characters. */
export function gistOf(finding: Pick<Finding, 'happens' | 'gist'>): string {
  return present(finding.gist) ? finding.gist : cutAtWord(firstSentence(finding.happens), GIST_MAX);
}
