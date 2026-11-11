import { panelOptionsFor, type PanelOptions } from './panel-options';

/** The few Chrome calls the worker uses, so tests can pass a fake. */
export interface PanelChrome {
  sidePanel: {
    setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
    setOptions(options: PanelOptions): Promise<void>;
  };
  tabs: {
    get(tabId: number): Promise<{ url?: string }>;
    onUpdated: { addListener(fn: (tabId: number, changeInfo: object, tab: { url?: string }) => void): void };
    onActivated: { addListener(fn: (info: { tabId: number }) => void): void };
  };
}

export function wirePanel(chrome: PanelChrome): void {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
    void chrome.sidePanel.setOptions(panelOptionsFor(tabId, tab.url));
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void chrome.tabs
      .get(tabId)
      .then((tab) => chrome.sidePanel.setOptions(panelOptionsFor(tabId, tab.url)))
      .catch(() => {}); // the tab closed before we looked
  });
}
