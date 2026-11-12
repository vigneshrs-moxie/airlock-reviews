// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ReviewDocumentSchema, type Finding } from '@airlock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelScreen } from '../../src/screens/PanelScreen';
import { recordOf } from '../helpers/post-fixtures';
import { prSummary } from './fixtures';
import { also, EVERYTHING_AGAIN_NOTES, finding, mergeDocument, reviewState, type ReviewOptions } from './review-fixtures';
import { chooseTab, fold, foldSection, openFold, queryFold, rows, strip, tick } from './review-dom';

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
const cards = rows;
const tablist = () => screen.getByRole('tablist');
/** The notes under More, in order. */
const notesUnderMore = (): string[] => {
  chooseTab('More');
  openFold('Notes from the review');
  return [...foldSection('Notes from the review').querySelectorAll('li')].map((li) => li.textContent ?? '');
};
const chips = (label: string): string[] =>
  [...(strip().querySelector(`[aria-label="${label}"]`)?.querySelectorAll('li') ?? [])].map((li) => li.textContent ?? '');
/** Opens the brief on the Change tab. */
const openBrief = () => { chooseTab('The change'); if (queryFold('What it does') !== null) openFold('What it does'); };
const follows = (a: HTMLElement, b: HTMLElement) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('starting a re-review', () => {
  // What the service's /pr says of the last stored review: here, one of an earlier head.
  const LAST = { reviewId: 'r_0000000001', headSha: EARLIER, createdAt: '2026-11-10T00:00:00.000Z', depth: 'deep' as const };
  const moved = { stale: true, doc: { depth: 'deep' as const }, pr: { lastReview: LAST } };

  it('a moved head shows the banner with both buttons, and Review the push starts with since last', () => {
    const { dispatch } = review([finding(1)], moved);
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
    review([], { ...moved, busy: true });
    expect((button('Review the push') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Review everything again') as HTMLButtonElement).disabled).toBe(true);
  });
  it('offers no push review when the service has no stored review: only Review everything again', () => {
    review([finding(1)], { ...moved, pr: { lastReview: null } });
    expect(screen.getByText('New commits since this review.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review the push' })).toBeNull();
    expect(button('Review everything again')).toBeTruthy();
  });
  it('offers no push review when the last stored review is already of the pull request\'s head', () => {
    // Another panel reviewed the new head; this one still shows the older review.
    review([finding(1)], { ...moved, pr: { lastReview: { ...LAST, headSha: prSummary().headSha } } });
    expect(screen.getByText('New commits since this review.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review the push' })).toBeNull();
    expect(button('Review everything again')).toBeTruthy();
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
    expect(strip().contains(line)).toBe(true);
    expect(follows(line, tablist())).toBe(true);
    expect(cards().map((c) => within(c).getByTestId('status').textContent)).toEqual(['Moved', 'New', 'Still open']);
  });
  it('counts what changed since the last review in the strip, a count of none left out', () => {
    const fixed = (n: number) => finding(n, { status: 'fixed', bucket: 'also', rank: null });
    review(
      [finding(1, { status: 'moved' }), finding(2, { status: 'new' }), finding(3, { status: 'still-open' }), also(4, { status: 'still-open' })],
      { doc: { previous: PREVIOUS, fixed: [fixed(7), fixed(8)] } },
    );
    const label = within(strip()).getByText('Since the last review');
    expect(chips('Since the last review')).toEqual(['2 fixed', '2 still open', '1 new', '1 moved']);
    expect(chips('Open findings')).toEqual(['3 to fix', '1 note']);
    expect(follows(label, strip().querySelector('[aria-label="Since the last review"]')!)).toBe(true);
    cleanup();
    review([finding(1, { status: 'new' })], { doc: { previous: PREVIOUS } });
    expect(chips('Since the last review')).toEqual(['1 new']);
    cleanup();
    review([], { doc: { previous: PREVIOUS } });
    expect(within(strip()).queryByText('Since the last review')).toBeNull();
  });
  it('a first review shows no push line, no status and no since-the-last-review chips', () => {
    review([finding(1, { status: null })]);
    expect(screen.queryByText(/^Review of the/)).toBeNull();
    expect(screen.queryByTestId('status')).toBeNull();
    expect(screen.queryByText('Since the last review')).toBeNull();
  });
  it('an also-found line carries its status too', () => {
    review([also(2, { status: 'still-open' })], { doc: { previous: PREVIOUS } });
    fireEvent.click(fold('Also found'));
    expect(screen.getByTestId('status').textContent).toBe('Still open');
  });
  it('the everything-again note is shown under More when the branch was rewritten, and the strip has no range line', () => {
    const note = 'The branch was rewritten, so everything was reviewed again.';
    review([finding(1)], { doc: { previous: PREVIOUS, notes: [note], range: { baseSha: 'b'.repeat(40), headSha: HEAD, kind: 'full' } } });
    expect(screen.queryByText(/^Review of the push/)).toBeNull();
    expect(notesUnderMore()).toEqual([note]);
  });
});

