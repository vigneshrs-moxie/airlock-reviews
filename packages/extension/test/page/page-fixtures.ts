import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// import.meta.dirname: under happy-dom, import.meta.url is not a file address.
const fixture = (name: string): string => readFileSync(join(import.meta.dirname, '../../e2e/fixtures', name), 'utf8');

export const CLASSIC_HTML = fixture('files-classic.html');
export const REACT_HTML = fixture('files-react.html');

export const PAUSE = 'diff-e116c16eefc8e8d9ec8ba37d3740b95e349244231679912217713dcfed49b434';
export const GUARD = 'diff-4980e811b0c50e77753fddf463922282914f94343bf4dbcf39a8627632c0e9ff';

/** Puts a fixture page into the test's document. Only tests do this; the product never sets markup. */
export function load(html: string): void {
  document.documentElement.innerHTML = html;
}

/**
 * The newer view's split layout for src/guard.ts, built from the unconfirmed fixture's own cells: each row is the old
 * side's number and code, then the new side's number and code. A row with nothing on one side has empty cells there.
 */
export function splitGuard(): void {
  const file = document.getElementById(GUARD)!;
  const body = file.querySelector('tbody')!;
  const rows: [string, string, string, string][] = [
    ['3', 'code 3', '3', 'code 3'],
    ['', '', '4', 'code 4'],
    ['4', 'code 4 old', '5', 'code 5'],
    ['6', 'code 6 removed', '', ''],
  ];
  body.replaceChildren(...rows.map(([oldNumber, oldCode, newNumber, newCode]) => {
    const row = document.createElement('tr');
    row.className = 'diff-line-row';
    const number = (text: string): HTMLTableCellElement => {
      const cell = document.createElement('td');
      cell.className = 'DiffLine-module__cell diff-line-number';
      cell.textContent = text;
      return cell;
    };
    const code = (text: string): HTMLTableCellElement => {
      const cell = document.createElement('td');
      cell.className = 'DiffLine-module__code diff-text-cell';
      const inner = document.createElement('div');
      inner.className = 'diff-text-inner';
      inner.textContent = text;
      cell.append(inner);
      return cell;
    };
    row.append(number(oldNumber), code(oldCode), number(newNumber), code(newCode));
    return row;
  }));
}

/** What e2e/fixtures/github-live.js does to a fixture page, as GitHub's own re-rendering would. */
export interface GithubFixture {
  unload(anchor: string): void;
  load(anchor: string): void;
  rerender(anchor: string): void;
  split(): void;
}

/** Runs the end-to-end tests' page script on the fixture now in the document (as the page itself would). */
export function live(): GithubFixture {
  new Function(fixture('github-live.js'))();
  return (window as unknown as { githubFixture: GithubFixture }).githubFixture;
}
