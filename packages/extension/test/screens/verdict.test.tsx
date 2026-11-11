// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fixPrompt, type Finding } from '@airlock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelScreen, type PanelScreenProps } from '../../src/screens/PanelScreen';
import type { PanelState } from '../../src/state/reduce';
import { FakeTimers } from '../helpers/fake-timers';
import { also, dismissal, finding, reviewState, type ReviewOptions } from './review-fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(state: PanelState, extra: Partial<PanelScreenProps> = {}) {
  const dispatch = vi.fn();
  const view = render(<PanelScreen state={state} dispatch={dispatch} onOpenPacks={() => undefined} {...extra} />);
  return { dispatch, ...view };
}

const review = (findings: Finding[], opts: ReviewOptions = {}) => show(reviewState(findings, opts));
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const queryButton = (name: string | RegExp) => screen.queryByRole('button', { name });
const heading = (name: string | RegExp) => screen.getByRole('heading', { name });
const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.finding-card')];
const tick = (title: string) => fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(`${title}$`) }));
const follows = (a: HTMLElement, b: HTMLElement) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

describe('the verdict and the top findings', () => {
  it('shows the verdict first, then the findings in rank order', () => {
    const f = [finding(1, { rank: 3 }), finding(2, { rank: 1 }), finding(3, { rank: 2 }), finding(4, { rank: 5 }), finding(5, { rank: 4 })];
    review(f);
    expect(heading('Approve after fixes')).toBeTruthy();
    expect(screen.getByText('Two things to fix.')).toBeTruthy();
    expect(screen.getByText('Reviewed at ccccccc · Standard · Generic')).toBeTruthy();
    expect(follows(heading('Approve after fixes'), heading('Findings'))).toBe(true);
    expect(cards().map((c) => within(c).getByRole('button').textContent)).toEqual(
      [2, 3, 1, 5, 4].map((n) => expect.stringContaining(`Problem ${n}`)),
    );
  });
  it('words the verdict by the pull request stage', () => {
    const state = reviewState([], { doc: { verdict: { label: 'ready-for-pr2', sentence: 'Nothing found.', counts: { block: 0, fix: 0, ask: 0, note: 0 } } } });
    show({ ...state, latest: { ...state.latest, document: { ...state.latest.document, pr: { ...state.latest.document.pr, stage: 'pr2' } } } });
    expect(heading('Ready for PR #3')).toBeTruthy();
  });
  it('names each pack by title on the reviewed line, and by id when it has no title', () => {
    review([], { doc: { packs: [{ id: 'orbit', version: 'v1' }, { id: 'mystery', version: 'v2' }] } });
    expect(screen.getByText('Reviewed at ccccccc · Standard · Orbit, mystery')).toBeTruthy();
  });
  it('shows a card with a severity word, title, place and source', () => {
    review([finding(1, { severity: 'block', source: { pack: 'orbit', lens: null, ruleId: 'R-7' } })]);
    const card = cards()[0]!;
    expect(within(card).getByText('Block')).toBeTruthy();
    expect(within(card).getByText('Problem 1')).toBeTruthy();
    expect(within(card).getByText('src/file1.ts:10')).toBeTruthy();
    expect(within(card).getByText('From: Orbit · R-7')).toBeTruthy();
    expect(within(card).getByRole('checkbox')).toBeTruthy();
  });
  it('says the line is outside the changed lines for an outside-diff anchor, and shows the path alone when not found', () => {
    review([
      finding(1, { anchor: { status: 'outside-diff', startLine: null, endLine: null } }),
      finding(2, { anchor: { status: 'not-found', startLine: null, endLine: null } }),
    ]);
    expect(screen.getByText('src/file1.ts, outside the changed lines')).toBeTruthy();
    expect(screen.getByText('src/file2.ts')).toBeTruthy();
  });
  it('renumbers the ranks when a top finding is dismissed', () => {
    const f = [finding(1), finding(2), finding(3)];
    review(f, { dismissals: [dismissal(f[0]!)] });
    expect(cards().map((c) => c.querySelector('.rank')?.textContent)).toEqual(['1', '2']);
    expect(cards().map((c) => within(c).getByRole('button').textContent)).toEqual([expect.stringContaining('Problem 2'), expect.stringContaining('Problem 3')]);
  });
  it('renders fifty findings without trouble', () => {
    review(Array.from({ length: 50 }, (_, i) => finding(i + 1)));
    expect(cards()).toHaveLength(50);
  });
});

