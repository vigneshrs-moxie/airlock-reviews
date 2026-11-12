// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, type PanelServices } from '../../src/panel/App';
import { PanelScreen, type PanelScreenProps } from '../../src/screens/PanelScreen';
import { tourMayOpen } from '../../src/screens/Tour';
import type { PanelState, UserAction } from '../../src/state/machine';
import type { SettingsStore } from '../../src/state/settings';
import { prSummary, running } from './fixtures';
import { finding, reviewState } from './review-fixtures';

afterEach(cleanup);

const REVIEW = reviewState([finding(1), finding(2)]);
const STEP_1 = 'The verdict says whether this can merge. Under it, each finding is one line. Tap a line for the short version; the detail is folded below it.';
const STEP_3 = 'Open findings also appear as private notes under their lines on GitHub\'s Files changed page. Settings changes the text and button size, and shows this tour again.';

/** A settings store whose tour flag the test reads, kept across panels like chrome.storage.local. */
function memory(seen = false) {
  const kept = { seen };
  const setTourSeen = vi.fn(async () => { kept.seen = true; });
  const settings: SettingsStore = {
    getToken: async () => null, setToken: async () => undefined, getDefaultDepth: async () => null, setDefaultDepth: async () => undefined,
    getShowNotes: async () => true, setShowNotes: async () => undefined, getSize: async () => 'm', setSize: async () => undefined,
    getTourSeen: async () => kept.seen, setTourSeen,
  };
  return { settings, setTourSeen, kept };
}

/** The App with a panel the test drives. */
async function app(settings: SettingsStore) {
  let emit: (s: PanelState) => void = () => undefined;
  const start = (onState: (s: PanelState) => void) => { emit = onState; return { dispatch: vi.fn<(a: UserAction) => void>(), stop: vi.fn() }; };
  const services: PanelServices = { settings, fetchStatus: () => new Promise(() => undefined) };
  const view = render(<App start={start} services={services} />);
  // The tour flag is read.
  await act(async () => undefined);
  return { ...view, send: (s: PanelState) => act(() => emit(s)) };
}

