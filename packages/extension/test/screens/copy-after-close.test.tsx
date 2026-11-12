// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandBox } from '../../src/screens/CommandBox';
import { CopyButton } from '../../src/screens/CopyButton';
import { FakeTimers } from '../helpers/fake-timers';

const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  cleanup();
  if (original) Object.defineProperty(navigator, 'clipboard', original);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

/** A clipboard whose write is answered only when the test says so. */
function slowClipboard(): { answer: () => void } {
  let answer = (): void => undefined;
  const writeText = vi.fn(() => new Promise<void>((resolve) => { answer = resolve; }));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return { answer: () => answer() };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('a copy answered after the screen is gone (fix round)', () => {
  it('starts no timer in the command box', async () => {
    const clipboard = slowClipboard();
    const timers = new FakeTimers();
    const view = render(<CommandBox intro="Run:" command="npm run service" timers={timers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    view.unmount();
    clipboard.answer();
    await settle();
    expect(timers.pending.size).toBe(0);
  });

  it('starts no timer in a copy button', async () => {
    const clipboard = slowClipboard();
    const timers = new FakeTimers();
    const view = render(<CopyButton text={() => 'prompt'} label="Copy fix prompt" timers={timers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy fix prompt' }));
    view.unmount();
    clipboard.answer();
    await settle();
    expect(timers.pending.size).toBe(0);
  });

  it('still says Copied for two seconds while the screen is there', async () => {
    const clipboard = slowClipboard();
    const timers = new FakeTimers();
    render(<CommandBox intro="Run:" command="npm run service" timers={timers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    clipboard.answer();
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
    expect(timers.delays()).toEqual([2_000]);
  });
});