describe('stage errors, the notice and a stale review', () => {
  it('shows stage errors above the findings, with the group when there is one', () => {
    review([finding(1)], {
      doc: {
        verdict: { label: 'incomplete', sentence: 'The review did not finish.', counts: { block: 0, fix: 1, ask: 0, note: 0 } },
        stageErrors: [{ stage: 'lenses', cohortId: 'c1', message: 'Timed out' }, { stage: 'brief', cohortId: null, message: 'No reply' }],
        map: { cohorts: [{ id: 'c1', title: 'Totals', summary: '', neighbours: [], inferredLinks: [], layers: [] }], standalone: [], links: [] },
      },
    });
    expect(follows(heading('Stage errors'), heading('Findings'))).toBe(true);
    expect(screen.getByText('lenses, Totals: Timed out')).toBeTruthy();
    expect(screen.getByText('brief: No reply')).toBeTruthy();
    expect(heading('Incomplete')).toBeTruthy();
  });
  it('shows the notice under the verdict', () => {
    review([finding(1)], { notice: 'Another review is running.' });
    const note = screen.getByText('Another review is running.');
    expect(follows(heading('Approve after fixes'), note)).toBe(true);
    expect(follows(note, heading('Findings'))).toBe(true);
  });
  it('a stale review shows a banner and Review again starts a review at the document depth', () => {
    const { dispatch } = review([finding(1)], { stale: true, doc: { depth: 'deep' } });
    expect(screen.getByText('This pull request has new commits since this review.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Review again' })).toHaveLength(1);
    fireEvent.click(button('Review again'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'start', depth: 'deep' });
    expect(dispatch.mock.calls[0]![0]).not.toHaveProperty('packIds');
  });
  it('a current review has no banner and Review again at the bottom', () => {
    const { dispatch } = review([finding(1)], { doc: { depth: 'quick' } });
    expect(screen.queryByText(/new commits/)).toBeNull();
    fireEvent.click(button('Review again'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'start', depth: 'quick' });
    expect(follows(heading('Findings'), button('Review again'))).toBe(true);
  });
  it('disables Review again while busy, banner or not', () => {
    review([], { stale: true, busy: true });
    expect((button('Review again') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    review([], { busy: true });
    expect((button('Review again') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the lists around the findings', () => {
  it('keeps Also found collapsed and opens it with one line per finding', () => {
    review([finding(1), also(2, { severity: 'ask' }), also(3)]);
    const toggle = button('Also found');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Problem 2')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const line = screen.getByRole('button', { name: /Problem 2/ });
    expect(line.textContent).toContain('Ask');
    expect(line.textContent).toContain('src/file2.ts:20');
  });
  it('shows questions, whose call and checks after merge, the last numbered', () => {
    review([], {
      doc: {
        questions: [{ text: 'Can a cart be empty?', cohortId: null, source: { pack: 'generic', lens: null, ruleId: null } }],
        whoseCall: ['Expiry belongs to scheduling.'],
        checksAfterMerge: ['Open a swap link.', 'Check one email.'],
      },
    });
    expect(heading('Questions')).toBeTruthy();
    expect(screen.getByText('Can a cart be empty?')).toBeTruthy();
    expect(heading('Whose call')).toBeTruthy();
    expect(screen.getByText('Expiry belongs to scheduling.')).toBeTruthy();
    const checks = heading('Check after merge').closest('section')!;
    expect(checks.querySelector('ol')).not.toBeNull();
    expect(within(checks).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Open a swap link.', 'Check one email.']);
  });
  it('shows the brief, the self-review text with a Copy button, and the map with each file tier', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    review([], {
      doc: {
        brief: { whatItDoes: ['Adds totals.'], claims: [{ text: 'Rounds', verdict: 'unclear', evidence: 'One test.' }] },
        selfReviewText: 'Reviewed with Airlock at ccccccc.',
        files: [
          { path: 'db/001.sql', tier: 'read', reason: '' }, { path: 'src/a.ts', tier: 'skim', reason: '' },
          { path: 'README.md', tier: 'trust', reason: '' }, { path: 'x.lock', tier: 'ignored', reason: '' },
        ],
        map: {
          cohorts: [{ id: 'c', title: 'Totals', summary: '', neighbours: [], inferredLinks: [], layers: [{ id: 'l', title: 'Data', kind: 'data', files: ['db/001.sql', 'src/a.ts', 'README.md', 'x.lock'], dependsOn: [], note: '' }] }],
          standalone: [], links: [],
        },
      },
    });
    expect(heading('What this does')).toBeTruthy();
    expect(heading('Claims to check')).toBeTruthy();
    expect(heading('Text for your pull request')).toBeTruthy();
    expect(screen.getByText('Reviewed with Airlock at ccccccc.')).toBeTruthy();
    fireEvent.click(button('Copy'));
    expect(writeText).toHaveBeenCalledWith('Reviewed with Airlock at ccccccc.');
    await screen.findByRole('button', { name: 'Copied' });
    expect(heading('Read in this order')).toBeTruthy();
    for (const [path, tier] of [['db/001.sql', 'read'], ['src/a.ts', 'skim'], ['README.md', 'trust'], ['x.lock', 'ignored']] as const) {
      const row = screen.getByText(path).closest('li')!;
      expect(within(row).getByText(tier)).toBeTruthy();
    }
  });
  it('lists dismissed findings, collapsed, with the reason, the saved text and Restore', () => {
    const f = [finding(1), finding(2), finding(3)];
    const { dispatch } = review(f, {
      dismissals: [dismissal(f[1]!, { reason: 'intended', text: 'The team wants this.' }), dismissal(f[2]!, { reason: 'not-now' })],
    });
    expect(cards()).toHaveLength(1);
    const toggle = button('Dismissed: 2');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Intended')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('Problem 2')).toBeTruthy();
    expect(screen.getByText('Intended')).toBeTruthy();
    expect(screen.getByText('The team wants this.')).toBeTruthy();
    expect(screen.getByText('Not now')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Restore/ })[0]!);
    expect(dispatch).toHaveBeenCalledWith({ type: 'restore', fingerprint: f[1]!.fingerprint });
  });
  it('disables Restore while busy', () => {
    const f = finding(1);
    review([f], { dismissals: [dismissal(f)], busy: true });
    fireEvent.click(button('Dismissed: 1'));
    expect((screen.getByRole('button', { name: /Restore/ }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows timing for stages that made a model run, with a total row', () => {
    const t = (stage: string, ms: number, agentRuns: number, inputTokens: number, outputTokens: number) => ({ stage, ms, agentRuns, inputTokens, outputTokens, costUsd: null });
    review([], { doc: { timings: [t('intake', 500, 0, 0, 0), t('brief', 2500, 1, 1000, 200), t('lenses', 12000, 4, 5000, 800)] } });
    const toggle = button('Timing');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const rows = within(screen.getByRole('table')).getAllByRole('row').map((r) => r.textContent);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toContain('2.5');
    expect(rows[1]).toContain('1,200');
    expect(rows[3]).toContain('Total');
    expect(rows[3]).toContain('15.0');
    expect(rows[3]).toContain('5');
    expect(rows[3]).toContain('7,000');
    expect(rows.join('|')).not.toContain('Reading the pull request');
  });
  it('shows a section only when it has something in it', () => {
    review([]);
    for (const name of ['Stage errors', 'Findings', 'Questions', 'Whose call', 'Check after merge', 'What this does', 'Claims to check', 'Text for your pull request', 'Read in this order']) {
      expect(screen.queryByRole('heading', { name }), name).toBeNull();
    }
    for (const name of ['Also found', 'Timing', /^Dropped/, /^Dismissed/]) expect(queryButton(name), String(name)).toBeNull();
  });
});

describe('the detail of a finding', () => {
  const full = finding(1, {
    connected: [{ path: 'src/other.ts', line: 7, role: 'caller', quote: 'call();' }, { path: 'src/lib.ts', line: null, role: 'type', quote: '' }],
    wouldBeWrongIf: 'Callers already round.',
  });

  it('opens from a card, shows every part and goes back', () => {
    review([full, finding(2)]);
    fireEvent.click(within(cards()[0]!).getByRole('button'));
    expect(heading('Problem 1')).toBeTruthy();
    expect(document.activeElement).toBe(heading('Problem 1'));
    expect(screen.queryByRole('heading', { name: 'Findings' })).toBeNull();
    for (const name of ['What happens', 'Why', 'Suggested change', 'Also involves', 'Checked', 'Would be wrong if', 'From']) expect(heading(name), name).toBeTruthy();
    expect(screen.getByText('Happens 1.')).toBeTruthy();
    expect(screen.getByText('Change 1.')).toBeTruthy();
    expect(screen.getByText('Checked 1.')).toBeTruthy();
    expect(screen.getByText('Callers already round.')).toBeTruthy();
    expect(screen.getByText('code 1;').closest('pre')).not.toBeNull();
    expect(screen.getByText('Generic · correctness')).toBeTruthy();
    fireEvent.click(button('Back to the review'));
    expect(heading('Findings')).toBeTruthy();
    expect(document.activeElement).toBe(within(cards()[0]!).getByRole('button'));
  });
  it('leaves out an empty part', () => {
    review([finding(1, { wouldBeWrongIf: '', checked: '', suggestedChange: '' })]);
    fireEvent.click(within(cards()[0]!).getByRole('button'));
    for (const name of ['Would be wrong if', 'Checked', 'Suggested change', 'Also involves']) expect(screen.queryByRole('heading', { name }), name).toBeNull();
  });
  it('shows each connected place as a button that calls onJump and shows what it resolved to', async () => {
    const onJump = vi.fn().mockResolvedValue('Jumped to src/other.ts line 7.');
    show(reviewState([full]), { onJump });
    fireEvent.click(within(cards()[0]!).getByRole('button'));
    const place = button(/src\/other\.ts:7/);
    expect(place.textContent).toContain('caller');
    expect(button(/src\/lib\.ts/).textContent).not.toContain(':');
    expect(document.querySelector('a')).toBeNull();
    fireEvent.click(place);
    expect(onJump).toHaveBeenCalledWith({ path: 'src/other.ts', line: 7 });
    expect(await screen.findByText('Jumped to src/other.ts line 7.')).toBeTruthy();
    expect(place.parentElement?.textContent).toContain('Jumped to src/other.ts line 7.');
  });
  it('Jump to line calls onJump with the finding path and start line; the default says it is not connected', async () => {
    const onJump = vi.fn().mockResolvedValue('Done.');
    show(reviewState([full]), { onJump });
    fireEvent.click(within(cards()[0]!).getByRole('button'));
    fireEvent.click(button('Jump to line'));
    expect(onJump).toHaveBeenCalledWith({ path: 'src/file1.ts', line: 10 });
    cleanup();
    review([full]);
    fireEvent.click(within(cards()[0]!).getByRole('button'));
    fireEvent.click(button('Jump to line'));
    expect(await screen.findByText('Jumping is not connected yet.')).toBeTruthy();
  });
  it('Dismiss calls onDismiss with the finding', () => {
    const onDismiss = vi.fn();
    show(reviewState([full]), { onDismiss });
    fireEvent.click(within(cards()[0]!).getByRole('button'));
    fireEvent.click(button('Dismiss'));
    expect(onDismiss).toHaveBeenCalledWith(full);
  });
  it('moves with Previous and Next through the top list then also found, skips dismissed ones and stops at the ends', () => {
    const f = [finding(1), finding(2), finding(3), also(4), also(5)];
    review(f, { dismissals: [dismissal(f[1]!), dismissal(f[3]!)] });
    fireEvent.click(within(cards()[0]!).getByRole('button'));
    expect((button('Previous') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button('Next'));
    expect(heading('Problem 3')).toBeTruthy();
    expect(document.activeElement).toBe(heading('Problem 3'));
    fireEvent.click(button('Next'));
    expect(heading('Problem 5')).toBeTruthy();
    expect((button('Next') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button('Previous'));
    expect(heading('Problem 3')).toBeTruthy();
    fireEvent.click(button('Previous'));
    expect(heading('Problem 1')).toBeTruthy();
  });
  it('opens an also-found finding and returns focus to its line', () => {
    review([finding(1), also(2)]);
    fireEvent.click(button('Also found'));
    fireEvent.click(button(/Problem 2/));
    expect(heading('Problem 2')).toBeTruthy();
    fireEvent.click(button('Back to the review'));
    expect(document.activeElement).toBe(button(/Problem 2/));
  });
  it('copies the fix prompt for this finding alone', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    const state = reviewState([full, finding(2)]);
    show(state);
    fireEvent.click(within(cards()[0]!).getByRole('button'));
    fireEvent.click(button('Copy fix prompt'));
    expect(writeText).toHaveBeenCalledWith(fixPrompt(state.latest.document, [full]));
  });
});

describe('the fix prompt', () => {
  it('shows no bar until a card is ticked, then copies the prompt for the ticked ones in list order', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    const f = [finding(1), finding(2), finding(3)];
    const state = reviewState(f);
    show(state);
    expect(queryButton(/Copy fix prompt/)).toBeNull();
    tick('Problem 3');
    tick('Problem 1');
    fireEvent.click(button('Copy fix prompt for 2 selected'));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(fixPrompt(state.latest.document, [f[0]!, f[2]!]));
    await screen.findByRole('button', { name: 'Copied' });
  });
  it('says Copied for two seconds, then the label again', async () => {
    clipboard(vi.fn().mockResolvedValue(undefined));
    const timers = new FakeTimers();
    show(reviewState([finding(1)]), { timers });
    tick('Problem 1');
    fireEvent.click(button('Copy fix prompt for 1 selected'));
    await screen.findByRole('button', { name: 'Copied' });
    expect(timers.delays()).toContain(2000);
    act(() => timers.fire());
    expect(button('Copy fix prompt for 1 selected')).toBeTruthy();
  });
  it('clears the selection', () => {
    review([finding(1)]);
    tick('Problem 1');
    fireEvent.click(button('Clear'));
    expect(queryButton(/Copy fix prompt/)).toBeNull();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });
  it('leaves a dismissed finding out of the prompt and the selection', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    const f = [finding(1), finding(2)];
    const open = reviewState(f);
    const { rerender } = show(open);
    tick('Problem 1');
    tick('Problem 2');
    rerender(<PanelScreen state={reviewState(f, { dismissals: [dismissal(f[0]!)] })} dispatch={vi.fn()} onOpenPacks={() => undefined} />);
    fireEvent.click(button('Copy fix prompt for 1 selected'));
    const text = writeText.mock.calls[0]![0] as string;
    expect(text).toBe(fixPrompt(open.latest.document, [f[1]!]));
    expect(text).not.toContain('Problem 1');
  });
  it('shows the prompt in a selected box when the clipboard refuses', async () => {
    clipboard(vi.fn().mockRejectedValue(new Error('denied')));
    const f = finding(1);
    const state = reviewState([f]);
    show(state);
    tick('Problem 1');
    fireEvent.click(button('Copy fix prompt for 1 selected'));
    const prompt = fixPrompt(state.latest.document, [f]);
    await waitFor(() => expect(window.getSelection()?.toString()).toBe(prompt));
    expect(queryButton('Copied')).toBeNull();
  });
  it('shows the prompt in a box when there is no clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const f = finding(1);
    const state = reviewState([f]);
    show(state);
    tick('Problem 1');
    fireEvent.click(button('Copy fix prompt for 1 selected'));
    await waitFor(() => expect(window.getSelection()?.toString()).toBe(fixPrompt(state.latest.document, [f])));
  });
  it('announces the count through the frame live region when it changes', () => {
    review([finding(1), finding(2)]);
    const region = document.querySelector('[aria-live="polite"]')!;
    tick('Problem 1');
    expect(region.textContent).toBe('1 selected');
    tick('Problem 2');
    expect(region.textContent).toBe('2 selected');
  });
});

describe('the dropped sheet', () => {
  const dropped = (over: object) => ({
    candidate: { ...finding(9), severity: 'fix' as const, confidence: 'high' as const },
    stage: 'challenge' as const, reason: 'The base already handles it.', refutation: null, ...over,
  });

  it('shows nothing for no dropped findings', () => {
    review([finding(1)]);
    expect(queryButton(/Dropped/)).toBeNull();
  });
  it('opens from Dropped: n with stage, reason and proof, a recorded decision in full', () => {
    const long = 'd'.repeat(400);
    review([], {
      doc: {
        dropped: [
          dropped({ refutation: { path: 'src/base.ts', line: 3, role: 'base', quote: 'q'.repeat(300) } }),
          dropped({ reason: 'A decision covers it.', refutation: { path: 'docs/decisions.md', line: null, role: 'learned', quote: long } }),
          dropped({ stage: 'anchor', reason: 'Not in the diff.' }),
        ],
      },
    });
    fireEvent.click(button('Dropped: 3'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Dropped at challenge: The base already handles it.')).toBeTruthy();
    expect(within(dialog).getByText('Dropped at anchor: Not in the diff.')).toBeTruthy();
    expect(within(dialog).getAllByText('Proof')).toHaveLength(2);
    expect(within(dialog).getByText('src/base.ts:3')).toBeTruthy();
    expect(within(dialog).getByText('before the pull request')).toBeTruthy();
    expect(within(dialog).getByText(`${'q'.repeat(160)}…`)).toBeTruthy();
    expect(within(dialog).getByText('docs/decisions.md')).toBeTruthy();
    expect(within(dialog).getByText('a recorded decision')).toBeTruthy();
    expect(within(dialog).getByText(long)).toBeTruthy();
  });
  it('moves focus in, closes on Escape and gives focus back to the opener', () => {
    review([], { doc: { dropped: [dropped({})] } });
    const opener = button('Dropped: 1');
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it('closes with its labelled close button', () => {
    review([], { doc: { dropped: [dropped({})] } });
    fireEvent.click(button('Dropped: 1'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('offline with a kept review', () => {
  it('shows the review read-only: Review again, Restore and Dismiss are disabled and Copy still works', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    const f = [finding(1), finding(2)];
    const kept = reviewState(f, { dismissals: [dismissal(f[1]!)], stale: true });
    const { dispatch } = show({ kind: 'offline', review: { pr: kept.pr, latest: kept.latest, stale: true } });
    expect(screen.getByText('Shown from before the service stopped.')).toBeTruthy();
    expect(screen.getByText("Airlock's service on this Mac is not running.")).toBeTruthy();
    expect(heading('Approve after fixes')).toBeTruthy();
    expect((button('Review again') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button('Dismissed: 1'));
    expect((button(/Restore/) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(cards()[0]!).getByRole('button'));
    expect((button('Dismiss') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button('Back to the review'));
    tick('Problem 1');
    fireEvent.click(button('Copy fix prompt for 1 selected'));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('text from a review is only ever text', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(1)</script>';
  const js = '[click](javascript:alert(1))';
  const noMarkup = () => { for (const tag of ['script', 'img', 'a']) expect(document.querySelector(tag), tag).toBeNull(); };

  it('on the verdict screen and the dropped sheet', () => {
    const f = finding(1, {
      title: evil, quote: evil, suggestedChange: js, connected: [{ path: 'p.ts', line: 1, role: evil, quote: js }],
    });
    review([f, also(2, { title: js })], {
      doc: {
        verdict: { label: 'approve', sentence: evil, counts: { block: 0, fix: 0, ask: 0, note: 0 } },
        questions: [{ text: evil, cohortId: null, source: { pack: 'generic', lens: null, ruleId: null } }],
        selfReviewText: evil,
        dropped: [{ candidate: finding(7, { title: js }), stage: 'challenge', reason: evil, refutation: { path: js, line: 1, role: 'head', quote: evil } }],
        stageErrors: [{ stage: 'lenses', cohortId: null, message: js }],
      },
    });
    expect(screen.getAllByText(evil).length).toBeGreaterThan(0);
    fireEvent.click(button('Also found'));
    expect(screen.getByText(js, { selector: 'span' })).toBeTruthy();
    fireEvent.click(button('Dropped: 1'));
    expect(screen.getByText(`Dropped at challenge: ${evil}`)).toBeTruthy();
    expect(screen.getByText(evil, { selector: 'pre, code' })).toBeTruthy();
    noMarkup();
    fireEvent.click(button('Close'));
    fireEvent.click(within(cards()[0]!).getByRole('button'));
    expect(screen.getByText(evil, { selector: 'pre, code' })).toBeTruthy();
    expect(screen.getAllByRole('button').some((b) => b.textContent?.includes('p.ts:1') && b.textContent.includes(evil))).toBe(true);
    noMarkup();
  });
});
