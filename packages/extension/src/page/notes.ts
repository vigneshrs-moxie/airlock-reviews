// Private notes on GitHub's Files changed page: each open finding shown under its line, in this browser only. The page
// gets one row per note, inserted after the line's row; nothing GitHub made is edited, hidden or moved.
// Imported by path, not from '@airlock/shared': this module has no zod, and the content script must stay small.
import { prRefFromUrl } from '../../../shared/src/pr-ref';
import { detectView, findFile, findLine } from './locate';
import { noteView } from './note-view';
import {
  notesRefused, readNotesMessage, type NoteOpenMessage, type NotesMessage, type NotesRefused, type NotesReply, type PageNote,
} from './protocol';
import { FILES, missingFor } from './selectors';

/** At most one pass over the notes per this many milliseconds after GitHub changes the files. */
export const PASS_MS = 200;

export interface Notes {
  /** Shows exactly these notes (adding and removing the difference) and says how many are placed and waiting. */
  set(message: NotesMessage): NotesReply;
  /** Removes every note. */
  clear(): void;
  /**
   * GitHub moved within the page, or the address changed: every note is removed unless `to` (the new address when the
   * event names it, else the page's) is still their pull request's Files changed view, where they are looked at again.
   */
  moved(to?: string): void;
  /** Removes every note for good: the extension was reloaded or removed. */
  stop(): void;
}

interface Held {
  note: PageNote;
  row: HTMLTableRowElement;
  cell: HTMLTableCellElement;
  /** GitHub's row the note is under; null while it waits for its line. */
  line: HTMLElement | null;
}

// The pull request a notes message is for (written out: the repository's guard reads an indexed 'pr' as a gh call).
type Pr = { repo: string; number: number };
const NOTHING_HELD = (): NotesReply => ({ placed: 0, waiting: 0, view: null, missing: [] });

const sameNote = (a: PageNote, b: PageNote): boolean =>
  a.anchorId === b.anchorId && a.line === b.line && a.severity === b.severity && a.title === b.title;

/** How many columns the line's row spans, so the note's one cell spans them all (3 unified, 4 split). */
const columns = (line: Element): number =>
  Array.from(line.children).reduce((sum, cell) => sum + ((cell as HTMLTableCellElement).colSpan || 1), 0);

/**
 * `address` reads the page's address (a parameter so tests can move it). `send` carries `Open in Airlock` to the extension;
 * it is the only thing that leaves the page script.
 */