describe('what a merge review says it covered (the document\'s mergeReview)', () => {
  const MERGE_RANGE = { baseSha: 'b'.repeat(40), headSha: HEAD, kind: 'sync-merge' as const };
  const BRIEF = { whatItDoes: ['Brings main in.'], claims: [] };
  const BY_HAND_HEADING = 'A merge of main: only what was changed by hand was reviewed';
  const CLEAN_HEADING = 'A merge of main: git merged it without conflicts and nothing was changed by hand.';
  const BY_HAND_LINE = `Review of the merge pushed since ${'a'.repeat(7)}: only what was changed by hand was reviewed.`;
  // A pushed merge names no branch: the push may have merged a branch other than the base.
  const CLEAN_LINE = 'The push only merged another branch in; git merged it without conflicts and nothing was changed by hand.';
  const anyMergeSentence = () => screen.queryAllByText(/changed by hand/);

  it('a first review of a merge reviewed by hand has the by-hand heading', () => {
    review([finding(1)], { doc: { range: MERGE_RANGE, brief: BRIEF, mergeReview: 'by-hand' } });
    openBrief();
    expect(screen.getByRole('heading', { name: BY_HAND_HEADING })).toBeTruthy();
    cleanup();
    review([finding(1)], { doc: { brief: BRIEF } });
    openBrief();
    expect(screen.queryByRole('heading', { name: /^A merge of/ })).toBeNull();
    expect(within(foldSection('What it does')).getByText('Brings main in.')).toBeTruthy();
  });
  it('a first review of a merge git made with nothing changed by hand says so, and nothing about a review of hand changes', () => {
    review([], { doc: { range: MERGE_RANGE, brief: BRIEF, mergeReview: 'nothing-by-hand' } });
    openBrief();
    expect(screen.getByRole('heading', { name: CLEAN_HEADING })).toBeTruthy();
    expect(screen.queryByText(/only what was changed by hand was reviewed/)).toBeNull();
  });
  it.each([
    ['a merge Airlock could not review', { mergeReview: 'not-reviewed' as const }],
    ['an older document without the field', {}],
  ])('%s says neither merge sentence: the brief keeps its usual heading', (_name, field) => {
    review([], { doc: { range: MERGE_RANGE, brief: BRIEF, ...field, verdict: { label: 'incomplete', sentence: 'The review did not finish.', counts: { block: 0, fix: 0, ask: 0, note: 0 } } } });
    expect(anyMergeSentence()).toEqual([]);
    openBrief();
    expect(screen.queryByRole('heading', { name: /^A merge of/ })).toBeNull();
    expect(anyMergeSentence()).toEqual([]);
    cleanup();
    review([], { doc: { range: MERGE_RANGE, brief: BRIEF, previous: PREVIOUS, ...field } });
    expect(anyMergeSentence()).toEqual([]);
    openBrief();
    expect(anyMergeSentence()).toEqual([]);
  });
  it('a merge pushed since the earlier review and reviewed by hand has its own line', () => {
    review([finding(1)], { doc: { previous: { ...PREVIOUS, covered: 'merge' }, range: MERGE_RANGE, mergeReview: 'by-hand' } });
    expect(screen.getByText(BY_HAND_LINE)).toBeTruthy();
    expect(screen.queryByText(CLEAN_LINE)).toBeNull();
    cleanup();
    // A document stored before the field: its merge range says it was a merge.
    review([finding(1)], { doc: { previous: PREVIOUS, range: MERGE_RANGE, mergeReview: 'by-hand' } });
    expect(screen.getByText(BY_HAND_LINE)).toBeTruthy();
    expect(screen.queryByText(CLEAN_LINE)).toBeNull();
  });
  it('a merge pushed since the earlier review with nothing changed by hand says git merged it', () => {
    review([finding(1)], { doc: { previous: { ...PREVIOUS, covered: 'merge' }, range: MERGE_RANGE, mergeReview: 'nothing-by-hand' } });
    const line = screen.getByText(CLEAN_LINE);
    expect(follows(screen.getByRole('heading', { name: 'Approve after fixes' }), line)).toBe(true);
    expect(screen.queryByText(BY_HAND_LINE)).toBeNull();
    // A re-review's brief keeps its usual heading.
    openBrief();
    expect(screen.queryByRole('heading', { name: /^A merge of/ })).toBeNull();
  });
  it.each(EVERYTHING_AGAIN_NOTES)('everything reviewed again: no line in the strip, and the note under More (%s)', (note) => {
    for (const kind of ['by-hand', 'nothing-by-hand', 'not-reviewed'] as const) {
      review([finding(1)], { doc: { previous: { ...PREVIOUS, covered: 'everything' }, range: MERGE_RANGE, mergeReview: kind, notes: [note] } });
      const verdict = strip();
      expect([...verdict.querySelectorAll('p')].map((p) => p.textContent).filter((t) => t !== 'Two things to fix.' && !t?.startsWith('Reviewed at'))).toEqual([]);
      expect(anyMergeSentence()).toEqual([]);
      expect(notesUnderMore()).toEqual([note]);
      expect(anyMergeSentence()).toEqual([]);
      cleanup();
    }
  });
});

