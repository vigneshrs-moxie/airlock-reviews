// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelState } from '../../src/state/reduce';
import { PanelScreen } from '../../src/screens/PanelScreen';
import { brief, latestFor, map, prSummary, running } from './fixtures';

afterEach(cleanup);

function show(state: PanelState, onOpenPacks = vi.fn()) {
  const dispatch = vi.fn();
  const view = render(<PanelScreen state={state} dispatch={dispatch} onOpenPacks={onOpenPacks} />);
  return { dispatch, onOpenPacks, ...view };
}

const two = { packs: [{ id: 'orbit', title: 'Orbit' }, { id: 'generic', title: 'Generic' }] };

describe('frame', () => {
  it('names Airlock, the connection and a Packs button that calls onOpenPacks', () => {
    const { onOpenPacks } = show({ kind: 'ready', pr: prSummary() });
    expect(screen.getByText('Airlock')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Packs' }));
    expect(onOpenPacks).toHaveBeenCalledTimes(1);
  });
  it('says Not running and Not paired', () => {
    show({ kind: 'offline' });
    expect(screen.getByText('Not running')).toBeTruthy();
    cleanup();
    show({ kind: 'unpaired' });
    expect(screen.getByText('Not paired')).toBeTruthy();
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
  it('says the last review is kept when it holds one', () => {
    const pr = prSummary();
    show({ kind: 'offline', review: { pr, latest: latestFor(pr), stale: false } });
    expect(screen.getByText('Your last review is kept and will come back when the service does.')).toBeTruthy();
  });
});

describe('unpaired', () => {
  it('shows where to get the token and the state message', () => {
    show({ kind: 'unpaired', message: 'That token was refused.' });
    expect(screen.getByText('npm run service -- token')).toBeTruthy();
    expect(screen.getByText('That token was refused.')).toBeTruthy();
    expect(screen.getByLabelText('Pairing token').getAttribute('type')).toBe('password');
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
  it('the review placeholder shows the title and Review again', () => {
    const pr = prSummary({ title: 'Add totals' });
    const { dispatch } = show({ kind: 'review', pr, latest: latestFor(pr), stale: false });
    expect(screen.getByText('Add totals')).toBeTruthy();
    expect(screen.getByText('Review finished.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review again' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'start', depth: pr.suggestedDepth });
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
  it('shows a pull request title with markup as characters on the placeholder', () => {
    const pr = prSummary({ title: '<script>x</script>' });
    show({ kind: 'review', pr, latest: latestFor(pr), stale: false });
    expect(screen.getByText('<script>x</script>')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
  });
});
