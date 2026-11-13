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

  it('shows notes in the diff unless the person turned them off', async () => {
    const area = fakeArea();
    const settings = createSettingsStore(area);
    expect(await settings.getShowNotes()).toBe(true);
    await settings.setShowNotes(false);
    expect(area.data).toEqual({ 'airlock.showNotes': false });
    expect(await settings.getShowNotes()).toBe(false);
    await settings.setShowNotes(true);
    expect(await settings.getShowNotes()).toBe(true);
    // Anything but a stored false leaves them on.
    for (const odd of ['false', 0, null]) expect(await createSettingsStore(fakeArea({ 'airlock.showNotes': odd })).getShowNotes()).toBe(true);
  });

  it('keeps the text size under airlock.size, Default when missing or not one of the four', async () => {
    const area = fakeArea();
    const settings = createSettingsStore(area);
    expect(await settings.getSize()).toBe('m');
    await settings.setSize('xl');
    expect(area.data).toEqual({ 'airlock.size': 'xl' });
    expect(await settings.getSize()).toBe('xl');
    for (const odd of ['huge', 1.3, null, true]) expect(await createSettingsStore(fakeArea({ 'airlock.size': odd })).getSize()).toBe('m');
  });

  it('keeps whether the tour was seen under airlock.tourSeen, not seen unless it is stored as true', async () => {
    const area = fakeArea();
    const settings = createSettingsStore(area);
    expect(await settings.getTourSeen()).toBe(false);
    await settings.setTourSeen();
    expect(area.data).toEqual({ 'airlock.tourSeen': true });
    expect(await settings.getTourSeen()).toBe(true);
    for (const odd of ['true', 1, null]) expect(await createSettingsStore(fakeArea({ 'airlock.tourSeen': odd })).getTourSeen()).toBe(false);
  });
});
