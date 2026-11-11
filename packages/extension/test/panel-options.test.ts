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

function fakeChrome() {
  const listeners: { updated?: (id: number, info: object, tab: { url?: string }) => void; activated?: (info: { tabId: number }) => void } = {};
  const chrome: PanelChrome = {
    sidePanel: { setPanelBehavior: vi.fn(async () => {}), setOptions: vi.fn(async () => {}) },
    tabs: {
      get: vi.fn(async (id: number) => ({ url: id === 2 ? 'https://github.com/a/b/pull/3' : undefined })),
      onUpdated: { addListener: (fn) => { listeners.updated = fn; } },
      onActivated: { addListener: (fn) => { listeners.activated = fn; } },
    },
  };
  return { chrome, listeners };
}

describe('wirePanel', () => {
  it('opens the panel on action click and sets options on tab update and activation', async () => {
    const { chrome, listeners } = fakeChrome();
    wirePanel(chrome);
    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
    listeners.updated?.(1, {}, { url: 'https://github.com/a/b/pull/3' });
    expect(chrome.sidePanel.setOptions).toHaveBeenLastCalledWith({ tabId: 1, path: 'sidepanel.html', enabled: true });
    await listeners.activated?.({ tabId: 2 });
    await Promise.resolve();
    expect(chrome.sidePanel.setOptions).toHaveBeenLastCalledWith({ tabId: 2, path: 'sidepanel.html', enabled: true });
    await listeners.activated?.({ tabId: 3 });
    await Promise.resolve();
    expect(chrome.sidePanel.setOptions).toHaveBeenLastCalledWith({ tabId: 3, path: 'sidepanel.html', enabled: false });
  });
});
