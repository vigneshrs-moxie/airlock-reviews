import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPEN_ID_KEY, OPEN_ID_MS, wireNoteOpen, type NoteOpenWorkerChrome } from '../src/background/note-open';
import { listenNoteOpen, type NoteOpenPanelChrome } from '../src/state/note-open';
import type { TabWatcher } from '../src/state/tab';

const ID = 'nbcmjckbkploiemllhkmhegjimgeimoa';
const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const OPEN = { type: 'airlock:note-open', id: 'c_00000002' };

type Listener = (message: unknown, sender: { id?: string; tab?: { id?: number } }, sendResponse: (r: unknown) => void) => unknown;
type Changed = (changes: Record<string, { newValue?: unknown }>) => void;

/** `chrome.storage.session` as both the worker and the panel see it: one store, with its change events. */
function session(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const changed = new Set<Changed>();
  return {
    data,
    changed,
    async get(keys: string[]) { return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])); },
    async set(items: Record<string, unknown>) {
      Object.assign(data, items);
      const changes = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }]));
      for (const fn of changed) fn(changes);
    },
    async remove(keys: string[]) { for (const k of keys) delete data[k]; },
    onChanged: { addListener: (fn: Changed) => void changed.add(fn), removeListener: (fn: Changed) => void changed.delete(fn) },
  };
}

function worker(store: ReturnType<typeof session>, opts: { openFails?: 'reject' | 'throw' } = {}) {
  const calls: string[] = [];
  const listeners: Listener[] = [];
  const chrome: NoteOpenWorkerChrome = {
    runtime: { id: ID, onMessage: { addListener: (fn) => void listeners.push(fn as Listener) } },
    sidePanel: {
      open: (options) => {
        calls.push(`open ${options.tabId}`);
        if (opts.openFails === 'throw') throw new Error('sidePanel.open is not a function');
        return opts.openFails === 'reject' ? Promise.reject(new Error('may only be called in response to a user gesture')) : Promise.resolve();
      },
    },
    storage: { session: { set: (items) => { calls.push('store'); return store.set(items); } } },
  };
  return { chrome, calls, listeners, press: (message: unknown, sender: Parameters<Listener>[1]) => listeners[0]!(message, sender, () => undefined) };
}

