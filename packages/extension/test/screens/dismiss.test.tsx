// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DismissBody, Finding } from '@airlock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelScreen } from '../../src/screens/PanelScreen';
import type { PanelState } from '../../src/state/reduce';
import { dismissal, finding, reviewState, type ReviewOptions } from './review-fixtures';

afterEach(cleanup);

const WRONG_LINE = 'Flagged "Problem 1" in src/file1.ts. Wrong because: ';

function mount(findings: Finding[], opts: ReviewOptions = {}) {
  const dispatch = vi.fn();
  const view = render(<PanelScreen state={reviewState(findings, opts)} dispatch={dispatch} onOpenPacks={() => undefined} />);
  const rerender = (state: PanelState): void => view.rerender(<PanelScreen state={state} dispatch={dispatch} onOpenPacks={() => undefined} />);
  return { ...view, dispatch, rerender };
}

/** Opens the first finding and its Dismiss sheet. */
function open(findings: Finding[] = [finding(1)], opts: ReviewOptions = {}) {
  const m = mount(findings, opts);
  fireEvent.click(document.querySelector('.finding-card button')!);
  const opener = screen.getByRole('button', { name: 'Dismiss' });
  opener.focus();
  fireEvent.click(opener);
  return { ...m, opener, dialog: screen.getByRole('dialog') };
}

const radio = (name: string) => screen.getByRole('radio', { name });
const field = () => screen.getByRole('textbox', { name: 'The line that will be saved to your pack' }) as HTMLTextAreaElement;
const save = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
const type = (value: string) => fireEvent.change(field(), { target: { value } });
const bodyOf = (dispatch: ReturnType<typeof vi.fn>): DismissBody => dispatch.mock.calls[0]![0].body as DismissBody;

