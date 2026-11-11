import { describe, expect, it } from 'vitest';
import { createTabWatcher, type TabsLike } from '../../src/state/tab';

type Tab = { id?: number; url?: string };
type Listener = (tabId: number, changeInfo: { url?: string }, tab: Tab) => void;

function fakeTabs(active: Tab[]) {
  const listeners = new Set<Listener>();
  const queries: object[] = [];
  const tabs: TabsLike = {
    async query(filter) {
      queries.push(filter);
      return active;
    },
    onUpdated: {
      addListener: (fn) => void listeners.add(fn),
      removeListener: (fn) => void listeners.delete(fn),
    },
  };
  const update = (tabId: number, tab: Tab, changeInfo: { url?: string } = {}) => {
    for (const fn of listeners) fn(tabId, changeInfo, tab);
  };
  return { tabs, queries, listeners, update };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('tab watcher', () => {
  it('reads the active tab of the current window once', async () => {
    const fake = fakeTabs([{ id: 7, url: 'https://github.com/acme/widgets/pull/1' }]);
    const watcher = createTabWatcher(fake.tabs);
    expect(await watcher.current()).toEqual({ tabId: 7, url: 'https://github.com/acme/widgets/pull/1' });
    expect(await watcher.current()).toEqual({ tabId: 7, url: 'https://github.com/acme/widgets/pull/1' });
    expect(fake.queries).toEqual([{ active: true, currentWindow: true }]);
  });

  it('reports changes to that tab only, with its address or undefined when Chrome hides it', async () => {
    const fake = fakeTabs([{ id: 7, url: 'https://github.com/acme/widgets/pull/1' }]);
    const watcher = createTabWatcher(fake.tabs);
    const seen: (string | undefined)[] = [];
    const off = watcher.onChange((url) => seen.push(url));
    await tick();
    fake.update(8, { id: 8, url: 'https://github.com/acme/widgets/pull/2' }, { url: 'https://github.com/acme/widgets/pull/2' });
    fake.update(7, { id: 7, url: 'https://github.com/acme/widgets/pull/3' }, { url: 'https://github.com/acme/widgets/pull/3' });
    fake.update(7, { id: 7 }, {});
    expect(seen).toEqual(['https://github.com/acme/widgets/pull/3', undefined]);
    off();
    expect(fake.listeners.size).toBe(0);
    fake.update(7, { id: 7, url: 'https://github.com/acme/widgets/pull/4' });
    expect(seen).toHaveLength(2);
  });

  it('a window with no active tab gives an id of -1 and no address, and no change is reported', async () => {
    const fake = fakeTabs([]);
    const watcher = createTabWatcher(fake.tabs);
    expect(await watcher.current()).toEqual({ tabId: -1, url: undefined });
    const seen: (string | undefined)[] = [];
    watcher.onChange((url) => seen.push(url));
    await tick();
    fake.update(-1, { url: 'https://github.com/acme/widgets/pull/1' });
    expect(seen).toEqual([]);
  });

  it('reads the tab again after a failed read, so Retry can work', async () => {
    const fake = fakeTabs([{ id: 7, url: 'https://github.com/acme/widgets/pull/1' }]);
    let fail = true;
    const query = fake.tabs.query;
    fake.tabs.query = async (filter) => {
      if (fail) {
        fail = false;
        throw new Error('No current window');
      }
      return query(filter);
    };
    const watcher = createTabWatcher(fake.tabs);
    await expect(watcher.current()).rejects.toThrow('No current window');
    expect(await watcher.current()).toEqual({ tabId: 7, url: 'https://github.com/acme/widgets/pull/1' });
  });
});
