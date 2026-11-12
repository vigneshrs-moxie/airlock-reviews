// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Finding } from '@airlock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelScreen } from '../../src/screens/PanelScreen';
import { recordOf } from '../helpers/post-fixtures';
import { also, finding, reviewState, type ReviewOptions } from './review-fixtures';

afterEach(cleanup);

const EARLIER = 'a'.repeat(40);
const HEAD = 'c'.repeat(40);
const PREVIOUS = { reviewId: 'r_0000000000', headSha: EARLIER };

function review(findings: Finding[], opts: ReviewOptions = {}) {
  const dispatch = vi.fn();
  render(<PanelScreen state={reviewState(findings, opts)} dispatch={dispatch} onOpenPacks={() => undefined} />);
  return { dispatch };
}
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.finding-card')];
const follows = (a: HTMLElement, b: HTMLElement) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('starting a re-review', () => {
  it('a moved head shows the banner with both buttons, and Review the push starts with since last', () => {
    const { dispatch } = review([finding(1)], { stale: true, doc: { depth: 'deep' } });
    expect(screen.getByText('New commits since this review.')).toBeTruthy();
    fireEvent.click(button('Review the push'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'start', depth: 'deep', since: 'last' });
    fireEvent.click(button('Review everything again'));
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'start', depth: 'deep' });
    expect(dispatch.mock.calls[1]![0]).not.toHaveProperty('since');
  });
  it('shows no banner, and no push button, when the head is the reviewed one', () => {
    review([finding(1)]);
    expect(screen.queryByText(/New commits/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review the push' })).toBeNull();
  });
  it('disables both buttons while busy', () => {
    review([], { stale: true, busy: true });
    expect((button('Review the push') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Review everything again') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('showing a re-review', () => {
  it('a re-review document shows the push line and a status on every card', () => {
    review(
      [finding(1, { status: 'moved' }), finding(2, { status: 'new' }), finding(3, { status: 'still-open' })],
      { doc: { previous: PREVIOUS, range: { baseSha: 'b'.repeat(40), headSha: HEAD, kind: 'rereview' } } },
    );
    const line = screen.getByText(`Review of the push ${'a'.repeat(7)} to ${'c'.repeat(7)}`);
    expect(follows(screen.getByRole('heading', { name: 'Approve after fixes' }), line)).toBe(true);
    expect(follows(line, screen.getByRole('heading', { name: 'Findings' }))).toBe(true);
    expect(cards().map((c) => within(c).getByTestId('status').textContent)).toEqual(['Moved', 'New', 'Still open']);
  });
  it('a first review shows no push line and no chips', () => {
    review([finding(1, { status: null })]);
    expect(screen.queryByText(/^Review of the/)).toBeNull();
    expect(screen.queryByTestId('status')).toBeNull();
  });
  it('an also-found line carries its status too', () => {
    review([also(2, { status: 'still-open' })], { doc: { previous: PREVIOUS } });
    fireEvent.click(button('Also found'));
    expect(screen.getByTestId('status').textContent).toBe('Still open');
  });
  it('the everything-again note is shown when the branch was rewritten', () => {
    const note = 'The branch was rewritten, so everything was reviewed again.';
    review([finding(1)], { doc: { previous: PREVIOUS, notes: [note], range: { baseSha: 'b'.repeat(40), headSha: HEAD, kind: 'full' } } });
    const shown = screen.getByText(note);
    expect(follows(screen.getByRole('heading', { name: 'Approve after fixes' }), shown)).toBe(true);
    expect(follows(shown, screen.getByRole('heading', { name: 'Findings' }))).toBe(true);
    expect(screen.queryByText(/^Review of the push/)).toBeNull();
  });
  it('a merge pushed since the earlier review has its own line', () => {
    review([finding(1)], { doc: { previous: PREVIOUS, range: { baseSha: 'b'.repeat(40), headSha: HEAD, kind: 'sync-merge' } } });
    expect(screen.getByText(`Review of the merge pushed since ${'a'.repeat(7)}: only what was changed by hand was reviewed.`)).toBeTruthy();
  });
  it('a merge review shows its heading', () => {
    const doc = {
      range: { baseSha: 'b'.repeat(40), headSha: HEAD, kind: 'sync-merge' as const },
      brief: { whatItDoes: ['Brings main in.'], claims: [] },
    };
    review([finding(1)], { doc });
    expect(screen.getByRole('heading', { name: 'A merge of main: only what was changed by hand was reviewed' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'What this does' })).toBeNull();
    cleanup();
    review([finding(1)], { doc: { brief: doc.brief } });
    expect(screen.getByRole('heading', { name: 'What this does' })).toBeTruthy();
  });
});

describe('fixed findings', () => {
  const fixed = (n: number, over: Partial<Finding> = {}): Finding =>
    finding(n, { status: 'fixed', bucket: 'also', rank: null, checked: 'The quoted code is gone; not checked further.', ...over });

  it('are listed collapsed with their reason and offer no actions', () => {
    review([finding(1)], { doc: { previous: PREVIOUS, fixed: [fixed(7), fixed(8, { checked: 'The line now reads differently.' })] } });
    const toggle = button('Fixed since the last review (2)');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Problem 7')).toBeNull();
    fireEvent.click(toggle);
    const section = toggle.closest('section')!;
    expect(within(section).getByText('Problem 7')).toBeTruthy();
    expect(within(section).getByText('src/file7.ts:70')).toBeTruthy();
    expect(within(section).getByText('The quoted code is gone; not checked further.')).toBeTruthy();
    expect(within(section).getByText('The line now reads differently.')).toBeTruthy();
    expect(within(section).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(section).queryAllByRole('button').map((b) => b.textContent)).toEqual([expect.stringContaining('Fixed since')]);
    expect(cards()).toHaveLength(1);
    // Fixed findings are not in the selection, so nothing can post or copy them.
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });
  it('are absent when none was fixed', () => {
    review([finding(1)], { doc: { previous: PREVIOUS, fixed: [] } });
    expect(screen.queryByRole('button', { name: /^Fixed since/ })).toBeNull();
  });
});

describe('marks that follow a finding into the next review', () => {
  it('a posted finding stays marked in the next review under an alias', () => {
    const f = finding(1, { fingerprint: '1'.repeat(16), aliases: ['2'.repeat(16)], status: 'still-open' });
    review([f], { doc: { previous: PREVIOUS }, posts: [recordOf(['2'.repeat(16)])] });
    expect(within(cards()[0]!).getByText(/Posted/)).toBeTruthy();
  });
  it('a dismissed finding stays dismissed in the next review under an alias', () => {
    const f = finding(1, { fingerprint: '1'.repeat(16), aliases: ['2'.repeat(16)], status: 'still-open' });
    review([f], {
      doc: { previous: PREVIOUS },
      dismissals: [{
        fingerprint: '2'.repeat(16), findingId: 'c_00000009', reviewId: 'r_0000000000', reason: 'wrong', text: '',
        at: '2026-11-11T00:00:00.000Z', learned: null,
      }],
    });
    expect(cards()).toHaveLength(0);
    expect(button('Dismissed: 1')).toBeTruthy();
  });
});