const tour = () => screen.queryByRole('dialog', { name: /^(Start at the top|Three things you can do with a finding|Notes and size)$/ });
const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('the tour', () => {
  it('opens by itself with the first finished review, not before, and walks its three steps to Done', async () => {
    const { settings, setTourSeen } = memory();
    const a = await app(settings);
    a.send({ kind: 'ready', pr: prSummary() });
    expect(tour()).toBeNull();
    a.send(running());
    expect(tour()).toBeNull();
    a.send(REVIEW);
    const dialog = screen.getByRole('dialog', { name: 'Start at the top' });
    expect(within(dialog).getByText('Step 1 of 3')).toBeTruthy();
    expect(within(dialog).getByText(STEP_1)).toBeTruthy();
    expect(within(dialog).getByText('This is step 1 of 3.')).toBeTruthy();
    expect(dialog.querySelectorAll('.ap-dots i')).toHaveLength(3);
    expect(dialog.closest('.sheet')?.classList.contains('bottom')).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Next' }));
    expect(within(dialog).getByRole('button', { name: 'Skip' })).toBeTruthy();

    press('Next');
    const two = screen.getByRole('dialog', { name: 'Three things you can do with a finding' });
    expect(within(two).getByText('Step 2 of 3')).toBeTruthy();
    expect(within(two).getByText('Copy fix prompt').parentElement?.textContent).toBe('Copy fix prompt copies instructions for your coding agent.');
    expect(within(two).getByText('Comment on GitHub').parentElement?.textContent)
      .toBe('Comment on GitHub shows you the exact text and where it goes: on the line, or in the review summary. It posts only when you press Post.');
    expect(within(two).getByText('Dismiss').parentElement?.textContent).toBe('Dismiss hides the finding here and teaches Airlock. Nothing goes to GitHub.');
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('Step 2 of 3. Three things you can do with a finding');

    press('Next');
    const three = screen.getByRole('dialog', { name: 'Notes and size' });
    expect(within(three).getByText(STEP_3)).toBeTruthy();
    expect(within(three).queryByRole('button', { name: 'Skip' })).toBeNull();
    expect(setTourSeen).not.toHaveBeenCalled();
    press('Done');
    expect(tour()).toBeNull();
    expect(setTourSeen).toHaveBeenCalledTimes(1);

    // A later review in the same panel does not bring it back.
    a.send(running());
    a.send(reviewState([finding(1)], { doc: { id: 'r_0000000002' } }));
    expect(tour()).toBeNull();
  });

  for (const [how, end] of [
    ['Skip', () => press('Skip')],
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    ['a click on the backdrop', () => fireEvent.click(document.querySelector('.sheet')!)],
  ] as const) {
    it(`never shows again after ${how}, in this panel or the next`, async () => {
      const { settings, setTourSeen } = memory();
      const a = await app(settings);
      a.send(REVIEW);
      expect(tour()).toBeTruthy();
      end();
      expect(tour()).toBeNull();
      expect(setTourSeen).toHaveBeenCalledTimes(1);
      a.send(running());
      a.send(REVIEW);
      expect(tour()).toBeNull();
      a.unmount();
      const b = await app(settings);
      b.send(REVIEW);
      expect(tour()).toBeNull();
    });
  }

  it('shows again, from step 1, in the next panel when this one was closed on step 2', async () => {
    const { settings, setTourSeen } = memory();
    const a = await app(settings);
    a.send(REVIEW);
    press('Next');
    expect(screen.getByRole('dialog', { name: 'Three things you can do with a finding' })).toBeTruthy();
    a.unmount();
    expect(setTourSeen).not.toHaveBeenCalled();
    const b = await app(settings);
    b.send(REVIEW);
    expect(screen.getByRole('dialog', { name: 'Start at the top' })).toBeTruthy();
  });

  it('goes without being marked seen when the review leaves the screen, and does not trap the person', async () => {
    const { settings, setTourSeen } = memory();
    const a = await app(settings);
    a.send(REVIEW);
    press('Next');
    // The service goes away: the review is kept, but the tour goes.
    a.send({ kind: 'offline', review: { pr: REVIEW.pr, latest: REVIEW.latest, stale: false } });
    expect(tour()).toBeNull();
    expect(setTourSeen).not.toHaveBeenCalled();
    expect(document.activeElement?.closest('.sheet')).toBeNull();
    // The review is back: not seen yet, so it opens again from the first step.
    a.send(REVIEW);
    expect(screen.getByRole('dialog', { name: 'Start at the top' })).toBeTruthy();
    // A push starts a new review: the tour goes again.
    a.send(running());
    expect(tour()).toBeNull();
    expect(setTourSeen).not.toHaveBeenCalled();
  });

  it('waits for the store to be read, and never opens by itself when it cannot be', async () => {
    const { settings } = memory();
    const a = await app({ ...settings, getTourSeen: () => Promise.reject(new Error('storage error')) });
    a.send(REVIEW);
    expect(tour()).toBeNull();
  });

  it('is replayed from Settings at step 1 over any screen, closing Settings, and gives focus back to the Settings button', async () => {
    const { settings, setTourSeen } = memory(true);
    const a = await app(settings);
    a.send({ kind: 'ready', pr: prSummary() });
    expect(tour()).toBeNull();
    await act(async () => { press('Settings'); });
    const row = screen.getByRole('button', { name: 'Show the tour again' });
    expect(document.getElementById(row.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Three short steps.');
    fireEvent.click(row);
    expect(document.querySelector('.settings-screen')).toBeNull();
    const dialog = screen.getByRole('dialog', { name: 'Start at the top' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Next' }));
    press('Next');
    press('Skip');
    expect(tour()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Settings' }));
    expect(setTourSeen).toHaveBeenCalledTimes(1);
  });

  it('traps focus while open: Tab goes round its buttons, and focus on the page behind comes back into it', async () => {
    const { settings } = memory();
    const a = await app(settings);
    a.send(REVIEW);
    const dialog = screen.getByRole('dialog', { name: 'Start at the top' });
    const next = within(dialog).getByRole('button', { name: 'Next' });
    const skip = within(dialog).getByRole('button', { name: 'Skip' });
    fireEvent.keyDown(next, { key: 'Tab' });
    expect(document.activeElement).toBe(skip);
    fireEvent.keyDown(skip, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(next);
    screen.getByRole('button', { name: 'Settings' }).focus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    press('Skip');
    expect(document.activeElement?.closest('.sheet')).toBeNull();
  });

  it('holds no img, a or script', async () => {
    const { settings } = memory();
    const a = await app(settings);
    a.send(REVIEW);
    for (let step = 1; step <= 3; step++) {
      expect(tour()!.querySelectorAll('img, a, script')).toHaveLength(0);
      if (step < 3) press('Next');
    }
  });
});

describe('the tour and the sheets', () => {
  /** The panel on a review, with the test setting the tour flag as the App would. */
  function mount(extra: Partial<PanelScreenProps> = {}) {
    const props = (more: Partial<PanelScreenProps>): PanelScreenProps => ({ state: REVIEW, dispatch: vi.fn(), ...extra, ...more });
    const view = render(<PanelScreen {...props({})} />);
    return { again: (more: Partial<PanelScreenProps>) => view.rerender(<PanelScreen {...props(more)} />) };
  }

  it('waits for an open dismiss sheet to close, then opens', () => {
    const m = mount();
    // Today's review screen: a finding, then its Dismiss button. Only the opening of the sheet depends on that markup.
    fireEvent.click(screen.getByRole('button', { name: /Problem 1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    m.again({ tourSeen: false });
    expect(tour()).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Start at the top' })).toBeTruthy();
  });

  it('opens only on a finished review with nothing over it, while not seen and not ended', () => {
    const at = { seen: false, ended: false, sheetOpen: false, settingsOpen: false };
    expect(tourMayOpen(REVIEW, at)).toBe(true);
    expect(tourMayOpen(REVIEW, { ...at, sheetOpen: true })).toBe(false);
    expect(tourMayOpen(REVIEW, { ...at, settingsOpen: true })).toBe(false);
    expect(tourMayOpen(REVIEW, { ...at, seen: true })).toBe(false);
    expect(tourMayOpen(REVIEW, { ...at, seen: null })).toBe(false);
    expect(tourMayOpen(REVIEW, { ...at, ended: true })).toBe(false);
    for (const state of [{ kind: 'ready', pr: prSummary() }, running(), { kind: 'offline', review: { pr: REVIEW.pr, latest: REVIEW.latest, stale: false } }, { kind: 'loading' }] as PanelState[]) {
      expect(tourMayOpen(state, at)).toBe(false);
    }
  });

  it('does not open while Settings is open, and opens when it closes', async () => {
    const m = mount();
    await act(async () => { press('Settings'); });
    m.again({ tourSeen: false });
    expect(tour()).toBeNull();
    await act(async () => { press('Back'); });
    expect(screen.getByRole('dialog', { name: 'Start at the top' })).toBeTruthy();
  });

  it('without onTourSeen, Skip still ends it for this panel', () => {
    mount({ tourSeen: false });
    press('Skip');
    expect(tour()).toBeNull();
  });
});
