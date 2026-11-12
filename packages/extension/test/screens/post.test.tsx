// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Finding, PostPreviewReply } from '@airlock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelScreen } from '../../src/screens/PanelScreen';
import { NOT_THIS_REVIEW_POST } from '../../src/screens/PostSheet';
import { shortTitle } from '../../src/screens/summary';
import type { PanelState, PostReply, UserAction } from '../../src/state/reduce';
import { CANNOT_ASK_GITHUB, GITHUB_HAS_IT } from '../helpers/fake-service';
import { UNKNOWN_SENTENCE, previewItem, previewOf, recordOf } from '../helpers/post-fixtures';
import { also, finding, reviewState, type ReviewOptions } from './review-fixtures';
import { fold, tab, tick } from './review-dom';

afterEach(cleanup);

const ACCOUNT = 'Posts as bob on acme/widgets#1, as a comment. Airlock never approves, requests changes or merges.';
const NOTHING_SENT = 'Nothing has been sent yet.';
const ON_LINE = (place: string): string => `${place}. It shows in Files changed, next to the code.`;

type Reply = PostReply extends infer R ? (R extends { ticket: number } ? Omit<R, 'ticket'> : never) : never;

function mount(findings: Finding[], opts: ReviewOptions = {}) {
  const dispatch = vi.fn<(action: UserAction) => void>();
  let shown: PanelState = reviewState(findings, opts);
  const view = render(<PanelScreen state={shown} dispatch={dispatch} onOpenPacks={() => undefined} />);
  const show = (state: PanelState): void => {
    shown = state;
    view.rerender(<PanelScreen state={state} dispatch={dispatch} onOpenPacks={() => undefined} />);
  };
  const last = (): UserAction => {
    const call = dispatch.mock.calls.at(-1);
    if (call === undefined) throw new Error('nothing was dispatched');
    return call[0];
  };
  /** The service's answer to the last request, as the panel's state carries it. */
  const answer = (reply: Reply, over: ReviewOptions = {}): void => {
    const action = last();
    if (!('ticket' in action)) throw new Error('the last action has no ticket');
    show({ ...reviewState(findings, { ...opts, ...over }), post: { ticket: action.ticket, ...reply } as PostReply });
  };
  return { ...view, dispatch, show, last, answer, state: () => shown };
}

type Mounted = ReturnType<typeof mount>;

const dialog = () => within(screen.getByRole('dialog'));
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const field = (name: string) => screen.getByRole('textbox', { name }) as HTMLTextAreaElement;
const type = (name: string, value: string) => fireEvent.change(field(name), { target: { value } });
const openDetail = (title: string) => fireEvent.click(screen.getByText(title, { selector: '.finding-card .title' }));
const follows = (a: HTMLElement, b: HTMLElement) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

const names = (list: string): string => `Names ${list}: GitHub notifies them unless the name is inside code.`;
const WAIT = 'Wait for the current action to finish.';
const NOT_LEARNED = 'Airlock could not learn what happened to this post. Look at the pull request before posting again.';

const itemFor = (f: Finding, over: Parameters<typeof previewItem>[1] = {}) => previewItem(f, over);

/** Opens the first finding, presses Comment on GitHub, and answers with its preview. */
function previewed(findings: Finding[] = [finding(1)], opts: ReviewOptions = {}, preview?: PostPreviewReply): Mounted & { preview: PostPreviewReply } {
  const m = mount(findings, opts);
  openDetail(shortTitle(findings[0] as Finding));
  fireEvent.click(button('Comment on GitHub'));
  const shownPreview = preview ?? previewOf([itemFor(findings[0] as Finding)]);
  m.answer({ kind: 'preview', preview: shownPreview });
  return { ...m, preview: shownPreview };
}

