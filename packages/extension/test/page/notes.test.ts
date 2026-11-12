// @vitest-environment happy-dom
import { SEVERITY_WORD } from '@airlock/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findFile, findLine } from '../../src/page/locate';
import { NOTE_LABEL } from '../../src/page/note-view';
import { PASS_MS, createNotes, listenNotes, type Notes, type NotesRuntime } from '../../src/page/notes';
import {
  NOTES_MAX, TITLE_MAX, readNotesMessage, type NoteOpenMessage, type NotesMessage, type PageNote, type View,
} from '../../src/page/protocol';
import { CLASSIC, FILES, REACT } from '../../src/page/selectors';
import { CLASSIC_HTML, GUARD, PAUSE, REACT_HTML, live, load } from './page-fixtures';

const FILES_URL = 'https://github.com/acme/widgets/pull/1/files';
const ATTR = 'data-airlock-note';

// The note's insides are in a closed shadow root, which the page cannot reach; the test keeps each root as it is made.
const roots = new WeakMap<Element, ShadowRoot>();
const attachShadow = Element.prototype.attachShadow;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
    const root = attachShadow.call(this, init);
    roots.set(this, root);
    return root;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.documentElement.innerHTML = '<head></head><body></body>';
});

const note = (over: Partial<PageNote> = {}): PageNote => ({
  id: 'c_00000001', anchorId: PAUSE, line: 11, severity: 'fix', title: 'Pause skips the guard', ...over,
});
const GUARD_NOTE = note({ id: 'c_00000002', anchorId: GUARD, line: 4, severity: 'block', title: 'The guard is never read' });
const message = (notes: PageNote[], number = 1): NotesMessage => ({ type: 'airlock:notes', pr: { repo: 'acme/widgets', number }, notes });

/** Notes on a page at an address the test can move, and every message `Open in Airlock` sent. */
function setup(href = FILES_URL): { notes: Notes; sent: NoteOpenMessage[]; go(next: string): void } {
  let address = href;
  const sent: NoteOpenMessage[] = [];
  const notes = createNotes(document, (m) => void sent.push(m), () => address);
  return { notes, sent, go: (next) => { address = next; } };
}

const rows = (): HTMLTableRowElement[] => [...document.querySelectorAll<HTMLTableRowElement>(`tr[${ATTR}]`)];
const rowOf = (id: string): HTMLTableRowElement | undefined => rows().find((r) => r.getAttribute(ATTR) === id);
const lineRow = (view: View, anchorId: string, line: number): HTMLElement | null => {
  const file = findFile(document, anchorId);
  return file === null ? null : findLine(document, view, file, anchorId, line);
};
/** What the person sees in a note: the severity word, the title and the button, read from inside its shadow root. */
function inside(row: Element): { word: string; title: string; button: HTMLButtonElement; root: ShadowRoot } {
  const host = row.querySelector('td')!.firstElementChild!;
  const root = roots.get(host)!;
  const box = root.querySelector('div')!;
  return {
    word: box.querySelector('b')!.textContent!,
    title: box.querySelector('span')!.textContent!,
    button: box.querySelector('button')!,
    root,
  };
}
/** Lets the page's observers see the changes, then lets the notes' one batched pass run. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(PASS_MS);
}
/** Every change made to the document while `fn` runs, as a list of node names added and removed. */
async function changesDuring(fn: () => unknown): Promise<string[]> {
  const seen: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) seen.push(`+${n.nodeName}`);
      for (const n of r.removedNodes) seen.push(`-${n.nodeName}`);
      if (r.type === 'attributes') seen.push(`@${r.attributeName}`);
    }
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  await fn();
  await Promise.resolve();
  observer.disconnect();
  return seen;
}

