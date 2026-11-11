// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/panel/App';
import type { PanelState, UserAction } from '../../src/state/machine';
import { prSummary } from './fixtures';

afterEach(cleanup);

function fakeStart() {
  const stop = vi.fn();
  const dispatch = vi.fn<(a: UserAction) => void>();
  let emit: (s: PanelState) => void = () => undefined;
  const start = vi.fn((onState: (s: PanelState) => void) => {
    emit = onState;
    return { dispatch, stop };
  });
  return { start, stop, dispatch, send: (s: PanelState) => act(() => emit(s)) };
}

describe('App', () => {
  it('starts the panel once, shows its states, passes dispatch down and stops on unmount', () => {
    const f = fakeStart();
    const view = render(<App start={f.start} />);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Looking at this pull request…')).toBeTruthy();
    f.send({ kind: 'ready', pr: prSummary() });
    screen.getByRole('button', { name: 'Review' }).click();
    expect(f.dispatch).toHaveBeenCalledWith({ type: 'start', depth: 'quick' });
    f.send({ kind: 'offline' });
    expect(screen.getByText('Not running')).toBeTruthy();
    expect(f.stop).not.toHaveBeenCalled();
    view.unmount();
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
});