describe('the post sheet', () => {
  it('Comment on GitHub opens the sheet with the service preview for that finding', () => {
    const f = finding(1);
    const m = mount([f, finding(2)]);
    openDetail('Problem 1');
    fireEvent.click(button('Comment on GitHub'));
    expect(m.last()).toEqual({
      type: 'preview-post', ticket: expect.any(Number),
      body: { repo: 'acme/widgets', number: 1, reviewId: 'r_0000000001', items: [{ fingerprint: f.fingerprint }] },
    });
    expect(dialog().getByText('Getting the preview…')).toBeTruthy();
    const preview = previewOf([itemFor(f, { body: 'The exact comment.' })]);
    m.answer({ kind: 'preview', preview });
    const d = dialog();
    expect(d.getByRole('heading', { name: 'Comment on GitHub' })).toBeTruthy();
    expect(d.getByText('Where it goes')).toBeTruthy();
    expect(d.getByText('On the line')).toBeTruthy();
    expect(d.getByText(ON_LINE('src/file1.ts, line 10'))).toBeTruthy();
    expect(d.getByText('The exact text')).toBeTruthy();
    expect(field('Comment 1').value).toBe('The exact comment.');
    expect(d.getByText(`${'The exact comment.'.length} of 4000`)).toBeTruthy();
    expect(field('Summary').value).toBe('Review notes from Airlock: 1 comment.');
    expect(d.getByText(`${ACCOUNT} ${NOTHING_SENT}`)).toBeTruthy();
    expect(d.getByRole('checkbox', { name: 'Put in the summary instead' })).toBeTruthy();
    expect(button('Post comment').disabled).toBe(false);
    expect(button('Post comment').classList.contains('primary')).toBe(true);
    expect(d.queryByRole('button', { name: 'Update preview' })).toBeNull();
  });

  it('leads with where the comment goes, then the exact text, the account line and the buttons', () => {
    previewed();
    const d = dialog();
    const order = [d.getByRole('heading', { name: 'Comment on GitHub' }), d.getByText('Where it goes'), d.getByText('On the line'),
      d.getByText('The exact text'), field('Comment 1'), d.getByText(`${ACCOUNT} ${NOTHING_SENT}`), button('Post comment'), button('Cancel')];
    for (const [i, node] of order.slice(1).entries()) expect(follows(order[i]!, node), node.textContent ?? '').toBe(true);
    expect(document.querySelector('.sheet')!.classList.contains('bottom')).toBe(true);
  });

  it('says for each comment whether it goes on the line or in the review summary', () => {
    const long = 'The pause handler calls the billing guard only after the account state is written, so it can order.';
    const [a, b, c] = [finding(1, { short: 'Pausing skips the guard' }), finding(2, { title: long }), finding(3)];
    previewed([a, b, c], {}, previewOf([
      itemFor(a), itemFor(b, { placement: 'summary', whySummary: 'The line is not part of the diff GitHub shows.' }),
      itemFor(c, { placement: 'summary', whySummary: 'You chose the summary.', line: null }),
    ]));
    const d = dialog();
    expect(d.getByRole('heading', { name: 'Comment on GitHub: 3 comments' })).toBeTruthy();
    expect(d.getByText('Where they go')).toBeTruthy();
    const places = [...document.querySelectorAll<HTMLElement>('.ap-dest')];
    expect(places.map((p) => p.querySelector('strong')?.textContent)).toEqual(['On the line', 'In the review summary', 'In the review summary']);
    // Each is headed by its short title: the summary stage's, else the title cut at a word.
    expect(places.map((p) => p.querySelector('.title')?.textContent)).toEqual(['Pausing skips the guard', 'The pause handler calls the billing guard only after the…', 'Problem 3']);
    expect([...document.querySelectorAll('.ap-field > .muted:first-child')].map((p) => p.textContent))
      .toEqual(['Pausing skips the guard', 'The pause handler calls the billing guard only after the…', 'Problem 3']);
    expect(within(places[0]!).getByText(ON_LINE('src/file1.ts, line 10'))).toBeTruthy();
    expect(within(places[1]!).getByText('The line is not part of the diff GitHub shows. The comment names the file and line.')).toBeTruthy();
    expect(within(places[2]!).getByText('You chose the summary. The comment names the file.')).toBeTruthy();
    expect(d.getByText(`Posts as bob on acme/widgets#1, as 3 comments in one review. Airlock never approves, requests changes or merges. ${NOTHING_SENT}`)).toBeTruthy();
    expect(d.queryByText(/Open each to read or edit|Posted together/)).toBeNull();
    expect(button('Post 3 comments')).toBeTruthy();
  });

  it('says why a comment goes in the summary, and a range of lines', () => {
    const [a, b] = [finding(1), finding(2)];
    previewed([a, b], {}, previewOf([
      itemFor(a, { placement: 'summary', whySummary: 'The line is not part of the diff GitHub shows.' }),
      itemFor(b, { line: 22, startLine: 20 }),
    ]));
    expect(dialog().getByText('The line is not part of the diff GitHub shows. The comment names the file and line.')).toBeTruthy();
    expect(dialog().getByText(ON_LINE('src/file2.ts, lines 20 to 22'))).toBeTruthy();
    // A comment the service put in the summary because its line is not in the diff cannot be moved inline.
    expect(dialog().getAllByRole('checkbox', { name: 'Put in the summary instead' })).toHaveLength(1);
  });

  it('Comment on GitHub sends the ticked findings and skips posted ones', () => {
    const [a, b, c] = [finding(1), finding(2), finding(3)];
    const m = mount([a, b, c], { posts: [recordOf([b.fingerprint])] });
    tick('Problem 1');
    tick('Problem 2');
    tick('Problem 3');
    fireEvent.click(button('Comment on GitHub (2)'));
    expect(m.last()).toMatchObject({
      type: 'preview-post',
      body: { items: [{ fingerprint: a.fingerprint }, { fingerprint: c.fingerprint }] },
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Comment on GitHub is disabled with its reason when every ticked finding is posted', () => {
    const [a, b] = [finding(1), finding(2)];
    mount([a, b], { posts: [recordOf([a.fingerprint])] });
    tick('Problem 1');
    expect(button('Comment on GitHub (0)').disabled).toBe(true);
    expect(screen.getByText('The selected findings are already posted.')).toBeTruthy();
  });

  it('an edit turns the button into Update preview and Post is not offered until the preview is fresh', () => {
    const f = finding(1);
    const m = previewed([f]);
    type('Comment 1', 'A better comment.');
    expect(dialog().queryByRole('button', { name: 'Post comment' })).toBeNull();
    expect(button('Update preview').disabled).toBe(false);
    // Typed back to what the service showed: the preview is the text again.
    type('Comment 1', m.preview.items[0]!.body);
    expect(button('Post comment')).toBeTruthy();
    type('Comment 1', 'A better comment.');
    fireEvent.click(button('Update preview'));
    expect(m.last()).toEqual({
      type: 'preview-post', ticket: expect.any(Number),
      body: { repo: 'acme/widgets', number: 1, reviewId: 'r_0000000001', items: [{ fingerprint: f.fingerprint, body: 'A better comment.' }] },
    });
    // While the new preview is coming, nothing can be posted.
    expect(dialog().queryByRole('button', { name: 'Post comment' })).toBeNull();
    m.answer({ kind: 'preview', preview: previewOf([itemFor(f, { body: 'A better comment.' })], { previewId: 'pv_1111111111111111' }) });
    fireEvent.click(button('Post comment'));
    expect(m.last()).toEqual({ type: 'post', ticket: expect.any(Number), previewId: 'pv_1111111111111111', fingerprints: [f.fingerprint] });
  });

  it('the text sent for preview is exactly the field value', () => {
    const [a, b] = [finding(1), finding(2)];
    const m = previewed([a, b], {}, previewOf([itemFor(a), itemFor(b)]));
    const text = '  Keep  two  spaces, <b>tags</b> & café \u{1F600}\n\nas typed  ';
    type('Comment 2', text);
    type('Summary', 'My own summary.');
    fireEvent.click(dialog().getAllByRole('checkbox', { name: 'Put in the summary instead' })[0]!);
    fireEvent.click(button('Update preview'));
    const action = m.last();
    expect(action.type === 'preview-post' && action.body).toEqual({
      repo: 'acme/widgets', number: 1, reviewId: 'r_0000000001',
      items: [
        { fingerprint: a.fingerprint, body: m.preview.items[0]!.body, placement: 'summary' },
        { fingerprint: b.fingerprint, body: text },
      ],
      summary: 'My own summary.',
    });
    expect(action.type === 'preview-post' && action.body.items[1]!.body).toBe(field('Comment 2').value);
  });

  it('a change of placement alone needs a new preview', () => {
    previewed();
    fireEvent.click(dialog().getByRole('checkbox', { name: 'Put in the summary instead' }));
    expect(button('Update preview')).toBeTruthy();
    fireEvent.click(dialog().getByRole('checkbox', { name: 'Put in the summary instead' }));
    expect(button('Post comment')).toBeTruthy();
  });

  it('a mention shows the notice with the names: the service\'s for a fresh preview, the typed ones for an edit', () => {
    const f = finding(1);
    // The service's list is shown as it is: the panel does not recount a fresh preview.
    previewed([f], {}, previewOf([itemFor(f, { body: 'Plain text.', mentions: ['@dave'] })], { reviewBody: 'Thanks @frank.', reviewBodyMentions: ['@erin'] }));
    expect(dialog().getByText(names('@dave'))).toBeTruthy();
    // The review's own text: the service's list for it, not a count the panel makes.
    expect(dialog().getByText(names('@erin'))).toBeTruthy();
    expect(dialog().queryByText(names('@frank'))).toBeNull();
    // mentionsIn reads no Markdown, so a name in backticks is listed too.
    type('Comment 1', 'Ask @alice and @acme/reviewers, not `@bob`.');
    expect(dialog().getByText(names('@alice, @acme/reviewers, @bob'))).toBeTruthy();
    expect(dialog().queryByText(names('@dave'))).toBeNull();
    // An inline comment is not part of the review's own text: its list still stands.
    expect(dialog().getByText(names('@erin'))).toBeTruthy();
    type('Summary', 'Thanks @carol.');
    expect(dialog().getByText(names('@carol'))).toBeTruthy();
    // The summary has unsent edits: the service's list for the review text no longer applies.
    expect(dialog().queryByText(names('@erin'))).toBeNull();
  });

  it('an edit to a comment placed in the summary also sets the service\'s list for the review text aside', () => {
    const f = finding(1);
    previewed([f], {}, previewOf([itemFor(f, { placement: 'summary', whySummary: 'The line is not part of the diff GitHub shows.' })], { reviewBodyMentions: ['@erin'] }));
    expect(dialog().getByText(names('@erin'))).toBeTruthy();
    type('Comment 1', 'Ask @gina.');
    expect(dialog().getByText(names('@gina'))).toBeTruthy();
    expect(dialog().queryByText(names('@erin'))).toBeNull();
  });

  it('after a 404 on the post, says it is checking whether the post already went through, then that the preview expired', () => {
    const f = finding(1);
    const m = previewed([f]);
    fireEvent.click(button('Post comment'));
    m.answer({ kind: 'waiting', checking: true }, { busy: true });
    expect(dialog().getByRole('status').textContent).toBe('Checking whether this post already went through…');
    expect(dialog().queryByText('Waiting to hear whether GitHub accepted the comments…')).toBeNull();
    m.answer({ kind: 'refused', message: 'This preview has expired. Open the preview again.' });
    expect(dialog().getByText('This preview has expired. Open the preview again.')).toBeTruthy();
    expect(dialog().queryByText('Checking whether this post already went through…')).toBeNull();
  });

  it('says nothing has been sent only while that is true', () => {
    const f = finding(1);
    const m = previewed([f]);
    const exact = `${ACCOUNT} ${NOTHING_SENT}`;
    expect(dialog().getByText(exact)).toBeTruthy();
    // An edit that was not previewed: the text shown is not what would be posted, so the line is not said.
    type('Comment 1', 'Edited.');
    expect(dialog().queryByText(exact)).toBeNull();
    expect(dialog().getByText(ACCOUNT)).toBeTruthy();
    // Nor while the new preview is asked for; it comes back with the fresh preview.
    fireEvent.click(button('Update preview'));
    expect(dialog().queryByText(exact)).toBeNull();
    m.answer({ kind: 'preview', preview: previewOf([itemFor(f, { body: 'Edited.' })]) });
    expect(dialog().getByText(exact)).toBeTruthy();
    fireEvent.click(button('Post comment'));
    expect(dialog().queryByText(exact)).toBeNull();
    m.answer({ kind: 'waiting' }, { busy: true });
    expect(dialog().queryByText(exact)).toBeNull();
    expect(dialog().getByText('Waiting to hear whether GitHub accepted the comments…')).toBeTruthy();
    m.answer({ kind: 'unclear', message: NOT_LEARNED });
    fireEvent.click(button('Update preview'));
    m.answer({ kind: 'preview', preview: previewOf([itemFor(f)], { previewId: 'pv_3333333333333333' }) });
    // A post was sent from this sheet, and what came of it is not known: the line is not said again.
    expect(dialog().queryByText(exact)).toBeNull();
  });

  it('shows the review\'s own text as the service returned it, greyed after an edit until the next preview', () => {
    const [a, b] = [finding(1), finding(2)];
    const reviewBody = 'Review notes from Airlock: 2 comments.\n\nNot on a changed line:\n\n`src/file1.ts:10`\n**Fix: Problem 1**';
    const m = previewed([a, b], {}, previewOf([
      itemFor(a, { placement: 'summary', whySummary: 'The line is not part of the diff GitHub shows.' }), itemFor(b),
    ], { reviewBody }));
    expect(dialog().getByText("The review's own text, as it will be posted:")).toBeTruthy();
    const shown = document.querySelector<HTMLElement>('[data-review-body]')!;
    expect(shown.textContent).toBe(reviewBody);
    expect(shown.getAttribute('data-stale')).toBe('false');
    expect(dialog().queryByText('Update preview to see this again.')).toBeNull();
    type('Summary', 'Mine.');
    expect(dialog().getByText('Update preview to see this again.')).toBeTruthy();
    expect(shown.getAttribute('data-stale')).toBe('true');
    fireEvent.click(button('Update preview'));
    m.answer({ kind: 'preview', preview: previewOf([itemFor(a), itemFor(b)], { summary: 'Mine.', reviewBody: 'Mine.' }) });
    expect(document.querySelector('[data-review-body]')!.textContent).toBe('Mine.');
    expect(dialog().queryByText('Update preview to see this again.')).toBeNull();
  });

  it('a fresh preview after an update is announced, and focus goes to the main button', () => {
    const f = finding(1);
    const m = previewed([f]);
    type('Comment 1', 'Better.');
    fireEvent.click(button('Update preview'));
    m.answer({ kind: 'preview', preview: previewOf([itemFor(f, { body: 'Better.' })]) });
    expect(document.querySelector('[aria-live]')?.textContent).toBe('Preview updated.');
    expect(document.activeElement).toBe(button('Post comment'));
  });

  it('Enter in a field adds a line and sends nothing', () => {
    const m = previewed();
    const calls = m.dispatch.mock.calls.length;
    const proceeded = fireEvent.keyDown(field('Comment 1'), { key: 'Enter' });
    expect(proceeded).toBe(true);
    expect(m.dispatch.mock.calls.length).toBe(calls);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it.each([
    ['the pull request closes', { pr: { state: 'closed' as const } }, 'The pull request is closed, so nothing can be posted to it.'],
    ['the pull request is merged', { pr: { state: 'merged' as const } }, 'The pull request is merged, so nothing can be posted to it.'],
    ['new commits arrive', { stale: true }, 'This review is of an older commit. Review the new commits before posting.'],
  ])('the sheet says why it cannot post when %s while it is open', (_name, over, reason) => {
    const f = finding(1);
    const m = previewed([f]);
    m.show(reviewState([f], over));
    const main = button('Post comment');
    expect(main.disabled).toBe(true);
    expect(main.getAttribute('aria-describedby')).toBe(dialog().getByText(reason).id);
    type('Comment 1', 'Edited.');
    expect(button('Update preview').disabled).toBe(true);
  });

  it('a text that cannot be posted says why, with its count, and nothing can be sent', () => {
    previewed();
    type('Comment 1', '   ');
    expect(dialog().getByText('The text is empty.')).toBeTruthy();
    expect(button('Update preview').disabled).toBe(true);
    type('Comment 1', 'y'.repeat(4001));
    expect(dialog().getByText('4001 of 4000')).toBeTruthy();
    expect(dialog().getByText('The text is 1 character longer than the 4000 allowed.')).toBeTruthy();
    expect(field('Comment 1').getAttribute('aria-invalid')).toBe('true');
    type('Comment 1', 'Hidden​ here');
    expect(dialog().getByText('The text has a hidden character; remove it.')).toBeTruthy();
    expect(button('Update preview').disabled).toBe(true);
  });

  it('a refusal keeps every text and shows the sentence', () => {
    const [a, b] = [finding(1), finding(2)];
    const m = previewed([a, b], {}, previewOf([itemFor(a), itemFor(b)]));
    type('Comment 1', 'Edited first.');
    type('Summary', 'Edited summary.');
    fireEvent.click(button('Update preview'));
    m.answer({ kind: 'preview', preview: previewOf([itemFor(a, { body: 'Edited first.' }), itemFor(b)], { summary: 'Edited summary.', previewId: 'pv_2222222222222222' }) });
    fireEvent.click(button('Post 2 comments'));
    const said = 'GitHub refused the comments: Line 10 is not part of the diff. Nothing was posted.';
    m.answer({ kind: 'refused', message: said });
    expect(dialog().getByRole('alert').textContent).toBe(said);
    expect(field('Comment 1').value).toBe('Edited first.');
    expect(field('Comment 2').value).toBe(m.preview.items[1]!.body);
    expect(field('Summary').value).toBe('Edited summary.');
    // A new preview of the kept texts comes before another post.
    expect(button('Update preview').disabled).toBe(false);
    expect(dialog().queryByRole('button', { name: 'Post 2 comments' })).toBeNull();
    // The next edit clears the sentence.
    type('Comment 1', 'Edited again.');
    expect(dialog().queryByRole('alert')).toBeNull();
  });

  it('a refused first preview says why, with Close', () => {
    const m = mount([finding(1)]);
    openDetail('Problem 1');
    fireEvent.click(button('Comment on GitHub'));
    m.answer({ kind: 'refused', message: 'This finding is already posted on this pull request: Problem 1.' });
    expect(dialog().getByRole('alert').textContent).toBe('This finding is already posted on this pull request: Problem 1.');
    fireEvent.click(button('Close'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('posted: says how many, links to the review, and marks the finding', () => {
    const f = finding(1);
    const m = previewed([f]);
    fireEvent.click(button('Post comment'));
    const record = recordOf([f.fingerprint]);
    m.answer({ kind: 'posted', record }, { posts: [record] });
    expect(dialog().getByText('Posted 1 comment.')).toBeTruthy();
    const link = dialog().getByRole('link', { name: 'Open on GitHub' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(record.url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(document.querySelector('[aria-live]')?.textContent).toBe('Posted 1 comment.');
    fireEvent.click(button('Done'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Posted', { selector: '.mark *' })).toBeTruthy();
    expect((screen.getByRole('link', { name: 'Open on GitHub' }) as HTMLAnchorElement).getAttribute('href')).toBe(record.url);
    expect(button('Comment on GitHub').disabled).toBe(true);
  });

  /** A post whose outcome is not known, in the sheet, after its texts were edited and previewed. */
  function unknownInSheet(f: Finding) {
    const m = previewed([f]);
    type('Comment 1', 'Kept text.');
    fireEvent.click(button('Update preview'));
    m.answer({ kind: 'preview', preview: previewOf([itemFor(f, { body: 'Kept text.' })]) });
    fireEvent.click(button('Post comment'));
    const record = recordOf([f.fingerprint], { outcome: 'unknown' });
    m.answer({ kind: 'unknown', message: UNKNOWN_SENTENCE, record }, { posts: [record] });
    return { m, record };
  }

  it('an unknown outcome offers It was not posted, which asks first, as on the finding, then forgets the record', () => {
    const f = finding(1);
    const { m, record } = unknownInSheet(f);
    const d = dialog();
    expect(d.getByRole('alert').textContent).toBe(UNKNOWN_SENTENCE);
    expect((d.getByRole('link', { name: 'Open the pull request' }) as HTMLAnchorElement).getAttribute('href')).toBe('https://github.com/acme/widgets/pull/1');
    const sent = m.dispatch.mock.calls.length;
    // One press asks; Keep puts the question away and sends nothing.
    fireEvent.click(d.getByRole('button', { name: 'It was not posted' }));
    expect(d.getByText('Forget this record? Only do this after looking at the pull request.')).toBeTruthy();
    expect(document.activeElement).toBe(d.getByRole('button', { name: 'Keep' }));
    fireEvent.click(d.getByRole('button', { name: 'Keep' }));
    expect(d.queryByText('Forget this record? Only do this after looking at the pull request.')).toBeNull();
    expect(document.activeElement).toBe(d.getByRole('button', { name: 'It was not posted' }));
    expect(m.dispatch.mock.calls.length).toBe(sent);
    // Asked and answered: the record is forgotten.
    fireEvent.click(d.getByRole('button', { name: 'It was not posted' }));
    fireEvent.click(d.getByRole('button', { name: 'It was not posted' }));
    expect(m.last()).toEqual({ type: 'forget-post', ticket: expect.any(Number), id: record.id });
    expect(m.dispatch.mock.calls.length).toBe(sent + 1);
    m.answer({ kind: 'forgotten', id: record.id });
    expect(field('Comment 1').value).toBe('Kept text.');
    expect(button('Update preview').disabled).toBe(false);
  });

  it('It was not posted in the sheet is disabled with its reason while the service is away', () => {
    const f = finding(1);
    const { m, record } = unknownInSheet(f);
    const shown = reviewState([f], { posts: [record] });
    m.show({ kind: 'offline', review: { pr: shown.pr, latest: shown.latest, stale: false } });
    const forget = dialog().getByRole('button', { name: 'It was not posted' }) as HTMLButtonElement;
    expect(forget.disabled).toBe(true);
    expect(document.getElementById(forget.getAttribute('aria-describedby')!)?.textContent).toBe('Posting needs the Airlock service, which is not answering.');
  });

  it.each([
    ['a newer review of the pull request lands', { doc: { id: 'r_0000000002' } }],
    ['the tab moved to another pull request', { pr: { number: 2 }, doc: { id: 'r_0000000002' } }],
  ] as const)('It was not posted in the sheet is disabled with the stale-review reason when %s, not told to wait', (_, over) => {
    const f = finding(1);
    const { m, record } = unknownInSheet(f);
    m.show(reviewState([f], { ...over, posts: [record] }));
    const forget = dialog().getByRole('button', { name: 'It was not posted' }) as HTMLButtonElement;
    expect(forget.disabled).toBe(true);
    expect(document.getElementById(forget.getAttribute('aria-describedby')!)?.textContent).toBe(NOT_THIS_REVIEW_POST);
    expect(dialog().queryByText(WAIT)).toBeNull();
  });

  it('GitHub has the review after all: the sheet says so, shows it as posted, and nothing was forgotten', () => {
    const f = finding(1);
    const { m, record } = unknownInSheet(f);
    fireEvent.click(dialog().getByRole('button', { name: 'It was not posted' }));
    fireEvent.click(dialog().getByRole('button', { name: 'It was not posted' }));
    const posted = { ...recordOf([f.fingerprint]), id: record.id };
    m.answer({ kind: 'found', message: GITHUB_HAS_IT, record: posted }, { posts: [posted] });
    const d = dialog();
    expect(d.getByRole('alert').textContent).toBe(GITHUB_HAS_IT);
    expect(d.getByText('Posted 1 comment.')).toBeTruthy();
    expect((d.getByRole('link', { name: 'Open on GitHub' }) as HTMLAnchorElement).getAttribute('href')).toBe(posted.url);
    fireEvent.click(button('Done'));
    expect(screen.getByText('Posted', { selector: '.mark *' })).toBeTruthy();
  });

  it('GitHub could not be asked: the sheet says the record was kept, and It was not posted is still offered', () => {
    const f = finding(1);
    const { m, record } = unknownInSheet(f);
    fireEvent.click(dialog().getByRole('button', { name: 'It was not posted' }));
    fireEvent.click(dialog().getByRole('button', { name: 'It was not posted' }));
    m.answer({ kind: 'refused', message: CANNOT_ASK_GITHUB }, { posts: [record] });
    const d = dialog();
    expect(d.getAllByRole('alert').map((a) => a.textContent)).toEqual([UNKNOWN_SENTENCE, CANNOT_ASK_GITHUB]);
    expect(d.getByRole('button', { name: 'It was not posted' })).toBeTruthy();
  });

  it('a post never sent because the proof got no answer says so and offers the same post again', () => {
    const f = finding(1);
    const m = previewed([f]);
    type('Comment 1', 'Kept text.');
    fireEvent.click(button('Update preview'));
    m.answer({ kind: 'preview', preview: previewOf([itemFor(f, { body: 'Kept text.' })]) });
    fireEvent.click(button('Post comment'));
    m.answer({ kind: 'unsent', message: 'Airlock could not reach its service, so nothing was sent.' });
    const d = dialog();
    expect(d.getByRole('alert').textContent).toBe('Airlock could not reach its service, so nothing was sent.');
    expect(d.queryByRole('link', { name: 'Open the pull request' })).toBeNull();
    expect(field('Comment 1').value).toBe('Kept text.');
    // Not a post whose outcome is unknown: the same preview can be posted again, and nothing has been sent.
    expect(d.getByText(`${ACCOUNT} ${NOTHING_SENT}`)).toBeTruthy();
    fireEvent.click(button('Post comment'));
    expect(m.dispatch.mock.calls.filter(([a]) => a.type === 'post')).toHaveLength(2);
  });

  it('an unknown record shows its mark on the finding and its card', () => {
    const f = finding(1);
    mount([f], { posts: [recordOf([f.fingerprint], { outcome: 'unknown' })] });
    expect(screen.getByText('Not known whether this was posted', { selector: '.finding-card *' })).toBeTruthy();
    openDetail('Problem 1');
    // Under Comment on GitHub, the mark in place of its line; the full mark, with its controls, in the screen.
    const comment = button('Comment on GitHub');
    expect(comment.disabled).toBe(true);
    expect(document.getElementById(comment.getAttribute('aria-describedby')!)?.textContent).toBe('Not known whether this was posted');
    expect(within(document.querySelector<HTMLElement>('.ap-onhub')!).getByText('Not known whether this was posted')).toBeTruthy();
    expect(within(document.querySelector<HTMLElement>('.ap-onhub')!).getByRole('button', { name: 'It was not posted' })).toBeTruthy();
  });

  it('a finding is posted under any of its aliases, either way round', () => {
    const f = finding(1, { aliases: ['00000000000000aa'] });
    const g = finding(2);
    mount([f, g], { posts: [recordOf(['00000000000000aa']), recordOf(['00000000000000bb'], { id: 'post_bbbbbbbbbbbb', items: [{ fingerprint: '00000000000000bb', aliases: [g.fingerprint], placement: 'inline' }] })] });
    expect(screen.getAllByText('Posted', { selector: '.finding-card *' })).toHaveLength(2);
  });

  it.each([
    ['a stale review', { stale: true }, 'This review is of an older commit. Review the new commits before posting.'],
    ['a closed pull request', { pr: { state: 'closed' as const } }, 'The pull request is closed, so nothing can be posted to it.'],
    ['a merged pull request', { pr: { state: 'merged' as const } }, 'The pull request is merged, so nothing can be posted to it.'],
  ])('posting is disabled with its reason on %s', (_name, opts, reason) => {
    mount([finding(1)], opts);
    tick('Problem 1');
    expect(button('Comment on GitHub (1)').disabled).toBe(true);
    expect(screen.getByText(reason)).toBeTruthy();
    openDetail('Problem 1');
    expect(button('Comment on GitHub').disabled).toBe(true);
    expect(button('Comment on GitHub').getAttribute('aria-describedby')).toBe(screen.getByText(reason).id);
  });

  it('posting is disabled with its reason offline', () => {
    const shown = reviewState([finding(1)]);
    const m = mount([finding(1)]);
    tick('Problem 1');
    m.show({ kind: 'offline', review: { pr: shown.pr, latest: shown.latest, stale: false } });
    expect(button('Comment on GitHub (1)').disabled).toBe(true);
    expect(screen.getByText('Posting needs the Airlock service, which is not answering.')).toBeTruthy();
  });

  it('a second press during a post sends nothing and the sheet cannot be closed', () => {
    const f = finding(1);
    const m = previewed([f]);
    const post = button('Post comment');
    fireEvent.click(post);
    fireEvent.click(post);
    expect(m.dispatch.mock.calls.filter(([a]) => a.type === 'post')).toHaveLength(1);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(document.querySelector('.sheet')!);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(button('Cancel').disabled).toBe(true);
    m.show(reviewState([f], { busy: true }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(m.dispatch.mock.calls.filter(([a]) => a.type === 'post')).toHaveLength(1);
  });

  it('markup in a comment text or a title is shown as characters', () => {
    const title = '<img src=x onerror=alert(1)> "quoted"';
    const f = finding(1, { title });
    previewed([f], {}, previewOf([itemFor(f, { body: '<b>bold</b> <script>alert(1)</script>', whySummary: null })]));
    const sheet = document.querySelector('.sheet')!;
    expect(sheet.querySelector('img, b, script')).toBeNull();
    expect(dialog().getByText(title)).toBeTruthy();
    expect(field('Comment 1').value).toBe('<b>bold</b> <script>alert(1)</script>');
  });
});

describe('the post sheet keeps its texts', () => {
  const offlineOf = (r: ReturnType<typeof reviewState>): PanelState => ({ kind: 'offline', review: { pr: r.pr, latest: r.latest, stale: false } });

  it('through a flip to offline and back, with nothing sent meanwhile', () => {
    const f = finding(1);
    const m = previewed([f]);
    type('Comment 1', 'Typed before the flip.');
    const calls = m.dispatch.mock.calls.length;
    m.show(offlineOf(reviewState([f])));
    expect(dialog().getByText('Airlock could not reach its service. Your comments are kept.')).toBeTruthy();
    expect(field('Comment 1').value).toBe('Typed before the flip.');
    expect(button('Update preview').disabled).toBe(true);
    fireEvent.click(button('Update preview'));
    expect(m.dispatch.mock.calls.length).toBe(calls);
    m.show(reviewState([f]));
    expect(field('Comment 1').value).toBe('Typed before the flip.');
    expect(button('Update preview').disabled).toBe(false);
  });

  it('through a screen without the review, and back', () => {
    const f = finding(1);
    const m = previewed([f]);
    type('Comment 1', 'Typed before.');
    m.show({ kind: 'unpaired' });
    expect(screen.queryByRole('dialog')).toBeNull();
    m.show(reviewState([f]));
    expect(field('Comment 1').value).toBe('Typed before.');
  });

  it('a post with no answer before the service went away shows what the records say when it is back', () => {
    const f = finding(1);
    const m = previewed([f]);
    fireEvent.click(button('Post comment'));
    m.show(offlineOf(reviewState([f])));
    expect(screen.getByRole('dialog')).toBeTruthy();
    const record = recordOf([f.fingerprint]);
    m.show(reviewState([f], { posts: [record] }));
    expect(dialog().getByText('Posted 1 comment.')).toBeTruthy();
  });

  it('a post with no answer finds its record when the service is back by the same rule as the marks (an alias)', () => {
    const f = finding(1, { aliases: ['00000000000000aa'] });
    const m = previewed([f]);
    fireEvent.click(button('Post comment'));
    m.show(offlineOf(reviewState([f])));
    m.show(reviewState([f], { posts: [recordOf(['00000000000000aa'])] }));
    expect(dialog().getByText('Posted 1 comment.')).toBeTruthy();
  });

  it('a post with no answer and no record when the service is back says so and keeps the texts', () => {
    const f = finding(1);
    const m = previewed([f]);
    fireEvent.click(button('Post comment'));
    m.show(offlineOf(reviewState([f])));
    m.show(reviewState([f]));
    expect(dialog().getByRole('alert').textContent).toBe(NOT_LEARNED);
    expect(dialog().getByRole('link', { name: 'Open the pull request' })).toBeTruthy();
    expect(field('Comment 1').value).toBe(m.preview.items[0]!.body);
    expect(button('Update preview')).toBeTruthy();
  });

  it('closes on Escape and gives focus back to Comment on GitHub', () => {
    previewed();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button('Comment on GitHub'));
  });

  it('Cancel drops the draft: the next sheet asks for a new preview', () => {
    const m = previewed();
    type('Comment 1', 'Dropped.');
    fireEvent.click(button('Cancel'));
    fireEvent.click(button('Comment on GitHub'));
    expect(m.last().type).toBe('preview-post');
    expect(dialog().getByText('Getting the preview…')).toBeTruthy();
  });

  it('a post in flight when the tab moves is not judged by the other pull request\'s records, and is when the tab is back', () => {
    const f = finding(1);
    const m = previewed([f]);
    fireEvent.click(button('Post comment'));
    m.show(reviewState([f], { busy: true }));
    // The tab moves to pull request 2: its review, and a record of its own that holds a finding with the same fingerprint.
    const elsewhere = recordOf([f.fingerprint], { number: 2, url: 'https://github.com/acme/widgets/pull/2#pullrequestreview-77' });
    m.show(reviewState([f], { pr: { number: 2 }, doc: { id: 'r_0000000002' }, posts: [elsewhere] }));
    const d = dialog();
    expect(d.getByText('This review is no longer the one on screen, so these comments cannot be posted from it. Closing this loses the texts here.')).toBeTruthy();
    expect(d.getByText('A post of these comments to acme/widgets#1 was in flight when the tab moved. Go back to that pull request to see what happened.')).toBeTruthy();
    expect(d.queryByText(NOT_LEARNED)).toBeNull();
    expect(d.queryByText('Posted 1 comment.')).toBeNull();
    // Over the other pull request the sheet can be left.
    expect(button('Close').disabled).toBe(false);
    // Back on pull request 1, its own record is the outcome.
    const record = recordOf([f.fingerprint]);
    m.show(reviewState([f], { posts: [record] }));
    expect(dialog().getByText('Posted 1 comment.')).toBeTruthy();
  });

  it('a post in flight, back on its pull request with no record of it there, says it could not learn what happened', () => {
    const f = finding(1);
    const m = previewed([f]);
    fireEvent.click(button('Post comment'));
    m.show(reviewState([f], { busy: true }));
    m.show(reviewState([f], { pr: { number: 2 }, doc: { id: 'r_0000000002' } }));
    m.show(reviewState([f]));
    expect(dialog().getByRole('alert').textContent).toBe(NOT_LEARNED);
  });

  it('a review that is no longer the one on screen is not posted to', () => {
    const f = finding(1);
    const m = previewed([f]);
    m.show(reviewState([f], { doc: { id: 'r_0000000002' } }));
    expect(dialog().getByText('This review is no longer the one on screen, so these comments cannot be posted from it. Closing this loses the texts here.')).toBeTruthy();
    expect(dialog().queryByRole('button', { name: 'Post comment' })).toBeNull();
    fireEvent.click(button('Close'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('a post in flight', () => {
  const offlineOf = (r: ReturnType<typeof reviewState>): PanelState => ({ kind: 'offline', review: { pr: r.pr, latest: r.latest, stale: false } });

  it('cannot be closed while the service is away, and shows its outcome when it is back', () => {
    const f = finding(1);
    const m = previewed([f]);
    fireEvent.click(button('Post comment'));
    m.show(offlineOf(reviewState([f])));
    expect(button('Cancel').disabled).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(document.querySelector('.sheet')!);
    expect(screen.getByRole('dialog')).toBeTruthy();
    const record = recordOf([f.fingerprint]);
    m.show(reviewState([f], { posts: [record] }));
    expect(dialog().getByText('Posted 1 comment.')).toBeTruthy();
    expect(button('Done').disabled).toBe(false);
  });

  it('while the panel waits for the record: says so and cannot be closed; with none, says it could not learn and keeps the texts', () => {
    const f = finding(1);
    const m = previewed([f]);
    type('Comment 1', 'Kept.');
    fireEvent.click(button('Update preview'));
    m.answer({ kind: 'preview', preview: previewOf([itemFor(f, { body: 'Kept.' })]) });
    fireEvent.click(button('Post comment'));
    m.answer({ kind: 'waiting' }, { busy: true });
    expect(dialog().getByText('Waiting to hear whether GitHub accepted the comments…')).toBeTruthy();
    expect(button('Cancel').disabled).toBe(true);
    m.answer({ kind: 'unclear', message: NOT_LEARNED });
    expect(dialog().getByRole('alert').textContent).toBe(NOT_LEARNED);
    expect((dialog().getByRole('link', { name: 'Open the pull request' }) as HTMLAnchorElement).getAttribute('href')).toBe('https://github.com/acme/widgets/pull/1');
    expect(dialog().queryByText('Waiting to hear whether GitHub accepted the comments…')).toBeNull();
    expect(field('Comment 1').value).toBe('Kept.');
    expect(button('Cancel').disabled).toBe(false);
    fireEvent.click(button('Cancel'));
    // The findings stay unmarked; a record read later marks them.
    expect(button('Comment on GitHub').disabled).toBe(false);
    m.show(reviewState([f], { posts: [recordOf([f.fingerprint])] }));
    expect(screen.getByText('Posted', { selector: '.mark *' })).toBeTruthy();
    expect(button('Comment on GitHub').disabled).toBe(true);
  });

  it('is the same post when the sheet is hidden and shown again: nothing can be sent and it cannot be closed', () => {
    const f = finding(1);
    const m = previewed([f]);
    fireEvent.click(button('Post comment'));
    m.show(reviewState([f], { busy: true }));
    m.show({ kind: 'unpaired' });
    expect(screen.queryByRole('dialog')).toBeNull();
    m.show(reviewState([f], { busy: true }));
    expect(button('Cancel').disabled).toBe(true);
    expect(button('Post comment').disabled).toBe(true);
    fireEvent.click(button('Post comment'));
    expect(m.dispatch.mock.calls.filter(([a]) => a.type === 'post')).toHaveLength(1);
  });
});

describe('an unknown record can be cleared from the finding', () => {
  const unknownFor = (f: Finding) => recordOf([f.fingerprint], { outcome: 'unknown' });

  function expectClearable(scope: ReturnType<typeof within>, m: Mounted, id: string) {
    expect(scope.getByText('Not known whether this was posted')).toBeTruthy();
    expect((scope.getByRole('link', { name: 'Open the pull request' }) as HTMLAnchorElement).getAttribute('href')).toBe('https://github.com/acme/widgets/pull/1');
    fireEvent.click(scope.getByRole('button', { name: 'It was not posted' }));
    expect(scope.getByText('Forget this record? Only do this after looking at the pull request.')).toBeTruthy();
    fireEvent.click(scope.getByRole('button', { name: 'Keep' }));
    expect(scope.queryByText('Forget this record? Only do this after looking at the pull request.')).toBeNull();
    expect(m.dispatch).not.toHaveBeenCalled();
    fireEvent.click(scope.getByRole('button', { name: 'It was not posted' }));
    fireEvent.click(scope.getByRole('button', { name: 'It was not posted' }));
    expect(m.last()).toEqual({ type: 'forget-post', ticket: expect.any(Number), id });
  }

  it('from its card', () => {
    const f = finding(1);
    const m = mount([f, finding(2)], { posts: [unknownFor(f)] });
    expectClearable(within(document.querySelector<HTMLElement>('.finding-card')!), m, unknownFor(f).id);
  });

  it('from its detail', () => {
    const f = finding(1);
    const m = mount([f], { posts: [unknownFor(f)] });
    openDetail('Problem 1');
    expectClearable(within(document.querySelector<HTMLElement>('.ap-onhub')!), m, unknownFor(f).id);
  });

  it('from its Also found entry', () => {
    const f = also(4);
    const m = mount([finding(1), f], { posts: [unknownFor(f)] });
    fireEvent.click(fold('Also found'));
    expectClearable(within(screen.getByText('Problem 4', { selector: 'li .title' }).closest('li')!), m, unknownFor(f).id);
  });

  it('moves focus to Keep, back to It was not posted, and after the record is forgotten to Comment on GitHub, saying so', () => {
    const f = finding(1);
    const m = mount([f], { posts: [unknownFor(f)] });
    openDetail('Problem 1');
    const scope = within(document.querySelector<HTMLElement>('main')!);
    fireEvent.click(scope.getByRole('button', { name: 'It was not posted' }));
    expect(document.activeElement).toBe(scope.getByRole('button', { name: 'Keep' }));
    fireEvent.click(scope.getByRole('button', { name: 'Keep' }));
    expect(document.activeElement).toBe(scope.getByRole('button', { name: 'It was not posted' }));
    fireEvent.click(scope.getByRole('button', { name: 'It was not posted' }));
    fireEvent.click(scope.getByRole('button', { name: 'It was not posted' }));
    m.answer({ kind: 'forgotten', id: unknownFor(f).id }, { posts: [] });
    expect(document.activeElement).toBe(button('Comment on GitHub'));
    expect(document.querySelector('[aria-live]')?.textContent).toBe('Record forgotten.');
  });

  it('from a card, after the record is forgotten focus goes to the Findings tab', () => {
    const f = finding(1);
    const m = mount([f], { posts: [unknownFor(f)] });
    const card = within(document.querySelector<HTMLElement>('.finding-card')!);
    fireEvent.click(card.getByRole('button', { name: 'It was not posted' }));
    fireEvent.click(card.getByRole('button', { name: 'It was not posted' }));
    m.answer({ kind: 'forgotten', id: unknownFor(f).id }, { posts: [] });
    expect(document.activeElement).toBe(tab('Findings'));
    expect(document.querySelector('[aria-live]')?.textContent).toBe('Record forgotten.');
  });

  it('GitHub has the review after all: the finding is marked Posted and the sentence is shown, with focus', () => {
    const f = finding(1);
    const m = mount([f], { posts: [unknownFor(f)] });
    const card = within(document.querySelector<HTMLElement>('.finding-card')!);
    fireEvent.click(card.getByRole('button', { name: 'It was not posted' }));
    fireEvent.click(card.getByRole('button', { name: 'It was not posted' }));
    const posted = { ...recordOf([f.fingerprint]), id: unknownFor(f).id };
    m.answer({ kind: 'found', message: GITHUB_HAS_IT, record: posted }, { posts: [posted] });
    expect(screen.getByText('Posted', { selector: '.finding-card *' })).toBeTruthy();
    expect(screen.queryByText('Not known whether this was posted')).toBeNull();
    expect(document.activeElement?.textContent).toBe(GITHUB_HAS_IT);
    expect(document.querySelector('[aria-live]')?.textContent).toBe(GITHUB_HAS_IT);
  });

  it('a refusal is said where it was asked', () => {
    const f = finding(1);
    const m = mount([f], { posts: [unknownFor(f)] });
    const card = within(document.querySelector<HTMLElement>('.finding-card')!);
    fireEvent.click(card.getByRole('button', { name: 'It was not posted' }));
    fireEvent.click(card.getByRole('button', { name: 'It was not posted' }));
    m.answer({ kind: 'refused', message: 'This review was posted, so Airlock keeps its record.' }, { posts: [unknownFor(f)] });
    expect(within(document.querySelector<HTMLElement>('.finding-card')!).getByRole('alert').textContent)
      .toBe('This review was posted, so Airlock keeps its record.');
  });

  it('is disabled with its reason offline and while another action is in flight', () => {
    const f = finding(1);
    const shown = reviewState([f], { posts: [unknownFor(f)] });
    const m = mount([f], { posts: [unknownFor(f)], busy: true });
    const forget = () => within(document.querySelector<HTMLElement>('.finding-card')!).getByRole('button', { name: 'It was not posted' }) as HTMLButtonElement;
    expect(forget().disabled).toBe(true);
    expect(document.getElementById(forget().getAttribute('aria-describedby')!)?.textContent).toBe(WAIT);
    m.show({ kind: 'offline', review: { pr: shown.pr, latest: shown.latest, stale: false } });
    expect(forget().disabled).toBe(true);
    expect(document.getElementById(forget().getAttribute('aria-describedby')!)?.textContent).toBe('Posting needs the Airlock service, which is not answering.');
  });
});

describe('the Post buttons', () => {
  it('while another action is in flight say to wait, for a screen reader', () => {
    mount([finding(1)], { busy: true });
    tick('Problem 1');
    const bar = button('Comment on GitHub (1)');
    expect(bar.disabled).toBe(true);
    expect(document.getElementById(bar.getAttribute('aria-describedby')!)?.textContent).toBe(WAIT);
    openDetail('Problem 1');
    const one = button('Comment on GitHub');
    expect(document.getElementById(one.getAttribute('aria-describedby')!)?.textContent).toBe(WAIT);
  });

  it.each([1, 2])('focus goes back to Comment on GitHub when the sheet was opened from the bar (%i ticked)', (n) => {
    const findings = [finding(1), finding(2)];
    mount(findings);
    for (const f of findings.slice(0, n)) tick(f.title);
    fireEvent.click(button(`Comment on GitHub (${n})`));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button(`Comment on GitHub (${n})`));
  });
});
