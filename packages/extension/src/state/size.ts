import type { SettingsStore } from './settings';

/** The text size of the whole panel. */
export type Size = 's' | 'm' | 'l' | 'xl';
export const SIZES: readonly Size[] = ['s', 'm', 'l', 'xl'];
export const SIZE_SCALE: Record<Size, number> = { s: 0.9, m: 1, l: 1.15, xl: 1.3 };
export const SIZE_LABEL: Record<Size, string> = { s: 'Small', m: 'Default', l: 'Large', xl: 'Largest' };
export const DEFAULT_SIZE: Size = 'm';

/** The copy of the size in the panel page's own localStorage, read before the first paint. */
const HINT_KEY = 'airlock.size';

export const isSize = (value: unknown): value is Size => typeof value === 'string' && (SIZES as readonly string[]).includes(value);

/** Scales the panel's text only: the styles multiply every font size by `--text-scale`. Boxes and spacing keep their size. */
export function applySize(size: Size, root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--text-scale', String(SIZE_SCALE[size]));
  root.dataset.size = size;
}

/** The hint, or Default when it is missing, is not one of the four, or storage cannot be read. */
export function readSizeHint(pageStorage?: Pick<Storage, 'getItem'>): Size {
  try {
    const value = (pageStorage ?? window.localStorage).getItem(HINT_KEY);
    return isSize(value) ? value : DEFAULT_SIZE;
  } catch {
    return DEFAULT_SIZE;
  }
}

/** Writes the hint; a page that cannot store it opens at the stored size a moment later instead. */
export function writeSizeHint(size: Size, pageStorage?: Pick<Storage, 'setItem'>): void {
  try {
    (pageStorage ?? window.localStorage).setItem(HINT_KEY, size);
  } catch {
    // The hint is only a copy of what the store keeps.
  }
}

/** The size on screen; `failed` while the last choice could not be stored and was undone. */
export interface SizeState { size: Size; failed: boolean }

/** The panel's size, applied to the root: read at start-up and changed by the person in Settings. */
export interface SizeSetting {
  current(): SizeState;
  subscribe(listener: () => void): () => void;
  /** Applies `size` at once, writes the hint and stores it; a size that cannot be stored is undone and `failed` set. */
  choose(size: Size): void;
}

/**
 * Applies the hint now, then reads the store, and applies its size and rewrites the hint when the two differ. A size the
 * person chose before the store answered is kept. A store that cannot be read leaves the hint, and says nothing.
 */
export function startSize(
  store: Pick<SettingsStore, 'getSize' | 'setSize'>,
  { root, pageStorage }: { root?: HTMLElement; pageStorage?: Pick<Storage, 'getItem' | 'setItem'> } = {},
): SizeSetting {
  const listeners = new Set<() => void>();
  const show = (next: SizeState): void => {
    state = next;
    applySize(next.size, root);
    writeSizeHint(next.size, pageStorage);
    for (const listener of listeners) listener();
  };
  const hint = readSizeHint(pageStorage);
  let state: SizeState = { size: hint, failed: false };
  applySize(hint, root);
  /** What is known to be stored, to go back to. */
  let stored = hint;
  let chosen = false;
  let latest = 0;
  store.getSize().then((value) => {
    if (chosen) return;
    stored = value;
    if (value !== state.size) show({ size: value, failed: false });
  }, () => undefined);
  return {
    current: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    choose(size) {
      chosen = true;
      const mine = ++latest;
      show({ size, failed: false });
      store.setSize(size).then(
        () => { stored = size; },
        () => { if (mine === latest) show({ size: stored, failed: true }); },
      );
    },
  };
}
