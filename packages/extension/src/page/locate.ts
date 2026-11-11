import { CLASSIC, REACT, type View } from './selectors';

/** Which Files changed view the page shows: classic when its file selector matches, else the newer one by its container or toolbar. */
export function detectView(doc: Document): View | null {
  if (doc.querySelector(CLASSIC.file.css) !== null) return 'classic';
  if (doc.querySelector(REACT.file.css) !== null || doc.querySelector(REACT.toolbar.css) !== null) return 'react';
  return null;
}

/** The file's container: in both views its id is the anchor, `diff-` plus the SHA-256 of the path. */
export function findFile(doc: Document, anchorId: string): HTMLElement | null {
  return doc.getElementById(anchorId);
}

/** The row showing new-side line `line` of the file, or null when it is not rendered. */
export function findLine(doc: Document, view: View, file: HTMLElement, anchorId: string, line: number): HTMLElement | null {
  if (view === 'classic') {
    const cell = doc.getElementById(`${anchorId}R${line}`);
    return cell !== null && file.contains(cell) && cell.matches(CLASSIC.newLineNumber.css) ? cell.closest('tr') : null;
  }
  const wanted = String(line);
  for (const row of file.querySelectorAll<HTMLElement>(REACT.row.css)) {
    if (newSideCell(row)?.textContent?.trim() === wanted) return row;
  }
  return null;
}

/**
 * The newer view's new-side line number cell, as the other extensions' source reads it: the second cell of a unified row
 * (number, number, code) and the third of a split row (number, code, number, code). The layout is told apart by how many
 * cells the row has and which of them are number cells; any other row (a hunk header) has none. A deleted row's new-side
 * cell is empty, so it never matches a line.
 */
function newSideCell(row: HTMLElement): Element | null {
  const cells = Array.from(row.children).filter((cell) => cell.tagName === 'TD');
  const isNumber = (i: number): boolean => cells[i]?.matches(REACT.lineNumber.css) === true;
  if (cells.length === 3 && isNumber(0) && isNumber(1) && !isNumber(2)) return cells[1] ?? null;
  if (cells.length === 4 && isNumber(0) && !isNumber(1) && isNumber(2) && !isNumber(3)) return cells[2] ?? null;
  return null;
}

/** What carries the mark: a classic row's cells (GitHub marks cells there too), or the newer view's row. */
export function targetsOf(view: View, row: HTMLElement): HTMLElement[] {
  return view === 'classic' ? Array.from(row.querySelectorAll<HTMLElement>(':scope > td')) : [row];
}
