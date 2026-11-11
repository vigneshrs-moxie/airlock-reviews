import { DepthSchema, type Depth } from '@airlock/shared';

const TOKEN_KEY = 'airlock.token';
const DEPTH_KEY = 'airlock.defaultDepth';

/** What the panel keeps between sessions. Only the panel page reads the token. */
export interface SettingsStore {
  getToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
  getDefaultDepth(): Promise<Depth | null>;
  setDefaultDepth(depth: Depth): Promise<void>;
}

/** The part of `chrome.storage.local` the store uses, so tests can pass a fake. */
export interface StorageAreaLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function createSettingsStore(area: StorageAreaLike): SettingsStore {
  const read = async (key: string): Promise<unknown> => (await area.get([key]))[key];
  return {
    async getToken() {
      const value = await read(TOKEN_KEY);
      return typeof value === 'string' && value !== '' ? value : null;
    },
    async setToken(token) {
      await area.set({ [TOKEN_KEY]: token });
    },
    async getDefaultDepth() {
      const value = DepthSchema.safeParse(await read(DEPTH_KEY));
      return value.success ? value.data : null;
    },
    async setDefaultDepth(depth) {
      await area.set({ [DEPTH_KEY]: depth });
    },
  };
}

/** The real store, in the extension's local storage (kept on this computer, never synced). */
export function browserSettings(): SettingsStore {
  return createSettingsStore(browser.storage.local);
}
