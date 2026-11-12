// Every selector Airlock uses on GitHub's Files changed page, each with a name. A selector that finds nothing is named in
// the jump's reply, so the panel's Packs screen and the console show it.
//
// The classic view was checked on a live page on 2026-11-11 (docs/reference/chrome-notes.md). The newer view was NOT
// checked: its selectors come from the source of two other extensions, which match parts of generated class names.

import type { View } from './protocol';

export interface NamedSelector {
  readonly name: string;
  readonly css: string;
}

export type { View };

export const CLASSIC = {
  file: { name: 'classic-file', css: 'div.file.js-file[id^="diff-"]' },
  newLineNumber: { name: 'classic-new-line-number', css: 'td.blob-num.js-blob-rnum' },
} as const satisfies Record<string, NamedSelector>;

export const REACT = {
  toolbar: { name: 'react-toolbar', css: '[class*="PullRequestFilesToolbar-module__toolbar"]' },
  file: { name: 'react-file', css: '[class*="diffTargetable"][id^="diff-"]' },
  row: { name: 'react-row', css: '.diff-line-row' },
  lineNumber: { name: 'react-line-number', css: 'td[class*="diff-line-number"]' },
} as const satisfies Record<string, NamedSelector>;

/**
 * The element holding every file of each view, which the notes watch for GitHub's re-renders (the page's body when it
 * matches nothing). The classic one is in the fixture taken from a live page; the newer one is unconfirmed.
 */
export const FILES: Record<View, NamedSelector> = {
  classic: { name: 'classic-files', css: '#files.js-diff-container' },
  react: { name: 'react-files', css: '[data-testid="progressive-diffs-list"]' },
};

/** What the lookups use for each view; for an unrecognised page, what was tried to recognise it. */
const TRIED: Record<View | 'none', readonly NamedSelector[]> = {
  classic: [CLASSIC.file, CLASSIC.newLineNumber],
  react: [REACT.toolbar, REACT.file, REACT.row, REACT.lineNumber],
  none: [CLASSIC.file, REACT.file, REACT.toolbar],
};

/** The names of the selectors tried for `view` (or to recognise the page, when null) that match nothing on the page. */
export function missingFor(doc: Document, view: View | null): string[] {
  return TRIED[view ?? 'none'].filter((s) => doc.querySelector(s.css) === null).map((s) => s.name);
}
