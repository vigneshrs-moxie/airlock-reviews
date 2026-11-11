// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, type PanelServices } from '../../src/panel/App';
import type { PanelState, UserAction } from '../../src/state/machine';
import { prSummary } from './fixtures';
import { finding, reviewState } from './review-fixtures';

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

  it('passes the jump to the review with its pull request, and shows the last jump\'s report on the Packs screen', async () => {
    const f = fakeStart();
    const jump = vi.fn<NonNullable<PanelServices['jump']>>(async (_pr, place, onReport) => {
      onReport({ view: 'react', missing: [] });
      return `Showing ${place.path}:${String(place.line)}.`;
    });
    const services: PanelServices = { settings: { getToken: async () => null, setToken: async () => undefined, getDefaultDepth: async () => null, setDefaultDepth: async () => undefined }, fetchStatus: () => new Promise(() => undefined), jump };
    render(<App start={f.start} services={services} />);
    f.send(reviewState([finding(1)]));
    fireEvent.click(screen.getByRole('button', { name: /Problem 1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Jump to line' }));
    expect(await screen.findByText('Showing src/file1.ts:10.')).toBeTruthy();
    expect(jump).toHaveBeenCalledWith(expect.objectContaining({ repo: 'acme/widgets', number: 1 }), { path: 'src/file1.ts', line: 10, kind: 'changed' }, expect.any(Function));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Packs' })); });
    expect(screen.getByText('Recognised as the newer view.')).toBeTruthy();
  });

  it('keeps the report of the latest jump when an earlier one reports later', async () => {
    const f = fakeStart();
    const pending: ((report: { view: 'react' | 'classic' | null; missing: string[] }) => void)[] = [];
    const jump = vi.fn<NonNullable<PanelServices['jump']>>((_pr, _place, onReport) => {
      pending.push(onReport);
      return new Promise<string>(() => undefined);
    });
    const services: PanelServices = { settings: { getToken: async () => null, setToken: async () => undefined, getDefaultDepth: async () => null, setDefaultDepth: async () => undefined }, fetchStatus: () => new Promise(() => undefined), jump };
    render(<App start={f.start} services={services} />);
    f.send(reviewState([finding(1, { connected: [{ path: 'src/other.ts', line: 7, role: 'caller', quote: '' }] })]));
    fireEvent.click(screen.getByRole('button', { name: /Problem 1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Jump to line' }));
    fireEvent.click(screen.getByRole('button', { name: /src\/other\.ts:7/ }));
    act(() => { pending[1]!({ view: 'classic', missing: [] }); });
    act(() => { pending[0]!({ view: null, missing: ['classic-file'] }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Packs' })); });
    expect(screen.getByText('Recognised as the classic view.')).toBeTruthy();
  });
});
