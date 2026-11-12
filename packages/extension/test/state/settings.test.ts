import { describe, expect, it } from 'vitest';
import { createSettingsStore, type StorageAreaLike } from '../../src/state/settings';

function fakeArea(initial: Record<string, unknown> = {}): StorageAreaLike & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    async get(keys) {
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const k of keys) delete data[k];
    },
  };
}

describe('settings', () => {
  it('keeps the token and the default depth under their airlock keys', async () => {
    const area = fakeArea();
    const settings = createSettingsStore(area);
    expect(await settings.getToken()).toBeNull();
    expect(await settings.getDefaultDepth()).toBeNull();
    await settings.setToken('f'.repeat(64));
    await settings.setDefaultDepth('deep');
    expect(area.data).toEqual({ 'airlock.token': 'f'.repeat(64), 'airlock.defaultDepth': 'deep' });
    expect(await settings.getToken()).toBe('f'.repeat(64));
    expect(await settings.getDefaultDepth()).toBe('deep');
  });

  it('clears the default depth when given null', async () => {
    const area = fakeArea();
    const settings = createSettingsStore(area);
    await settings.setDefaultDepth('deep');
    await settings.setDefaultDepth(null);
    expect(area.data).toEqual({});
    expect(await settings.getDefaultDepth()).toBeNull();
  });

  it('reads a stored value of the wrong shape as nothing', async () => {
    const settings = createSettingsStore(fakeArea({ 'airlock.token': 42, 'airlock.defaultDepth': 'thorough' }));
    expect(await settings.getToken()).toBeNull();
    expect(await settings.getDefaultDepth()).toBeNull();
    expect(await createSettingsStore(fakeArea({ 'airlock.token': '' })).getToken()).toBeNull();
  });
});