function panel(store: ReturnType<typeof session>, tabId = 7) {
  const listeners = new Set<Listener>();
  const chrome: NoteOpenPanelChrome = {
    runtime: { id: ID, onMessage: { addListener: (fn) => void listeners.add(fn as Listener), removeListener: (fn) => void listeners.delete(fn as Listener) } },
    session: store,
  };
  const tab: TabWatcher = { current: async () => ({ tabId, url: 'https://github.com/acme/widgets/pull/1/files' }), onChange: () => () => undefined };
  const send = (message: unknown, sender: Parameters<Listener>[1]) => { for (const fn of listeners) fn(message, sender, () => undefined); };
  return { chrome, tab, listeners, send };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

afterEach(() => vi.restoreAllMocks());

describe('Open in Airlock with the panel closed', () => {
  it('with the panel closed the worker opens it and the pending id is read once and expires after 30 seconds', async () => {
    const store = session();
    const w = worker(store);
    wireNoteOpen(w.chrome, () => T0);
    expect(w.press(OPEN, { id: ID, tab: { id: 7 } })).toBeUndefined();
    // Opened inside the click's message, before anything was awaited, so Chrome counts it as the person's action.
    expect(w.calls).toEqual(['open 7', 'store']);
    await settle();
    expect(store.data).toEqual({ [OPEN_ID_KEY]: { id: 'c_00000002', at: T0, tabId: 7 } });

    // The panel starts within 30 seconds: it opens that finding and takes the id away.
    expect(OPEN_ID_MS).toBe(30_000);
    const opened: string[] = [];
    const p = panel(store);
    const stop = listenNoteOpen(p.chrome, p.tab, (id) => opened.push(id), () => T0 + OPEN_ID_MS);
    await settle();
    expect(opened).toEqual(['c_00000002']);
    expect(store.data).toEqual({});
    stop();
    // Read once: the next start finds nothing.
    const again = panel(store);
    const stopAgain = listenNoteOpen(again.chrome, again.tab, (id) => opened.push(id), () => T0 + OPEN_ID_MS);
    await settle();
    expect(opened).toEqual(['c_00000002']);
    stopAgain();

    // An id left more than 30 seconds before the panel starts is taken away and not used.
    w.press(OPEN, { id: ID, tab: { id: 7 } });
    await settle();
    const late = panel(store);
    const stopLate = listenNoteOpen(late.chrome, late.tab, (id) => opened.push(id), () => T0 + OPEN_ID_MS + 1);
    await settle();
    expect(opened).toEqual(['c_00000002']);
    expect(store.data).toEqual({});
    stopLate();

    // An id left for another tab is that tab's panel's: it is not used here, and left alone.
    w.press(OPEN, { id: ID, tab: { id: 8 } });
    await settle();
    const other = panel(store, 7);
    listenNoteOpen(other.chrome, other.tab, (id) => opened.push(id), () => T0);
    await settle();
    expect(opened).toEqual(['c_00000002']);
    expect(store.data).toEqual({ [OPEN_ID_KEY]: { id: 'c_00000002', at: T0, tabId: 8 } });
  });

  it('the worker acts only on a well-formed note-open from a page of this extension, and catches a refused open', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const store = session();
    const w = worker(store, { openFails: 'reject' });
    wireNoteOpen(w.chrome, () => T0);
    for (const [message, sender] of [
      [OPEN, { id: 'abcdefghijklmnopabcdefghijklmnop', tab: { id: 7 } }],
      [OPEN, { id: ID }],
      [{ ...OPEN, id: 'c_0000000G' }, { id: ID, tab: { id: 7 } }],
      [{ ...OPEN, extra: true }, { id: ID, tab: { id: 7 } }],
      [{ type: 'airlock:notes-clear' }, { id: ID, tab: { id: 7 } }],
      [null, { id: ID, tab: { id: 7 } }],
    ] as const) {
      expect(w.press(message, sender)).toBeUndefined();
    }
    expect(w.calls).toEqual([]);
    // A refused open (no user action counted) is caught; the id is still left for when the person opens the panel.
    w.press(OPEN, { id: ID, tab: { id: 7 } });
    await settle();
    expect(w.calls).toEqual(['open 7', 'store']);
    expect(store.data[OPEN_ID_KEY]).toEqual({ id: 'c_00000002', at: T0, tabId: 7 });
    // A Chrome without sidePanel.open: the same.
    const old = worker(session(), { openFails: 'throw' });
    wireNoteOpen(old.chrome, () => T0);
    expect(() => old.press(OPEN, { id: ID, tab: { id: 7 } })).not.toThrow();
    expect(old.calls).toEqual(['open 7', 'store']);
    // The worker asks nothing of the network.
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Open in Airlock with the panel open', () => {
  it('opens the finding from its own tab\'s note and from an id the worker leaves meanwhile, and ignores other tabs and senders', async () => {
    const store = session();
    const p = panel(store);
    const opened: string[] = [];
    const stop = listenNoteOpen(p.chrome, p.tab, (id) => opened.push(id), () => T0);
    await settle();
    p.send(OPEN, { id: ID, tab: { id: 7 } });
    expect(opened).toEqual(['c_00000002']);
    for (const [message, sender] of [
      [OPEN, { id: ID, tab: { id: 8 } }],
      [OPEN, { id: 'abcdefghijklmnopabcdefghijklmnop', tab: { id: 7 } }],
      [OPEN, { id: ID }],
      [{ ...OPEN, id: 'c_1' }, { id: ID, tab: { id: 7 } }],
    ] as const) p.send(message, sender);
    expect(opened).toEqual(['c_00000002']);

    // The worker leaves the id too (it cannot tell the panel is open): the open panel takes it at once.
    const w = worker(store);
    wireNoteOpen(w.chrome, () => T0);
    w.press({ ...OPEN, id: 'c_00000003' }, { id: ID, tab: { id: 7 } });
    await settle();
    expect(opened).toEqual(['c_00000002', 'c_00000003']);
    expect(store.data).toEqual({});
    // One left for another tab stays.
    w.press(OPEN, { id: ID, tab: { id: 8 } });
    await settle();
    expect(opened).toEqual(['c_00000002', 'c_00000003']);
    expect(store.data[OPEN_ID_KEY]).toMatchObject({ tabId: 8 });

    stop();
    expect(p.listeners.size).toBe(0);
    expect(store.changed.size).toBe(0);
  });
});
