// One note as the person sees it on GitHub's page: a row under the line, and inside a closed shadow root the severity word,
// the title and `Open in Airlock`. The page sees only the row, its id attribute, and a host with a role and a fixed label.
// Imported by path, not from '@airlock/shared': this module has no zod, and the content script must stay small.
import { SEVERITY_WORD } from '../../../shared/src/words';
import type { PageNote } from './protocol';

export const NOTE_ATTR = 'data-airlock-note';
/**
 * The accessible name of the host, which is the note (the row stays a row of GitHub's table). Fixed: nothing of the
 * finding is in the page's attributes.
 */
export const NOTE_LABEL = 'Airlock note';

// GitHub's own custom properties carry both its themes; the fallbacks are its light theme's values. The host's inline-size
// containment keeps a long title from widening GitHub's table. Written tight: the content script's size is bounded.
const CSS = [
  ':host{display:block;contain:inline-size}',
  'div{display:flex;align-items:center;gap:8px;margin:4px 8px;padding:4px 8px;border-left:3px solid var(--c);'
    + 'border-radius:0 6px 6px 0;background:var(--bgColor-muted,#f6f8fa);color:var(--fgColor-default,#1f2328);'
    + 'font:12px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
  '.block{--c:var(--fgColor-danger,#d1242f)}',
  '.fix{--c:var(--fgColor-severe,#bc4c00)}',
  '.ask{--c:var(--fgColor-attention,#9a6700)}',
  '.note{--c:var(--fgColor-accent,#0969da)}',
  'b,button{flex:none;white-space:nowrap}',
  'span{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
  'button{font:inherit;color:inherit;background:var(--bgColor-default,#ffffff);cursor:pointer;'
    + 'border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;padding:0 8px}',
].join('');

/** The row and its one cell (whose span follows the line's row). Every string from the note is set as text. */
export interface NoteView { row: HTMLTableRowElement; cell: HTMLTableCellElement }

export function noteView(doc: Document, note: PageNote, open: () => void): NoteView {
  const row = doc.createElement('tr');
  row.setAttribute(NOTE_ATTR, note.id);
  const cell = row.insertCell();
  const host = cell.appendChild(doc.createElement('div'));
  host.setAttribute('role', 'note');
  host.setAttribute('aria-label', NOTE_LABEL);
  const root = host.attachShadow({ mode: 'closed' });
  const part = <K extends keyof HTMLElementTagNameMap>(tag: K, text: string): HTMLElementTagNameMap[K] => {
    const el = doc.createElement(tag);
    el.textContent = text;
    return el;
  };
  const box = doc.createElement('div');
  box.className = note.severity;
  const button = part('button', 'Open in Airlock');
  button.type = 'button';
  // Only the person's own click: a click a script makes is not trusted.
  button.addEventListener('click', (event) => { if (event.isTrusted) open(); });
  box.append(part('b', SEVERITY_WORD[note.severity]), part('span', note.title), button);
  root.append(part('style', CSS), box);
  return { row, cell };
}
