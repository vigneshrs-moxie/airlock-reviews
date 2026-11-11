// Reading a standard as whole sentences, so a quote offered as proof of documented intent can be checked against it.

/** A quote proves intent only when it is a whole sentence: this long without whitespace, with this many words. */
const MIN_SENTENCE_CHARS = 40;
const MIN_SENTENCE_WORDS = 4;

/** A leading list marker such as `- `, `* ` or `1. `; it is not part of the entry after it. */
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^\s*#/;
const TABLE_ROW = /^\s*\|/;
const BLOCK_QUOTE = /^\s*>\s?/;
/** A sentence ends at `.`, `!` or `?`, then whitespace, then an uppercase letter, a digit, a quote, a backtick, an opening bracket or the end. */
const SENTENCE_END = /(?<=[.!?])\s+(?=[\p{Lu}\p{N}"'`“‘([{]|$)/u;

const squash = (text: string): string => text.replace(/\s+/g, '');

/** One whole sentence, entry or table row without whitespace; `null` marks a heading, which no quote can match. */
export type Unit = string | null;

type Block = { kind: 'paragraph' | 'quote' | 'item' | 'heading' | 'row'; text: string };

/**
 * The text as paragraphs, block quotes, list entries, headings and table rows. A wrapped line continues the block above
 * it; a block ends at a blank line, before a list item, heading, table row or block quote, and after a heading or table
 * row. Consecutive block-quote lines form one block quote.
 */
function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let open: Block | null = null;
  for (const line of text.split(/\r?\n/)) {
    const body = line.trim();
    if (body === '') {
      open = null;
      continue;
    }
    let block: Block;
    if (HEADING.test(line)) block = { kind: 'heading', text: body };
    else if (TABLE_ROW.test(line)) block = { kind: 'row', text: body };
    else if (LIST_MARKER.test(line)) block = { kind: 'item', text: line.replace(LIST_MARKER, '').trim() };
    else if (BLOCK_QUOTE.test(line)) {
      const quoted = line.replace(BLOCK_QUOTE, '').trim();
      if (open !== null && open.kind === 'quote') {
        open.text += ` ${quoted}`;
        continue;
      }
      block = { kind: 'quote', text: quoted };
    } else if (open !== null) {
      open.text += ` ${body}`;
      continue;
    } else block = { kind: 'paragraph', text: body };
    blocks.push(block);
    open = block.kind === 'heading' || block.kind === 'row' ? null : block;
  }
  return blocks;
}

const sentencesIn = (text: string): string[] => text.split(SENTENCE_END).map((s) => s.trim()).filter((s) => s !== '');

/**
 * The units a quote must match whole, each without whitespace: the sentences of each paragraph, block quote and list
 * entry, and each table row. A list entry under a lead-in ending with a colon is one unit with that lead-in sentence.
 * A heading is `null`.
 */
export function unitsOf(text: string): Unit[] {
  const blocks = blocksOf(text);
  const units: Unit[] = [];
  let leadIn: string | null = null;
  blocks.forEach((b, i) => {
    if (b.kind === 'item') {
      units.push(...(leadIn === null ? sentencesIn(b.text) : [`${leadIn} ${b.text}`]).map(squash));
      return;
    }
    leadIn = null;
    if (b.kind === 'heading') units.push(null);
    else if (b.kind === 'row') units.push(squash(b.text));
    else {
      const sentences = sentencesIn(b.text);
      if (blocks[i + 1]?.kind === 'item' && sentences.at(-1)?.endsWith(':')) leadIn = sentences.pop()!;
      units.push(...sentences.map(squash));
    }
  });
  return units;
}

/** True when `needle` appears as consecutive items of `hay`. A heading matches nothing, not even another heading. */
const hasRun = (hay: Unit[], needle: Unit[]): boolean =>
  needle.length > 0 && hay.some((_, i) => needle.every((n, k) => n !== null && hay[i + k] === n));

const isLongEnough = (quote: string): boolean =>
  squash(quote).length >= MIN_SENTENCE_CHARS
  && quote.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length >= MIN_SENTENCE_WORDS;

/**
 * True when `quote` is one or more whole consecutive units of `text` (whitespace ignored) and is at least 40
 * characters without whitespace and four words long.
 */
export function isWholeUnits(quote: string, text: string): boolean {
  return isLongEnough(quote) && hasRun(unitsOf(text), unitsOf(quote));
}

/**
 * True when `quote` is the whole of `entry` (whitespace ignored, a leading list marker allowed) and is at least 40
 * characters without whitespace and four words long.
 */
export function isWholeEntry(quote: string, entry: string): boolean {
  return isLongEnough(quote) && squash(quote.replace(LIST_MARKER, '')) === squash(entry);
}
