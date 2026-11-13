// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fixPrompt, type Finding } from '@airlock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetFindingFolds } from '../../src/screens/finding-folds';
import { PanelScreen, type PanelScreenProps } from '../../src/screens/PanelScreen';
import type { PanelState } from '../../src/state/reduce';
import type { JumpResult } from '../../src/state/jump';
import { FakeTimers } from '../helpers/fake-timers';
import { also, dismissal, finding, reviewState, type ReviewOptions } from './review-fixtures';
import { chooseTab, fold, foldSection, openFold, queryFold, rows, strip, tab, tick } from './review-dom';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  forgetFindingFolds();
});

function show(state: PanelState, extra: Partial<PanelScreenProps> = {}) {
  const dispatch = vi.fn();
  const view = render(<PanelScreen state={state} dispatch={dispatch} onOpenSettings={() => undefined} {...extra} />);
  return { dispatch, ...view };
}

const review = (findings: Finding[], opts: ReviewOptions = {}) => show(reviewState(findings, opts));
/** The pull request a jump is for: the reviewed one, at the reviewed commit. */
const REVIEWED = expect.objectContaining({ repo: 'acme/widgets', number: 1, headSha: 'c'.repeat(40) });
const NO_RELOAD = { reload: false };
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const queryButton = (name: string | RegExp) => screen.queryByRole('button', { name });
const heading = (name: string | RegExp) => screen.getByRole('heading', { name });
const cards = rows;
const openRow = (i = 0) => fireEvent.click(within(cards()[i]!).getByRole('button'));
const follows = (a: HTMLElement, b: HTMLElement) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const chipTexts = (label: string): string[] =>
  [...(strip().querySelector(`[aria-label="${label}"]`)?.querySelectorAll('li') ?? [])].map((li) => li.textContent ?? '');
const NO_COUNTS = { block: 0, fix: 0, ask: 0, note: 0 };

function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

describe('the verdict strip', () => {
  it('shows the verdict, its sentence and the quiet line first, then the tabs, then the findings in rank order', () => {
    const f = [finding(1, { rank: 3 }), finding(2, { rank: 1 }), finding(3, { rank: 2 }), finding(4, { rank: 5 }), finding(5, { rank: 4 })];
    review(f);
    expect(heading('Approve after fixes')).toBeTruthy();
    expect(within(strip()).getByText('Two things to fix.')).toBeTruthy();
    expect(within(strip()).getByText('Reviewed at ccccccc · Standard')).toBeTruthy();
    expect(follows(heading('Approve after fixes'), screen.getByRole('tablist'))).toBe(true);
    expect(cards().map((c) => within(c).getByRole('button').textContent)).toEqual(
      [2, 3, 1, 5, 4].map((n) => expect.stringContaining(`Problem ${n}`)),
    );
  });
  it('words the verdict by the pull request stage', () => {
    const state = reviewState([], { doc: { verdict: { label: 'ready-for-pr2', sentence: 'Nothing found.', counts: NO_COUNTS } } });
    show({ ...state, latest: { ...state.latest, document: { ...state.latest.document, pr: { ...state.latest.document.pr, stage: 'pr2' } } } });
    expect(heading('Ready to merge')).toBeTruthy();
  });
  it.each([
    ['one of each kind', [finding(1, { severity: 'block' }), finding(2, { severity: 'fix' }), finding(3, { severity: 'ask' }), also(4)], ['1 blocking', '1 to fix', '1 question', '1 note'], 'sev-block'],
    ['several fixes and questions', [finding(1), finding(2), finding(3), finding(4, { severity: 'ask' }), finding(5, { severity: 'ask' })], ['3 to fix', '2 questions'], 'sev-fix'],
    ['questions and notes only', [finding(1, { severity: 'ask' }), also(2), also(3), also(4)], ['1 question', '3 notes'], 'sev-ask'],
    ['notes only', [also(1)], ['1 note'], 'sev-note'],
    ['two blocking', [finding(1, { severity: 'block' }), finding(2, { severity: 'block' })], ['2 blocking'], 'sev-block'],
  ])('counts the open findings by kind, worst first, and colours the verdict by the worst: %s', (_name, findings, chips, tone) => {
    review(findings);
    expect(chipTexts('Finding counts')).toEqual(chips);
    expect(heading('Approve after fixes').className).toContain(tone);
  });
  it('leaves dismissed findings out of the kinds and counts them in a quiet chip of their own, and shows no chips when there is nothing', () => {
    const f = [finding(1), finding(2, { severity: 'ask' }), also(3)];
    review(f, { dismissals: [dismissal(f[1]!), dismissal(f[2]!)] });
    expect(chipTexts('Finding counts')).toEqual(['1 to fix', '2 dismissed']);
    expect(within(strip()).getByText('2 dismissed').className).toContain('ap-chip-quiet');
    cleanup();
    review(f, { dismissals: f.map((x) => dismissal(x)) });
    expect(chipTexts('Finding counts')).toEqual(['3 dismissed']);
    cleanup();
    review([]);
    expect(strip().querySelector('[aria-label="Finding counts"]')).toBeNull();
  });
  const APPROVE = { label: 'approve' as const, sentence: 'Nothing that needs fixing was found.', counts: NO_COUNTS };
  it('is green only for a clean approve: an approving label, nothing open, no question, stage error, limit or note, and not stale', () => {
    review([], { doc: { verdict: APPROVE } });
    expect(heading('Approve').className).toContain('sev-ok');
    const notClear: [string, ReviewOptions][] = [
      ['a note', { doc: { verdict: APPROVE, notes: ['Nothing in this pull request was read closely: all 3 changed files are of kinds Airlock trusts.'] } }],
      ['a limit', { doc: { verdict: APPROVE, limits: ['82 of 673 changed lines were cut.'] } }],
      ['a stage error', { doc: { verdict: APPROVE, stageErrors: [{ stage: 'brief', cohortId: null, message: 'No reply' }] } }],
      ['a stale review', { doc: { verdict: APPROVE }, stale: true }],
      ['a question', { doc: { verdict: APPROVE, questions: [{ text: '12 changed names were not searched for callers because the pull request is very large.', cohortId: null }] } }],
    ];
    for (const [name, opts] of notClear) {
      cleanup();
      review([], opts);
      expect(heading('Approve').className, name).not.toMatch(/sev-/);
    }
    // Not an approving label, with nothing open (every fix dismissed): the engine's words, plain.
    cleanup();
    const f = finding(1);
    review([f], { dismissals: [dismissal(f)] });
    expect(heading('Approve after fixes').className).not.toMatch(/sev-/);
    // Something open: the worst open kind, whatever the label.
    cleanup();
    review([also(2)], { doc: { verdict: APPROVE } });
    expect(heading('Approve').className).toContain('sev-note');
  });
  it('opens Questions for the author under The change from the start, as the review is first shown', () => {
    review([], { doc: { verdict: APPROVE, questions: [{ text: 'The review kit could not be refreshed.', cohortId: null }] } });
    chooseTab('The change');
    expect(fold('Questions for the author').getAttribute('aria-expanded')).toBe('true');
    expect(within(foldSection('Questions for the author')).getByText('The review kit could not be refreshed.')).toBeTruthy();
  });
  it('keeps the verdict in words for a review that did not finish, with no colour claiming it is clear', () => {
    review([], { doc: { verdict: { label: 'incomplete', sentence: 'It stopped.', counts: NO_COUNTS } } });
    expect(heading('Review incomplete').className).not.toMatch(/sev-/);
  });
  it('names each pack by title on the More tab\'s line, and by id when it has no title', () => {
    review([], { doc: { packs: [{ id: 'orbit', version: 'v1' }, { id: 'mystery', version: 'v2' }] } });
    chooseTab('More');
    expect(screen.getByText('Reviewed at ccccccc · Standard depth · Packs: Orbit, mystery')).toBeTruthy();
  });
});

