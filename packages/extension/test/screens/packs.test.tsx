// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Depth, ServiceStatus } from '@airlock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelScreen, type PanelScreenProps } from '../../src/screens/PanelScreen';
import type { PanelState } from '../../src/state/reduce';
import { prSummary } from './fixtures';
import { dismissal as dismissalFor, finding, reviewState } from './review-fixtures';

afterEach(cleanup);

const STATUS: ServiceStatus = {
  version: '0.2.0', claude: true, gh: false, packsDir: '/p',
  running: [{ runId: 'run_000000000001', repo: 'acme/widgets', number: 7 }],
};

function show(state: PanelState, extra: Partial<PanelScreenProps> = {}) {
  const dispatch = vi.fn();
  const fetchStatus = vi.fn().mockResolvedValue(STATUS);
  const setDepth = vi.fn();
  const view = render(
    <PanelScreen state={state} dispatch={dispatch} onOpenPacks={() => undefined} fetchStatus={fetchStatus}
      defaultDepth={null} onDefaultDepth={setDepth} {...extra} />,
  );
  return { dispatch, fetchStatus, setDepth, ...view };
}
const openPacks = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Packs' })); }); };

describe('the Packs and settings screen', () => {
  it('lists the packs of this repository, with versions cut to 7 characters when a review is on screen', async () => {
    const sha = 'abcdef0123456789abcdef0123456789abcdef01';
    show(reviewState([finding(1)], { doc: { packs: [{ id: 'generic', version: sha }, { id: 'orbit', version: 'v3' }] } }));
    await openPacks();
    expect(screen.getByRole('heading', { name: 'Packs for this repository' })).toBeTruthy();
    expect(screen.getByText('Generic')).toBeTruthy();
    expect(screen.getByText('version abcdef0')).toBeTruthy();
    expect(screen.getByText('version v3')).toBeTruthy();
  });

  it('shows no versions without a review, and a sentence when no pull request is known', async () => {
    const { unmount } = show({ kind: 'ready', pr: prSummary() });
    await openPacks();
    expect(within(document.querySelector<HTMLElement>('.packs-screen')!).getByText('Generic')).toBeTruthy();
    expect(screen.queryByText(/^version/)).toBeNull();
    unmount();
    show({ kind: 'no-pr' });
    await openPacks();
    expect(screen.getByText('Open a pull request to see its packs.')).toBeTruthy();
  });

  it('says the service status in words, fetched when the screen opens', async () => {
    const { fetchStatus } = show({ kind: 'ready', pr: prSummary() });
    await openPacks();
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Running, version 0.2.0')).toBeTruthy();
    expect(screen.getByText('Claude: found')).toBeTruthy();
    expect(screen.getByText('GitHub command: not signed in')).toBeTruthy();
    expect(screen.getByText('acme/widgets #7')).toBeTruthy();
  });

  it('says it could not reach the service, and Check again fetches again', async () => {
    const fetchStatus = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue({ ...STATUS, claude: false, gh: true, running: [] });
    show({ kind: 'ready', pr: prSummary() }, { fetchStatus });
    await openPacks();
    expect(screen.getByText('Airlock could not reach its service.')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check again' })); });
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Airlock could not reach its service.')).toBeNull();
    expect(screen.getByText('Claude: not found')).toBeTruthy();
    expect(screen.getByText('GitHub command: signed in')).toBeTruthy();
  });

  it('shows the pairing state and the unpair instruction', async () => {
    const { unmount } = show({ kind: 'ready', pr: prSummary() });
    await openPacks();
    expect(screen.getByText('This panel is paired.')).toBeTruthy();
    expect(screen.getByText('npm run service -- unpair')).toBeTruthy();
    expect(screen.getByText('To unpair, in the airlock-reviews folder run:')).toBeTruthy();
    unmount();
    show({ kind: 'unpaired' });
    await openPacks();
    expect(screen.getByText('Not paired yet.')).toBeTruthy();
    expect(screen.queryByText('npm run service -- unpair')).toBeNull();
  });

  it('stores the default depth, and Suggested clears it', async () => {
    const { setDepth } = show({ kind: 'ready', pr: prSummary() }, { defaultDepth: 'deep' });
    await openPacks();
    expect((screen.getByRole('radio', { name: 'Deep' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Quick' }));
    expect(setDepth).toHaveBeenLastCalledWith('quick');
    fireEvent.click(screen.getByRole('radio', { name: 'Suggested for each pull request' }));
    expect(setDepth).toHaveBeenLastCalledWith(null);
  });

  it('Back returns to the panel and focus to the Packs button, without stopping a running review', async () => {
    const dispatch = vi.fn();
    show({ kind: 'ready', pr: prSummary() }, { dispatch });
    const button = screen.getByRole('button', { name: 'Packs' });
    await openPacks();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
    expect(document.activeElement).toBe(button);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('renders service text as text', async () => {
    const evil = '<img src=x onerror=alert(1)>/x';
    show({ kind: 'ready', pr: prSummary() }, { fetchStatus: vi.fn().mockResolvedValue({ ...STATUS, version: evil, running: [{ runId: 'run_000000000001', repo: evil, number: 1 }] }) });
    await openPacks();
    expect(screen.getByText(`Running, version ${evil}`)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('the Ready screen and the stored default depth', () => {
  const depthOf = (): Depth => (['quick', 'standard', 'deep'] as const).find((d) => (screen.getByRole('radio', { name: new RegExp(`^${d}`, 'i') }) as HTMLInputElement).checked)!;
  it('preselects the stored default, or the suggested depth without one', () => {
    const { unmount } = show({ kind: 'ready', pr: prSummary({ suggestedDepth: 'quick' }) }, { defaultDepth: 'deep' });
    expect(depthOf()).toBe('deep');
    unmount();
    show({ kind: 'ready', pr: prSummary({ suggestedDepth: 'standard' }) });
    expect(depthOf()).toBe('standard');
  });
  it('follows a default that arrives after the screen, until the person picks one', () => {
    const state: PanelState = { kind: 'ready', pr: prSummary({ suggestedDepth: 'quick' }) };
    const view = show(state);
    expect(depthOf()).toBe('quick');
    view.rerender(<PanelScreen state={state} dispatch={view.dispatch} onOpenPacks={() => undefined} defaultDepth="deep" />);
    expect(depthOf()).toBe('deep');
    within(document.body).getByRole('radio', { name: /^Standard/ }).click();
    view.rerender(<PanelScreen state={state} dispatch={view.dispatch} onOpenPacks={() => undefined} defaultDepth="deep" />);
    expect(depthOf()).toBe('standard');
  });
});

describe('the Packs screen (fix round 1)', () => {
  it('says nothing about pairing when it does not know, and says it from the state when it does', async () => {
    const { unmount } = show({ kind: 'no-pr' });
    await openPacks();
    expect(screen.getByRole('heading', { name: 'Pairing' })).toBeTruthy();
    expect(screen.queryByText('This panel is paired.')).toBeNull();
    expect(screen.queryByText('Not paired yet.')).toBeNull();
    expect(screen.queryByText('npm run service -- unpair')).toBeNull();
    unmount();
    show({ kind: 'loading' });
    await openPacks();
    expect(screen.queryByText('This panel is paired.')).toBeNull();
  });

  it('is paired for running and review states, and for offline it does not know', async () => {
    const { unmount } = show({ kind: 'running', pr: prSummary(), stages: [], brief: null, map: null });
    await openPacks();
    expect(screen.getByText('This panel is paired.')).toBeTruthy();
    unmount();
    const r = reviewState([finding(1)]);
    show({ kind: 'offline', review: { pr: r.pr, latest: r.latest, stale: false } });
    await openPacks();
    expect(within(document.querySelector<HTMLElement>('.packs-screen')!).getByText('Generic')).toBeTruthy();
    expect(screen.queryByText('This panel is paired.')).toBeNull();
  });

  it('keeps the Ready screen\'s choices while open and after Back', async () => {
    show({ kind: 'ready', pr: prSummary() });
    fireEvent.click(screen.getByRole('radio', { name: /^Deep/ }));
    await openPacks();
    const kept = document.querySelector('.kept')!;
    expect(kept.hasAttribute('hidden')).toBe(true);
    expect(kept.hasAttribute('inert')).toBe(true);
    expect(kept.contains(document.activeElement)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect((screen.getByRole('radio', { name: /^Deep/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('keeps an open finding, its sheet and the typed line while Packs is open and after Back', async () => {
    show(reviewState([finding(1)]));
    fireEvent.click(document.querySelector('.finding-card button')!);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Intended' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'The line that will be saved to your pack' }), { target: { value: 'Totals are rounded on purpose' } });
    await openPacks();
    const kept = document.querySelector('.kept')!;
    expect(kept.hasAttribute('inert')).toBe(true);
    expect(kept.contains(document.activeElement)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'The line that will be saved to your pack' }) as HTMLTextAreaElement).value).toBe('Totals are rounded on purpose');
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('says it is not known yet when nothing proves whether the panel is paired', async () => {
    show({ kind: 'no-pr' });
    await openPacks();
    expect(screen.getByText('Not known yet.')).toBeTruthy();
  });

  it('holds a focus move that falls due while hidden until the body is visible again', async () => {
    const f = finding(1);
    const view = show(reviewState([f]));
    fireEvent.click(document.querySelector('.finding-card button')!);
    await openPacks();
    const heading = document.querySelector<HTMLElement>('.packs-screen h2')!;
    // The open finding is dismissed elsewhere while Packs is open; the detail closes behind it.
    view.rerender(<PanelScreen state={reviewState([f], { dismissals: [dismissalFor(f)] })} dispatch={view.dispatch} fetchStatus={view.fetchStatus} />);
    expect(document.activeElement).toBe(heading);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(document.activeElement?.hasAttribute('data-focus') || document.activeElement?.tagName === 'H2').toBe(true);
  });

  it('changes nothing when a status fetch resolves after Back', async () => {
    let resolve!: (s: ServiceStatus) => void;
    const fetchStatus = vi.fn().mockReturnValue(new Promise<ServiceStatus>((r) => { resolve = r; }));
    show({ kind: 'ready', pr: prSummary() }, { fetchStatus });
    await openPacks();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await act(async () => { resolve(STATUS); });
    expect(screen.queryByText('Claude: found')).toBeNull();
    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
  });

  it('disables Check again while a fetch is in flight', async () => {
    let resolve!: (s: ServiceStatus) => void;
    const fetchStatus = vi.fn().mockReturnValue(new Promise<ServiceStatus>((r) => { resolve = r; }));
    show({ kind: 'ready', pr: prSummary() }, { fetchStatus });
    await openPacks();
    expect((screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { resolve(STATUS); });
    expect((screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows that the setting could not be saved when told so', async () => {
    show({ kind: 'ready', pr: prSummary() }, { depthFailed: true, defaultDepth: 'quick' });
    await openPacks();
    expect(screen.getByText('Airlock could not save that setting.')).toBeTruthy();
  });
});
