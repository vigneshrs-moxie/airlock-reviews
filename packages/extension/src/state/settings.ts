import { DepthSchema, type Depth } from '@airlock/shared';

const TOKEN_KEY = 'airlock.token';
const DEPTH_KEY = 'airlock.defaultDepth';
const NOTES_KEY = 'airlock.showNotes';

/** What the panel keeps between sessions. Only the panel page reads the token. */
export interface SettingsStore {
  getToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
  getDefaultDepth(): Promise<Depth | null>;
  /** `null` clears the stored value, so each pull request's suggestion is used. */
  setDefaultDepth(depth: Depth | null): Promise<void>;
  /** Whether the review's notes are shown in the diff on GitHub's page: on unless the person turned them off. */
  getShowNotes(): Promise<boolean>;
  setShowNotes(on: boolean): Promise<void>;
}

/** The part of `chrome.storage.local` the store uses, so tests can pass a fake. */
export interface StorageAreaLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
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
      if (depth === null) await area.remove([DEPTH_KEY]);
      else await area.set({ [DEPTH_KEY]: depth });
    },
    async getShowNotes() {
      return (await read(NOTES_KEY)) !== false;
    },
    async setShowNotes(on) {
      await area.set({ [NOTES_KEY]: on });
    },
  };
}

/** The real store, in the extension's local storage (kept on this computer, never synced). */
export function browserSettings(): SettingsStore {
  return createSettingsStore(browser.storage.local);
}
