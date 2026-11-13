import { DepthSchema, type Depth } from '@airlock/shared';
import { DEFAULT_SIZE, isSize, type Size } from './size';

const TOKEN_KEY = 'airlock.token';
const DEPTH_KEY = 'airlock.defaultDepth';
const NOTES_KEY = 'airlock.showNotes';
const SIZE_KEY = 'airlock.size';
const TOUR_KEY = 'airlock.tourSeen';

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
  /** The text size: Default when none is stored or the stored value is not one of the four. */
  getSize(): Promise<Size>;
  setSize(size: Size): Promise<void>;
  /** Whether the tour was finished or skipped; it shows by itself until then. */
  getTourSeen(): Promise<boolean>;
  setTourSeen(): Promise<void>;
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
    async getSize() {
      const value = await read(SIZE_KEY);
      return isSize(value) ? value : DEFAULT_SIZE;
    },
    async setSize(size) {
      await area.set({ [SIZE_KEY]: size });
    },
    async getTourSeen() {
      return (await read(TOUR_KEY)) === true;
    },
    async setTourSeen() {
      await area.set({ [TOUR_KEY]: true });
    },
  };
}

/** The real store, in the extension's local storage (kept on this computer, never synced). */
export function browserSettings(): SettingsStore {
  return createSettingsStore(browser.storage.local);
}