export function createNotes(doc: Document, send: (m: NoteOpenMessage) => void, address = (): string => doc.location.href): Notes {
  let pr: Pr | null = null;
  let held = new Map<string, Held>();
  let stopped = false;
  // Airlock's own rows, known by identity: an attribute the page could copy is never trusted.
  const ours = new WeakSet<Element>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watched: Node | null = null;

  const isFilesOf = (href: string, of: Pr): boolean => {
    const ref = prRefFromUrl(href);
    return ref !== null && ref.page === 'files' && ref.number === of.number && ref.repo.toLowerCase() === of.repo.toLowerCase();
  };

  /** The note's row is in the run of Airlock rows directly after its line's row. */
  const under = (line: Element, row: Element): boolean => {
    for (let next = line.nextElementSibling; next !== null && ours.has(next); next = next.nextElementSibling) {
      if (next === row) return true;
    }
    return false;
  };

  /** The note is under its line, which is on the page, and spans the line's columns. */
  const inPlace = (h: Held): boolean =>
    h.line !== null && h.line.isConnected && under(h.line, h.row) && h.cell.colSpan === columns(h.line);

  // A pass is needed when a note is waiting, GitHub removed, replaced, moved or re-laid-out what one was under, or the
  // watched container left the page.
  const observer = new MutationObserver(() => {
    if (timer === null && ((watched !== null && !watched.isConnected) || [...held.values()].some((h) => !inPlace(h)))) {
      timer = setTimeout(pass, PASS_MS);
    }
  });

  /**
   * Watches the view's files container, or the body while there is none, and the children of each of its ancestors, so a
   * container rendered anew in its place is seen; the next pass watches the new one.
   */
  const watch = (view: ReturnType<typeof detectView>): void => {
    const target = (view === null ? null : doc.querySelector(FILES[view].css)) ?? doc.body;
    if (target === watched) return;
    observer.disconnect();
    watched = target;
    if (target === null) return;
    observer.observe(target, { childList: true, subtree: true });
    for (let up = target.parentNode; up !== null; up = up.parentNode) observer.observe(up, { childList: true });
  };

  /**
   * Puts every note that is not in place under its line when the line is on the page; a note whose line is not stays off
   * the page and waits. A page that is no longer the pull request's Files changed view (it can change before the address
   * watcher says so) loses every note instead.
   */
  function pass(): ReturnType<typeof detectView> {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pr !== null && !isFilesOf(address(), pr)) {
      clear();
      return null;
    }
    const view = detectView(doc);
    for (const h of held.values()) {
      if (inPlace(h)) continue;
      const file = view === null ? null : findFile(doc, h.note.anchorId);
      h.line = file === null || view === null ? null : findLine(doc, view, file, h.note.anchorId, h.note.line);
      if (h.line === null) {
        h.row.remove();
        continue;
      }
      if (!under(h.line, h.row)) {
        let last: Element = h.line;
        while (last.nextElementSibling !== null && ours.has(last.nextElementSibling)) last = last.nextElementSibling;
        last.after(h.row);
      }
      const span = columns(h.line);
      if (h.cell.colSpan !== span) h.cell.colSpan = span;
    }
    watch(view);
    return view;
  }

  function clear(): void {
    for (const h of held.values()) h.row.remove();
    held = new Map();
    pr = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    observer.disconnect();
    watched = null;
  }

  return {
    set(message) {
      if (pr !== null && (pr.number !== message.pr.number || pr.repo.toLowerCase() !== message.pr.repo.toLowerCase())) clear();
      if (stopped || !isFilesOf(address(), message.pr)) {
        clear();
        return NOTHING_HELD();
      }
      pr = message.pr;
      const next = new Map<string, Held>();
      for (const note of message.notes) {
        const kept = held.get(note.id);
        if (kept !== undefined && sameNote(kept.note, note)) {
          next.set(note.id, kept);
          continue;
        }
        const { row, cell } = noteView(doc, note, () => send({ type: 'airlock:note-open', id: note.id }));
        ours.add(row);
        next.set(note.id, { note, row, cell, line: null });
      }
      for (const [id, h] of held) if (next.get(id) !== h) h.row.remove();
      held = next;

      const view = pass();
      const placed = [...held.values()].filter((h) => h.line !== null).length;
      const missing = missingFor(doc, view);
      if (view !== null && doc.querySelector(FILES[view].css) === null) missing.push(FILES[view].name);
      if (missing.length > 0) console.warn(`Airlock: selectors that found nothing on this page: ${missing.join(', ')}`);
      return { placed, waiting: held.size - placed, view, missing };
    },
    clear,
    moved(to) {
      if (pr === null) return;
      if (!isFilesOf(to ?? address(), pr)) clear();
      else if (timer === null) timer = setTimeout(pass, PASS_MS);
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}

type Sender = { id?: string };
type Listener = (message: unknown, sender: Sender, sendResponse: (reply: NotesReply | NotesRefused) => void) => undefined;

/** The part of `chrome.runtime` the notes use, so tests can pass a fake. */
export interface NotesRuntime {
  readonly id: string;
  onMessage: { addListener(fn: Listener): void };
}

const listening = new WeakSet<object>();

/**
 * Answers notes and clear messages from this extension only, at once. A notes message that fails validation changes
 * nothing and is answered with a sentence for the panel; every other message gets no reply. Registers once per runtime.
 */
export function listenNotes(runtime: NotesRuntime, notes: Notes): void {
  if (listening.has(runtime.onMessage)) return;
  listening.add(runtime.onMessage);
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== runtime.id) return undefined;
    const read = readNotesMessage(message);
    if (read === null) return undefined;
    try {
      if (typeof read === 'string') sendResponse(notesRefused(read));
      else if (read.type === 'airlock:notes-clear') {
        notes.clear();
        sendResponse(NOTHING_HELD());
      } else sendResponse(notes.set(read));
    } catch {
      sendResponse({ error: "The page could not show Airlock's notes." });
    }
    return undefined;
  });
}
