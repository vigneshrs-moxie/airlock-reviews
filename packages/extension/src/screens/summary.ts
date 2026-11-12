import type { Finding } from '@airlock/shared';

/** How long a row's title may be before it is cut, and a summary before it is cut. */
export const SHORT_LIMIT = 60;
export const GIST_LIMIT = 200;

/**
 * `text` with its runs of white space made single spaces, cut at a word to at most `limit` characters (code points) with
 * `…` at the end when it was cut. A first word longer than the limit is cut inside the word.
 */
export function cutAtWord(text: string, limit: number): string {
  const plain = text.replace(/\s+/g, ' ').trim();
  const chars = [...plain];
  if (chars.length <= limit) return plain;
  const room = chars.slice(0, limit - 1).join('');
  const space = room.lastIndexOf(' ');
  const kept = (space > 0 ? room.slice(0, space) : room).replace(/[\s,;:.\-–—]+$/u, '');
  return `${kept === '' ? room : kept}…`;
}

const present = (text: string | undefined): text is string => text !== undefined && text.trim() !== '';

/** A finding's title for a row: its `short`, written by the summary stage, else its title cut at a word to about 60 characters. */
export function shortTitle(finding: Pick<Finding, 'title' | 'short'>): string {
  return present(finding.short) ? finding.short.trim() : cutAtWord(finding.title, SHORT_LIMIT);
}

/** A finding in one or two sentences: its `gist`, else the first sentence of what happens, at most 200 characters. */
export function gistOf(finding: Pick<Finding, 'gist' | 'happens'>): string {
  if (present(finding.gist)) return finding.gist.trim();
  const happens = finding.happens.replace(/\s+/g, ' ').trim();
  const end = /[.!?](?=\s|$)/.exec(happens);
  return cutAtWord(end === null ? happens : happens.slice(0, end.index + 1), GIST_LIMIT);
}
