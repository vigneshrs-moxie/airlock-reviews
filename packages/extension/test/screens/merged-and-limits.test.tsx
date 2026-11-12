// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Dropped, Finding } from '@airlock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetFindingFolds } from '../../src/screens/finding-folds';
import { PanelScreen } from '../../src/screens/PanelScreen';
import type { PanelState } from '../../src/state/reduce';
import { also, dismissal, finding, reviewState, type ReviewOptions } from './review-fixtures';
import { chooseTab, fold, queryFold, rows, tick } from './review-dom';

afterEach(() => {
  cleanup();
  forgetFindingFolds();
});

function show(findings: Finding[], opts: ReviewOptions = {}) {
  const dispatch = vi.fn();
  const view = render(<PanelScreen state={reviewState(findings, opts)} dispatch={dispatch} onOpenSettings={() => undefined} />);
  const rerender = (state: PanelState): void => view.rerender(<PanelScreen state={state} dispatch={dispatch} onOpenSettings={() => undefined} />);
  return { ...view, dispatch, rerender };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const queryButton = (name: string | RegExp) => screen.queryByRole('button', { name });
const heading = (name: string | RegExp) => screen.getByRole('heading', { name });
const cards = rows;
const openDropped = (n: number) => { chooseTab('More'); fireEvent.click(button(`Dropped: ${n}`)); };
const follows = (a: HTMLElement, b: HTMLElement) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('what the reviewer was not shown', () => {
  const LIMITS = ['The diff of src/big.ts was cut at 4,000 lines.', 'The rule file docs/rules.md was left out: <b>too long</b>.'];

  it('is a collapsed fold on the More tab, after Review again, listing each limit when opened', () => {
    show([finding(1)], {
      doc: { limits: LIMITS, stageErrors: [{ stage: 'lenses', cohortId: null, message: 'Timed out' }] },
    });
    expect(queryFold('Not shown to the reviewer')).toBeNull();
    chooseTab('More');
    const toggle = fold('Not shown to the reviewer');
    expect(toggle.textContent).toBe('Not shown to the reviewer 2');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(LIMITS[0]!)).toBeNull();
    expect(follows(heading('Stage errors'), toggle)).toBe(true);
    expect(follows(button('Review again'), toggle)).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(LIMITS[0]!)).toBeTruthy();
    // Text from the document is only ever text.
    expect(screen.getByText(LIMITS[1]!)).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
  });
  it('is the first fold on the More tab', () => {
    show([finding(1)], { doc: { limits: [LIMITS[0]!], notes: ['A note.'] } });
    chooseTab('More');
    expect(follows(fold('Not shown to the reviewer'), fold('Notes from the review'))).toBe(true);
  });
  it('is absent when the list is empty or missing', () => {
    show([finding(1)], { doc: { limits: [] } });
    chooseTab('More');
    expect(queryFold('Not shown to the reviewer')).toBeNull();
    cleanup();
    show([finding(1)]);
    chooseTab('More');
    expect(queryFold('Not shown to the reviewer')).toBeNull();
  });
});

describe('the review\'s notes (second round)', () => {
  const NOTES = ['The kit was a day old.', 'Two files were <img src=x onerror=alert(1)> skipped [click](javascript:alert(1)).'];

  it('is a collapsed fold Notes from the review directly after Not shown to the reviewer, one item per note, as text', () => {
    show([finding(1)], { doc: { limits: ['The diff was cut.'], notes: NOTES } });
    chooseTab('More');
    const toggle = fold('Notes from the review');
    expect(toggle.textContent).toBe('Notes from the review 2');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(NOTES[0]!)).toBeNull();
    const limits = fold('Not shown to the reviewer');
    expect(follows(limits, toggle)).toBe(true);
    // Directly after: no other section between the two.
    expect(limits.closest('section')?.nextElementSibling).toBe(toggle.closest('section'));
    fireEvent.click(toggle);
    const items = within(toggle.closest('section')!).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(NOTES);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('a')).toBeNull();
  });
  it('follows Review again when nothing was left out', () => {
    show([finding(1)], { doc: { notes: [NOTES[0]!] } });
    chooseTab('More');
    expect(follows(button('Review again'), fold('Notes from the review'))).toBe(true);
  });
  it('is absent when there are no notes or the field is missing', () => {
    show([finding(1)], { doc: { notes: [] } });
    chooseTab('More');
    expect(queryButton(/^Notes/)).toBeNull();
    cleanup();
    show([finding(1)]);
    chooseTab('More');
    expect(queryButton(/^Notes/)).toBeNull();
  });
});

