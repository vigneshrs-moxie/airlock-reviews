// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelScreen } from '../../src/screens/PanelScreen';
import type { PanelState } from '../../src/state/reduce';
import { prSummary } from './fixtures';
import { finding, reviewState } from './review-fixtures';
import { tick } from './review-dom';

afterEach(cleanup);

function mount(state: PanelState) {
  const dispatch = vi.fn();
  const view = render(<PanelScreen state={state} dispatch={dispatch} onOpenSettings={() => undefined} />);
  const flip = (next: PanelState): void => view.rerender(<PanelScreen state={next} dispatch={dispatch} onOpenSettings={() => undefined} />);
  return { dispatch, flip };
}

const ticked = (): string[] =>
  screen.getAllByRole('checkbox').filter((c) => (c as HTMLInputElement).checked).map((c) => c.getAttribute('aria-label') ?? '');
const backButton = () => screen.queryByRole('button', { name: 'Back to the review' });

describe('a flip to offline and back keeps the screen (fix round)', () => {
  it('keeps the open finding and the ticked findings of a review', () => {
    const shown = reviewState([finding(1), finding(2), finding(3)]);
    const { flip } = mount(shown);
    tick('Problem 1');
    tick('Problem 2');
    fireEvent.click(document.querySelectorAll<HTMLButtonElement>('.finding-card .open')[2]!);
    expect(backButton()).not.toBeNull();

    flip({ kind: 'offline', review: { pr: shown.pr, latest: shown.latest, stale: shown.stale } });
    expect(screen.getByText("Airlock's service on this Mac is not running.")).toBeTruthy();
    expect(backButton()).not.toBeNull();

    flip(shown);
    expect(screen.queryByText("Airlock's service on this Mac is not running.")).toBeNull();
    expect(backButton()).not.toBeNull();
    fireEvent.click(backButton()!);
    expect(ticked()).toEqual(['Select: Problem 1', 'Select: Problem 2']);
  });

  it('keeps the depth and the pack choices of Ready, with Review unavailable while offline', () => {
    const pr = prSummary({ packs: [{ id: 'generic', title: 'Generic' }, { id: 'orbit', title: 'Orbit' }] });
    const { flip, dispatch } = mount({ kind: 'ready', pr });
    fireEvent.click(screen.getByRole('radio', { name: /Deep/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Packs' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Orbit' }));

    flip({ kind: 'offline', ready: pr });
    expect(screen.getByText("Airlock's service on this Mac is not running.")).toBeTruthy();
    expect((screen.getByRole('radio', { name: /Deep/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('switch', { name: 'Orbit' }) as HTMLInputElement).checked).toBe(false);
    const review = screen.getByRole('button', { name: 'Review this pull request' }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);

    flip({ kind: 'ready', pr });
    expect((screen.getByRole('radio', { name: /Deep/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('switch', { name: 'Orbit' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Review this pull request' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'start', depth: 'deep', packIds: ['generic'] });
  });
});
