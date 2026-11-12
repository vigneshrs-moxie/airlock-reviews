// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, type PanelServices } from '../../src/panel/App';
import { ServiceClient } from '../../src/client/service';
import { PanelScreen, type PanelScreenProps } from '../../src/screens/PanelScreen';
import { startPanel, type PanelState, type UserAction } from '../../src/state/machine';
import { COULD_NOT_REACH_PAGE, notesLine, type NotesState, type PageNotes } from '../../src/state/notes';
import type { NotesResult } from '../../src/state/jump';
import type { SettingsStore } from '../../src/state/settings';
import type { TabWatcher } from '../../src/state/tab';
import { BASE, FakeService, TOKEN, prUrl } from '../helpers/fake-service';
import type { OpenFinding } from '../../src/screens/Verdict';
import type { PostReply } from '../../src/state/reduce';
import { FakeTimers } from '../helpers/fake-timers';
import { previewItem, previewOf } from '../helpers/post-fixtures';
import { prSummary } from './fixtures';
import { dismissal, finding, reviewState } from './review-fixtures';

afterEach(cleanup);

const shown = (placed: number, waiting: number, view: 'classic' | 'react' | null = 'classic', missing: string[] = []): NotesResult =>
  ({ kind: 'shown', placed, waiting, view, missing });
const region = () => document.querySelector('[aria-live="polite"]')!;
const verdictCard = () => document.querySelector<HTMLElement>('.verdict')!;

function show(state: PanelState, extra: Partial<PanelScreenProps> = {}) {
  const timers = new FakeTimers();
  const props = (more: Partial<PanelScreenProps>) => ({ state, dispatch: vi.fn(), onOpenPacks: () => undefined, timers, ...extra, ...more });
  const view = render(<PanelScreen {...props({})} />);
  return { timers, again: (more: Partial<PanelScreenProps>) => view.rerender(<PanelScreen {...props(more)} />) };
}

describe('the notes line under the verdict', () => {
  it('shows the placed and waiting counts, and the missing selectors when the view is not recognised', () => {
    const state = reviewState([finding(1), finding(2), finding(3)], {
      doc: { range: { baseSha: 'a'.repeat(40), headSha: 'c'.repeat(40), kind: 'rereview' }, previous: { reviewId: 'r_0000000000', headSha: 'b'.repeat(40) } },
    });
    const s = show(state, { notesLine: notesLine(shown(3, 0), 0) });
    const line = within(verdictCard()).getByText('3 notes shown in the diff');
    // With the other small lines under the verdict: after the review-of-the-push line, before the reviewed-at line.
    expect(line.previousElementSibling?.textContent).toBe('Review of the push bbbbbbb to ccccccc');
    expect(line.nextElementSibling?.textContent).toMatch(/^Reviewed at/);
    expect(region().textContent).toBe('3 notes shown in the diff');

    s.again({ notesLine: notesLine(shown(2, 1), 0) });
    expect(within(verdictCard()).getByText('2 shown, 1 waiting for their lines to load')).toBeTruthy();
    expect(region().textContent).toBe('2 shown, 1 waiting for their lines to load');
    // Sent again with the same counts: not said again.
    s.again({ notesLine: notesLine(shown(2, 1), 0) });
    expect(region().textContent).toBe('2 shown, 1 waiting for their lines to load');
    expect(s.timers.pending.size).toBe(0);

    const missing = "Notes cannot be shown on this version of GitHub's page (classic-file, react-file, react-toolbar). Jump to line still works.";
    s.again({ notesLine: notesLine(shown(0, 3, null, ['classic-file', 'react-file', 'react-toolbar']), 0) });
    expect(within(verdictCard()).getByText(missing)).toBeTruthy();
    expect(region().textContent).toBe(missing);
    s.again({ notesLine: null });
    expect(within(verdictCard()).queryByText(/notes|shown/)).toBeNull();
  });

  it('offers the reload button with the reload sentence, and reloads only when it is pressed', () => {
    const onReloadNotes = vi.fn();
    show(reviewState([finding(1)]), { notesLine: notesLine({ kind: 'unreached' }, 0), onReloadNotes });
    expect(within(verdictCard()).getByText(COULD_NOT_REACH_PAGE)).toBeTruthy();
    expect(onReloadNotes).not.toHaveBeenCalled();
    fireEvent.click(within(verdictCard()).getByRole('button', { name: 'Reload the GitHub tab' }));
    expect(onReloadNotes).toHaveBeenCalledTimes(1);
  });

  it('shows the line on a review kept from before the service stopped', () => {
    const { pr, latest, stale } = reviewState([finding(1)]);
    show({ kind: 'offline', review: { pr, latest, stale } }, { notesLine: notesLine(shown(1, 0), 0) });
    expect(within(verdictCard()).getByText('1 note shown in the diff')).toBeTruthy();
  });
});