describe('a finding also raised by other lenses and rules', () => {
  const merged = finding(1, {
    alsoRaisedBy: [{ pack: 'orbit', lens: null, ruleId: 'R-7' }, { pack: 'generic', lens: 'security', ruleId: null }, { pack: 'mystery', lens: null, ruleId: null }],
    aliases: ['00000000000000aa'],
  });

  it('keeps its row to the kind, the title and the place: who else raised it is in the finding', () => {
    show([merged, finding(2)]);
    expect(within(cards()[0]!).queryByText(/Also raised by/)).toBeNull();
    expect(within(cards()[0]!).getByRole('button').textContent).toBe('FixProblem 1src/file1.ts:10');
  });
  it('lists each one in its detail as the pack title and the lens or rule', () => {
    show([merged]);
    fireEvent.click(within(cards()[0]!).getByRole('button'));
    fireEvent.click(button('How sure is this'));
    const part = heading('Also raised by').closest('.ap-line')!;
    expect([...part.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Orbit · R-7', 'Generic · security', 'mystery']);
  });
  it('has no such part when nothing else raised it, or the list is empty', () => {
    show([finding(1), finding(2, { alsoRaisedBy: [] })]);
    expect(screen.queryByText(/Also raised by/)).toBeNull();
    fireEvent.click(within(cards()[0]!).getByRole('button'));
    fireEvent.click(button('How sure is this'));
    expect(heading('From')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Also raised by' })).toBeNull();
    fireEvent.click(button('Next finding'));
    expect(heading('From')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Also raised by' })).toBeNull();
  });
});

describe('a dismissal made under one of a finding\'s aliases', () => {
  const ALIAS = '00000000000000aa';
  const merged = finding(1, { aliases: [ALIAS] });
  const underAlias = dismissal(merged, { fingerprint: ALIAS, reason: 'not-now' });

  it('takes the finding out of the list and into Dismissed, where Restore sends the dismissal\'s fingerprint', () => {
    const { dispatch } = show([merged, finding(2)], { dismissals: [underAlias] });
    expect(cards()).toHaveLength(1);
    chooseTab('More');
    fireEvent.click(fold('Dismissed'));
    fireEvent.click(button('Restore Problem 1'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'restore', fingerprint: ALIAS });
  });
  it('is the dismiss sheet\'s own result after Dismiss, and Undo restores it by the dismissal\'s fingerprint', () => {
    const { rerender, dispatch } = show([merged, finding(2)]);
    fireEvent.click(within(cards()[0]!).getByRole('button'));
    fireEvent.click(button('Dismiss'));
    fireEvent.click(screen.getByRole('radio', { name: 'Hide it on this pull request only' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Dismiss' }));
    rerender(reviewState([merged, finding(2)], { dismissals: [underAlias] }));
    expect(within(screen.getByRole('dialog')).getByText('Hidden on this pull request.')).toBeTruthy();
    fireEvent.click(button('Undo'));
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'restore', fingerprint: ALIAS });
  });
  it('makes a sheet opened before it read-only, as a dismissal from elsewhere', () => {
    const { rerender } = show([merged]);
    fireEvent.click(within(cards()[0]!).getByRole('button'));
    fireEvent.click(button('Dismiss'));
    rerender(reviewState([merged], { dismissals: [underAlias] }));
    expect(within(screen.getByRole('dialog')).getByText('This finding was already dismissed, so this line cannot be saved to it.')).toBeTruthy();
  });
  it('drops the finding from the selection and the fix prompt bar', () => {
    const { rerender } = show([merged, finding(2)]);
    expect(button('Copy fix prompt for the 2 fixes')).toBeTruthy();
    tick('Problem 1');
    expect(button('Copy fix prompt (1)')).toBeTruthy();
    rerender(reviewState([merged, finding(2)], { dismissals: [underAlias] }));
    expect(button('Copy fix prompt (0)')).toBeTruthy();
    fireEvent.click(button('Done'));
    expect(button('Copy fix prompt for the 1 fix')).toBeTruthy();
  });
});

describe('a dropped duplicate', () => {
  const duplicate = (over: Partial<Dropped> = {}): Dropped => ({
    candidate: { ...finding(9), title: 'The same problem, raised again', severity: 'fix', confidence: 'high' },
    stage: 'merge', reason: 'Same place and cause as another finding.', refutation: null, mergedInto: 'c_00000002', ...over,
  });

  it('says it was dropped as a duplicate', () => {
    show([finding(1), finding(2)], { doc: { dropped: [duplicate()] } });
    openDropped(1);
    expect(within(screen.getByRole('dialog')).getByText('Dropped as a duplicate: Same place and cause as another finding.')).toBeTruthy();
  });
  it('shows the finding it was merged into: the sheet closes and that finding\'s detail opens', () => {
    show([finding(1), finding(2)], { doc: { dropped: [duplicate()] } });
    openDropped(1);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Show the finding it was merged into' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(heading('Problem 2')).toBeTruthy();
    expect(button('Back to the review')).toBeTruthy();
    expect(document.activeElement).toBe(heading('Problem 2'));
  });
  it('opens a merged-into finding that is in Also found', () => {
    show([finding(1), also(2)], { doc: { dropped: [duplicate()] } });
    openDropped(1);
    fireEvent.click(button('Show the finding it was merged into'));
    expect(heading('Problem 2')).toBeTruthy();
  });
  it('offers no button when the finding is not on screen: dismissed, not in the review, or not given', () => {
    const f2 = finding(2);
    show([finding(1), f2], {
      doc: {
        dropped: [
          duplicate(),
          duplicate({ mergedInto: 'c_00000077' }),
          duplicate({ mergedInto: null }),
          duplicate({ mergedInto: undefined, stage: 'challenge' }),
        ],
      },
      dismissals: [dismissal(f2)],
    });
    openDropped(4);
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Show the finding it was merged into' })).toBeNull();
    expect(within(screen.getByRole('dialog')).getByText('Dropped in the challenge: Same place and cause as another finding.')).toBeTruthy();
  });
});