describe('the dismiss sheet', () => {
  it('shows the title, three reasons with their lines, and nothing chosen with Save disabled', () => {
    const { dialog } = open();
    expect(within(dialog).getByText('Problem 1')).toBeTruthy();
    expect(within(dialog).getByRole('radiogroup')).toBeTruthy();
    expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).checked)).toEqual([false, false, false]);
    expect(radio('Wrong').getAttribute('aria-describedby')).toBeTruthy();
    expect(within(dialog).getByText('The finding is mistaken. Saved to your pack so the same mistake is not made again.')).toBeTruthy();
    expect(within(dialog).getByText('The code is right for a reason the reviewer could not know. Saved to your pack as a product fact.')).toBeTruthy();
    expect(within(dialog).getByText('Hide it on this pull request only. Nothing is saved to your pack.')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(save().disabled).toBe(true);
  });

  it('not now saves without any text', () => {
    const { dispatch } = open();
    fireEvent.click(radio('Not now'));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    expect(dispatch).toHaveBeenCalledWith({
      type: 'dismiss',
      body: { repo: 'acme/widgets', number: 1, reviewId: 'r_0000000001', findingId: 'c_00000001', reason: 'not-now', text: '' },
    });
  });

  it('wrong starts from a draft with the title and path, and needs the reason typed after it', () => {
    open();
    fireEvent.click(radio('Wrong'));
    expect(field().value).toBe(WRONG_LINE);
    expect(screen.getByText('This line is given to the reviewer as an instruction in every later review of this repository. Write it so it is true on its own.')).toBeTruthy();
    expect(save().disabled).toBe(true);
    expect(screen.getByText('The text starts or ends with a space; remove it.')).toBeTruthy();
    type(`${WRONG_LINE}the cart is never empty here`);
    expect(save().disabled).toBe(false);
    expect(screen.queryByText('The text starts or ends with a space; remove it.')).toBeNull();
  });

  it('collapses whitespace in the title and cuts it to 120 characters', () => {
    open([finding(1, { title: `Spaced\n   out ${'x'.repeat(200)}` })]);
    fireEvent.click(radio('Wrong'));
    expect(field().value).toBe(`Flagged "Spaced out ${'x'.repeat(120 - 'Spaced out '.length)}…" in src/file1.ts. Wrong because: `);
  });

  it('shows a title with markup or a quotation mark as plain characters', () => {
    const title = '<img src=x onerror=alert(1)> "quoted"';
    open([finding(1, { title })]);
    fireEvent.click(radio('Wrong'));
    expect(field().value).toBe(`Flagged "${title}" in src/file1.ts. Wrong because: `);
    expect(document.querySelector('.sheet img')).toBeNull();
  });

  it('intended starts empty with a placeholder', () => {
    open();
    fireEvent.click(radio('Intended'));
    expect(field().value).toBe('');
    expect(field().placeholder).toBe('The product fact the reviewer did not know');
    expect(screen.getByText('The text needs at least 10 characters.')).toBeTruthy();
    expect(save().disabled).toBe(true);
  });

  it('keeps what was typed when switching between wrong and intended', () => {
    open();
    fireEvent.click(radio('Intended'));
    type('Totals are rounded on purpose');
    fireEvent.click(radio('Wrong'));
    expect(field().value).toBe('Totals are rounded on purpose');
    fireEvent.click(radio('Intended'));
    expect(field().value).toBe('Totals are rounded on purpose');
  });

  it('replaces an untouched draft when the reason changes', () => {
    open();
    fireEvent.click(radio('Wrong'));
    fireEvent.click(radio('Intended'));
    expect(field().value).toBe('');
  });

  it('turns a pasted line break into a space', () => {
    open();
    fireEvent.click(radio('Intended'));
    type('first line\nsecond line\r\nthird');
    expect(field().value).toBe('first line second line third');
  });

  it('shows the count and the rule sentence as the field changes, tied to the field', () => {
    open();
    fireEvent.click(radio('Intended'));
    type('short');
    expect(screen.getByText('5 of 500')).toBeTruthy();
    const sentence = screen.getByText('The text needs at least 10 characters.');
    expect(field().getAttribute('aria-describedby')).toBe(sentence.id);
    type('y'.repeat(501));
    expect(screen.getByText('501 of 500')).toBeTruthy();
    expect(screen.getByText('The text is longer than 500 characters.')).toBeTruthy();
    expect(save().disabled).toBe(true);
    type('y'.repeat(500));
    expect(screen.getByText('500 of 500')).toBeTruthy();
    expect(field().getAttribute('aria-describedby')).toBeNull();
    expect(save().disabled).toBe(false);
  });

  it('sends exactly the text in the field', () => {
    const { dispatch } = open();
    fireEvent.click(radio('Intended'));
    const text = '  odd <b>text</b> "quoted" & more  '.trim();
    type(text);
    fireEvent.click(save());
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'dismiss',
      body: { repo: 'acme/widgets', number: 1, reviewId: 'r_0000000001', findingId: 'c_00000001', reason: 'intended', text },
    });
    expect(bodyOf(dispatch).text).toBe(field().value);
  });

  it('wrong sends the draft with the typed reason', () => {
    const { dispatch } = open();
    fireEvent.click(radio('Wrong'));
    type(`${WRONG_LINE}the guard is two lines up`);
    fireEvent.click(save());
    expect(bodyOf(dispatch)).toEqual({
      repo: 'acme/widgets', number: 1, reviewId: 'r_0000000001', findingId: 'c_00000001', reason: 'wrong',
      text: `${WRONG_LINE}the guard is two lines up`,
    });
  });

  it('on a refusal, stays open with the notice and the text', () => {
    const { rerender } = open();
    fireEvent.click(radio('Intended'));
    type('Totals are rounded on purpose');
    fireEvent.click(save());
    rerender({ ...reviewState([finding(1)]), notice: 'That pack cannot be written.' });
    expect(within(screen.getByRole('dialog')).getByText('That pack cannot be written.')).toBeTruthy();
    expect(field().value).toBe('Totals are rounded on purpose');
    expect(screen.queryByText(/^Saved to/)).toBeNull();
  });

  it('on a success shows the pack title, and Undo restores and returns to the form with the text', () => {
    const f = finding(1);
    const { rerender, dispatch } = open([f]);
    fireEvent.click(radio('Intended'));
    type('Totals are rounded on purpose');
    fireEvent.click(save());
    const done = dismissal(f, { reason: 'intended', text: 'Totals are rounded on purpose', learned: { packId: 'orbit', kind: 'intended', date: '2026-11-11' } });
    rerender(reviewState([f], { dismissals: [done] }));
    expect(within(screen.getByRole('dialog')).getByText('Saved to Orbit.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'restore', fingerprint: f.fingerprint });
    rerender(reviewState([f]));
    expect(field().value).toBe('Totals are rounded on purpose');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('names the pack by id when it has no title, and says a hidden finding is hidden', () => {
    const f = finding(1);
    const { rerender } = open([f]);
    fireEvent.click(radio('Wrong'));
    type(`${WRONG_LINE}it is fine`);
    fireEvent.click(save());
    rerender(reviewState([f], { dismissals: [dismissal(f, { learned: { packId: 'mystery', kind: 'wrong', date: '2026-11-11' } })] }));
    expect(within(screen.getByRole('dialog')).getByText('Saved to mystery.')).toBeTruthy();
  });

  it('says Hidden on this pull request for not now, and Done closes the sheet', () => {
    const f = finding(1);
    const { rerender } = open([f, finding(2)]);
    fireEvent.click(radio('Not now'));
    fireEvent.click(save());
    rerender(reviewState([f, finding(2)], { dismissals: [dismissal(f, { reason: 'not-now' })] }));
    expect(within(screen.getByRole('dialog')).getByText('Hidden on this pull request.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('announces the result in the live region', () => {
    const f = finding(1);
    const { rerender } = open([f, finding(2)]);
    fireEvent.click(radio('Not now'));
    fireEvent.click(save());
    rerender(reviewState([f, finding(2)], { dismissals: [dismissal(f, { reason: 'not-now' })] }));
    expect(document.querySelector('[aria-live]')?.textContent).toBe('Hidden on this pull request.');
  });

  it('disables Save while busy, and Undo while busy', () => {
    const f = finding(1);
    const { rerender } = open([f]);
    fireEvent.click(radio('Not now'));
    rerender(reviewState([f], { busy: true }));
    expect(save().disabled).toBe(true);
    rerender(reviewState([f], { dismissals: [dismissal(f, { reason: 'not-now' })], busy: true }));
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes on Escape and gives focus back to the finding\'s Dismiss button', () => {
    const { opener } = open();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('opens one sheet at a time over the review', () => {
    open();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});
