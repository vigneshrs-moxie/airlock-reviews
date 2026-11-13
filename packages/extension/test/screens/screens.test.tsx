// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelState } from '../../src/state/reduce';
import { PanelScreen } from '../../src/screens/PanelScreen';
import { STAGE_WORDS } from '../../src/state/stage-words';
import { brief, latestFor, map, prSummary, running } from './fixtures';

afterEach(cleanup);

function show(state: PanelState, onOpenSettings = vi.fn()) {
  const dispatch = vi.fn();
  const view = render(<PanelScreen state={state} dispatch={dispatch} onOpenSettings={onOpenSettings} />);
  return { dispatch, onOpenSettings, ...view };
}

const two = { packs: [{ id: 'orbit', title: 'Orbit' }, { id: 'generic', title: 'Generic' }] };

describe('frame', () => {
  it('names Airlock, the connection and a Settings button, with its gear hidden from screen readers, that calls onOpenSettings', () => {
    const { onOpenSettings } = show({ kind: 'ready', pr: prSummary() });
    expect(screen.getByText('Airlock')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Settings' });
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelectorAll('header button')).toHaveLength(1);
    fireEvent.click(button);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
  it('says Not running and Not paired', () => {
    show({ kind: 'offline' });
    expect(screen.getByText('Not running')).toBeTruthy();
    cleanup();
    show({ kind: 'unpaired' });
    expect(screen.getByText('Not paired')).toBeTruthy();
  });
  it('says only what the state proves', () => {
    const pr = prSummary();
    const cases: [PanelState, string | null][] = [
      [{ kind: 'loading' }, 'Checking…'],
      [{ kind: 'no-pr' }, null],
      [{ kind: 'problem', pr: null, message: 'x' }, 'Problem'],
      [{ kind: 'ready', pr }, 'Connected'],
      [running(), 'Connected'],
      [{ kind: 'review', pr, latest: latestFor(pr), stale: false }, 'Connected'],
    ];
    for (const [state, word] of cases) {
      show(state);
      const status = document.querySelector('.status');
      if (word === null) expect(status).toBeNull();
      else expect(status?.textContent).toBe(word);
      cleanup();
    }
  });
  it('loading and no-pr show one line each', () => {
    show({ kind: 'loading' });
    expect(screen.getByText('Looking at this pull request…')).toBeTruthy();
    cleanup();
    show({ kind: 'no-pr' });
    expect(screen.getByText('Open a pull request on GitHub and Airlock will appear here.')).toBeTruthy();
  });
});

describe('offline', () => {
  it('shows the start command with a Copy button and no review controls', () => {
    show({ kind: 'offline' });
    expect(screen.getByText("Airlock's service on this Mac is not running.")).toBeTruthy();
    expect(screen.getByText('npm run service')).toBeTruthy();
    expect(screen.getByText('Airlock checks again every few seconds.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /copy/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
  });
  it('labels the command box with visible text, not an aria-label on the code', () => {
    show({ kind: 'offline' });
    expect(document.querySelector('code')?.hasAttribute('aria-label')).toBe(false);
    expect(screen.getByRole('group', { name: /In the airlock-reviews folder, run:/ })).toBeTruthy();
  });
  it('copies the command, and selects it when copying is refused', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    show({ kind: 'offline' });
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith('npm run service');
    cleanup();
    writeText.mockRejectedValue(new Error('denied'));
    show({ kind: 'offline' });
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    await vi.waitFor(() => expect(window.getSelection()?.toString()).toContain('npm run service'));
  });
  it('shows the kept brief and map of a running review', () => {
    show({ kind: 'offline', progress: { pr: prSummary(), brief, map, startedAt: null } });
    expect(screen.getByText('Adds a totals column.')).toBeTruthy();
    expect(screen.getByText('Data layer')).toBeTruthy();
  });
  it('shows a kept review under one line and no brief or map from a running review', () => {
    const pr = prSummary();
    show({ kind: 'offline', review: { pr, latest: latestFor(pr), stale: false }, progress: { pr, brief, map, startedAt: null } });
    expect(screen.getAllByText('Shown from before the service stopped.')).toHaveLength(1);
    expect(screen.queryByText(/Your last review is kept/)).toBeNull();
    expect(screen.queryByText('Adds a totals column.')).toBeNull();
    expect(screen.queryByText('Data layer')).toBeNull();
  });
});

describe('unpaired', () => {
  it('shows where to get the token and the state message', () => {
    show({ kind: 'unpaired', message: 'That token was refused.' });
    expect(screen.getByText('npm run service -- token')).toBeTruthy();
    expect(screen.getByText('That token was refused.')).toBeTruthy();
  });
  it('keeps the field out of the password manager', () => {
    show({ kind: 'unpaired' });
    const field = screen.getByLabelText('Pairing token') as HTMLInputElement;
    expect(field.getAttribute('type')).toBe('text');
    expect(field.hasAttribute('name')).toBe(false);
    expect(field.closest('form')).toBeNull();
    expect(document.querySelector('form')).toBeNull();
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect(field.getAttribute('spellcheck')).toBe('false');
    expect(field.getAttribute('autocapitalize')).toBe('off');
    expect(field.getAttribute('autocorrect')).toBe('off');
    expect(field.getAttribute('data-1p-ignore')).not.toBeNull();
    expect(field.getAttribute('data-lpignore')).toBe('true');
    expect(field.getAttribute('data-form-type')).toBe('other');
    expect(field.className).toContain('masked');
  });
  it('presses Pair on Enter in the field', () => {
    const { dispatch } = show({ kind: 'unpaired' });
    const field = screen.getByLabelText('Pairing token');
    fireEvent.change(field, { target: { value: 'abc' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'pair', token: 'abc' });
  });
  it('clears the field after Pair and shows the token nowhere else', () => {
    const token = 'a'.repeat(64);
    const { dispatch } = show({ kind: 'unpaired' });
    const field = screen.getByLabelText('Pairing token') as HTMLInputElement;
    fireEvent.change(field, { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'pair', token });
    expect(field.value).toBe('');
    expect(document.body.textContent).not.toContain(token);
    expect(document.body.innerHTML).not.toContain(token);
  });
});

/** The start screen's Packs row opens the pack choice under it. */
const openPacks = (): void => {
  const row = screen.getByRole('button', { name: 'Packs' });
  if (row.getAttribute('aria-expanded') !== 'true') fireEvent.click(row);
};
const reviewButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Review this pull request' });

describe('ready', () => {
  it('names the stage in words', () => {
    const cases: [Partial<ReturnType<typeof prSummary>>, string][] = [
      [{ stage: 'pr1', isOwn: true }, "Your pull request, first stage: your branch into the team's branch."],
      [{ stage: 'pr1', isOwn: false }, "A pull request into the team's branch."],
      [{ stage: 'pr2' }, "Second stage: the team's branch into staging."],
      [{ stage: 'pr3' }, 'Third stage: staging into production.'],
      [{ stage: 'other' }, 'A pull request outside the three stages.'],
    ];
    for (const [over, words] of cases) {
      show({ kind: 'ready', pr: prSummary(over) });
      expect(screen.getByText(words)).toBeTruthy();
      cleanup();
    }
  });
  it('shows the pull request under its label, with one quiet line: repository, number, files and lines', () => {
    show({ kind: 'ready', pr: prSummary({ changedFiles: 3, additions: 10, deletions: 2 }) });
    const card = screen.getByRole('region', { name: 'Add totals' });
    expect(within(card).getByText('Pull request')).toBeTruthy();
    expect(within(card).getByRole('heading', { name: 'Add totals' })).toBeTruthy();
    expect(within(card).getByText('acme/widgets #1 · 3 files · 10 lines added, 2 removed')).toBeTruthy();
    cleanup();
    show({ kind: 'ready', pr: prSummary({ changedFiles: 1, additions: 1, deletions: 0 }) });
    expect(screen.getByText('acme/widgets #1 · 1 file · 1 line added, 0 removed')).toBeTruthy();
  });
  it('preselects the suggested depth in a group of three, and says only the chosen depth\'s line under it', () => {
    show({ kind: 'ready', pr: prSummary({ suggestedDepth: 'deep' }) });
    const group = screen.getByRole('radiogroup', { name: 'Depth' });
    expect(within(group).getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual(['Quick', 'Standard', 'Deep']);
    expect((within(group).getByRole('radio', { name: 'Deep' }) as HTMLInputElement).checked).toBe(true);
    expect((within(group).getByRole('radio', { name: 'Quick' }) as HTMLInputElement).checked).toBe(false);
    const line = screen.getByText('Standard, plus a closer second pass over each layer.');
    expect(group.getAttribute('aria-describedby')).toBe(line.id);
    expect(screen.queryByText('One pass, no second opinion. For small changes.')).toBeNull();
    expect(screen.queryByText('Every finding is challenged before you see it.')).toBeNull();
    fireEvent.click(within(group).getByRole('radio', { name: 'Quick' }));
    expect(screen.getByText('One pass, no second opinion. For small changes.')).toBeTruthy();
    expect(screen.queryByText('Standard, plus a closer second pass over each layer.')).toBeNull();
    fireEvent.click(within(group).getByRole('radio', { name: 'Standard' }));
    expect(screen.getByText('Every finding is challenged before you see it.')).toBeTruthy();
    expect(within(group).getByRole('radio', { name: 'Standard' }).closest('label')?.className).toBe('on');
  });
  it('lists the packs on its Packs row, and opens the pack choice in place under it', () => {
    show({ kind: 'ready', pr: prSummary(two) });
    const row = screen.getByRole('button', { name: 'Packs' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Orbit, Generic').id).toBe(row.getAttribute('aria-describedby'));
    expect(screen.queryByRole('switch')).toBeNull();
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(row.getAttribute('aria-controls') ?? '')?.contains(screen.getByRole('switch', { name: 'Orbit' }))).toBe(true);
    // Still the start screen: the pull request and the button are where they were.
    expect(screen.getByRole('heading', { name: 'Add totals' })).toBeTruthy();
    expect(reviewButton()).toBeTruthy();
    fireEvent.click(row);
    expect(screen.queryByRole('switch')).toBeNull();
  });
  it('names the packs, each with a switch that is on', () => {
    show({ kind: 'ready', pr: prSummary(two) });
    openPacks();
    expect((screen.getByRole('switch', { name: 'Orbit' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('switch', { name: 'Generic' }) as HTMLInputElement).checked).toBe(true);
  });
  it('leaves packIds out when every pack is on, and sends the depth', () => {
    const { dispatch } = show({ kind: 'ready', pr: prSummary({ ...two, suggestedDepth: 'standard' }) });
    fireEvent.click(screen.getByRole('radio', { name: 'Quick' }));
    fireEvent.click(reviewButton());
    expect(dispatch).toHaveBeenCalledWith({ type: 'start', depth: 'quick' });
  });
  it('sends the remaining pack ids when one is off, and the last pack cannot be switched off', () => {
    const { dispatch } = show({ kind: 'ready', pr: prSummary(two) });
    openPacks();
    fireEvent.click(screen.getByRole('switch', { name: 'Orbit' }));
    expect((screen.getByRole('switch', { name: 'Generic' }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('switch', { name: 'Generic' }));
    expect((screen.getByRole('switch', { name: 'Generic' }) as HTMLInputElement).checked).toBe(true);
    // The row says which packs are on, with the choice closed as with it open.
    expect(screen.getByRole('button', { name: 'Packs' }).getAttribute('aria-describedby')).toBe(screen.getByText('Generic', { selector: '.grow > .muted' }).id);
    fireEvent.click(screen.getByRole('button', { name: 'Packs' }));
    fireEvent.click(reviewButton());
    expect(dispatch).toHaveBeenCalledWith({ type: 'start', depth: 'quick', packIds: ['generic'] });
  });
  it('pins the button that starts the review, with the line that says where it runs and that nothing is posted', () => {
    show({ kind: 'ready', pr: prSummary() });
    const bar = screen.getByRole('group', { name: 'Start the review' });
    expect(bar.closest('.ap-pinned')).not.toBeNull();
    const button = within(bar).getByRole('button', { name: 'Review this pull request' });
    expect(button.className).toContain('primary');
    const note = within(bar).getByText('Runs on your Claude login. Nothing is posted to GitHub.');
    expect(button.getAttribute('aria-describedby')).toBe(note.id);
  });
  it('disables Review while busy, and shows a notice over the button', () => {
    show({ kind: 'ready', pr: prSummary(), busy: true, notice: 'Another review is running.' });
    expect(reviewButton().disabled).toBe(true);
    const notice = screen.getByRole('alert');
    expect(notice.textContent).toBe('Another review is running.');
    expect(notice.closest('.ap-pinned')).not.toBeNull();
  });
  it('disables the switches and the depth choice while busy', () => {
    show({ kind: 'ready', pr: prSummary(two), busy: true });
    openPacks();
    for (const box of screen.getAllByRole('switch')) expect((box as HTMLInputElement).disabled).toBe(true);
    for (const radio of screen.getAllByRole('radio')) expect((radio as HTMLInputElement).disabled).toBe(true);
  });
  it('explains the last pack switch that cannot be turned off', () => {
    show({ kind: 'ready', pr: prSummary(two) });
    openPacks();
    expect(screen.queryByText('At least one pack stays on.')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Orbit' }));
    const hint = screen.getByText('At least one pack stays on.');
    const last = screen.getByRole('switch', { name: 'Generic' });
    expect(last.getAttribute('aria-describedby')).toBe(hint.id);
  });
  it('has no last-reviewed link', () => {
    show({ kind: 'ready', pr: prSummary() });
    expect(screen.queryByText(/last reviewed/i)).toBeNull();
  });
});

/** Every stage the engine runs, in order; `lenses-deep` only at deep depth. */
const ENGINE_STAGES = ['intake', 'packs', 'shape', 'facts', 'map', 'brief', 'lenses', 'sweep', 'seams', 'anchor', 'merge', 'challenge', 'lenses-deep', 'select', 'summary', 'store'];
const line = (stage: string, status: 'working' | 'done' | 'failed' | 'skipped' = 'done', detail = '') => ({ stage, words: STAGE_WORDS[stage as keyof typeof STAGE_WORDS] ?? stage, status, detail });
const progressbar = (): HTMLElement => screen.getByRole('progressbar', { name: 'Progress' });
const openSteps = (): HTMLElement => {
  fireEvent.click(screen.getByRole('button', { name: /^Show the steps/ }));
  return screen.getByRole('list', { name: 'Stages' });
};

describe('running', () => {
  it('names the stage now as its title, under the label Reviewing', () => {
    show(running());
    expect(screen.getByRole('heading', { name: 'Reviewing' })).toBeTruthy();
    expect(screen.getByText('Mapping the change', { selector: '.ap-title' })).toBeTruthy();
    cleanup();
    show(running({ stages: [] }));
    expect(screen.getByText('Starting the review', { selector: '.ap-title' })).toBeTruthy();
    expect(progressbar().getAttribute('aria-valuetext')).toBe('Starting the review');
  });
  it('names the stage started last while two run side by side', () => {
    show(running({ stages: [line('intake'), line('lenses', 'working'), line('sweep', 'working')] }));
    expect(screen.getByText('Checking each file against the pack rules', { selector: '.ap-title' })).toBeTruthy();
  });
  it('shows a real progress bar whose value is the step in words, out of the stages the engine runs at that depth', () => {
    show(running({ depth: 'standard' }));
    const bar = progressbar();
    expect(bar.getAttribute('aria-valuetext')).toBe('Step 2 of 15');
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('15');
    expect((bar.querySelector('i') as HTMLElement).style.width).toBe(`${(2 / 15) * 100}%`);
    expect(screen.getByText(/^Step 2 of 15 · /)).toBeTruthy();
    cleanup();
    show(running({ depth: 'quick' }));
    expect(progressbar().getAttribute('aria-valuetext')).toBe('Step 2 of 15');
    cleanup();
    show(running({ depth: 'deep' }));
    expect(progressbar().getAttribute('aria-valuetext')).toBe('Step 2 of 16');
  });
  it('says "Step n" with no total, and shows no share, when it cannot know how many stages there are', () => {
    show(running());
    const bar = progressbar();
    expect(bar.getAttribute('aria-valuetext')).toBe('Step 2');
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar.hasAttribute('aria-valuemax')).toBe(false);
    expect(bar.querySelector('i')).toBeNull();
    expect(bar.className).toContain('unknown');
    expect(screen.getByText(/^Step 2 · /)).toBeTruthy();
    cleanup();
    // A stage this panel has no words for: a newer engine, so the count would be a guess.
    show(running({ depth: 'standard', stages: [line('intake'), line('new-stage', 'working')] }));
    expect(progressbar().getAttribute('aria-valuetext')).toBe('Step 2');
  });
  it('learns the count from the stages reported when it did not choose the depth', () => {
    show(running({ stages: [...ENGINE_STAGES.slice(0, 12).map((s) => line(s)), line('lenses-deep', 'working')] }));
    expect(progressbar().getAttribute('aria-valuetext')).toBe('Step 13 of 16');
    cleanup();
    show(running({ stages: [...ENGINE_STAGES.slice(0, 12).map((s) => line(s)), line('select', 'working')] }));
    expect(progressbar().getAttribute('aria-valuetext')).toBe('Step 13 of 15');
    cleanup();
    // A deep review with no deep pass (a sync merge): the later stage settles it.
    show(running({ depth: 'deep', stages: [...ENGINE_STAGES.slice(0, 12).map((s) => line(s)), line('select', 'working')] }));
    expect(progressbar().getAttribute('aria-valuetext')).toBe('Step 13 of 15');
  });
  it('says the time so far, and the files and groups once the map is known, on one quiet line', () => {
    vi.useFakeTimers();
    try {
      show(running({ depth: 'standard' }));
      expect(screen.getByText('Step 2 of 15 · 0 s')).toBeTruthy();
      act(() => { vi.advanceTimersByTime(130_000); });
      expect(screen.getByText('Step 2 of 15 · 2 min 10 s')).toBeTruthy();
      cleanup();
      show(running({ depth: 'standard', map }));
      expect(screen.getByText('Step 2 of 15 · 0 s · 4 files in 2 groups')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
  it('lists every stage the review will run in a fold, in the engine\'s order, each with Done, Now or Next', () => {
    show(running({ depth: 'standard', stages: [line('intake'), line('packs'), line('shape', 'skipped', 'not a sync merge'), line('facts'), line('map', 'working')] }));
    const fold = screen.getByRole('button', { name: /^Show the steps/ });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(fold.textContent).toContain('15');
    expect(screen.queryByRole('list', { name: 'Stages' })).toBeNull();
    const items = within(openSteps()).getAllByRole('listitem');
    expect(items.map((i) => i.querySelector('.ap-sev')?.textContent)).toEqual(['Done', 'Done', 'Skipped', 'Done', 'Now', ...Array<string>(10).fill('Next')]);
    expect(items.map((i) => i.querySelector('.ap-step-words')?.textContent)).toEqual(
      ENGINE_STAGES.filter((s) => s !== 'lenses-deep').map((s) => STAGE_WORDS[s as keyof typeof STAGE_WORDS]),
    );
    expect(progressbar().getAttribute('aria-valuetext')).toBe('Step 5 of 15');
  });
  it('lists only the stages reported so far when it cannot know the rest', () => {
    show(running());
    expect(screen.getByRole('button', { name: /^Show the steps/ }).textContent).toContain('2');
    const items = within(openSteps()).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual(['DoneReading the pull request', 'NowMapping the change']);
  });
  it('shows a failed stage as failed with its message, and a skipped one as skipped', () => {
    show(running({ stages: [
      { stage: 'lenses', words: 'Looking through each lens', status: 'failed', detail: 'Claude timed out' },
      { stage: 'seams', words: 'Checking where the groups meet', status: 'skipped', detail: 'one group' },
    ] }));
    // Said on the card itself, with the list of steps still closed.
    const card = screen.getByRole('heading', { name: 'Reviewing' }).closest('section')!;
    expect(within(card).getByText('A step failed: Looking through each lens')).toBeTruthy();
    expect(within(card).getAllByText(/^A step failed/)).toHaveLength(1);
    const list = openSteps();
    expect(within(list).getByText('Failed')).toBeTruthy();
    expect(within(list).getByText('Claude timed out')).toBeTruthy();
    expect(within(list).getByText('Skipped')).toBeTruthy();
    cleanup();
    show(running());
    expect(screen.queryByText(/^A step failed/)).toBeNull();
  });
  it('counts the time from when the panel asked for the run, when it knows, not from when the screen appeared', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse('2026-11-12T10:05:00.000Z'));
      show(running({ depth: 'standard', startedAt: Date.parse('2026-11-12T10:00:00.000Z') }));
      expect(screen.getByText('Step 2 of 15 · 5 min')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
  it('shows the brief before the last stage is done, with only unverified claims, under What it has found so far', () => {
    show(running({ brief }));
    const fold = screen.getByRole('button', { name: 'What it has found so far' });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Rounds to cents.')).toBeNull();
    fireEvent.click(fold);
    expect(screen.getByRole('heading', { name: 'What this does' })).toBeTruthy();
    expect(screen.getByText('Rounds to cents.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Claims to check' })).toBeTruthy();
    expect(screen.getByText('Not supported')).toBeTruthy();
    expect(screen.getByText('Unclear')).toBeTruthy();
    expect(screen.getByText('No migration touches old rows.')).toBeTruthy();
    expect(screen.queryByText('Totals are rounded')).toBeNull();
  });
  it('shows nothing of the brief or map before they exist, or when they hold nothing', () => {
    show(running());
    expect(screen.queryByRole('button', { name: 'What it has found so far' })).toBeNull();
    cleanup();
    show(running({ brief: { whatItDoes: [], claims: [{ text: 'Fine', verdict: 'verified', evidence: '' }] }, map: { cohorts: [], standalone: [], links: [] } }));
    expect(screen.queryByRole('button', { name: 'What it has found so far' })).toBeNull();
  });
  it('lists groups in order with their layers and files', () => {
    show(running({ map }));
    fireEvent.click(screen.getByRole('button', { name: 'What it has found so far' }));
    expect(screen.getByRole('heading', { name: 'Read in this order' })).toBeTruthy();
    const text = document.body.textContent ?? '';
    const order = ['Totals', 'Data layer', 'db/001.sql', 'Screens layer', 'src/Cart.tsx', 'src/Totals.tsx', 'Docs', 'Notes layer', 'README.md'];
    let at = -1;
    for (const part of order) {
      const next = text.indexOf(part, at + 1);
      expect(next, part).toBeGreaterThan(at);
      at = next;
    }
  });
  it('announces a status change through one polite region', () => {
    const { rerender, dispatch } = show(running());
    const next = running({ stages: [
      { stage: 'intake', words: 'Reading the pull request', status: 'done', detail: '' },
      { stage: 'map', words: 'Mapping the change', status: 'done', detail: '' },
    ] });
    rerender(<PanelScreen state={next} dispatch={dispatch} onOpenSettings={() => undefined} />);
    const regions = document.querySelectorAll('[aria-live="polite"]');
    expect(regions).toHaveLength(1);
    expect(regions[0]?.textContent).toContain('Mapping the change: Done');
    expect(regions[0]?.closest('.panel')).not.toBeNull();
  });
  it('announces the running step with the word the list of steps uses: Now', () => {
    const { rerender, dispatch } = show(running({ stages: [line('intake')] }));
    rerender(<PanelScreen state={running({ stages: [line('intake'), line('packs', 'working')] })} dispatch={dispatch} onOpenSettings={() => undefined} />);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(`${STAGE_WORDS.packs}: Now`);
    expect(within(openSteps()).getByText(STAGE_WORDS.packs).closest('li')?.querySelector('.ap-sev')?.textContent).toBe('Now');
  });
  it('does not announce a finished review that was there when the panel opened, or one shown read-only', () => {
    const pr = prSummary();
    show({ kind: 'review', pr, latest: latestFor(pr), stale: false });
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('');
    cleanup();
    show({ kind: 'offline', review: { pr, latest: latestFor(pr), stale: false } });
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('');
  });
  it('announces the move to a finished review through the same region', () => {
    const { rerender, dispatch } = show(running());
    const pr = prSummary();
    rerender(<PanelScreen state={{ kind: 'review', pr, latest: latestFor(pr), stale: false }} dispatch={dispatch} onOpenSettings={() => undefined} />);
    const regions = document.querySelectorAll('[aria-live="polite"]');
    expect(regions).toHaveLength(1);
    expect(regions[0]?.textContent).toContain('Review finished.');
  });
});

describe('problem and review', () => {
  it('shows the message and Retry, and dispatches retry', () => {
    const { dispatch } = show({ kind: 'problem', pr: null, message: 'Something broke.', brief, map });
    expect(screen.getByText('Something broke.')).toBeTruthy();
    expect(screen.getByText('Adds a totals column.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'retry' });
  });
  it('Review again is disabled while busy', () => {
    const pr = prSummary();
    show({ kind: 'review', pr, latest: latestFor(pr), stale: false, busy: true });
    fireEvent.click(screen.getByRole('tab', { name: 'More' }));
    expect((screen.getByRole('button', { name: 'Review again' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('text from the state', () => {
  it('shows a pull request\'s and a pack\'s markup as characters on the start screen', () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    show({ kind: 'ready', pr: prSummary({ title: evil, repo: 'acme/widgets', packs: [{ id: 'evil', title: evil }, { id: 'generic', title: 'Generic' }] }), notice: evil });
    openPacks();
    expect(screen.getAllByText(evil, { exact: false }).length).toBeGreaterThanOrEqual(4);
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('a')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });
  it('shows markup and javascript: as characters and builds no script or a element', () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    const js = '[click](javascript:alert(1))';
    show(running({
      pr: prSummary({ title: evil }),
      stages: [{ stage: 'x', words: evil, status: 'failed', detail: js }],
      brief: { whatItDoes: [evil], claims: [{ text: js, verdict: 'unclear', evidence: js }] },
      map: { cohorts: [{ id: 'c', title: evil, summary: '', neighbours: [], inferredLinks: [], layers: [{ id: 'l', title: js, kind: 'data', files: [evil], dependsOn: [], note: '' }] }], standalone: [], links: [] },
    }));
    fireEvent.click(screen.getByRole('button', { name: /^Show the steps/ }));
    fireEvent.click(screen.getByRole('button', { name: 'What it has found so far' }));
    expect(screen.getAllByText(evil, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(js, { exact: false }).length).toBeGreaterThan(0);
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('a')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });
});
