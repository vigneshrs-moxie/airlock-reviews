// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelState } from '../../src/state/reduce';
import { PanelScreen } from '../../src/screens/PanelScreen';
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
  it('shows the size', () => {
    show({ kind: 'ready', pr: prSummary({ changedFiles: 3, additions: 10, deletions: 2 }) });
    expect(screen.getByText('3 files, 12 changed lines')).toBeTruthy();
  });
  it('preselects the suggested depth, with a line for each', () => {
    show({ kind: 'ready', pr: prSummary({ suggestedDepth: 'deep' }) });
    expect((screen.getByRole('radio', { name: /Deep/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /Quick/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText('One pass, no second opinion. For small changes.')).toBeTruthy();
    expect(screen.getByText('Every finding is challenged before you see it.')).toBeTruthy();
    expect(screen.getByText('Standard, plus a closer second pass over each layer.')).toBeTruthy();
  });
  it('names the packs, each with a switch that is on', () => {
    show({ kind: 'ready', pr: prSummary(two) });
    expect((screen.getByRole('switch', { name: 'Orbit' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('switch', { name: 'Generic' }) as HTMLInputElement).checked).toBe(true);
  });
  it('leaves packIds out when every pack is on, and sends the depth', () => {
    const { dispatch } = show({ kind: 'ready', pr: prSummary({ ...two, suggestedDepth: 'standard' }) });
    fireEvent.click(screen.getByRole('radio', { name: /Quick/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'start', depth: 'quick' });
  });
  it('sends the remaining pack ids when one is off, and the last pack cannot be switched off', () => {
    const { dispatch } = show({ kind: 'ready', pr: prSummary(two) });
    fireEvent.click(screen.getByRole('switch', { name: 'Orbit' }));
    expect((screen.getByRole('switch', { name: 'Generic' }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('switch', { name: 'Generic' }));
    expect((screen.getByRole('switch', { name: 'Generic' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'start', depth: 'quick', packIds: ['generic'] });
  });
  it('disables Review while busy, and shows a notice', () => {
    show({ kind: 'ready', pr: prSummary(), busy: true, notice: 'Another review is running.' });
    expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Another review is running.')).toBeTruthy();
  });
  it('disables the switches and the depth choice while busy', () => {
    show({ kind: 'ready', pr: prSummary(two), busy: true });
    for (const box of screen.getAllByRole('switch')) expect((box as HTMLInputElement).disabled).toBe(true);
    for (const radio of screen.getAllByRole('radio')) expect((radio as HTMLInputElement).disabled).toBe(true);
  });
  it('explains the last pack switch that cannot be turned off', () => {
    show({ kind: 'ready', pr: prSummary(two) });
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

describe('running', () => {
  it('lists every stage with its words and a status word', () => {
    show(running());
    expect(screen.getByRole('heading', { name: 'Reviewing' })).toBeTruthy();
    const items = within(screen.getByRole('list', { name: 'Stages' })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Reading the pull request');
    expect(items[0]?.textContent).toContain('Done');
    expect(items[1]?.textContent).toContain('Working');
  });
  it('shows a failed stage as failed with its message, and a skipped one as skipped', () => {
    show(running({ stages: [
      { stage: 'lenses', words: 'Looking through each lens', status: 'failed', detail: 'Claude timed out' },
      { stage: 'seams', words: 'Checking where the groups meet', status: 'skipped', detail: 'one group' },
    ] }));
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Claude timed out')).toBeTruthy();
    expect(screen.getByText('Skipped')).toBeTruthy();
  });
  it('shows the brief before the last stage is done, with only unverified claims', () => {
    show(running({ brief }));
    expect(screen.getByRole('heading', { name: 'What this does' })).toBeTruthy();
    expect(screen.getByText('Rounds to cents.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Claims to check' })).toBeTruthy();
    expect(screen.getByText('Not supported')).toBeTruthy();
    expect(screen.getByText('Unclear')).toBeTruthy();
    expect(screen.getByText('No migration touches old rows.')).toBeTruthy();
    expect(screen.queryByText('Totals are rounded')).toBeNull();
  });
  it('shows nothing of the brief or map before they exist', () => {
    show(running());
    expect(screen.queryByRole('heading', { name: 'What this does' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Read in this order' })).toBeNull();
  });
  it('lists groups in order with their layers and files', () => {
    show(running({ map }));
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
    rerender(<PanelScreen state={next} dispatch={dispatch} onOpenPacks={() => undefined} />);
    const regions = document.querySelectorAll('[aria-live="polite"]');
    expect(regions).toHaveLength(1);
    expect(regions[0]?.textContent).toContain('Mapping the change: Done');
    expect(regions[0]?.closest('.panel')).not.toBeNull();
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
    rerender(<PanelScreen state={{ kind: 'review', pr, latest: latestFor(pr), stale: false }} dispatch={dispatch} onOpenPacks={() => undefined} />);
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
  it('shows markup and javascript: as characters and builds no script or a element', () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    const js = '[click](javascript:alert(1))';
    show(running({
      pr: prSummary({ title: evil }),
      stages: [{ stage: 'x', words: evil, status: 'failed', detail: js }],
      brief: { whatItDoes: [evil], claims: [{ text: js, verdict: 'unclear', evidence: js }] },
      map: { cohorts: [{ id: 'c', title: evil, summary: '', neighbours: [], inferredLinks: [], layers: [{ id: 'l', title: js, kind: 'data', files: [evil], dependsOn: [], note: '' }] }], standalone: [], links: [] },
    }));
    expect(screen.getAllByText(evil, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(js, { exact: false }).length).toBeGreaterThan(0);
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('a')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });
});
