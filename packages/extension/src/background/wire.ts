import { panelOptionsFor, type PanelOptions } from './panel-options';

type Tab = { id?: number; url?: string };

/** The few Chrome calls the worker uses, so tests can pass a fake. */
export interface PanelChrome {
  storage: {
    local: { setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void> };
  };
  sidePanel: {
    setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
    setOptions(options: Partial<PanelOptions>): Promise<void>;
  };
  tabs: {
    get(tabId: number): Promise<Tab>;
    query(filter: { url: string }): Promise<Tab[]>;
    onUpdated: { addListener(fn: (tabId: number, changeInfo: object, tab: Tab) => void): void };
    onActivated: { addListener(fn: (info: { tabId: number }) => void): void };
  };
}

// A tab can close in the middle of any of these calls; a failure here is never worth a crash.
function settle(work: () => Promise<unknown>): Promise<void> {
  try {
    return work().then(() => undefined, () => undefined);
  } catch {
    return Promise.resolve();
  }
}

export function wirePanel(chrome: PanelChrome): void {
  // The pairing token is in local storage, which content scripts could read unless the extension says otherwise.
  try {
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch((e: unknown) => {
      console.warn(`Airlock could not keep its storage from content scripts: ${e instanceof Error ? e.message : String(e)}`);
    });
  } catch (e) {
    console.warn(`Airlock could not keep its storage from content scripts: ${e instanceof Error ? e.message : String(e)}`);
  }

  const apply = (tabId: number, url: string | undefined): Promise<void> =>
    settle(() => chrome.sidePanel.setOptions(panelOptionsFor(tabId, url)));

  // Off for every tab by default; WXT's manifest would otherwise leave it on everywhere.
  const off = settle(() => chrome.sidePanel.setOptions({ enabled: false }));
  void settle(() => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }));

  // Tabs that were already open when the worker started.
  void off.then(() =>
    settle(async () => {
      const open = await chrome.tabs.query({ url: 'https://github.com/*' });
      await Promise.all(open.flatMap((tab) => (tab.id === undefined ? [] : [apply(tab.id, tab.url)])));
    }),
  );

  chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
    void apply(tabId, tab.url);
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void settle(async () => {
      const tab = await chrome.tabs.get(tabId);
      await apply(tabId, tab.url);
    });
  });
}
