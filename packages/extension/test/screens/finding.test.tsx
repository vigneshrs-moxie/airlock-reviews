// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Finding, PostRecord } from '@airlock/shared';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetFindingFolds } from '../../src/screens/finding-folds';
import { CAPTION, FindingDetail, type FindingDetailProps, type OnJump } from '../../src/screens/FindingDetail';
import { PanelScreen } from '../../src/screens/PanelScreen';
import { WAIT } from '../../src/screens/PostedMark';
import { recordOf } from '../helpers/post-fixtures';
import { finding, reviewState, type ReviewOptions } from './review-fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  forgetFindingFolds();
});

const PACKS = [{ id: 'generic', title: 'Generic' }];
const notConnected: OnJump = () => Promise.resolve({ sentence: 'Jumping is not connected yet.', needsReload: false });
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const heading = (name: string | RegExp) => screen.getByRole('heading', { name });
const fold = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const actions = (): HTMLElement => document.querySelector<HTMLElement>('.ap-bar')!;
const describedBy = (node: HTMLElement): string | null | undefined => document.getElementById(node.getAttribute('aria-describedby') ?? '')?.textContent;
const follows = (a: HTMLElement, b: HTMLElement) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/** The finding screen on its own, moving between `findings` as the review screen does (keyed on the finding). */
function Harness({ findings, extra }: { findings: Finding[]; extra?: Partial<FindingDetailProps> }) {
  const [at, setAt] = useState(0);
  const f = findings[at]!;
  return (
    <FindingDetail
      key={f.id} finding={f} packs={PACKS} previous={findings[at - 1] ?? null} next={findings[at + 1] ?? null}
      position={{ index: at + 1, total: findings.length }} canDismiss fixPrompt={() => `Prompt for ${f.title}`} onBack={() => undefined}
      onOpen={(g) => setAt(findings.indexOf(g))} onJump={notConnected} changedPaths={new Set([f.path])} onDismiss={() => undefined}
      {...extra}
    />
  );
}

const detail = (findings: Finding[], extra?: Partial<FindingDetailProps>) => render(<Harness findings={findings} {...(extra ? { extra } : {})} />);

/** The panel on a review, with the first finding open. */
function panelOn(findings: Finding[], opts: ReviewOptions = {}) {
  const dispatch = vi.fn();
  const view = render(<PanelScreen state={reviewState(findings, opts)} dispatch={dispatch} onOpenSettings={() => undefined} />);
  fireEvent.click(document.querySelector('.finding-card button')!);
  return { ...view, dispatch };
}