describe('the rows', () => {
  it('shows a row with the kind as a word, the title and the place, and no checkbox until Select', () => {
    review([finding(1, { severity: 'block', source: { pack: 'orbit', lens: null, ruleId: 'R-7' } })]);
    const card = cards()[0]!;
    expect(within(card).getByText('Block')).toBeTruthy();
    expect(within(card).getByText('Problem 1')).toBeTruthy();
    expect(within(card).getByText('src/file1.ts:10')).toBeTruthy();
    expect(within(card).queryByRole('checkbox')).toBeNull();
    expect(within(card).getAllByRole('button')).toHaveLength(1);
  });
  it.each([['block', 'Block'], ['fix', 'Fix'], ['ask', 'Ask'], ['note', 'Note']] as const)('words the kind %s as %s', (severity, word) => {
    review([finding(1, { severity })]);
    expect(within(cards()[0]!).getByText(word).className).toContain(`sev-${severity}`);
  });
  it('titles a row with the short title when the review has one, and the finding shows its full title under What happens', () => {
    review([finding(1, { title: 'The totals module rounds each line before adding them up', short: 'Totals can be a cent off' })]);
    expect(within(cards()[0]!).getByText('Totals can be a cent off')).toBeTruthy();
    expect(within(cards()[0]!).queryByText(/rounds each line/)).toBeNull();
    openRow();
    expect(heading('Totals can be a cent off')).toBeTruthy();
    openFold('What happens');
    expect(screen.getByText('The totals module rounds each line before adding them up')).toBeTruthy();
  });
  it('cuts a 141-character title at a word when there is no short title, and the finding keeps it whole under What happens', () => {
    const title = 'The totals module rounds each line before adding them, so an order of many small items can be a cent or more off the amount the customer pays';
    expect([...title]).toHaveLength(141);
    review([finding(1, { title })]);
    expect(within(cards()[0]!).getByText('The totals module rounds each line before adding them, so…')).toBeTruthy();
    openRow();
    expect(heading('The totals module rounds each line before adding them, so…')).toBeTruthy();
    openFold('What happens');
    expect(screen.getByText(title)).toBeTruthy();
  });
  it('says the line is outside the changed lines for an outside-diff anchor, and shows the path alone when not found', () => {
    review([
      finding(1, { anchor: { status: 'outside-diff', startLine: null, endLine: null } }),
      finding(2, { anchor: { status: 'not-found', startLine: null, endLine: null } }),
    ]);
    expect(screen.getByText('src/file1.ts, outside the changed lines')).toBeTruthy();
    expect(screen.getByText('src/file2.ts')).toBeTruthy();
  });
  it('shows no status on a first review\'s rows', () => {
    review([finding(1, { status: 'new' })]);
    expect(screen.queryByTestId('status')).toBeNull();
  });
  it('drops a dismissed top finding from the rows', () => {
    const f = [finding(1), finding(2), finding(3)];
    review(f, { dismissals: [dismissal(f[0]!)] });
    expect(cards().map((c) => within(c).getByRole('button').textContent)).toEqual([expect.stringContaining('Problem 2'), expect.stringContaining('Problem 3')]);
  });
  it('renders fifty findings without trouble', () => {
    review(Array.from({ length: 50 }, (_, i) => finding(i + 1)));
    expect(cards()).toHaveLength(50);
  });
});

