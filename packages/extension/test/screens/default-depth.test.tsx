// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Depth } from '@airlock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDefaultDepth } from '../../src/panel/usePanel';
import type { SettingsStore } from '../../src/state/settings';

afterEach(cleanup);

function Probe({ settings }: { settings: SettingsStore }) {
  const { depth, failed, setDepth } = useDefaultDepth(settings);
  return (
    <>
      <p>{`depth:${depth ?? 'none'}`}</p>
      <p>{failed ? 'failed' : 'ok'}</p>
      <button type="button" onClick={() => setDepth('deep')}>deep</button>
    </>
  );
}

const store = (over: Partial<SettingsStore>): SettingsStore => ({
  getToken: async () => null, setToken: async () => undefined, getDefaultDepth: async () => 'quick' as Depth | null,
  setDefaultDepth: async () => undefined, getShowNotes: async () => true, setShowNotes: async () => undefined, ...over,
});

describe('useDefaultDepth', () => {
  it('goes back to what is stored when storing fails, and says so', async () => {
    const setDefaultDepth = vi.fn().mockRejectedValue(new Error('full'));
    render(<Probe settings={store({ setDefaultDepth })} />);
    await act(async () => undefined);
    expect(screen.getByText('depth:quick')).toBeTruthy();
    await act(async () => { screen.getByRole('button', { name: 'deep' }).click(); });
    expect(screen.getByText('depth:quick')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
  });
  it('keeps a stored choice and shows no failure when storing works', async () => {
    render(<Probe settings={store({})} />);
    await act(async () => undefined);
    await act(async () => { screen.getByRole('button', { name: 'deep' }).click(); });
    expect(screen.getByText('depth:deep')).toBeTruthy();
    expect(screen.getByText('ok')).toBeTruthy();
  });
});
