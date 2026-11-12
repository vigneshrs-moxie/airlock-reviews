type Tab = { id?: number; url?: string };

/** The tab the panel sits beside: its address now, and each time it changes. */
export interface TabWatcher {
  current(): Promise<{ tabId: number; url: string | undefined }>;
  /**
   * Calls `fn` with the tab's address on every update to that tab (undefined when Chrome does not show it), and the
   * update's load status when it has one (`complete` when the page finished loading).
   */
  onChange(fn: (url: string | undefined, status?: string) => void): () => void;
}

type UpdatedListener = (tabId: number, changeInfo: { url?: string; status?: string }, tab: Tab) => void;

/** The part of `chrome.tabs` the watcher uses, so tests can pass a fake. */
export interface TabsLike {
  query(filter: { active: true; currentWindow: true }): Promise<Tab[]>;
  onUpdated: {
    addListener(fn: UpdatedListener): void;
    removeListener(fn: UpdatedListener): void;
  };
}

const NO_TAB = -1;

/**
 * Watches the tab that was active in this window when the panel loaded. The panel is opened per tab, so that tab is
 * the one it sits beside for its whole life.
 */
export function createTabWatcher(tabs: TabsLike): TabWatcher {
  let found: Promise<{ tabId: number; url: string | undefined }> | undefined;
  let tabId: number | undefined;
  const current = (): Promise<{ tabId: number; url: string | undefined }> => {
    found ??= tabs.query({ active: true, currentWindow: true }).then(
      ([tab]) => {
        tabId = tab?.id ?? NO_TAB;
        return { tabId, url: tab?.url };
      },
      (error: unknown) => {
        // Not kept: the next call (Retry) asks Chrome again.
        found = undefined;
        throw error;
      },
    );
    return found;
  };
  return {
    current,
    onChange(fn) {
      const listener: UpdatedListener = (id, changeInfo, tab) => {
        if (tabId !== undefined && tabId !== NO_TAB && id === tabId) fn(tab.url, changeInfo.status);
      };
      tabs.onUpdated.addListener(listener);
      void current().catch(() => undefined);
      return () => tabs.onUpdated.removeListener(listener);
    },
  };
}

/** The real watcher, through Chrome's tabs API. */
export function browserTab(): TabWatcher {
  return createTabWatcher(browser.tabs);
}
