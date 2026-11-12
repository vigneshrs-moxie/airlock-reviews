import { describe, expect, it, vi } from 'vitest';
import { panelOptionsFor } from '../src/background/panel-options';
import { wirePanel, type PanelChrome } from '../src/background/wire';

describe('panelOptionsFor', () => {
  it('enables the panel only on pull request tabs', () => {
    const on = { tabId: 7, path: 'sidepanel.html', enabled: true };
    expect(panelOptionsFor(7, 'https://github.com/acme/widgets/pull/12')).toEqual(on);
    expect(panelOptionsFor(7, 'https://github.com/acme/widgets/pull/12/files')).toEqual(on);
    const off = { tabId: 7, path: 'sidepanel.html', enabled: false };
    expect(panelOptionsFor(7, 'https://github.com/acme/widgets')).toEqual(off);
    expect(panelOptionsFor(7, 'https://github.com/acme/widgets/issues/12')).toEqual(off);
    expect(panelOptionsFor(7, 'https://example.com/acme/widgets/pull/12')).toEqual(off);
    expect(panelOptionsFor(7, 'not a url')).toEqual(off);
    expect(panelOptionsFor(7, undefined)).toEqual(off);
  });
});

type Tab = { id?: number; url?: string };

function fakeChrome(opts: { open?: Tab[]; queryFails?: boolean; setOptionsFails?: boolean; accessFails?: boolean } = {}) {
  const calls: string[] = [];
  const listeners: {
    updated?: (id: number, info: object, tab: Tab) => void;
    activated?: (info: { tabId: number }) => void;
  } = {};
  const tabsById: Record<number, Tab> = { 2: { url: 'https://github.com/a/b/pull/3' } };
  const chrome: PanelChrome = {
    storage: {
      local: {
        setAccessLevel: vi.fn(async (o: { accessLevel: string }) => {
          calls.push(`access ${o.accessLevel}`);
          if (opts.accessFails) throw new Error('not supported');
        }),
      },
    },
    sidePanel: {
      setPanelBehavior: vi.fn(async () => { calls.push('behavior'); }),
      setOptions: vi.fn(async (o) => {
        calls.push(o.tabId === undefined ? 'global' : `tab${o.tabId}`);
        if (opts.setOptionsFails) throw new Error('No tab with id');
      }),
    },
    tabs: {
      get: vi.fn(async (id: number) => tabsById[id] ?? {}),
      query: vi.fn(async () => {
        calls.push('query');
        if (opts.queryFails) throw new Error('query failed');
        return opts.open ?? [];
      }),
      onUpdated: { addListener: (fn) => { calls.push('onUpdated'); listeners.updated = fn; } },
      onActivated: { addListener: (fn) => { calls.push('onActivated'); listeners.activated = fn; } },
    },
  };
  return { chrome, listeners, calls };
}

describe('wirePanel', () => {
  it('turns the panel off for every tab before anything else', async () => {
    const { chrome, calls } = fakeChrome();
    wirePanel(chrome);
    expect(calls.filter((c) => !c.startsWith('access'))[0]).toBe('global');
    expect(chrome.sidePanel.setOptions).toHaveBeenNthCalledWith(1, { enabled: false });
    await vi.waitFor(() => expect(calls).toContain('query'));
    expect(calls.indexOf('global')).toBeLessThan(calls.indexOf('query'));
    expect(chrome.tabs.query).toHaveBeenCalledWith({ url: 'https://github.com/*' });
  });

  it('enables an already-open pull request tab at start and not another GitHub tab', async () => {
    const { chrome } = fakeChrome({
      open: [{ id: 4, url: 'https://github.com/a/b/pull/9' }, { id: 5, url: 'https://github.com/a/b' }, { url: 'https://github.com/a/b/pull/1' }],
    });
    wirePanel(chrome);
    await vi.waitFor(() => expect(chrome.sidePanel.setOptions).toHaveBeenCalledTimes(3));
    expect(chrome.sidePanel.setOptions).toHaveBeenCalledWith({ tabId: 4, path: 'sidepanel.html', enabled: true });
    expect(chrome.sidePanel.setOptions).toHaveBeenCalledWith({ tabId: 5, path: 'sidepanel.html', enabled: false });
  });

  it('registers the listeners even when the tab query rejects', async () => {
    const { chrome, listeners } = fakeChrome({ queryFails: true });
    wirePanel(chrome);
    expect(listeners.updated).toBeTypeOf('function');
    expect(listeners.activated).toBeTypeOf('function');
    await vi.waitFor(() => expect(chrome.tabs.query).toHaveBeenCalled());
  });

  it('opens the panel on action click and sets options on tab update and activation', async () => {
    const { chrome, listeners } = fakeChrome();
    wirePanel(chrome);
    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
    listeners.updated?.(1, {}, { url: 'https://github.com/a/b/pull/3' });
    expect(chrome.sidePanel.setOptions).toHaveBeenCalledWith({ tabId: 1, path: 'sidepanel.html', enabled: true });
    listeners.activated?.({ tabId: 2 });
    await vi.waitFor(() =>
      expect(chrome.sidePanel.setOptions).toHaveBeenCalledWith({ tabId: 2, path: 'sidepanel.html', enabled: true }));
    listeners.activated?.({ tabId: 3 });
    await vi.waitFor(() =>
      expect(chrome.sidePanel.setOptions).toHaveBeenCalledWith({ tabId: 3, path: 'sidepanel.html', enabled: false }));
  });

  it('keeps its storage, and so the pairing token, from content scripts, before anything else', () => {
    const { chrome, calls } = fakeChrome();
    wirePanel(chrome);
    expect(calls[0]).toBe('access TRUSTED_CONTEXTS');
  });

  it('produces no unhandled rejection when the storage access level cannot be set, and still wires the panel', async () => {
    const unhandled: unknown[] = [];
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const record = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', record);
    try {
      const { chrome, listeners } = fakeChrome({ accessFails: true });
      wirePanel(chrome);
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('not supported'));
      expect(listeners.updated).toBeTypeOf('function');
    } finally {
      process.off('unhandledRejection', record);
      warned.mockRestore();
    }
  });

  it('produces no unhandled rejection when setOptions fails', async () => {
    const unhandled: unknown[] = [];
    const record = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', record);
    try {
      const { chrome, listeners } = fakeChrome({ setOptionsFails: true });
      wirePanel(chrome);
      listeners.updated?.(1, {}, { url: 'https://github.com/a/b/pull/3' });
      listeners.activated?.({ tabId: 2 });
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });
});