describe('the line is decided by what the document says it covered, never by a note\'s wording', () => {
  const MERGE_RANGE = { baseSha: 'b'.repeat(40), headSha: HEAD, kind: 'sync-merge' as const };
  const PUSH_RANGE = { baseSha: EARLIER, headSha: HEAD, kind: 'rereview' as const };
  const underVerdict = (): (string | null)[] => {
    const verdict = strip();
    return [...verdict.querySelectorAll('p')].map((p) => p.textContent).filter((t) => t !== 'Two things to fix.' && !t?.startsWith('Reviewed at'));
  };

  it('everything again with a note worded in another way: no line in the strip, the note under More', () => {
    const note = 'Airlock looked at the whole pull request this time.';
    for (const range of [MERGE_RANGE, PUSH_RANGE]) {
      review([finding(1)], { doc: { previous: { ...PREVIOUS, covered: 'everything' }, range, mergeReview: 'by-hand', notes: [note] } });
      expect(underVerdict()).toEqual([]);
      expect(notesUnderMore()).toEqual([note]);
      cleanup();
    }
  });
  it('a pushed merge or a push whose note happens to end in "reviewed again." keeps its own line', () => {
    const note = 'Questions from the last review were repeated and reviewed again.';
    review([finding(1)], { doc: { previous: { ...PREVIOUS, covered: 'merge' }, range: MERGE_RANGE, mergeReview: 'by-hand', notes: [note] } });
    expect(underVerdict()).toEqual([`Review of the merge pushed since ${'a'.repeat(7)}: only what was changed by hand was reviewed.`]);
    expect(notesUnderMore()).toEqual([note]);
    cleanup();
    review([finding(1)], { doc: { previous: { ...PREVIOUS, covered: 'push' }, range: PUSH_RANGE, notes: [note] } });
    expect(underVerdict()).toEqual([`Review of the push ${'a'.repeat(7)} to ${'c'.repeat(7)}`]);
    expect(notesUnderMore()).toEqual([note]);
  });
});

