// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SIZES, SIZE_LABEL, SIZE_SCALE, applySize, readSizeHint, startSize, writeSizeHint, type Size,
} from '../../src/state/size';

const root = (): HTMLElement => document.createElement('div');

/** A page's local storage held in memory. */
function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => { data[key] = value; },
  };
}

const throwing: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('denied'); },
};

/** A store whose read and write the test settles. */
function deferredStore() {
  let release: (size: Size) => void = () => undefined;
  let refuse: (error: Error) => void = () => undefined;
  const read = new Promise<Size>((resolve, reject) => { release = resolve; refuse = reject; });
  const setSize = vi.fn<(size: Size) => Promise<void>>().mockResolvedValue(undefined);
  return { store: { getSize: () => read, setSize }, release, refuse, setSize };
}

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

afterEach(() => { vi.restoreAllMocks(); });

describe('the sizes', () => {
  it('are four, with their scales and their names', () => {
    expect(SIZES).toEqual(['s', 'm', 'l', 'xl']);
    expect(SIZE_SCALE).toEqual({ s: 0.9, m: 1, l: 1.15, xl: 1.3 });
    expect(SIZE_LABEL).toEqual({ s: 'Small', m: 'Default', l: 'Large', xl: 'Largest' });
  });

  it('each applies its scale as the text scale of the root, and names itself on it', () => {
    for (const size of SIZES) {
      const el = root();
      applySize(size, el);
      expect(el.style.getPropertyValue('--text-scale')).toBe(String(SIZE_SCALE[size]));
      expect(el.dataset.size).toBe(size);
    }
  });

  it('applies to the document by default', () => {
    applySize('xl');
    expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('1.3');
    expect(document.documentElement.dataset.size).toBe('xl');
    applySize('m');
    expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('1');
  });
});

describe('the hint in the page\'s storage', () => {
  it('reads back what was written', () => {
    const storage = memoryStorage();
    writeSizeHint('l', storage);
    expect(storage.data).toEqual({ 'airlock.size': 'l' });
    expect(readSizeHint(storage)).toBe('l');
  });

  it('gives Default when nothing is there, for a value that is not a size, and when storage throws', () => {
    expect(readSizeHint(memoryStorage())).toBe('m');
    for (const odd of ['huge', 'M', '', '1.3']) expect(readSizeHint(memoryStorage({ 'airlock.size': odd }))).toBe('m');
    expect(readSizeHint(throwing)).toBe('m');
    expect(() => writeSizeHint('xl', throwing)).not.toThrow();
  });

  it('gives Default when the page\'s localStorage itself cannot be reached', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('SecurityError'); });
    expect(readSizeHint()).toBe('m');
    expect(() => writeSizeHint('l')).not.toThrow();
  });
});

describe('start-up', () => {
  it('applies the hint at once, then the stored size when it differs, and rewrites the hint', async () => {
    const el = root();
    const storage = memoryStorage({ 'airlock.size': 'l' });
    const { store, release } = deferredStore();
    const size = startSize(store, { root: el, pageStorage: storage });
    // Before the store has answered: the hint.
    expect(el.dataset.size).toBe('l');
    expect(size.current()).toEqual({ size: 'l', failed: false });
    const heard = vi.fn();
    size.subscribe(heard);
    release('xl');
    await settle();
    expect(el.dataset.size).toBe('xl');
    expect(el.style.getPropertyValue('--text-scale')).toBe('1.3');
    expect(storage.data['airlock.size']).toBe('xl');
    expect(size.current()).toEqual({ size: 'xl', failed: false });
    expect(heard).toHaveBeenCalled();
  });

  it('changes nothing when the store agrees with the hint', async () => {
    const el = root();
    const { store, release } = deferredStore();
    const size = startSize(store, { root: el, pageStorage: memoryStorage({ 'airlock.size': 's' }) });
    const heard = vi.fn();
    size.subscribe(heard);
    release('s');
    await settle();
    expect(el.dataset.size).toBe('s');
    expect(heard).not.toHaveBeenCalled();
  });

  it('opens at Default and says nothing when neither the hint nor the store can be read', async () => {
    const el = root();
    const { store, refuse } = deferredStore();
    const size = startSize(store, { root: el, pageStorage: throwing });
    refuse(new Error('storage error'));
    await settle();
    expect(el.dataset.size).toBe('m');
    expect(el.style.getPropertyValue('--text-scale')).toBe('1');
    expect(size.current()).toEqual({ size: 'm', failed: false });
  });

  it('keeps a size chosen before the store answered', async () => {
    const el = root();
    const { store, release } = deferredStore();
    const size = startSize(store, { root: el, pageStorage: memoryStorage() });
    size.choose('l');
    release('s');
    await settle();
    expect(el.dataset.size).toBe('l');
    expect(size.current().size).toBe('l');
  });
});

describe('choosing a size', () => {
  it('applies it at once, stores it and writes the hint', async () => {
    const el = root();
    const storage = memoryStorage();
    const { store, release, setSize } = deferredStore();
    const size = startSize(store, { root: el, pageStorage: storage });
    release('m');
    await settle();
    size.choose('xl');
    expect(el.style.getPropertyValue('--text-scale')).toBe('1.3');
    expect(storage.data['airlock.size']).toBe('xl');
    expect(setSize).toHaveBeenCalledWith('xl');
    await settle();
    expect(size.current()).toEqual({ size: 'xl', failed: false });
  });

  it('undoes a size that cannot be stored, and says so until the next choice', async () => {
    const el = root();
    const storage = memoryStorage();
    const { store, release, setSize } = deferredStore();
    const size = startSize(store, { root: el, pageStorage: storage });
    release('l');
    await settle();
    setSize.mockRejectedValueOnce(new Error('quota'));
    size.choose('s');
    expect(el.dataset.size).toBe('s');
    await settle();
    expect(el.dataset.size).toBe('l');
    expect(storage.data['airlock.size']).toBe('l');
    expect(size.current()).toEqual({ size: 'l', failed: true });
    size.choose('xl');
    expect(size.current()).toEqual({ size: 'xl', failed: false });
  });

  it('ignores the failure of an earlier choice once a later one is made', async () => {
    const el = root();
    const { store, release, setSize } = deferredStore();
    const size = startSize(store, { root: el, pageStorage: memoryStorage() });
    release('m');
    await settle();
    let refuseFirst: (e: Error) => void = () => undefined;
    setSize.mockReturnValueOnce(new Promise((_, reject) => { refuseFirst = reject; }));
    size.choose('s');
    size.choose('xl');
    refuseFirst(new Error('late'));
    await settle();
    expect(size.current()).toEqual({ size: 'xl', failed: false });
    expect(el.dataset.size).toBe('xl');
  });
});
