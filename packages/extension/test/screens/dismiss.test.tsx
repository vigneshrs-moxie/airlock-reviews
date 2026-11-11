// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DismissBody, Finding } from '@airlock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelScreen } from '../../src/screens/PanelScreen';
import type { PanelState } from '../../src/state/reduce';
import { Verdict } from '../../src/screens/Verdict';
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

const offlineOf = (r: ReturnType<typeof reviewState>): PanelState => ({ kind: 'offline', review: { pr: r.pr, latest: r.latest, stale: false } });
const dlg = () => within(screen.getByRole('dialog'));
const KEPT = 'Airlock could not reach its service. Your line is kept.';

describe('the sheet keeps the typed line (fix round 1)', () => {
  it('stays open over a kept review when the service goes away, with Save disabled, and is usable again', () => {
    const { rerender } = open();
    fireEvent.click(radio('Intended'));
    type('Totals are rounded on purpose');
    rerender(offlineOf(reviewState([finding(1)])));
    expect(dlg().getByText(KEPT)).toBeTruthy();
    expect(field().value).toBe('Totals are rounded on purpose');
    expect(save().disabled).toBe(true);
    rerender(reviewState([finding(1)]));
    expect(screen.queryByText(KEPT)).toBeNull();
    expect(field().value).toBe('Totals are rounded on purpose');
    expect(save().disabled).toBe(false);
  });

  it.each([
    ['unpaired', { kind: 'unpaired' } as PanelState],
    ['loading', { kind: 'loading' } as PanelState],
    ['problem', { kind: 'problem', pr: null, message: 'No.' } as PanelState],
  ])('hides the sheet in %s but brings it back with its text', (_name, away) => {
    const { rerender } = open();
    fireEvent.click(radio('Intended'));
    type('Totals are rounded on purpose');
    rerender(away);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(reviewState([finding(1)]));
    expect(field().value).toBe('Totals are rounded on purpose');
    expect((radio('Intended') as HTMLInputElement).checked).toBe(true);
  });

  it('is cleared by Cancel: the next sheet starts empty', () => {
    const { rerender } = open();
    fireEvent.click(radio('Intended'));
    type('Totals are rounded on purpose');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    rerender({ kind: 'unpaired' });
    rerender(reviewState([finding(1)]));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('a sheet acts only on the review it was opened on', () => {
  it('becomes read-only when a different review is on screen', () => {
    const { rerender, dispatch } = open();
    fireEvent.click(radio('Intended'));
    type('Totals are rounded on purpose');
    rerender(reviewState([finding(1)], { doc: { id: 'r_0000000002' } }));
    const d = dlg();
    expect(d.getByText('This review is no longer the one on screen, so this line cannot be saved to it.')).toBeTruthy();
    expect(d.getByText('Totals are rounded on purpose')).toBeTruthy();
    expect(d.getByRole('button', { name: 'Copy line' })).toBeTruthy();
    expect((d.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect((d.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(d.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('becomes read-only when the finding is no longer in the review', () => {
    const { rerender } = open([finding(1), finding(2)]);
    fireEvent.click(radio('Not now'));
    rerender(reviewState([finding(2)]));
    expect(dlg().getByText('This review is no longer the one on screen, so this line cannot be saved to it.')).toBeTruthy();
  });

  it('sends the review id of the document it was opened on', () => {
    const { rerender, dispatch } = open();
    fireEvent.click(radio('Not now'));
    rerender(reviewState([finding(1)], { notice: 'Something else.' }));
    fireEvent.click(save());
    expect(bodyOf(dispatch).reviewId).toBe('r_0000000001');
  });
});

describe('what the sheet says after Save and Undo (fix round 1)', () => {
  const learned = { packId: 'orbit', kind: 'intended' as const, date: '2026-11-11' };
  function saved() {
    const f = finding(1);
    const m = open([f]);
    fireEvent.click(radio('Intended'));
    type('Totals are rounded on purpose');
    fireEvent.click(save());
    const done = dismissal(f, { reason: 'intended', text: 'Totals are rounded on purpose', learned });
    m.rerender(reviewState([f], { dismissals: [done] }));
    return { ...m, f, done };
  }

  it('shows a refused Undo as an alert and keeps the result line', () => {
    const { rerender, f, done } = saved();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    rerender(reviewState([f], { dismissals: [done], notice: 'Could not undo that.' }));
    expect(dlg().getByRole('alert').textContent).toBe('Could not undo that.');
    expect(dlg().getByText('Saved to Orbit.')).toBeTruthy();
  });

  it('shows the note that comes with a restore as plain information', () => {
    const { rerender, f } = saved();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    rerender(reviewState([f], { notice: 'The saved line was no longer there.' }));
    expect(field().value).toBe('Totals are rounded on purpose');
    expect(dlg().getByText('The saved line was no longer there.')).toBeTruthy();
    expect(within(screen.getByRole('dialog')).queryByRole('alert')).toBeNull();
  });

  it('does not show another finding\'s dismissal as this sheet\'s result', () => {
    const { rerender } = open([finding(1), finding(2)]);
    fireEvent.click(radio('Not now'));
    rerender(reviewState([finding(1), finding(2)], { dismissals: [dismissal(finding(2), { reason: 'not-now' })] }));
    expect(screen.queryByText('Hidden on this pull request.')).toBeNull();
    expect(save()).toBeTruthy();
  });

  it('clears a refusal at the next edit or change of reason', () => {
    const { rerender } = open();
    fireEvent.click(radio('Intended'));
    type('Totals are rounded on purpose');
    fireEvent.click(save());
    rerender({ ...reviewState([finding(1)]), notice: 'Refused once.' });
    expect(dlg().getByText('Refused once.')).toBeTruthy();
    type('Totals are rounded on purpose!');
    expect(within(screen.getByRole('dialog')).queryByText('Refused once.')).toBeNull();
    rerender({ ...reviewState([finding(1)]), notice: 'Refused twice.' });
    fireEvent.click(radio('Wrong'));
    expect(within(screen.getByRole('dialog')).queryByText('Refused twice.')).toBeNull();
  });

  it('still shows a refusal worded exactly like the notice before it', () => {
    const { rerender } = open([finding(1)], { notice: 'Same words.' });
    fireEvent.click(radio('Not now'));
    fireEvent.click(save());
    rerender(reviewState([finding(1)], { notice: 'Same words.', busy: true }));
    rerender(reviewState([finding(1)], { notice: 'Same words.' }));
    expect(dlg().getByText('Same words.')).toBeTruthy();
  });
});

describe('closing', () => {
  it('cannot happen while a save is in flight', () => {
    const { rerender } = open();
    fireEvent.click(radio('Not now'));
    rerender(reviewState([finding(1)], { busy: true }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(document.querySelector('.sheet')!);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('dialog')).toBeTruthy();
    rerender(reviewState([finding(1)]));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cannot happen with Done while an undo is in flight', () => {
    const f = finding(1);
    const { rerender } = open([f, finding(2)]);
    fireEvent.click(radio('Not now'));
    rerender(reviewState([f, finding(2)], { dismissals: [dismissal(f, { reason: 'not-now' })], busy: true }));
    expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('returns focus to the Dismiss button after Cancel', () => {
    const { opener } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(opener);
  });

  it('puts focus on the next finding\'s card after Done on a saved dismissal', () => {
    const f = finding(1);
    const { rerender } = open([f, finding(2)]);
    fireEvent.click(radio('Not now'));
    fireEvent.click(save());
    rerender(reviewState([f, finding(2)], { dismissals: [dismissal(f, { reason: 'not-now' })] }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(document.activeElement).toBe(document.querySelector('.finding-card button'));
    expect(document.activeElement?.textContent).toContain('Problem 2');
  });

  it('puts focus on a heading when no finding is left', () => {
    const f = finding(1);
    const { rerender } = open([f]);
    fireEvent.click(radio('Not now'));
    fireEvent.click(save());
    rerender(reviewState([f], { dismissals: [dismissal(f, { reason: 'not-now' })] }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(document.activeElement?.tagName).toBe('H2');
  });
});

describe('the field', () => {
  it('does nothing on Enter', () => {
    const { dispatch } = open();
    fireEvent.click(radio('Intended'));
    type('Totals are rounded');
    const proceeded = fireEvent.keyDown(field(), { key: 'Enter' });
    expect(proceeded).toBe(false);
    expect(field().value).toBe('Totals are rounded');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('sends inner double spaces, a decomposed accent and an emoji unchanged', () => {
    const { dispatch } = open();
    fireEvent.click(radio('Intended'));
    const text = 'Keep  two  spaces, cafe\u0301 and \u{1F600} as typed';
    type(text);
    fireEvent.click(save());
    expect(bodyOf(dispatch).text).toBe(text);
    expect([...bodyOf(dispatch).text]).toEqual([...text]);
  });

  it.each([
    ['a leading space', ' starts with a space here', 'The text starts or ends with a space; remove it.'],
    ['a trailing space', 'ends with a space here ', 'The text starts or ends with a space; remove it.'],
    ['a forbidden character', 'has a bell\u0007 in the middle', 'The text has a control, invisible or line-break character; use plain characters on one line.'],
  ])('disables Save and gives the rule for %s', (_n, text, sentence) => {
    open();
    fireEvent.click(radio('Intended'));
    type(text);
    expect(save().disabled).toBe(true);
    expect(screen.getByText(sentence)).toBeTruthy();
  });

  it.each([
    ['a line break', 'Two\nlines'],
    ['a zero-width character', 'Zero\u200bwidth'],
    ['a right-to-left override', 'Over\u202eride'],
    ['the draft\'s own words', 'x. Wrong because: y'],
  ])('keeps Save disabled for a draft built from a title with %s', (_n, title) => {
    open([finding(1, { title })]);
    fireEvent.click(radio('Wrong'));
    expect(save().disabled).toBe(true);
    expect(field().value.endsWith('Wrong because: ')).toBe(true);
  });

  it('shows the count and the sentence when a long path pushes the draft past 500', () => {
    open([finding(1, { path: `src/${'p'.repeat(500)}.ts` })]);
    fireEvent.click(radio('Wrong'));
    expect(screen.getByText(`${[...field().value].length} of 500`)).toBeTruthy();
    expect(screen.getByText('The text starts or ends with a space; remove it.')).toBeTruthy();
    type(`${field().value}x`);
    expect(screen.getByText('The text is longer than 500 characters.')).toBeTruthy();
    expect(save().disabled).toBe(true);
  });
});

describe('Verdict on its own', () => {
  it('still calls its onDismiss prop with the finding', () => {
    const onDismiss = vi.fn();
    const f = finding(1);
    render(<Verdict state={reviewState([f])} dispatch={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.click(document.querySelector('.finding-card button')!);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledWith(f);
  });
});