describe('the top row', () => {
  it('has Review with a back chevron, n of m, and Previous and Next finding, disabled at the ends', () => {
    detail([finding(1), finding(2), finding(3)]);
    const back = button('Back to the review');
    expect(back.textContent).toBe('Review');
    expect(back.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('1 of 3')).toBeTruthy();
    expect(button('Previous finding').disabled).toBe(true);
    expect(button('Next finding').disabled).toBe(false);
    fireEvent.click(button('Next finding'));
    expect(screen.getByText('2 of 3')).toBeTruthy();
    expect(heading('Problem 2')).toBeTruthy();
    expect(document.activeElement).toBe(heading('Problem 2'));
    fireEvent.click(button('Next finding'));
    expect(screen.getByText('3 of 3')).toBeTruthy();
    expect(button('Next finding').disabled).toBe(true);
    fireEvent.click(button('Previous finding'));
    expect(screen.getByText('2 of 3')).toBeTruthy();
  });

  it('says no position when none is given', () => {
    render(
      <FindingDetail
        finding={finding(1)} packs={PACKS} previous={null} next={null} canDismiss fixPrompt={() => ''} onBack={() => undefined}
        onOpen={() => undefined} onJump={notConnected} changedPaths={new Set()} onDismiss={() => undefined}
      />,
    );
    expect(screen.queryByText(/ of /)).toBeNull();
    expect(button('Previous finding').disabled).toBe(true);
  });

  it('goes back with Review', () => {
    const onBack = vi.fn();
    detail([finding(1)], { onBack });
    fireEvent.click(button('Back to the review'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('the short version', () => {
  it('shows the kind as a word, the short title, the place with Show in diff, the summary and what to do, in that order', () => {
    detail([finding(1, {
      severity: 'block', short: 'The guard is skipped', gist: 'A paused account can still order.', suggestedChange: 'Call the guard first.',
    })]);
    const kind = screen.getByText('Block');
    expect(kind.className).toContain('sev-block');
    const title = heading('The guard is skipped');
    const place = screen.getByText('src/file1.ts:10', { selector: '.ap-where code span' });
    const summary = screen.getByText('A paused account can still order.');
    const todo = heading('What to do');
    const order = [kind, title, place, button('Show in diff'), summary, todo, screen.getByText('Call the guard first.'), fold('What happens')];
    for (const [i, node] of order.slice(1).entries()) expect(follows(order[i]!, node), node.textContent ?? '').toBe(true);
    expect(todo.closest('.ap-do')).not.toBeNull();
  });

  it('falls back to the title and the first sentence of what happens', () => {
    detail([finding(1, { title: 'Pause skips the guard', happens: 'A paused account can still order. The guard is never asked.' })]);
    expect(heading('Pause skips the guard')).toBeTruthy();
    expect(screen.getByText('A paused account can still order.', { selector: '.ap-short' })).toBeTruthy();
  });

  it('leaves What to do out when there is no suggested change', () => {
    detail([finding(1, { suggestedChange: '  ' })]);
    expect(screen.queryByRole('heading', { name: 'What to do' })).toBeNull();
  });

  it('shows the whole title as the first line of What happens when the shown title is shorter', () => {
    const title = 'The pause handler calls the billing guard only after the account state is written, so a paused account can still order.';
    detail([finding(1, { title, happens: 'Happens.' })]);
    expect(screen.queryByText(title)).toBeNull();
    fireEvent.click(fold('What happens'));
    const whole = screen.getByText(title);
    expect(follows(whole, screen.getByText('Happens.', { selector: '.ap-folded p' }))).toBe(true);
  });

  it('does not repeat the title in What happens when it is shown whole', () => {
    detail([finding(1)]);
    fireEvent.click(fold('What happens'));
    expect(screen.getAllByText('Problem 1')).toHaveLength(1);
  });

  it('shows a short title or a gist with markup as plain characters', () => {
    const evil = '<img src=x onerror=alert(1)><a href="javascript:x">y</a>';
    detail([finding(1, { short: evil, gist: `${evil} <script>alert(1)</script>` })]);
    expect(heading(evil)).toBeTruthy();
    expect(screen.getByText(`${evil} <script>alert(1)</script>`, { selector: '.ap-short' })).toBeTruthy();
    for (const tag of ['img', 'a', 'script']) expect(document.querySelector(tag), tag).toBeNull();
  });
});

describe('the folds', () => {
  const full = finding(1, {
    connected: [{ path: 'src/other.ts', line: 7, role: 'caller', quote: '' }], wouldBeWrongIf: 'Callers round first.',
    alsoRaisedBy: [{ pack: 'orbit', lens: null, ruleId: 'R-7' }],
  });

  it('are closed at first, each a button with aria-expanded, The code with its place and Also involves with its count', () => {
    detail([full]);
    const names = [...document.querySelectorAll('.ap-fold')].map((b) => b.textContent);
    expect(names).toEqual(['What happens', 'Why it matters', 'The codesrc/file1.ts:10', 'Also involves1', 'How sure is this']);
    // The place under the title is shown whole as text; only its display is cut, at the start, when the row is too narrow.
    const place = document.querySelector('.ap-where code')!;
    expect(place.textContent).toBe('src/file1.ts:10');
    expect(place.classList.contains('ap-end')).toBe(true);
    for (const b of document.querySelectorAll('.ap-fold')) expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Happens 1.', { selector: '.ap-folded p' })).toBeNull();
    fireEvent.click(fold('Why it matters'));
    expect(fold('Why it matters').getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(fold('Why it matters').getAttribute('aria-controls')!)?.textContent).toBe('Why 1.');
    fireEvent.click(fold('Why it matters'));
    expect(fold('Why it matters').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Why 1.')).toBeNull();
  });

  it('The code shows the whole place first, then the code', () => {
    const path = `src/${'very-long-folder-name/'.repeat(6)}pause.ts`;
    detail([finding(1, { path })]);
    fireEvent.click(fold('The code'));
    const folded = fold('The code').closest('section')!.querySelector('.ap-folded')!;
    const whole = within(folded as HTMLElement).getByText(`${path}:10`);
    expect(whole.classList.contains('ap-end')).toBe(false);
    expect(follows(whole, within(folded as HTMLElement).getByText('code 1;'))).toBe(true);
  });

  it('How sure is this holds Checked, It would be wrong if, From and Also raised by', () => {
    detail([full]);
    fireEvent.click(fold('How sure is this'));
    const proof = fold('How sure is this').closest('section')!;
    expect([...proof.querySelectorAll('h4')].map((h) => h.textContent)).toEqual(['Checked', 'It would be wrong if', 'From', 'Also raised by']);
    expect(within(proof).getByText('Checked 1.')).toBeTruthy();
    expect(within(proof).getByText('Callers round first.')).toBeTruthy();
    expect(within(proof).getByText('Generic · correctness')).toBeTruthy();
    expect(within(proof).getByText('orbit · R-7')).toBeTruthy();
  });

  it('Also involves still jumps to each place', async () => {
    const onJump = vi.fn().mockResolvedValue({ sentence: 'Opened src/other.ts.', needsReload: false });
    detail([full], { onJump });
    fireEvent.click(fold('Also involves'));
    fireEvent.click(button(/src\/other\.ts:7/));
    expect(onJump).toHaveBeenCalledWith({ path: 'src/other.ts', line: 7, kind: 'elsewhere' }, { reload: false });
    expect(await screen.findByText('Opened src/other.ts.')).toBeTruthy();
  });

  it('stay as they were across Previous and Next, and when the person comes back to the finding', () => {
    panelOn([finding(1), finding(2), finding(3)]);
    fireEvent.click(fold('The code'));
    fireEvent.click(fold('How sure is this'));
    fireEvent.click(button('Next finding'));
    expect(heading('Problem 2')).toBeTruthy();
    const open = (): string[] => [...document.querySelectorAll('.ap-fold[aria-expanded="true"]')].map((b) => b.textContent ?? '');
    expect(open()).toEqual(['The codesrc/file2.ts:20', 'How sure is this']);
    expect(screen.getByText('code 2;')).toBeTruthy();
    fireEvent.click(fold('The code'));
    fireEvent.click(button('Previous finding'));
    expect(heading('Problem 1')).toBeTruthy();
    expect(open()).toEqual(['How sure is this']);
    fireEvent.click(button('Back to the review'));
    fireEvent.click(document.querySelector('.finding-card button')!);
    expect(open()).toEqual(['How sure is this']);
  });
});

describe('the pinned actions', () => {
  it('are three buttons with a quiet line each, at the end of the screen', () => {
    detail([finding(1)]);
    const bar = actions();
    expect(bar.closest('.ap-pinned')).not.toBeNull();
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['Copy fix prompt', 'Comment on GitHub', 'Dismiss']);
    for (const [name, line] of [['Copy fix prompt', CAPTION.copy], ['Comment on GitHub', CAPTION.post], ['Dismiss', CAPTION.dismiss]] as const) {
      expect(describedBy(button(name)), name).toBe(line);
    }
    expect(CAPTION).toEqual({ copy: 'for your coding agent', post: 'you see it first', dismiss: 'hide it, teach Airlock' });
    expect(follows(fold('How sure is this'), bar)).toBe(true);
  });

  it.each([
    ['block', 'Copy fix prompt'],
    ['fix', 'Copy fix prompt'],
    ['ask', 'Comment on GitHub'],
    ['note', null],
  ] as const)('fills the button that follows a %s', (severity, filled) => {
    detail([finding(1, { severity })]);
    const primary = within(actions()).getAllByRole('button').filter((b) => b.classList.contains('primary')).map((b) => b.textContent);
    expect(primary).toEqual(filled === null ? [] : [filled]);
  });

  it('replaces a disabled button\'s line with its reason', () => {
    const reason = 'This review is of an older commit. Review the new commits before posting.';
    detail([finding(1)], { postBlocked: reason });
    const post = button('Comment on GitHub');
    expect(post.disabled).toBe(true);
    expect(describedBy(post)).toBe(reason);
    expect(within(actions()).getByText(reason)).toBeTruthy();
    expect(within(actions()).queryByText(CAPTION.post)).toBeNull();
  });

  it('keeps the line in sight while another action is in flight, and says to wait to a screen reader', () => {
    detail([finding(1)], { canPost: false });
    const post = button('Comment on GitHub');
    expect(post.disabled).toBe(true);
    expect(describedBy(post)).toBe(WAIT);
    expect(document.getElementById(post.getAttribute('aria-describedby')!)?.className).toBe('sr-only');
    expect(within(actions()).getByText(CAPTION.post)).toBeTruthy();
  });

  it('a posted finding shows its mark, with the link, under Comment on GitHub', () => {
    const record: PostRecord = recordOf([finding(1).fingerprint]);
    detail([finding(1)], { posted: record });
    const post = button('Comment on GitHub');
    expect(post.disabled).toBe(true);
    const cell = post.closest('.ap-act')!;
    expect(within(cell as HTMLElement).getByText('Posted')).toBeTruthy();
    expect(within(cell as HTMLElement).getByRole('link', { name: 'Open on GitHub' }).getAttribute('href')).toBe(record.url);
    expect(describedBy(post)).toContain('Posted');
    expect(within(actions()).queryByText(CAPTION.post)).toBeNull();
  });

  it('a post whose outcome is not known: the mark under the button, and the full mark with its controls in the screen', () => {
    const record = recordOf([finding(1).fingerprint], { outcome: 'unknown' });
    detail([finding(1)], { posted: record, unknownMark: (id) => <div className="mark block"><span id={id}>Not known whether this was posted</span><button type="button">It was not posted</button></div> });
    expect(describedBy(button('Comment on GitHub'))).toBe('Not known whether this was posted');
    const full = document.querySelector<HTMLElement>('.ap-onhub')!;
    expect(within(full).getByRole('button', { name: 'It was not posted' })).toBeTruthy();
    expect(follows(full, actions())).toBe(true);
  });

  it('Dismiss and Comment on GitHub call their props with the finding', () => {
    const onDismiss = vi.fn();
    const onPost = vi.fn();
    const f = finding(1);
    detail([f], { onDismiss, onPost });
    fireEvent.click(button('Dismiss'));
    fireEvent.click(button('Comment on GitHub'));
    expect(onDismiss).toHaveBeenCalledWith(f);
    expect(onPost).toHaveBeenCalledWith(f);
  });

  it('Dismiss is disabled when the review is read-only', () => {
    detail([finding(1)], { canDismiss: false });
    expect(button('Dismiss').disabled).toBe(true);
  });

  it('Copy fix prompt copies this finding\'s prompt and says Copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    detail([finding(1)]);
    fireEvent.click(button('Copy fix prompt'));
    expect(writeText).toHaveBeenCalledWith('Prompt for Problem 1');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('says the prompt is copied and to paste it to the coding agent', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    panelOn([finding(1)]);
    fireEvent.click(button('Copy fix prompt'));
    await screen.findByRole('button', { name: 'Copied' });
    expect(document.querySelector('[aria-live]')?.textContent).toBe('Copied. Paste it to your coding agent.');
  });

  it('shows the prompt, selected, above the actions when copying is refused', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('no')) }, configurable: true });
    detail([finding(1)]);
    fireEvent.click(button('Copy fix prompt'));
    const box = await screen.findByText('Prompt for Problem 1', { selector: 'pre' });
    expect(box.closest('.ap-pinned')).not.toBeNull();
    expect(follows(box, actions())).toBe(true);
    expect(window.getSelection()?.toString()).toContain('Prompt for Problem 1');
    // Close puts the box away, so it no longer covers the screen, and focus goes back to the button.
    fireEvent.click(within(box.closest('.ap-pinned-above') as HTMLElement).getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('Prompt for Problem 1', { selector: 'pre' })).toBeNull();
    expect(document.querySelector('.ap-pinned-above')).toBeNull();
    expect(document.activeElement).toBe(button('Copy fix prompt'));
  });
});

describe('the finding screen in the panel', () => {
  it('opens the comment sheet from Comment on GitHub, and the dismiss sheet from Dismiss, as bottom sheets', () => {
    const { dispatch } = panelOn([finding(1)]);
    fireEvent.click(button('Comment on GitHub'));
    expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'preview-post' }));
    expect(screen.getByRole('dialog', { name: 'Comment on GitHub' })).toBeTruthy();
    expect(document.querySelector('.sheet')!.classList.contains('bottom')).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(document.activeElement).toBe(button('Comment on GitHub'));
    fireEvent.click(button('Dismiss'));
    expect(screen.getByRole('dialog', { name: 'Dismiss this finding' })).toBeTruthy();
    expect(document.querySelector('.sheet')!.classList.contains('bottom')).toBe(true);
  });

  it('holds no img, a or script for review text that looks like markup', () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    panelOn([finding(1, { title: evil, happens: evil, why: evil, quote: evil, suggestedChange: evil, checked: evil, wouldBeWrongIf: evil })]);
    for (const name of ['What happens', 'Why it matters', 'The code', 'How sure is this']) fireEvent.click(fold(name));
    expect(screen.getAllByText(evil).length).toBeGreaterThan(4);
    for (const tag of ['img', 'a', 'script']) expect(document.querySelector(tag), tag).toBeNull();
  });
});