describe('the setting in Settings', () => {
  it('turns notes off and on with Notes in the diff, on by default, and says when it could not be saved', async () => {
    const onShowNotes = vi.fn();
    const s = show({ kind: 'ready', pr: prSummary() }, { showNotes: true, onShowNotes, fetchStatus: () => new Promise(() => undefined) });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Settings' })); });
    const toggle = screen.getByRole('switch', { name: 'Notes in the diff' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    expect(onShowNotes).toHaveBeenCalledWith(false);
    s.again({ showNotes: false, onShowNotes });
    expect((screen.getByRole('switch', { name: 'Notes in the diff' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('switch', { name: 'Notes in the diff' }));
    expect(onShowNotes).toHaveBeenLastCalledWith(true);
    s.again({ showNotes: true, onShowNotes, notesFailed: true });
    const section = screen.getByRole('region', { name: 'On GitHub' });
    expect(within(section).getByRole('alert').textContent).toBe('Airlock could not save that setting.');
    // Not read yet: shown on, and not to be changed until it is known.
    s.again({ showNotes: null, onShowNotes });
    expect((screen.getByRole('switch', { name: 'Notes in the diff' }) as HTMLInputElement).disabled).toBe(true);
  });
});

function fakeStart() {
  let emit: (s: PanelState) => void = () => undefined;
  const start = vi.fn((onState: (s: PanelState) => void) => {
    emit = onState;
    return { dispatch: vi.fn<(a: UserAction) => void>(), stop: vi.fn() };
  });
  return { start, send: (s: PanelState) => act(() => emit(s)) };
}

const settings: SettingsStore = {
  getToken: async () => null, setToken: async () => undefined, getDefaultDepth: async () => null, setDefaultDepth: async () => undefined,
  getShowNotes: async () => true, setShowNotes: async () => undefined,
  getSize: async () => 'm', setSize: async () => undefined, getTourSeen: async () => true, setTourSeen: async () => undefined,
};

/** The App with a fake source of Open in Airlock presses, and fake notes whose line and setting the test sets. */
function app() {
  const f = fakeStart();
  let press: (id: string) => void = () => undefined;
  let notesState: NotesState = { on: true, line: null, failed: false };
  const subscribers = new Set<(s: NotesState) => void>();
  const notes: PageNotes = {
    review: vi.fn(), setShown: vi.fn(), reload: vi.fn(), head: vi.fn(), stop: vi.fn(),
    current: () => notesState,
    subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
  };
  const services: PanelServices = {
    settings, fetchStatus: () => new Promise(() => undefined), notes,
    noteOpen: (open) => { press = open; return () => { press = () => undefined; }; },
  };
  render(<App start={f.start} services={services} />);
  return {
    ...f, notes,
    press: (id: string) => act(() => press(id)),
    setNotes: (next: NotesState) => act(() => { notesState = next; for (const fn of subscribers) fn(next); }),
  };
}

const detailHeading = () => document.querySelector<HTMLElement>('[data-focus="detail"]');

describe('Open in Airlock in the panel', () => {
  it('a note-open message opens that finding and ignores an id that is not in the review', async () => {
    const a = app();
    a.send(reviewState([finding(1), finding(2), finding(3)], { dismissals: [dismissal(finding(3))] }));
    a.press('c_00000009');
    expect(detailHeading()).toBeNull();
    // A dismissed finding is not on screen to open.
    a.press(finding(3).id);
    expect(detailHeading()).toBeNull();
    a.press(finding(2).id);
    expect(detailHeading()?.textContent).toBe('Problem 2');
    a.press(finding(1).id);
    expect(detailHeading()?.textContent).toBe('Problem 1');

    // Over Settings (here its Packs screen): it goes back to the panel to show the finding.
    fireEvent.click(screen.getByRole('button', { name: 'Back to the review' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Settings' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Packs and learned lines' })); });
    expect(document.querySelector('.packs-screen')).not.toBeNull();
    a.press('c_00000009');
    expect(document.querySelector('.packs-screen')).not.toBeNull();
    a.press(finding(2).id);
    expect(document.querySelector('.packs-screen')).toBeNull();
    expect(document.querySelector('.settings-screen')).toBeNull();
    expect(detailHeading()?.textContent).toBe('Problem 2');
  });

  it('an id pressed while the panel is loading opens its finding once the review is on screen, and is dropped otherwise', () => {
    const a = app();
    a.press(finding(2).id);
    a.send(reviewState([finding(1), finding(2)]));
    expect(detailHeading()?.textContent).toBe('Problem 2');
    // A later review does not open it again.
    fireEvent.click(screen.getByRole('button', { name: 'Back to the review' }));
    a.send(reviewState([finding(1), finding(2)], { doc: { id: 'r_0000000002' } }));
    expect(detailHeading()).toBeNull();

    // The first screen after loading is not a review: the id is dropped.
    cleanup();
    const c = app();
    c.press(finding(2).id);
    c.send({ kind: 'ready', pr: prSummary() });
    c.send(reviewState([finding(1), finding(2)]));
    expect(detailHeading()).toBeNull();
  });

  it('gives the Service screen what the page said it recognised when sent notes', async () => {
    const a = app();
    a.send(reviewState([finding(1), finding(2)]));
    a.setNotes({ on: true, line: null, failed: false, page: { view: 'react', missing: ['react-row'] } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Settings' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Service' })); });
    const section = within(screen.getByRole('region', { name: 'GitHub page' }));
    expect(section.getByText('Recognised as the newer view. Selectors that found nothing: react-row.')).toBeTruthy();
  });

  it('feeds the notes line and the setting through the panel', async () => {
    const a = app();
    a.send(reviewState([finding(1)]));
    a.setNotes({ on: true, line: { text: '1 note shown in the diff', reload: false }, failed: false });
    expect(within(verdictCard()).getByText('1 note shown in the diff')).toBeTruthy();
    a.setNotes({ on: true, line: { text: COULD_NOT_REACH_PAGE, reload: true }, failed: false });
    fireEvent.click(screen.getByRole('button', { name: 'Reload the GitHub tab' }));
    expect(a.notes.reload).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Settings' })); });
    fireEvent.click(screen.getByRole('switch', { name: 'Notes in the diff' }));
    expect(a.notes.setShown).toHaveBeenCalledWith(false);
  });
});