describe('the tabs', () => {
  it('are Findings with the count of open findings, The change and More; Findings is chosen first', () => {
    const f = [finding(1), finding(2), also(3), also(4)];
    review(f, { dismissals: [dismissal(f[1]!)] });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Findings · 3', 'The change', 'More']);
    expect(tab('Findings').getAttribute('aria-selected')).toBe('true');
    expect(tab('More').getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tab('Findings').id);
  });
  it('count zero when nothing is open', () => {
    review([]);
    expect(tab('Findings').textContent).toBe('Findings · 0');
  });
  it('show one panel at a time', () => {
    review([finding(1)], { doc: { selfReviewText: 'Self-review.' } });
    expect(cards()).toHaveLength(1);
    chooseTab('The change');
    expect(cards()).toHaveLength(0);
    expect(fold('Text for your pull request')).toBeTruthy();
    chooseTab('More');
    expect(button('Review again')).toBeTruthy();
    expect(queryFold('Text for your pull request')).toBeNull();
  });
  it('move with the arrow keys, wrapping at the ends, and with Home and End; only the chosen tab is in the Tab order', () => {
    review([finding(1)]);
    const findings = tab('Findings');
    findings.focus();
    expect(findings.tabIndex).toBe(0);
    expect(tab('More').tabIndex).toBe(-1);
    fireEvent.keyDown(findings, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('The change'));
    expect(tab('The change').getAttribute('aria-selected')).toBe('true');
    expect(tab('The change').tabIndex).toBe(0);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('More'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('Findings'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tab('More'));
    expect(button('Review again')).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(tab('Findings'));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(tab('More'));
  });
  it('keep the chosen tab while a finding is open and after Back', () => {
    review([finding(1)], { doc: { dropped: [{ candidate: finding(9), stage: 'merge', reason: 'Same.', refutation: null, mergedInto: 'c_00000001' }] } });
    chooseTab('More');
    fireEvent.click(button('Dropped: 1'));
    fireEvent.click(button('Show the finding it was merged into'));
    expect(heading('Problem 1')).toBeTruthy();
    fireEvent.click(button('Back to the review'));
    expect(tab('More').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(button('Dropped: 1'));
  });
});

describe('under the strip, before any tab', () => {
  it('shows stage errors without a tab being pressed, with the group when there is one', () => {
    review([finding(1)], {
      doc: {
        verdict: { label: 'incomplete', sentence: 'The review did not finish.', counts: { block: 0, fix: 1, ask: 0, note: 0 } },
        stageErrors: [{ stage: 'lenses', cohortId: 'c1', message: 'Timed out' }, { stage: 'brief', cohortId: null, message: 'No reply' }],
        map: { cohorts: [{ id: 'c1', title: 'Totals', summary: '', neighbours: [], inferredLinks: [], layers: [] }], standalone: [], links: [] },
      },
    });
    expect(follows(strip(), heading('Stage errors'))).toBe(true);
    expect(follows(heading('Stage errors'), screen.getByRole('tablist'))).toBe(true);
    expect(screen.getByText('Totals. Failed while reading the code: Timed out')).toBeTruthy();
    expect(screen.getByText('Failed when working out what the pull request does: No reply')).toBeTruthy();
    expect(heading('Review incomplete')).toBeTruthy();
    for (const name of ['The change', 'More'] as const) {
      chooseTab(name);
      expect(heading('Stage errors')).toBeTruthy();
    }
  });
  it('shows the notice under the strip, before the tabs', () => {
    review([finding(1)], { notice: 'Another review is running.' });
    const note = screen.getByText('Another review is running.');
    expect(follows(strip(), note)).toBe(true);
    expect(follows(note, screen.getByRole('tablist'))).toBe(true);
  });
  it('a stale review shows a banner whose Review everything again starts a review at the document depth', () => {
    const { dispatch } = review([finding(1)], { stale: true, doc: { depth: 'deep' } });
    expect(follows(strip(), screen.getByText('New commits since this review.'))).toBe(true);
    expect(follows(screen.getByText('New commits since this review.'), screen.getByRole('tablist'))).toBe(true);
    chooseTab('More');
    expect(screen.getAllByRole('button', { name: 'Review everything again' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Review again' })).toBeNull();
    fireEvent.click(button('Review everything again'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'start', depth: 'deep' });
    expect(dispatch.mock.calls[0]![0]).not.toHaveProperty('packIds');
  });
  it('a current review has no banner and Review again on the More tab', () => {
    const { dispatch } = review([finding(1)], { doc: { depth: 'quick' } });
    expect(screen.queryByText(/new commits/)).toBeNull();
    expect(queryButton('Review again')).toBeNull();
    chooseTab('More');
    fireEvent.click(button('Review again'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'start', depth: 'quick' });
  });
  it('disables Review again while busy, banner or not', () => {
    review([], { stale: true, busy: true });
    expect((button('Review everything again') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    review([], { busy: true });
    chooseTab('More');
    expect((button('Review again') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the findings tab\'s folds', () => {
  it('keeps Also found collapsed with its count, and opens it with one row per finding', () => {
    review([finding(1), also(2, { severity: 'ask' }), also(3)]);
    const toggle = fold('Also found');
    expect(toggle.textContent).toContain('2');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Problem 2')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const line = screen.getByRole('button', { name: /Problem 2/ });
    expect(line.textContent).toContain('Ask');
    expect(line.textContent).toContain('src/file2.ts:20');
  });
});

describe('the change tab', () => {
  const full = {
    brief: { whatItDoes: ['Adds totals.', 'Rounds to cents.'], claims: [{ text: 'Rounds', verdict: 'unclear' as const, evidence: 'One test.' }] },
    questions: [{ text: 'Can a cart be empty?', cohortId: null, source: { pack: 'generic', lens: null, ruleId: null } }],
    whoseCall: ['Expiry belongs to scheduling.'],
    checksAfterMerge: ['Open a swap link.', 'Check one email.'],
    selfReviewText: 'Reviewed with Airlock at ccccccc.',
    files: [
      { path: 'db/001.sql', tier: 'read' as const, reason: '' }, { path: 'src/a.ts', tier: 'skim' as const, reason: '' },
      { path: 'README.md', tier: 'trust' as const, reason: '' }, { path: 'x.lock', tier: 'ignored' as const, reason: '' },
    ],
    map: {
      cohorts: [{ id: 'c', title: 'Totals', summary: '', neighbours: [], inferredLinks: [], layers: [{ id: 'l', title: 'Data', kind: 'data' as const, files: ['db/001.sql', 'src/a.ts', 'README.md', 'x.lock'], dependsOn: [], note: '' }] }],
      standalone: [], links: [],
    },
  };

  it('leads with In short from the review\'s own sentence', () => {
    review([], { doc: { ...full, brief: { ...full.brief, inShort: 'Adds a totals column to the cart.' } } });
    chooseTab('The change');
    expect(heading('In short')).toBeTruthy();
    expect(screen.getByText('Adds a totals column to the cart.')).toBeTruthy();
  });
  it('falls back to the first thing it does when there is no in-short sentence, and leaves In short out when there is neither', () => {
    review([], { doc: full });
    chooseTab('The change');
    expect(heading('In short').nextElementSibling?.textContent).toBe('Adds totals.');
    cleanup();
    review([], { doc: { selfReviewText: 'x' } });
    chooseTab('The change');
    expect(screen.queryByRole('heading', { name: 'In short' })).toBeNull();
  });
  it('folds each part with its count, in order, under Before you merge', () => {
    review([], { doc: full });
    chooseTab('The change');
    const titles = ['What it does', 'Questions for the author', 'Whose call', 'Check after merge', 'Text for your pull request', 'Files'];
    expect(titles.map((t) => fold(t).textContent)).toEqual([
      'What it does 3 points', 'Questions for the author 1', 'Whose call 1', 'Check after merge 2 steps', 'Text for your pull request copy', 'Files 4',
    ]);
    // Questions for the author starts open (the engine writes its own limits there); the rest start closed.
    for (const t of titles) expect(fold(t).getAttribute('aria-expanded'), t).toBe(t === 'Questions for the author' ? 'true' : 'false');
    const before = heading('Before you merge');
    expect(follows(fold('What it does'), before)).toBe(true);
    expect(follows(before, fold('Questions for the author'))).toBe(true);
  });
  it('opens the brief with its claims, the questions, whose call and checks after merge, the last numbered', () => {
    review([], { doc: full });
    chooseTab('The change');
    openFold('What it does');
    expect(within(foldSection('What it does')).getByText('Rounds to cents.')).toBeTruthy();
    expect(heading('Claims to check')).toBeTruthy();
    expect(screen.getByText('Unclear')).toBeTruthy();
    openFold('Questions for the author');
    expect(screen.getByText('Can a cart be empty?')).toBeTruthy();
    openFold('Whose call');
    expect(screen.getByText('Expiry belongs to scheduling.')).toBeTruthy();
    const checks = foldSection(openFold('Check after merge').textContent!.replace(/ 2 steps$/, ''));
    expect(checks.querySelector('ol')).not.toBeNull();
    expect(within(checks.querySelector('ol')!).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Open a swap link.', 'Check one email.']);
  });
  it('copies the text for the pull request, and shows the map with each file tier', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    review([], { doc: full });
    chooseTab('The change');
    openFold('Text for your pull request');
    expect(screen.getByText('Reviewed with Airlock at ccccccc.')).toBeTruthy();
    fireEvent.click(button('Copy'));
    expect(writeText).toHaveBeenCalledWith('Reviewed with Airlock at ccccccc.');
    await screen.findByRole('button', { name: 'Copied' });
    openFold('Files');
    expect(heading('Read in this order')).toBeTruthy();
    for (const [path, tier] of [['db/001.sql', 'read'], ['src/a.ts', 'skim'], ['README.md', 'trust'], ['x.lock', 'ignored']] as const) {
      const row = screen.getByText(path).closest('li')!;
      expect(within(row).getByText(tier)).toBeTruthy();
    }
  });
  it('keeps a fold open across a tab change', () => {
    review([finding(1)], { doc: full });
    chooseTab('The change');
    openFold('Whose call');
    chooseTab('Findings');
    chooseTab('The change');
    expect(fold('Whose call').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('the more tab', () => {
  it('lists dismissed findings, collapsed with their count, with the reason, the saved text and Restore', () => {
    const f = [finding(1), finding(2), finding(3)];
    const { dispatch } = review(f, {
      dismissals: [dismissal(f[1]!, { reason: 'intended', text: 'The team wants this.' }), dismissal(f[2]!, { reason: 'not-now' })],
    });
    expect(cards()).toHaveLength(1);
    chooseTab('More');
    const toggle = fold('Dismissed');
    expect(toggle.textContent).toBe('Dismissed 2');
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
    chooseTab('More');
    // With every finding dismissed the fold is already open.
    expect((screen.getByRole('button', { name: /Restore/ }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows timing for stages that made a model run, with a total row', () => {
    const t = (stage: string, ms: number, agentRuns: number, inputTokens: number, outputTokens: number) => ({ stage, ms, agentRuns, inputTokens, outputTokens, costUsd: null });
    review([], { doc: { timings: [t('intake', 500, 0, 0, 0), t('brief', 2500, 1, 1000, 200), t('lenses', 12000, 4, 5000, 800), t('store', 0, 0, 0, 0)] } });
    chooseTab('More');
    const toggle = fold('Timing');
    expect(toggle.textContent).toBe('Timing 3 steps');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const cells = within(screen.getByRole('table')).getAllByRole('row').map((r) => [...r.querySelectorAll('th, td')].map((c) => c.textContent));
    expect(cells).toEqual([
      ['Stage', 'Seconds', 'Runs', 'Tokens'],
      ['Reading the pull request', '0.5', '–', '–'],
      ['Working out what the pull request does', '2.5', '1', '1,200'],
      ['Looking through each lens', '12.0', '4', '5,800'],
      ['Total', '15.0', '5', '7,000'],
    ]);
  });
  it('holds neither what the reviewer was not shown nor the notes: they are above the tabs', () => {
    for (const previous of [undefined, { reviewId: 'r_0000000000', headSha: 'a'.repeat(40) }]) {
      review([finding(1)], { doc: { notes: ['One note.'], limits: ['A limit.'], ...(previous === undefined ? {} : { previous }) } });
      chooseTab('More');
      const more = screen.getByRole('tabpanel');
      expect(within(more).queryByText('One note.')).toBeNull();
      expect(within(more).queryByText('A limit.')).toBeNull();
      expect(within(more).queryByRole('button', { name: /Not shown|Notes|About this review/ })).toBeNull();
      cleanup();
    }
  });
  it('gives the review\'s total time on its quiet line when the timings say', () => {
    const t = (stage: string, startedAt: string, finishedAt: string) => ({ stage, ms: 1000, agentRuns: 1, inputTokens: 1, outputTokens: 1, costUsd: null, startedAt, finishedAt });
    review([], { doc: { timings: [t('intake', '2026-11-12T10:00:00.000Z', '2026-11-12T10:00:30.000Z'), t('lenses', '2026-11-12T10:00:20.000Z', '2026-11-12T10:05:25.000Z')] } });
    chooseTab('More');
    expect(screen.getByText('Reviewed at ccccccc · Standard depth · 5 min 25 s · Packs: Generic')).toBeTruthy();
    cleanup();
    review([], { doc: { startedAt: '2026-11-12T10:00:00.000Z', createdAt: '2026-11-12T10:00:42.000Z' } });
    chooseTab('More');
    expect(screen.getByText('Reviewed at ccccccc · Standard depth · 42 s · Packs: Generic')).toBeTruthy();
  });
});

describe('a part is shown only when it has something in it', () => {
  it('on every tab', () => {
    review([]);
    for (const name of ['Stage errors', 'In short', 'Before you merge', 'Claims to check', 'Read in this order']) {
      expect(screen.queryByRole('heading', { name }), name).toBeNull();
    }
    expect(screen.queryByRole('list', { name: 'Top findings' })).toBeNull();
    const absent = ['Also found', 'Fixed since the last review', 'What it does', 'Questions for the author', 'Whose call', 'Check after merge', 'Text for your pull request', 'Files',
      'About this review', 'Dismissed', 'Timing'];
    for (const name of ['Findings', 'The change', 'More'] as const) {
      chooseTab(name);
      for (const title of absent) expect(queryFold(title), title).toBeNull();
      expect(queryButton(/^Dropped/)).toBeNull();
    }
  });
});

describe('the detail of a finding', () => {
  const full = finding(1, {
    connected: [{ path: 'src/other.ts', line: 7, role: 'caller', quote: 'call();' }, { path: 'src/lib.ts', line: null, role: 'type', quote: '' }],
    wouldBeWrongIf: 'Callers already round.',
  });

  it('opens from a row, shows every part and goes back', () => {
    review([full, finding(2)]);
    openRow();
    expect(heading('Problem 1')).toBeTruthy();
    expect(document.activeElement).toBe(heading('Problem 1'));
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(heading('What to do')).toBeTruthy();
    expect(screen.getByText('Change 1.')).toBeTruthy();
    for (const name of ['What happens', 'Why it matters', 'The code', 'Also involves', 'How sure is this']) openFold(name);
    expect(screen.getAllByText('Happens 1.').length).toBeGreaterThan(0);
    expect(screen.getByText('Why 1.')).toBeTruthy();
    for (const name of ['Checked', 'It would be wrong if', 'From']) expect(heading(name), name).toBeTruthy();
    expect(screen.getByText('Checked 1.')).toBeTruthy();
    expect(screen.getByText('Callers already round.')).toBeTruthy();
    expect(screen.getByText('code 1;').closest('pre')).not.toBeNull();
    expect(screen.getByText('Generic · correctness')).toBeTruthy();
    fireEvent.click(button('Back to the review'));
    expect(tab('Findings')).toBeTruthy();
    expect(document.activeElement).toBe(within(cards()[0]!).getByRole('button'));
  });
  it('leaves out an empty part', () => {
    review([finding(1, { wouldBeWrongIf: '', checked: '', suggestedChange: '' })]);
    openRow();
    openFold('How sure is this');
    for (const name of ['It would be wrong if', 'Checked', 'What to do']) expect(screen.queryByRole('heading', { name }), name).toBeNull();
    expect(queryButton(/^Also involves/)).toBeNull();
    expect(heading('From')).toBeTruthy();
  });
  it('shows no pinned bar while a finding is open', () => {
    review([finding(1)]);
    expect(button('Select')).toBeTruthy();
    openRow();
    expect(queryButton('Select')).toBeNull();
    expect(queryButton(/^Copy fix prompt for the/)).toBeNull();
  });
  it('comes back to where the review was scrolled', () => {
    review(Array.from({ length: 30 }, (_, i) => finding(i + 1)));
    const scroller = document.scrollingElement ?? document.documentElement;
    scroller.scrollTop = 640;
    openRow(20);
    scroller.scrollTop = 0;
    fireEvent.click(button('Back to the review'));
    expect(scroller.scrollTop).toBe(640);
    expect(document.activeElement).toBe(within(cards()[20]!).getByRole('button'));
  });
  it('shows each connected place as a button that calls onJump and shows what it resolved to', async () => {
    const onJump = vi.fn().mockResolvedValue({ sentence: 'Jumped to src/other.ts line 7.', needsReload: false });
    show(reviewState([full]), { onJump });
    openRow();
    openFold('Also involves');
    const place = button(/src\/other\.ts:7/);
    expect(place.textContent).toContain('caller');
    expect(button(/src\/lib\.ts/).textContent).not.toContain(':');
    expect(document.querySelector('a')).toBeNull();
    fireEvent.click(place);
    expect(onJump).toHaveBeenCalledWith(REVIEWED, { path: 'src/other.ts', line: 7, kind: 'elsewhere' }, NO_RELOAD);
    expect(await screen.findByText('Jumped to src/other.ts line 7.')).toBeTruthy();
    expect(place.parentElement?.textContent).toContain('Jumped to src/other.ts line 7.');
  });
  it('Show in diff calls onJump with the finding path and start line; the default says it is not connected', async () => {
    const onJump = vi.fn().mockResolvedValue({ sentence: 'Done.', needsReload: false });
    show(reviewState([full]), { onJump });
    openRow();
    fireEvent.click(button('Show in diff'));
    expect(onJump).toHaveBeenCalledWith(REVIEWED, { path: 'src/file1.ts', line: 10, kind: 'changed' }, NO_RELOAD);
    cleanup();
    review([full]);
    openRow();
    fireEvent.click(button('Show in diff'));
    expect(await screen.findByText('Jumping is not connected yet.')).toBeTruthy();
  });
  it('says what kind of place each jump is: changed, outside the changed lines, or not in the pull request', () => {
    const onJump = vi.fn().mockResolvedValue({ sentence: 'Done.', needsReload: false });
    const files = [{ path: 'src/file1.ts', tier: 'read' as const, reason: '' }, { path: 'src/lib.ts', tier: 'read' as const, reason: '' }];
    const outside = { ...full, anchor: { status: 'outside-diff' as const, startLine: 40, endLine: 40 } };
    show(reviewState([outside], { doc: { files } }), { onJump });
    openRow();
    fireEvent.click(button('Show in diff'));
    expect(onJump).toHaveBeenLastCalledWith(REVIEWED, { path: 'src/file1.ts', line: 40, kind: 'outside' }, NO_RELOAD);
    openFold('Also involves');
    fireEvent.click(button(/src\/lib\.ts/));
    expect(onJump).toHaveBeenLastCalledWith(REVIEWED, { path: 'src/lib.ts', line: null, kind: 'changed' }, NO_RELOAD);
    fireEvent.click(button(/src\/other\.ts:7/));
    expect(onJump).toHaveBeenLastCalledWith(REVIEWED, { path: 'src/other.ts', line: 7, kind: 'elsewhere' }, NO_RELOAD);
  });
  it('shows only the latest jump’s answer when an earlier one answers later', async () => {
    const answers: ((result: JumpResult) => void)[] = [];
    const onJump = vi.fn(() => new Promise<JumpResult>((resolve) => answers.push(resolve)));
    show(reviewState([full]), { onJump });
    openRow();
    fireEvent.click(button('Show in diff'));
    openFold('Also involves');
    fireEvent.click(button(/src\/other\.ts:7/));
    await act(async () => { answers[1]!({ sentence: 'Opened src/other.ts in a new tab; it is not part of this pull request.', needsReload: false }); });
    await act(async () => { answers[0]!({ sentence: 'Asked GitHub to show src/file1.ts:10.', needsReload: false }); });
    expect(screen.getByText('Opened src/other.ts in a new tab; it is not part of this pull request.')).toBeTruthy();
    expect(screen.queryByText('Asked GitHub to show src/file1.ts:10.')).toBeNull();
  });
  it('offers to reload the GitHub tab when a jump needs it, and reloads nothing without the click', async () => {
    const stuck = { sentence: 'Airlock could not reach the GitHub page. Reload it, then try again.', needsReload: true };
    const onJump = vi.fn().mockResolvedValueOnce(stuck).mockResolvedValueOnce({ sentence: 'Showing src/file1.ts:10.', needsReload: false });
    show(reviewState([full]), { onJump });
    openRow();
    fireEvent.click(button('Show in diff'));
    const reload = await screen.findByRole('button', { name: 'Reload the GitHub tab' });
    expect(screen.getByText(stuck.sentence)).toBeTruthy();
    expect(reload.parentElement?.textContent).toContain(stuck.sentence);
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenLastCalledWith(REVIEWED, { path: 'src/file1.ts', line: 10, kind: 'changed' }, NO_RELOAD);
    fireEvent.click(reload);
    expect(onJump).toHaveBeenCalledTimes(2);
    expect(onJump).toHaveBeenLastCalledWith(REVIEWED, { path: 'src/file1.ts', line: 10, kind: 'changed' }, { reload: true });
    expect(await screen.findByText('Showing src/file1.ts:10.')).toBeTruthy();
    expect(queryButton('Reload the GitHub tab')).toBeNull();
  });
  it('offers the reload beside a connected place too, and reloads for that place', async () => {
    const stuck = { sentence: 'Airlock could not reach the GitHub page. Reload it, then try again.', needsReload: true };
    const onJump = vi.fn().mockResolvedValue(stuck);
    show(reviewState([full], { doc: { files: [{ path: 'src/other.ts', tier: 'read', reason: '' }] } }), { onJump });
    openRow();
    openFold('Also involves');
    const place = button(/src\/other\.ts:7/);
    fireEvent.click(place);
    const reload = await screen.findByRole('button', { name: 'Reload the GitHub tab' });
    expect(place.parentElement?.contains(reload)).toBe(true);
    fireEvent.click(reload);
    expect(onJump).toHaveBeenLastCalledWith(REVIEWED, { path: 'src/other.ts', line: 7, kind: 'changed' }, { reload: true });
  });
  it('jumps from a review shown read-only while the service is away', async () => {
    const onJump = vi.fn().mockResolvedValue({ sentence: 'Showing src/file1.ts:10.', needsReload: false });
    const kept = reviewState([full]);
    show({ kind: 'offline', review: { pr: kept.pr, latest: kept.latest, stale: false } }, { onJump });
    openRow();
    fireEvent.click(button('Show in diff'));
    expect(onJump).toHaveBeenCalledWith(REVIEWED, { path: 'src/file1.ts', line: 10, kind: 'changed' }, NO_RELOAD);
    expect(await screen.findByText('Showing src/file1.ts:10.')).toBeTruthy();
  });
  it('Dismiss opens the dismiss sheet for the finding', () => {
    show(reviewState([full]));
    openRow();
    fireEvent.click(button('Dismiss'));
    const dialog = screen.getByRole('dialog', { name: 'Dismiss this finding' });
    expect(within(dialog).getByText(full.title)).toBeTruthy();
  });
  it('moves with Previous and Next through the top list then also found, skips dismissed ones and stops at the ends', () => {
    const f = [finding(1), finding(2), finding(3), also(4), also(5)];
    review(f, { dismissals: [dismissal(f[1]!), dismissal(f[3]!)] });
    openRow();
    expect((button('Previous finding') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button('Next finding'));
    expect(heading('Problem 3')).toBeTruthy();
    expect(document.activeElement).toBe(heading('Problem 3'));
    fireEvent.click(button('Next finding'));
    expect(heading('Problem 5')).toBeTruthy();
    expect((button('Next finding') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button('Previous finding'));
    expect(heading('Problem 3')).toBeTruthy();
    fireEvent.click(button('Previous finding'));
    expect(heading('Problem 1')).toBeTruthy();
  });
  it('opens an also-found finding and returns focus to its row', () => {
    review([finding(1), also(2)]);
    openFold('Also found');
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
    openRow();
    fireEvent.click(button('Copy fix prompt'));
    expect(writeText).toHaveBeenCalledWith(fixPrompt(state.latest.document, [full]));
  });
});

describe('the pinned bar', () => {
  it.each([
    [[finding(1)], 'Copy fix prompt for the 1 fix'],
    [[finding(1, { severity: 'block' }), finding(2), also(3, { severity: 'fix' }), finding(4, { severity: 'ask' })], 'Copy fix prompt for the 3 fixes'],
  ])('copies one prompt for every open Block and Fix, in list order (%#)', async (findings, label) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    const state = reviewState(findings);
    show(state);
    fireEvent.click(button(label));
    const fixes = findings.filter((f) => f.severity === 'block' || f.severity === 'fix').sort((a, b) => Number(a.bucket === 'also') - Number(b.bucket === 'also'));
    expect(writeText).toHaveBeenCalledWith(fixPrompt(state.latest.document, fixes));
    await screen.findByRole('button', { name: 'Copied' });
  });
  it('leaves dismissed fixes out of the prompt for the fixes', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    const f = [finding(1), finding(2)];
    const state = reviewState(f, { dismissals: [dismissal(f[0]!)] });
    show(state);
    fireEvent.click(button('Copy fix prompt for the 1 fix'));
    expect(writeText).toHaveBeenCalledWith(fixPrompt(state.latest.document, [f[1]!]));
  });
  it('offers only Select when nothing open is a Block or a Fix, and nothing at all when nothing is open', () => {
    review([finding(1, { severity: 'ask' }), also(2)]);
    expect(queryButton(/^Copy fix prompt/)).toBeNull();
    expect(button('Select')).toBeTruthy();
    cleanup();
    review([]);
    expect(queryButton('Select')).toBeNull();
  });
  it('Select shows a checkbox on every row of the findings tab, also found included, and moves to that tab', () => {
    review([finding(1), finding(2), also(3)], { doc: { previous: { reviewId: 'r_0000000000', headSha: 'a'.repeat(40) }, fixed: [finding(7, { status: 'fixed' })] } });
    chooseTab('More');
    fireEvent.click(button('Select'));
    expect(tab('Findings').getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(document.activeElement).toBe(screen.getAllByRole('checkbox')[0]);
    openFold('Also found');
    openFold('Fixed since the last review');
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['Select: Problem 1', 'Select: Problem 2', 'Select: Problem 3']);
    expect(button('Copy fix prompt (0)')).toBeTruthy();
    expect((button('Copy fix prompt (0)') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Comment on GitHub (0)') as HTMLButtonElement).disabled).toBe(true);
    expect(queryButton('Select')).toBeNull();
  });
  it('copies the prompt for the ticked ones in list order', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    const f = [finding(1), finding(2), finding(3)];
    const state = reviewState(f);
    show(state);
    tick('Problem 3');
    tick('Problem 1');
    fireEvent.click(button('Copy fix prompt (2)'));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(fixPrompt(state.latest.document, [f[0]!, f[2]!]));
    await screen.findByRole('button', { name: 'Copied' });
  });
  it('says Copied for two seconds, then the label again', async () => {
    clipboard(vi.fn().mockResolvedValue(undefined));
    const timers = new FakeTimers();
    show(reviewState([finding(1)]), { timers });
    tick('Problem 1');
    fireEvent.click(button('Copy fix prompt (1)'));
    await screen.findByRole('button', { name: 'Copied' });
    expect(timers.delays()).toContain(2000);
    act(() => timers.fire());
    expect(button('Copy fix prompt (1)')).toBeTruthy();
  });
  it('Done clears the selection, hides the checkboxes and gives focus back to Select', () => {
    review([finding(1)]);
    tick('Problem 1');
    fireEvent.click(button('Done'));
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(document.activeElement).toBe(button('Select'));
    fireEvent.click(button('Select'));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(button('Copy fix prompt (0)')).toBeTruthy();
  });
  it('leaves a dismissed finding out of the prompt and the selection', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    const f = [finding(1), finding(2)];
    const open = reviewState(f);
    const { rerender } = show(open);
    tick('Problem 1');
    tick('Problem 2');
    rerender(<PanelScreen state={reviewState(f, { dismissals: [dismissal(f[0]!)] })} dispatch={vi.fn()} onOpenSettings={() => undefined} />);
    fireEvent.click(button('Copy fix prompt (1)'));
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
    fireEvent.click(button('Copy fix prompt (1)'));
    const prompt = fixPrompt(state.latest.document, [f]);
    await waitFor(() => expect(window.getSelection()?.toString()).toBe(prompt));
    expect(queryButton('Copied')).toBeNull();
  });
  it('shows the prompt in a box when there is no clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const f = finding(1);
    const state = reviewState([f]);
    show(state);
    fireEvent.click(button('Copy fix prompt for the 1 fix'));
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
  const openDropped = (n: number) => { chooseTab('More'); fireEvent.click(button(`Dropped: ${n}`)); };

  it('shows nothing for no dropped findings', () => {
    review([finding(1)]);
    chooseTab('More');
    expect(queryButton(/Dropped/)).toBeNull();
  });
  it('opens from Dropped: n on the More tab with stage, reason and proof, a recorded decision in full', () => {
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
    openDropped(3);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Dropped in the challenge: The base already handles it.')).toBeTruthy();
    expect(within(dialog).getByText('Dropped when finding its line: Not in the diff.')).toBeTruthy();
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
    chooseTab('More');
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
    openDropped(1);
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
    expect((button('Review everything again') as HTMLButtonElement).disabled).toBe(true);
    chooseTab('More');
    openFold('Dismissed');
    expect((button(/Restore/) as HTMLButtonElement).disabled).toBe(true);
    chooseTab('Findings');
    openRow();
    expect((button('Dismiss') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button('Back to the review'));
    tick('Problem 1');
    fireEvent.click(button('Copy fix prompt (1)'));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('text from a review is only ever text', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(1)</script>';
  const js = '[click](javascript:alert(1))';
  const noMarkup = () => { for (const tag of ['script', 'img', 'a']) expect(document.querySelector(tag), tag).toBeNull(); };

  it('on the review screen and the dropped sheet', () => {
    const f = finding(1, {
      title: evil, quote: evil, suggestedChange: js, connected: [{ path: 'p.ts', line: 1, role: evil, quote: js }],
    });
    review([f, also(2, { title: js })], {
      doc: {
        verdict: { label: 'approve', sentence: evil, counts: NO_COUNTS },
        questions: [{ text: evil, cohortId: null, source: { pack: 'generic', lens: null, ruleId: null } }],
        selfReviewText: evil,
        brief: { whatItDoes: [js], claims: [], inShort: evil },
        dropped: [{ candidate: finding(7, { title: js }), stage: 'challenge', reason: evil, refutation: { path: js, line: 1, role: 'head', quote: evil } }],
        stageErrors: [{ stage: 'lenses', cohortId: null, message: js }],
      },
    });
    expect(screen.getAllByText(evil).length).toBeGreaterThan(0);
    openFold('Also found');
    expect(screen.getByText(js, { selector: 'span' })).toBeTruthy();
    noMarkup();
    chooseTab('The change');
    openFold('Questions for the author');
    openFold('Text for your pull request');
    // The sentence in the strip, In short, the question and the text for the pull request.
    expect(screen.getAllByText(evil).length).toBe(4);
    noMarkup();
    chooseTab('More');
    fireEvent.click(button('Dropped: 1'));
    expect(screen.getByText(`Dropped in the challenge: ${evil}`)).toBeTruthy();
    expect(screen.getByText(evil, { selector: 'pre, code' })).toBeTruthy();
    noMarkup();
    fireEvent.click(button('Close'));
    chooseTab('Findings');
    openRow();
    openFold('The code');
    openFold('Also involves');
    expect(screen.getByText(evil, { selector: 'pre, code' })).toBeTruthy();
    expect(screen.getAllByRole('button').some((b) => b.textContent?.includes('p.ts:1') && b.textContent.includes(evil))).toBe(true);
    noMarkup();
  });
});

describe('dismissing the open finding', () => {
  it('closes the detail, focuses the Findings tab, and a restore does not reopen it', () => {
    const f = [finding(1), finding(2)];
    const { rerender } = show(reviewState(f));
    openRow();
    expect(heading('Problem 1')).toBeTruthy();
    const draw = (opts: ReviewOptions) => rerender(<PanelScreen state={reviewState(f, opts)} dispatch={vi.fn()} onOpenSettings={() => undefined} />);
    draw({ dismissals: [dismissal(f[0]!)] });
    expect(queryButton('Back to the review')).toBeNull();
    expect(document.activeElement).toBe(tab('Findings'));
    draw({});
    expect(queryButton('Back to the review')).toBeNull();
    expect(cards()).toHaveLength(2);
  });
  it('focuses the verdict heading when no findings are left', () => {
    const f = finding(1);
    const { rerender } = show(reviewState([f]));
    openRow();
    rerender(<PanelScreen state={reviewState([f], { dismissals: [dismissal(f)] })} dispatch={vi.fn()} onOpenSettings={() => undefined} />);
    expect(document.activeElement).toBe(heading('Approve after fixes'));
  });
  it('returns from Next into the collapsed Also found by opening it and focusing the row', () => {
    review([finding(1), also(2)]);
    openRow();
    fireEvent.click(button('Next finding'));
    fireEvent.click(button('Back to the review'));
    expect(fold('Also found').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(button(/Problem 2/));
  });
  it('keeps the notice and the stale banner above an open detail', () => {
    review([finding(1)], { notice: 'Another review is running.', stale: true });
    openRow();
    expect(heading('Problem 1')).toBeTruthy();
    expect(screen.getByText('Another review is running.')).toBeTruthy();
    expect(screen.getByText('New commits since this review.')).toBeTruthy();
    expect(button('Review everything again')).toBeTruthy();
  });
  it('disables both Previous and Next for a single finding', () => {
    review([finding(1)]);
    openRow();
    expect((button('Previous finding') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Next finding') as HTMLButtonElement).disabled).toBe(true);
  });
  it('cuts a very long title in its row and in the finding, and shows it whole as the first line of What happens', () => {
    const title = `${'Very long title '.repeat(40)}end`;
    review([finding(1, { title })]);
    const shown = within(cards()[0]!).getByText(/^Very long title/).textContent!;
    expect(shown.endsWith('…')).toBe(true);
    expect([...shown].length).toBeLessThanOrEqual(60);
    openRow();
    expect(heading(`${'Very long title '.repeat(3)}Very long…`)).toBeTruthy();
    openFold('What happens');
    expect(screen.getByText(title)).toBeTruthy();
  });
});

describe('a verdict never stands alone', () => {
  it('says an incomplete review is not cleared when there are no findings', () => {
    review([], { doc: { verdict: { label: 'incomplete', sentence: 'It stopped.', counts: NO_COUNTS } } });
    expect(within(strip()).getByText('The review did not finish, so nothing here is cleared.')).toBeTruthy();
    expect(screen.queryByText('No findings.')).toBeNull();
  });
  it('says no open findings in the strip and on the Findings tab, whose Show dismissed goes to More with Dismissed open', () => {
    const f = [finding(1), also(2)];
    review(f, { dismissals: f.map((x) => dismissal(x)) });
    expect(within(strip()).getByText('No open findings. 2 dismissed.')).toBeTruthy();
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('No open findings. 2 dismissed.')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Show dismissed' }));
    expect(tab('More').getAttribute('aria-selected')).toBe('true');
    expect(fold('Dismissed').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(fold('Dismissed'));
    expect(screen.getByText('Problem 1')).toBeTruthy();
  });
  it('offers no Show dismissed while findings are open', () => {
    const f = [finding(1), finding(2)];
    review(f, { dismissals: [dismissal(f[0]!)] });
    expect(queryButton('Show dismissed')).toBeNull();
  });
  it('says No findings when there are none, and nothing of the kind when some are shown', () => {
    review([]);
    expect(within(strip()).getByText('No findings.')).toBeTruthy();
    cleanup();
    review([finding(1)]);
    expect(screen.queryByText(/No findings|No open findings|did not finish/)).toBeNull();
  });
});

describe('selection and the dropped sheet, second look', () => {
  it('a finding ticked, dismissed and restored comes back unticked', () => {
    const f = [finding(1), finding(2)];
    const { rerender } = show(reviewState(f));
    tick('Problem 1');
    const draw = (opts: ReviewOptions) => rerender(<PanelScreen state={reviewState(f, opts)} dispatch={vi.fn()} onOpenSettings={() => undefined} />);
    draw({ dismissals: [dismissal(f[0]!)] });
    draw({});
    expect((screen.getByRole('checkbox', { name: /Problem 1$/ }) as HTMLInputElement).checked).toBe(false);
    expect(button('Copy fix prompt (0)')).toBeTruthy();
  });
  const longProof = { path: 'src/base.ts', line: 3, role: 'head', quote: 'q'.repeat(300) };
  const drop = { candidate: finding(9), stage: 'challenge' as const, reason: 'Held.', refutation: longProof };
  const openDropped = () => { chooseTab('More'); const opener = button('Dropped: 1'); fireEvent.click(opener); return opener; };
  it('Show all reveals the rest of a clipped quote', () => {
    review([], { doc: { dropped: [drop] } });
    openDropped();
    expect(screen.queryByText('q'.repeat(300))).toBeNull();
    fireEvent.click(button('Show all'));
    expect(screen.getByText('q'.repeat(300))).toBeTruthy();
    expect(queryButton('Show all')).toBeNull();
  });
  it('closes on a click on the backdrop and gives focus back to the opener', () => {
    review([], { doc: { dropped: [drop] } });
    const opener = openDropped();
    fireEvent.click(document.querySelector('.sheet')!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it('does not close on a click inside the sheet', () => {
    review([], { doc: { dropped: [drop] } });
    openDropped();
    fireEvent.click(screen.getByText('Held.', { exact: false }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('keeps Tab and Shift+Tab inside the sheet', () => {
    review([], { doc: { dropped: [drop] } });
    openDropped();
    const dialog = screen.getByRole('dialog');
    const close = within(dialog).getByRole('button', { name: 'Close' });
    const all = within(dialog).getByRole('button', { name: 'Show all' });
    all.focus();
    fireEvent.keyDown(all, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(all);
    (dialog.querySelector('h2') as HTMLElement).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(all);
  });
});

describe('focus stays in the dropped sheet', () => {
  const drop = { candidate: finding(9), stage: 'challenge' as const, reason: 'Held.', refutation: { path: 'src/base.ts', line: 3, role: 'head', quote: 'q'.repeat(300) } };
  const open = () => {
    const view = review([finding(1)], { doc: { dropped: [drop] } });
    chooseTab('More');
    fireEvent.click(button('Dropped: 1'));
    return view;
  };
  it('moves focus to the revealed quote after Show all', () => {
    open();
    fireEvent.click(button('Show all'));
    expect(document.activeElement).toBe(screen.getByText('q'.repeat(300)).closest('pre'));
  });
  it('catches a Tab pressed while focus is on the body', () => {
    open();
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });
  it('sends focus back into the sheet when something behind it is focused, until it closes', () => {
    open();
    const dialog = screen.getByRole('dialog');
    const behind = button('Settings');
    behind.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    behind.focus();
    expect(document.activeElement).toBe(behind);
  });
});

describe('the live region', () => {
  it('changes twice when the same sentence is announced twice', async () => {
    clipboard(vi.fn().mockResolvedValue(undefined));
    const timers = new FakeTimers();
    render(<PanelScreen state={reviewState([finding(1)])} dispatch={vi.fn()} onOpenSettings={() => undefined} timers={timers} />);
    const region = document.querySelector('[aria-live="polite"]')!;
    tick('Problem 1');
    act(() => timers.fire());
    fireEvent.click(button('Copy fix prompt (1)'));
    await screen.findByRole('button', { name: 'Copied' });
    act(() => timers.fire());
    expect(region.textContent).toBe('Copied. Paste it to your coding agent.');
    fireEvent.click(button('Copy fix prompt (1)'));
    await screen.findByRole('button', { name: 'Copied' });
    expect(region.textContent).toBe('');
    act(() => timers.fire());
    expect(region.textContent).toBe('Copied. Paste it to your coding agent.');
  });
});

describe('folds', () => {
  it('point aria-controls only at an element that exists, hide the arrow from assistive technology, and say their count in text', () => {
    review([finding(1), also(2)]);
    const toggle = fold('Also found');
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    expect(toggle.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(toggle.textContent).toBe('Also found 1');
    fireEvent.click(toggle);
    const id = toggle.getAttribute('aria-controls')!;
    expect(document.getElementById(id)).not.toBeNull();
  });
});

describe('a jump that fails', () => {
  const full = finding(1);
  const sentence = 'Airlock could not jump to that place.';
  it('says so when onJump rejects', async () => {
    show(reviewState([full]), { onJump: () => Promise.reject(new Error('no')) });
    openRow();
    fireEvent.click(button('Show in diff'));
    expect(await screen.findByText(sentence)).toBeTruthy();
  });
  it('says so when onJump throws', async () => {
    show(reviewState([full]), { onJump: () => { throw new Error('no'); } });
    openRow();
    fireEvent.click(button('Show in diff'));
    expect(await screen.findByText(sentence)).toBeTruthy();
  });
});

describe('every field of document text is only text', () => {
  const NO_ELEMENTS = 'script, img, a, iframe, svg';
  const h = (field: string): string => `<img src=x onerror="${field}()"><svg onload=${field}></svg>[x](javascript:${field})`;
  const literal = (box: Element | null, field: string): void => {
    expect(box, field).not.toBeNull();
    expect(box!.textContent, field).toContain(h(field));
    expect(box!.querySelectorAll(NO_ELEMENTS), field).toHaveLength(0);
  };
  const section = (name: string): Element | null => heading(name).closest('section');
  /** What a fold of the finding screen holds, once open: the fold's own button and its arrow left out. */
  const folded = (name: string): Element | null => {
    openFold(name);
    return screen.getByRole('button', { name: new RegExp(`^${name}`) }).closest('section')!.querySelector('.ap-folded');
  };

  it('in the lists, the notice, the stage errors and the dismissed section', () => {
    const gone = also(3, { title: 'Gone' });
    review([finding(1, { short: h('short') }), gone], {
      notice: h('notice'),
      pr: { packs: [{ id: 'generic', title: h('pack') }] },
      dismissals: [dismissal(gone, { reason: 'intended', text: h('saved') })],
      doc: {
        brief: { whatItDoes: [], claims: [], inShort: h('inshort') },
        whoseCall: [h('whose')], checksAfterMerge: [h('check')],
        stageErrors: [{ stage: 'lenses', cohortId: 'c1', message: h('error') }],
        map: { cohorts: [{ id: 'c1', title: h('group'), summary: '', neighbours: [], inferredLinks: [], layers: [] }], standalone: [], links: [] },
      },
    });
    literal(document.querySelector('.notice'), 'notice');
    literal(cards()[0]!, 'short');
    literal(section('Stage errors'), 'error');
    literal(section('Stage errors'), 'group');
    chooseTab('The change');
    literal(heading('In short').parentElement, 'inshort');
    openFold('Whose call');
    literal(foldSection('Whose call'), 'whose');
    openFold('Check after merge');
    literal(foldSection('Check after merge'), 'check');
    chooseTab('More');
    literal(screen.getByText(/^Reviewed at .* Packs:/), 'pack');
    openFold('Dismissed');
    literal(foldSection('Dismissed'), 'saved');
  });
  it('in the detail', () => {
    review([finding(1, { happens: h('happens'), why: h('why'), checked: h('checked'), wouldBeWrongIf: h('wrong'), suggestedChange: h('change') })]);
    openRow();
    literal(folded('What happens'), 'happens');
    literal(folded('Why it matters'), 'why');
    const proof = folded('How sure is this');
    literal(proof, 'checked');
    literal(proof, 'wrong');
    literal(section('What to do'), 'change');
  });
});

describe('what this review did not see stays in sight', () => {
  const NOTHING_READ = 'Nothing in this pull request was read closely: all 3 changed files are of kinds Airlock trusts.';
  const APPROVE = { label: 'approve' as const, sentence: 'Nothing that needs fixing was found.', counts: NO_COUNTS };
  const PREVIOUS = { reviewId: 'r_0000000000', headSha: 'a'.repeat(40) };

  it('a first review with the nothing-read note and nothing open shows About this review under the strip, open, its note in sight, and no green', () => {
    review([], { doc: { verdict: APPROVE, notes: [NOTHING_READ] } });
    const about = fold('About this review');
    expect(about.textContent).toBe('About this review 1 note');
    expect(about.getAttribute('aria-expanded')).toBe('true');
    expect(follows(strip(), about)).toBe(true);
    expect(follows(about, screen.getByRole('tablist'))).toBe(true);
    expect(heading('Approve').className).not.toMatch(/sev-ok/);
    expect(within(foldSection('About this review')).getByText(NOTHING_READ)).toBeTruthy();
    expect(heading('Notes')).toBeTruthy();
    // It can still be closed.
    fireEvent.click(about);
    expect(about.getAttribute('aria-expanded')).toBe('false');
  });
  it('About this review starts closed when a finding is open, and open when every finding is dismissed', () => {
    const f = finding(1);
    review([f], { doc: { notes: [NOTHING_READ] } });
    expect(fold('About this review').getAttribute('aria-expanded')).toBe('false');
    cleanup();
    review([f], { doc: { notes: [NOTHING_READ] }, dismissals: [dismissal(f)] });
    expect(fold('About this review').getAttribute('aria-expanded')).toBe('true');
  });
  it('counts limits and notes in words, a zero part left out, and lists the limits first', () => {
    review([finding(1)], { doc: { limits: ['82 of 673 lines were cut.'], notes: ['One.', 'Two.'] } });
    expect(fold('About this review').textContent).toBe('About this review 1 not shown to the reviewer, 2 notes');
    openFold('About this review');
    const section = foldSection('About this review');
    expect([...section.querySelectorAll('h4')].map((h) => h.textContent)).toEqual(['Not shown to the reviewer', 'Notes']);
    expect([...section.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['82 of 673 lines were cut.', 'One.', 'Two.']);
    cleanup();
    review([finding(1)], { doc: { limits: ['A.', 'B.'] } });
    expect(fold('About this review').textContent).toBe('About this review 2 not shown to the reviewer');
    cleanup();
    review([finding(1)]);
    expect(queryFold('About this review')).toBeNull();
  });
  it('a re-review prints its notes in the strip, and only its limits get the fold', () => {
    review([finding(1)], { doc: { previous: PREVIOUS, notes: ['The push changed only files Airlock does not review.'], limits: ['A limit.'] } });
    expect(within(strip()).getByText('The push changed only files Airlock does not review.')).toBeTruthy();
    expect(fold('About this review').textContent).toBe('About this review 1 not shown to the reviewer');
    openFold('About this review');
    expect(within(foldSection('About this review')).queryByText('The push changed only files Airlock does not review.')).toBeNull();
    cleanup();
    review([finding(1)], { doc: { previous: PREVIOUS, notes: ['A note.'] } });
    expect(within(strip()).getByText('A note.')).toBeTruthy();
    expect(queryFold('About this review')).toBeNull();
  });
});

describe('Open in Airlock and Back', () => {
  const asked = (id: string, seq: number) => ({ id, seq });

  it('chooses the Findings tab, and Back puts focus on the finding\'s row', () => {
    const state = reviewState([finding(1), finding(2)]);
    const dispatch = vi.fn();
    const { rerender } = render(<PanelScreen state={state} dispatch={dispatch} onOpenSettings={() => undefined} openFinding={null} />);
    chooseTab('More');
    rerender(<PanelScreen state={state} dispatch={dispatch} onOpenSettings={() => undefined} openFinding={asked('c_00000002', 1)} />);
    expect(heading('Problem 2')).toBeTruthy();
    fireEvent.click(button('Back to the review'));
    expect(tab('Findings').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(within(cards()[1]!).getByRole('button'));
  });
  it('puts focus on the Findings tab when the finding\'s row is not drawn (Also found closed)', () => {
    const state = reviewState([finding(1), also(2)]);
    const dispatch = vi.fn();
    const { rerender } = render(<PanelScreen state={state} dispatch={dispatch} onOpenSettings={() => undefined} openFinding={null} />);
    rerender(<PanelScreen state={state} dispatch={dispatch} onOpenSettings={() => undefined} openFinding={asked('c_00000002', 1)} />);
    fireEvent.click(button('Back to the review'));
    expect(fold('Also found').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(tab('Findings'));
  });
});

describe('the tab panel', () => {
  it('is in the Tab order and named by its tab', () => {
    review([finding(1)]);
    chooseTab('The change');
    const panel = screen.getByRole('tabpanel', { name: 'The change' });
    expect(panel.tabIndex).toBe(0);
  });
});

describe('the bar\'s copy', () => {
  it('says Copied on the button and announces where the prompt goes', async () => {
    clipboard(vi.fn().mockResolvedValue(undefined));
    review([finding(1)]);
    fireEvent.click(button('Copy fix prompt for the 1 fix'));
    await screen.findByRole('button', { name: 'Copied' });
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe('Copied. Paste it to your coding agent.');
  });
});
