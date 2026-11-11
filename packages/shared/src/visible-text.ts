// No dependency on zod, so a small bundle (the content script) could import this module by path.

/**
 * Characters no screen shows: controls other than line feed and tab (a carriage return too, so CR LF becomes LF),
 * format characters (zero-width and bidirectional marks, tag characters), the line and paragraph separators, and the
 * variation selectors.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

/** The text without the characters a person cannot see, and how many were dropped. */
export function visibleText(text: string): { text: string; removed: number } {
  let removed = 0;
  const kept = text.replace(HIDDEN, (ch) => {
    if (ch === '\n' || ch === '\t') return ch;
    removed += 1;
    return '';
  });
  return { text: kept, removed };
}