describe('Open in Airlock while a sheet is open', () => {
  /** The panel on a review, with the test setting the state and asking for findings as the App would. */
  function mount() {
    const dispatch = vi.fn<(a: UserAction) => void>();
    let state: PanelState = reviewState([finding(1), finding(2)]);
    let asked: OpenFinding | null = null;
    const el = () => <PanelScreen state={state} dispatch={dispatch} onOpenPacks={() => undefined} openFinding={asked} />;
    const view = render(el());
    return {
      dispatch,
      setState: (next: PanelState) => { state = next; view.rerender(el()); },
      ask: (id: string, seq: number) => { asked = { id, seq }; view.rerender(el()); },
    };
  }
  const dialog = () => screen.queryByRole('dialog');
  const textbox = (name: string) => screen.getByRole('textbox', { name }) as HTMLTextAreaElement;

  it('waits for a dismiss sheet to close: the sheet and its draft stay, then the finding opens', () => {
    const m = mount();
    fireEvent.click(screen.getByRole('button', { name: /Problem 1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Wrong' }));
    const line = 'Flagged "Problem 1" in src/file1.ts. Wrong because: the caller checks it first.';
    fireEvent.change(textbox('The line that will be saved to your pack'), { target: { value: line } });
    textbox('The line that will be saved to your pack').focus();
    m.ask(finding(2).id, 1);
    expect(dialog()).not.toBeNull();
    expect(textbox('The line that will be saved to your pack').value).toBe(line);
    expect(document.activeElement).toBe(textbox('The line that will be saved to your pack'));
    expect(detailHeading()?.textContent).toBe('Problem 1');
    fireEvent.click(within(dialog()!).getByRole('button', { name: 'Cancel' }));
    expect(dialog()).toBeNull();
    expect(detailHeading()?.textContent).toBe('Problem 2');
  });

  it('waits for a post sheet to close: the sheet and its edited comment stay, then the finding opens', () => {
    const m = mount();
    fireEvent.click(screen.getByRole('button', { name: /Problem 1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    const action = m.dispatch.mock.calls.at(-1)![0] as Extract<UserAction, { type: 'preview-post' }>;
    const preview = previewOf([previewItem(finding(1))]);
    m.setState({ ...reviewState([finding(1), finding(2)]), post: { ticket: action.ticket, kind: 'preview', preview } as PostReply });
    fireEvent.change(textbox('Comment 1'), { target: { value: 'My own words.' } });
    m.ask(finding(2).id, 1);
    expect(dialog()).not.toBeNull();
    expect(textbox('Comment 1').value).toBe('My own words.');
    expect(detailHeading()?.textContent).toBe('Problem 1');
    fireEvent.click(within(dialog()!).getByRole('button', { name: 'Cancel' }));
    expect(dialog()).toBeNull();
    expect(detailHeading()?.textContent).toBe('Problem 2');
  });
});

describe('the GitHub tab loads again while a sheet is open', () => {
  it('the dismiss sheet stays open with its text while the pull request is read again, and the review is then known as stale', async () => {
    const svc = new FakeService();
    svc.latest.set('acme/widgets#1', reviewState([finding(1), finding(2)], { pr: {} }).latest);
    const listeners = new Set<(url: string | undefined, status?: string) => void>();
    const files = prUrl('acme/widgets', 1, '/files');
    const tab: TabWatcher = {
      current: async () => ({ tabId: 3, url: files }),
      onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    };
    const paired: SettingsStore = { ...settings, getToken: async () => TOKEN };
    const client = new ServiceClient(BASE, () => paired.getToken(), svc.fetch, new FakeTimers(), () => 0);
    const heads: string[] = [];
    const quiet: NotesState = { on: true, line: null, failed: false };
    const notes: PageNotes = {
      review: vi.fn(), setShown: vi.fn(), reload: vi.fn(), stop: vi.fn(), head: (h) => void heads.push(h.state),
      current: () => quiet, subscribe: () => () => undefined,
    };
    let stop = (): void => undefined;
    render(<App
      start={(onState) => { const p = startPanel({ client, tab, settings: paired, onState, timers: new FakeTimers(), notes }); stop = p.stop; return p; }}
      services={{ settings: paired, fetchStatus: () => new Promise(() => undefined), notes }}
    />);
    fireEvent.click(await screen.findByRole('button', { name: /Problem 1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Wrong' }));
    const line = 'Flagged "Problem 1" in src/file1.ts. Wrong because: the caller checks it first.';
    const field = () => screen.getByRole('textbox', { name: 'The line that will be saved to your pack' }) as HTMLTextAreaElement;
    fireEvent.change(field(), { target: { value: line } });
    const reads = svc.calls.filter((c) => c === 'GET /pr').length;

    // The author pushed; the person reloads the GitHub tab.
    svc.addPr(prSummary({ headSha: 'd'.repeat(40) }));
    act(() => { for (const fn of listeners) fn(files, 'loading'); });
    act(() => { for (const fn of listeners) fn(files, 'complete'); });
    await waitFor(() => expect(heads.at(-1)).toBe('known'));
    expect(heads.slice(-2)).toEqual(['reading', 'known']);
    expect(svc.calls.filter((c) => c === 'GET /pr').length).toBe(reads + 1);
    const lastReview = vi.mocked(notes.review).mock.calls.at(-1)?.[0];
    expect(lastReview?.stale).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(field().value).toBe(line);
    stop();
  });
});
