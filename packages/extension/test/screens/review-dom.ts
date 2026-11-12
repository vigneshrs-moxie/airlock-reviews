import { fireEvent, screen } from '@testing-library/react';

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One of the review's three tabs, by its words ("Findings" matches "Findings · n"). */
export const tab = (name: 'Findings' | 'The change' | 'More'): HTMLElement =>
  screen.getByRole('tab', { name: name === 'Findings' ? /^Findings · \d+$/ : name });

export const chooseTab = (name: 'Findings' | 'The change' | 'More'): void => { fireEvent.click(tab(name)); };

/** A fold's button by its title; its name goes on with the count. */
export const fold = (title: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^${escape(title)}( .*)?$`) });
export const queryFold = (title: string): HTMLElement | null => screen.queryByRole('button', { name: new RegExp(`^${escape(title)}( .*)?$`) });

/** Opens a fold when it is closed, and gives its button. */
export function openFold(title: string): HTMLElement {
  const button = fold(title);
  if (button.getAttribute('aria-expanded') === 'false') fireEvent.click(button);
  return button;
}

/** The section a fold holds, with its button. */
export const foldSection = (title: string): HTMLElement => fold(title).closest('section')!;

/** Ticks a finding by its full title, pressing Select first when the rows have no checkboxes yet. */
export function tick(title: string): void {
  if (screen.queryAllByRole('checkbox').length === 0) fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(`${escape(title)}$`) }));
}

/** The rows of the findings tab: top, then also found when it is open. */
export const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.finding-card')];

/** The verdict strip. */
export const strip = (): HTMLElement => document.querySelector<HTMLElement>('.ap-verdict')!;