describe('merge documents of every kind are valid stored documents', () => {
  it.each(['by-hand', 'nothing-by-hand', 'not-reviewed', undefined] as const)('%s', (kind) => {
    const doc = mergeDocument(kind);
    expect(ReviewDocumentSchema.safeParse(doc).success).toBe(true);
    expect(doc.range.kind).toBe('sync-merge');
  });
});

describe('a merge pushed since the earlier review, as the engine writes it', () => {
  // Copied from the document the engine's own test writes for this case (packages/engine/test/rereview/fix-round.test.ts,
  // "a push of one merge of the base is a sync-merge range with previous"): the range's base is not the earlier head, the
  // brief is the pull request's own, the engine adds its note, and the findings carry Moved, Still open and New.
  const EARLIER_HEAD = 'c3eee29a592f3b73206cd161ee020c0d8271aa87';
  const MERGE_HEAD = 'df3c441a8deee1d25e16684545330dbdb9564527';
  const NOTE = 'The push since the last review only merges the base branch main in, so only what was changed by hand in that merge was reviewed.';
  const doc = {
    id: 'r_1af82a364b',
    range: { baseSha: '83e7843503f4fb77d66c70ca1382d89df6f2e31d', headSha: MERGE_HEAD, kind: 'sync-merge' as const },
    previous: { reviewId: 'r_bec2ea7ab6', headSha: EARLIER_HEAD, covered: 'merge' as const },
    mergeReview: 'by-hand' as const,
    notes: [NOTE],
    brief: { whatItDoes: ['Adds refunds and a pause job.'], claims: [] },
    verdict: { label: 'approve-after-fixes' as const, sentence: '3 things to fix, none of them blocking. The first: A TODO is left in formatMoney.', counts: { block: 0, fix: 3, ask: 0, note: 0 } },
    fixed: [],
  };
  const findings = [
    finding(1, { title: 'A TODO is left in formatMoney', status: 'moved', anchor: { status: 'in-diff', startLine: 4, endLine: 4, comment: { line: 4, startLine: null } } }),
    finding(2, { title: 'A refund formats a negative amount', status: 'still-open', anchor: { status: 'in-diff', startLine: 8, endLine: 8, comment: { line: 8, startLine: null } } }),
    finding(3, { title: 'Too many digits throws', status: 'new', anchor: { status: 'in-diff', startLine: 3, endLine: 3, comment: { line: 3, startLine: null } } }),
  ];

  it('is a valid stored document', () => {
    expect(ReviewDocumentSchema.safeParse(reviewState(findings, { doc, pr: { headSha: MERGE_HEAD } }).latest.document).success).toBe(true);
  });

  it('shows the merge line in the strip, the engine\'s note under More, the pull request\'s brief, and a status on every row', () => {
    review(findings, { doc, pr: { headSha: MERGE_HEAD } });
    const line = within(strip()).getByText('Review of the merge pushed since c3eee29: only what was changed by hand was reviewed.');
    expect(follows(line, tablist())).toBe(true);
    expect(screen.queryByText(/^Review of the push/)).toBeNull();
    expect(cards().map((c) => within(c).getByTestId('status').textContent)).toEqual(['Moved', 'Still open', 'New']);
    expect(within(strip()).getByText('Reviewed at df3c441 · Standard')).toBeTruthy();
    expect(chips('Since the last review')).toEqual(['1 still open', '1 new', '1 moved']);
    // A re-review of a merge shows the pull request's brief under its usual heading, not the first merge review's heading.
    openBrief();
    expect(within(foldSection('What it does')).getByText('Adds refunds and a pause job.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /^A merge of/ })).toBeNull();
    expect(notesUnderMore()).toEqual([NOTE]);
    expect(screen.getByText('Reviewed at df3c441 · Standard depth · Packs: Generic')).toBeTruthy();
  });
});

describe('notes of every kind the engine writes', () => {
  // The engine's sentences: packs (choosePacks), merge (unconfirmedNote), select (a merged question), and the re-review's
  // own notes in pipeline/review.ts. The merged question quotes pull request text, so it carries markup that must stay text.
  const NOTES = [
    'A learned line could not be read and was left out: acme/learned/wrong.md:3.',
    'Airlock could not confirm whether 2 findings at the same place are the same problem ("Totals drift", "Totals round wrong"), so they are listed separately.',
    'A question was merged into the question "Is <b>rounding</b> intended?": "Is <img src=x onerror=alert(1)> rounding on purpose?"',
    'The branch was rewritten since the last review (its earlier head aaaaaaa is no longer part of it), so the whole pull request was reviewed again.',
    'The push changed only files Airlock does not review.',
    'The push changed no files.',
  ];
  const noMarkup = () => {
    expect(document.querySelector('.card.verdict b, .card.verdict img, section b, section img, li b, li img')).toBeNull();
  };

  it.each([['a re-review', { previous: PREVIOUS }], ['a first review', {}]])('on %s, every note is a line of text in the collapsed Notes from the review', (_name, previous) => {
    review([finding(1, { status: null })], { doc: { notes: NOTES, ...previous } });
    expect(screen.queryByText(NOTES[0]!)).toBeNull();
    chooseTab('More');
    const toggle = fold('Notes from the review');
    expect(toggle.textContent).toBe(`Notes from the review ${NOTES.length}`);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect([...foldSection('Notes from the review').querySelectorAll('li')].map((li) => li.textContent)).toEqual(NOTES);
    expect(within(strip()).queryByText(NOTES[0]!)).toBeNull();
    noMarkup();
  });
});

describe('fixed findings', () => {
  const fixed = (n: number, over: Partial<Finding> = {}): Finding =>
    finding(n, { status: 'fixed', bucket: 'also', rank: null, checked: 'The quoted code is gone; not checked further.', ...over });

  it('are listed collapsed with their reason and offer no actions', () => {
    review([finding(1)], { doc: { previous: PREVIOUS, fixed: [fixed(7), fixed(8, { checked: 'The line now reads differently.' })] } });
    const toggle = fold('Fixed since the last review');
    expect(toggle.textContent).toBe('Fixed since the last review 2');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Problem 7')).toBeNull();
    fireEvent.click(toggle);
    const section = toggle.closest('section')!;
    expect(within(section).getByText('Problem 7')).toBeTruthy();
    expect(within(section).getAllByText('Fixed')).toHaveLength(2);
    expect(within(section).getByText('src/file7.ts:70')).toBeTruthy();
    expect(within(section).getByText('The quoted code is gone; not checked further.')).toBeTruthy();
    expect(within(section).getByText('The line now reads differently.')).toBeTruthy();
    expect(within(section).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(section).queryAllByRole('button').map((b) => b.textContent)).toEqual([expect.stringContaining('Fixed since')]);
    expect(cards()).toHaveLength(1);
    // Fixed findings are not in the selection, so nothing can post or copy them.
    tick('Problem 1');
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(within(section).queryAllByRole('checkbox')).toHaveLength(0);
  });
  it('are absent when none was fixed', () => {
    review([finding(1)], { doc: { previous: PREVIOUS, fixed: [] } });
    expect(queryFold('Fixed since the last review')).toBeNull();
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
    chooseTab('More');
    expect(fold('Dismissed').textContent).toBe('Dismissed 1');
  });
});