describe('placing notes', () => {
  it('places one note row under the line in the classic view and in the newer view fixture', () => {
    for (const [html, view] of [[CLASSIC_HTML, 'classic'], [REACT_HTML, 'react']] as const) {
      load(html);
      const { notes } = setup();
      expect(notes.set(message([note(), GUARD_NOTE]))).toEqual({ placed: 2, waiting: 0, view, missing: [] });
      expect(rows()).toHaveLength(2);
      for (const [n, line] of [[note(), lineRow(view, PAUSE, 11)], [GUARD_NOTE, lineRow(view, GUARD, 4)]] as const) {
        const row = rowOf(n.id)!;
        expect(row.previousElementSibling, view).toBe(line);
        expect([...row.children].map((c) => c.tagName)).toEqual(['TD']);
        const cell = row.firstElementChild as HTMLTableCellElement;
        expect(cell.colSpan).toBe(3);
        expect(cell.children).toHaveLength(1);
        const host = cell.firstElementChild!;
        for (const el of [row, host]) {
          expect(el.getAttribute('role')).toBe('note');
          expect(el.getAttribute('aria-label')!.startsWith('Airlock note')).toBe(true);
        }
        const seen = inside(row);
        expect(seen.word).toBe(SEVERITY_WORD[n.severity]);
        expect(seen.title).toBe(n.title);
        expect(seen.button.textContent).toBe('Open in Airlock');
        expect(seen.button.type).toBe('button');
      }
      notes.stop();
    }
  });

  it('shows each severity by its word, the same words the rest of Airlock uses', () => {
    load(CLASSIC_HTML);
    const { notes } = setup();
    for (const severity of ['block', 'fix', 'ask', 'note'] as const) {
      notes.set(message([note({ severity })]));
      expect(inside(rowOf(note().id)!).word).toBe(SEVERITY_WORD[severity]);
    }
    expect(SEVERITY_WORD).toEqual({ block: 'Block', fix: 'Fix', ask: 'Ask', note: 'Note' });
  });

  it('colours the note from GitHub\'s own custom properties, with fixed fallbacks for both themes', () => {
    load(CLASSIC_HTML);
    setup().notes.set(message([note()]));
    const css = inside(rowOf(note().id)!).root.querySelector('style')!.textContent!;
    for (const property of ['--fgColor-default', '--bgColor-muted', '--borderColor-default', '--fgColor-danger']) {
      expect(css).toMatch(new RegExp(`var\\(${property}, ?#[0-9a-f]{6}\\)`));
    }
    expect(css).toContain('text-overflow:ellipsis');
  });

  it('a second message with the same notes adds nothing; a changed list adds and removes exactly the difference', async () => {
    load(CLASSIC_HTML);
    const { notes } = setup();
    notes.set(message([note(), GUARD_NOTE]));
    const [first, second] = [rowOf(note().id)!, rowOf(GUARD_NOTE.id)!];
    expect(await changesDuring(() => notes.set(message([note(), GUARD_NOTE])))).toEqual([]);
    expect(rows()).toEqual([first, second]);

    const added = note({ id: 'c_0000000a', line: 13, severity: 'ask', title: 'Why thirteen?' });
    expect(notes.set(message([GUARD_NOTE, added]))).toMatchObject({ placed: 2, waiting: 0 });
    expect(first.isConnected).toBe(false);
    expect(rowOf(GUARD_NOTE.id)).toBe(second);
    expect(rowOf(added.id)!.previousElementSibling).toBe(lineRow('classic', PAUSE, 13));

    // The same id with another title or line is shown anew.
    notes.set(message([GUARD_NOTE, { ...added, title: 'Why thirteen, really?' }]));
    expect(rows()).toHaveLength(2);
    expect(inside(rowOf(added.id)!).title).toBe('Why thirteen, really?');
    notes.set(message([GUARD_NOTE, { ...added, line: 14 }]));
    expect(rowOf(added.id)!.previousElementSibling).toBe(lineRow('classic', PAUSE, 14));
    expect(rows()).toHaveLength(2);
    notes.set(message([]));
    expect(rows()).toEqual([]);
  });

  it('keeps every note of one line under it, in the order sent, and a further pass moves nothing', async () => {
    load(REACT_HTML);
    const { notes } = setup();
    const other = note({ id: 'c_000000ff', severity: 'note', title: 'Also here' });
    notes.set(message([note(), other]));
    const line = lineRow('react', PAUSE, 11)!;
    expect(line.nextElementSibling).toBe(rowOf(note().id));
    expect(line.nextElementSibling!.nextElementSibling).toBe(rowOf(other.id));
    // Something else changes in the files: the pass that may follow finds everything in place and changes nothing.
    const changes = await changesDuring(async () => {
      document.getElementById(GUARD)!.querySelector('h3')!.append(document.createElement('i'));
      await settle();
      await settle();
    });
    expect(changes).toEqual(['+I']);
  });

  it('a note whose line is not on the page waits and is placed when the file loads', async () => {
    for (const [html, view] of [[CLASSIC_HTML, 'classic'], [REACT_HTML, 'react']] as const) {
      load(html);
      const github = live();
      github.unload(GUARD);
      const { notes } = setup();
      const folded = note({ id: 'c_00000003', line: 99, title: 'Outside the diff' });
      expect(notes.set(message([note(), GUARD_NOTE, folded]))).toEqual({ placed: 1, waiting: 2, view, missing: [] });
      expect(rows()).toHaveLength(1);

      github.load(GUARD);
      await Promise.resolve();
      // One pass per 200 ms: not before.
      await vi.advanceTimersByTimeAsync(PASS_MS - 1);
      expect(rowOf(GUARD_NOTE.id), view).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(rowOf(GUARD_NOTE.id)!.previousElementSibling).toBe(lineRow(view, GUARD, 4));
      // A line that never appears is not forced anywhere.
      expect(rowOf(folded.id)).toBeUndefined();
      expect(notes.set(message([note(), GUARD_NOTE, folded]))).toMatchObject({ placed: 2, waiting: 1 });
      notes.stop();
    }
  });

  it('waits on a page where no view is recognised yet, says what it tried, and places the notes once the files render', async () => {
    load('<head></head><body><main></main></body>');
    const { notes } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(notes.set(message([note()]))).toEqual({
      placed: 0, waiting: 1, view: null, missing: [CLASSIC.file.name, REACT.file.name, REACT.toolbar.name],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(CLASSIC.file.name));
    document.querySelector('main')!.append(...new DOMParser().parseFromString(REACT_HTML, 'text/html').body.childNodes);
    await settle();
    expect(rowOf(note().id)!.previousElementSibling).toBe(lineRow('react', PAUSE, 11));
  });

  it('names the files container when it finds nothing, and still places and restores notes', async () => {
    load(REACT_HTML);
    const list = document.querySelector(FILES.react.css)!;
    list.replaceWith(...list.childNodes);
    const github = live();
    const { notes } = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(notes.set(message([note()]))).toEqual({ placed: 1, waiting: 0, view: 'react', missing: [FILES.react.name] });
    github.rerender(PAUSE);
    await settle();
    expect(rowOf(note().id)!.previousElementSibling).toBe(lineRow('react', PAUSE, 11));
  });
});

describe('when GitHub renders the diff again', () => {
  it('a note removed by a re-render is put back once', async () => {
    for (const [html, view] of [[CLASSIC_HTML, 'classic'], [REACT_HTML, 'react']] as const) {
      load(html);
      const github = live();
      const { notes } = setup();
      notes.set(message([note(), GUARD_NOTE]));
      github.rerender(PAUSE);
      expect(rowOf(note().id), view).toBeUndefined();
      await settle();
      expect(rows()).toHaveLength(2);
      expect(rowOf(note().id)!.previousElementSibling).toBe(lineRow(view, PAUSE, 11));
      // Nothing more happens afterwards.
      expect(await changesDuring(() => settle())).toEqual([]);

      // A page script that removes the row directly: it is put back on the next change, and only once.
      rowOf(GUARD_NOTE.id)!.remove();
      await settle();
      expect(rows().filter((r) => r.getAttribute(ATTR) === GUARD_NOTE.id)).toHaveLength(1);
      expect(rowOf(GUARD_NOTE.id)!.previousElementSibling).toBe(lineRow(view, GUARD, 4));
      notes.stop();
    }
  });

  it('a note whose row was left behind when its line was rendered anew moves under the new line', async () => {
    load(REACT_HTML);
    const { notes } = setup();
    notes.set(message([note()]));
    // As React does: its own row is replaced by a new element, the foreign row stays where it was.
    const old = lineRow('react', PAUSE, 11)!;
    const fresh = old.cloneNode(true) as HTMLElement;
    old.replaceWith(fresh);
    const before = rowOf(note().id)!;
    fresh.before(before);
    await settle();
    expect(fresh.nextElementSibling).toBe(before);
    expect(rows()).toHaveLength(1);
  });

  it('switching to split view keeps one note per line spanning the row', async () => {
    for (const [html, view] of [[CLASSIC_HTML, 'classic'], [REACT_HTML, 'react']] as const) {
      load(html);
      const github = live();
      const { notes } = setup();
      notes.set(message([note(), GUARD_NOTE]));
      github.split();
      await settle();
      expect(rows(), view).toHaveLength(2);
      for (const [id, anchor, line] of [[note().id, PAUSE, 11], [GUARD_NOTE.id, GUARD, 4]] as const) {
        const row = rowOf(id)!;
        const above = lineRow(view, anchor, line)!;
        expect(above.children).toHaveLength(4);
        expect(row.previousElementSibling).toBe(above);
        expect((row.firstElementChild as HTMLTableCellElement).colSpan).toBe(4);
      }
      notes.stop();
    }
  });
});

describe('removing notes', () => {
  it('leaving the Files changed view, or a message for another pull request, removes every note', async () => {
    load(CLASSIC_HTML);
    const page = setup();
    const { notes } = page;
    notes.set(message([note(), GUARD_NOTE]));
    // Still this pull request's Files changed view: a fragment, a query, the newer address.
    for (const address of [`${FILES_URL}#${PAUSE}R11`, `${FILES_URL}?w=1`, 'https://github.com/ACME/widgets/pull/1/changes']) {
      page.go(address);
      notes.moved();
      expect(rows(), address).toHaveLength(2);
    }
    // The address the watcher names decides, before the page's own address has changed.
    notes.moved('https://github.com/acme/widgets/pull/1');
    expect(rows()).toEqual([]);

    page.go(FILES_URL);
    notes.set(message([note(), GUARD_NOTE]));
    page.go('https://github.com/acme/widgets/pull/1/commits');
    notes.moved();
    expect(rows()).toEqual([]);
    // Coming back shows nothing until the panel sends the notes again.
    page.go(FILES_URL);
    notes.moved();
    await settle();
    expect(rows()).toEqual([]);

    notes.set(message([note(), GUARD_NOTE]));
    expect(notes.set(message([note()], 2))).toEqual({ placed: 0, waiting: 0, view: null, missing: [] });
    expect(rows()).toEqual([]);

    notes.set(message([note(), GUARD_NOTE]));
    notes.clear();
    expect(rows()).toEqual([]);
    // Nothing comes back by itself after a clear.
    live().rerender(PAUSE);
    await settle();
    expect(rows()).toEqual([]);
  });

  it('places nothing for a message whose pull request is not the page\'s, and nothing after stop', async () => {
    load(CLASSIC_HTML);
    const elsewhere = setup('https://github.com/acme/widgets/pull/1');
    expect(elsewhere.notes.set(message([note()]))).toEqual({ placed: 0, waiting: 0, view: null, missing: [] });
    expect(setup('https://github.com/acme/gadgets/pull/1/files').notes.set(message([note()]))).toMatchObject({ placed: 0 });
    expect(rows()).toEqual([]);

    const { notes } = setup();
    notes.set(message([note()]));
    notes.stop();
    expect(rows()).toEqual([]);
    expect(notes.set(message([note()]))).toEqual({ placed: 0, waiting: 0, view: null, missing: [] });
    live().rerender(PAUSE);
    await settle();
    expect(rows()).toEqual([]);
  });
});

describe('what the page can see', () => {
  it('a title with markup is shown as characters and nothing of it is in the page DOM outside the shadow root', () => {
    load(CLASSIC_HTML);
    const title = '<img src=x onerror="alert(1)"><b>loud</b> & "quoted"';
    const images = document.querySelectorAll('img').length;
    setup().notes.set(message([note({ title })]));
    const row = rowOf(note().id)!;
    const seen = inside(row);
    expect(seen.title).toBe(title);
    expect(seen.root.querySelector('span')!.children).toHaveLength(0);
    expect(seen.root.querySelectorAll('img')).toHaveLength(0);
    expect(document.querySelectorAll('img').length).toBe(images);
    // The page's view of the note: the id, a role and a fixed label, and an empty host whose root it cannot open.
    const host = row.querySelector('td')!.firstElementChild!;
    expect(row.getAttributeNames().sort()).toEqual(['aria-label', 'data-airlock-note', 'role']);
    expect(row.getAttribute(ATTR)).toBe(note().id);
    expect(row.getAttribute('aria-label')).toBe(NOTE_LABEL);
    expect(row.querySelector('td')!.getAttributeNames()).toEqual(['colspan']);
    expect(host.getAttributeNames().sort()).toEqual(['aria-label', 'role']);
    expect(host.shadowRoot).toBeNull();
    expect(host.childNodes).toHaveLength(0);
    for (const text of ['loud', 'onerror', 'quoted', 'Pause', 'Fix', 'Open in Airlock']) {
      expect(document.documentElement.outerHTML).not.toContain(text);
      expect(document.documentElement.textContent).not.toContain(text);
    }
  });

  it('Open in Airlock sends the note id and nothing else', () => {
    load(REACT_HTML);
    const { notes, sent } = setup();
    notes.set(message([note(), GUARD_NOTE]));
    const row = rowOf(GUARD_NOTE.id)!;
    row.click();
    inside(row).root.querySelector('b')!.click();
    expect(sent).toEqual([]);
    inside(row).button.click();
    expect(sent).toEqual([{ type: 'airlock:note-open', id: GUARD_NOTE.id }]);
    expect(Object.keys(sent[0]!)).toEqual(['type', 'id']);
  });

  it('no GitHub element is changed: the page without Airlock rows is identical before and after', async () => {
    for (const html of [CLASSIC_HTML, REACT_HTML]) {
      load(html);
      const before = document.documentElement.outerHTML;
      const github = live();
      const { notes } = setup();
      notes.set(message([note(), GUARD_NOTE, note({ id: 'c_00000003', line: 99 })]));
      // GitHub renders a file again (as served, so the page without Airlock's rows reads as before).
      github.rerender(GUARD);
      await settle();
      expect(rows()).toHaveLength(2);
      const copy = document.documentElement.cloneNode(true) as HTMLElement;
      for (const row of copy.querySelectorAll(`[${ATTR}]`)) row.remove();
      expect(copy.outerHTML).toBe(before);
      notes.clear();
      expect(document.documentElement.outerHTML).toBe(before);
    }
  });
});

describe('the notes message', () => {
  const valid = (): Record<string, unknown> => ({ ...message([note(), GUARD_NOTE]) });
  const withNote = (over: Record<string, unknown>): Record<string, unknown> => ({ ...valid(), notes: [{ ...note(), ...over }] });

  it('61 notes, a title of 201 characters, a line of 0 and an unknown severity are refused', () => {
    const many = (n: number) => message(Array.from({ length: n }, (_, i) => note({ id: `c_${i.toString(16).padStart(8, '0')}` })));
    expect(readNotesMessage(many(NOTES_MAX))).toEqual(many(NOTES_MAX));
    expect(readNotesMessage(many(NOTES_MAX + 1))).toBe('more than 60 notes');
    expect(readNotesMessage(withNote({ title: 'a'.repeat(TITLE_MAX) }))).not.toBeTypeOf('string');
    expect(readNotesMessage(withNote({ title: 'a'.repeat(TITLE_MAX + 1) }))).toBe('a title is empty or longer than 200 characters');
    expect(readNotesMessage(withNote({ line: 0 }))).toBe('a line is not a positive whole number');
    expect(readNotesMessage(withNote({ severity: 'praise' }))).toBe('a severity is unknown');
  });

  it('refuses every other malformed field, and reads a valid message field by field', () => {
    for (const bad of [
      withNote({ id: 'c_0000000' }), withNote({ id: 'c_0000000G' }), withNote({ id: 'C_00000001' }), withNote({ id: 'x_00000001' }),
      withNote({ id: 'c_00000001 ' }), withNote({ id: 7 }), withNote({ anchorId: 'diff-xyz' }), withNote({ anchorId: `${PAUSE}R11` }),
      withNote({ line: 1.5 }), withNote({ line: -1 }), withNote({ line: '11' }), withNote({ line: 2 ** 53 }), withNote({ title: '' }),
      withNote({ title: 5 }), withNote({ severity: 'Fix' }), withNote({ extra: 1 }), { ...valid(), notes: [note(), note()] },
      { ...valid(), notes: [null] }, { ...valid(), notes: {} }, { ...valid(), pr: { repo: 'acme', number: 1 } },
      { ...valid(), pr: { repo: 'acme/widgets', number: 0 } }, { ...valid(), pr: { repo: 'acme/widgets', number: 1, x: 1 } },
      { ...valid(), extra: true }, { type: 'airlock:notes' }, { type: 'airlock:notes-clear', notes: [] },
    ]) {
      expect(readNotesMessage(bad), JSON.stringify(bad)).toBeTypeOf('string');
    }
    for (const other of [null, undefined, 'airlock:notes', [valid()], { type: 'airlock:jump' }, { type: 'airlock:note-open', id: 'c_00000001' }]) {
      expect(readNotesMessage(other)).toBeNull();
    }
    expect(readNotesMessage({ type: 'airlock:notes-clear' })).toEqual({ type: 'airlock:notes-clear' });
    expect(readNotesMessage(valid())).toEqual(message([note(), GUARD_NOTE]));
  });
});

describe('the notes listener', () => {
  const ID = 'nbcmjckbkploiemllhkmhegjimgeimoa';
  function runtime() {
    const listeners: Parameters<NotesRuntime['onMessage']['addListener']>[0][] = [];
    const rt: NotesRuntime = { id: ID, onMessage: { addListener: (fn) => void listeners.push(fn) } };
    const send = (m: unknown, sender: { id?: string } = { id: ID }) => {
      const replies: unknown[] = [];
      const kept = listeners[0]!(m, sender, (r) => void replies.push(r));
      return { kept, replies };
    };
    return { rt, listeners, send };
  }

  it('answers a notes message from this extension with the counts, and a clear message by removing every note', () => {
    load(CLASSIC_HTML);
    const r = runtime();
    const { notes } = setup();
    listenNotes(r.rt, notes);
    listenNotes(r.rt, notes);
    expect(r.listeners).toHaveLength(1);
    expect(r.send(message([note()])).replies).toEqual([{ placed: 1, waiting: 0, view: 'classic', missing: [] }]);
    expect(rows()).toHaveLength(1);
    expect(r.send({ type: 'airlock:notes-clear' }).replies).toEqual([{ placed: 0, waiting: 0, view: null, missing: [] }]);
    expect(rows()).toEqual([]);
  });

  it('answers a message that fails validation with a sentence, and changes nothing', () => {
    load(CLASSIC_HTML);
    const r = runtime();
    const { notes } = setup();
    listenNotes(r.rt, notes);
    r.send(message([note()]));
    const { replies } = r.send({ ...message([note()]), notes: [note({ severity: 'praise' as 'fix' })] });
    expect(replies).toEqual([{ error: "The page refused Airlock's notes: a severity is unknown." }]);
    expect(rows()).toHaveLength(1);
  });

  it('ignores another sender and every other message, and does not answer them', () => {
    load(CLASSIC_HTML);
    const r = runtime();
    listenNotes(r.rt, setup().notes);
    for (const [m, sender] of [
      [message([note()]), { id: 'abcdefghijklmnopabcdefghijklmnop' }],
      [message([note()]), {}],
      [{ type: 'airlock:jump' }, { id: ID }],
      [null, { id: ID }],
    ] as const) {
      const { kept, replies } = r.send(m, sender);
      expect(kept).toBeUndefined();
      expect(replies).toEqual([]);
    }
    expect(rows()).toEqual([]);
  });

  it('answers with a sentence when showing the notes fails, instead of not answering', () => {
    const r = runtime();
    const failing: Notes = { set: () => { throw new Error('boom'); }, clear: () => undefined, moved: () => undefined, stop: () => undefined };
    listenNotes(r.rt, failing);
    expect(r.send(message([note()])).replies).toEqual([{ error: 'The page could not show Airlock\'s notes.' }]);
  });
});
