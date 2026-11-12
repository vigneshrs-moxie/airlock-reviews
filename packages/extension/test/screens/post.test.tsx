// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Finding, PostPreviewReply } from '@airlock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelScreen } from '../../src/screens/PanelScreen';
import type { PanelState, PostReply, UserAction } from '../../src/state/reduce';
import { UNKNOWN_SENTENCE, previewItem, previewOf, recordOf } from '../helpers/post-fixtures';
import { finding, reviewState, type ReviewOptions } from './review-fixtures';

afterEach(cleanup);

const FIXED = 'Airlock posts these as one review with the Comment action. It never approves or requests changes.';

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
const tick = (title: string) => fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(`${title}$`) }));

const itemFor = (f: Finding, over: Parameters<typeof previewItem>[1] = {}) => previewItem(f, over);

/** Opens the first finding, presses Post comment, and answers with its preview. */
function previewed(findings: Finding[] = [finding(1)], opts: ReviewOptions = {}, preview?: PostPreviewReply): Mounted & { preview: PostPreviewReply } {
  const m = mount(findings, opts);
  openDetail((findings[0] as Finding).title);
  fireEvent.click(button('Post comment'));
  const shownPreview = preview ?? previewOf([itemFor(findings[0] as Finding)]);
  m.answer({ kind: 'preview', preview: shownPreview });
  return { ...m, preview: shownPreview };
}

describe('the post sheet', () => {
  it('Post comment opens the sheet with the service preview for that finding', () => {
    const f = finding(1);
    const m = mount([f, finding(2)]);
    openDetail('Problem 1');
    fireEvent.click(button('Post comment'));
    expect(m.last()).toEqual({
      type: 'preview-post', ticket: expect.any(Number),
      body: { repo: 'acme/widgets', number: 1, reviewId: 'r_0000000001', items: [{ fingerprint: f.fingerprint }] },
    });
    expect(dialog().getByText('Getting the preview…')).toBeTruthy();
    const preview = previewOf([itemFor(f, { body: 'The exact comment.' })]);
    m.answer({ kind: 'preview', preview });
    const d = dialog();
    expect(d.getByRole('heading', { name: 'Post to GitHub' })).toBeTruthy();
    expect(d.getByText('Posts as bob on acme/widgets#1.')).toBeTruthy();
    expect(d.getByText('On src/file1.ts, line 10')).toBeTruthy();
    expect(field('Comment 1').value).toBe('The exact comment.');
    expect(d.getByText(`${'The exact comment.'.length} of 4000`)).toBeTruthy();
    expect(field('Summary').value).toBe('Review notes from Airlock: 1 comment.');
    expect(d.getByText(FIXED)).toBeTruthy();
    expect(d.getByRole('checkbox', { name: 'Put in the summary instead' })).toBeTruthy();
    expect(button('Post 1 comment to GitHub').disabled).toBe(false);
    expect(d.queryByRole('button', { name: 'Update preview' })).toBeNull();
  });

  it('says why a comment goes in the summary, and a range of lines', () => {
    const [a, b] = [finding(1), finding(2)];
    previewed([a, b], {}, previewOf([
      itemFor(a, { placement: 'summary', whySummary: 'The line is not part of the diff GitHub shows.' }),
      itemFor(b, { line: 22, startLine: 20 }),
    ]));
    expect(dialog().getByText('In the summary: The line is not part of the diff GitHub shows.')).toBeTruthy();
    expect(dialog().getByText('On src/file2.ts, lines 20 to 22')).toBeTruthy();
    // A comment the service put in the summary because its line is not in the diff cannot be moved inline.
    expect(dialog().getAllByRole('checkbox', { name: 'Put in the summary instead' })).toHaveLength(1);
  });

  it('Post selected sends the ticked findings and skips posted ones', () => {
    const [a, b, c] = [finding(1), finding(2), finding(3)];
    const m = mount([a, b, c], { posts: [recordOf([b.fingerprint])] });
    tick('Problem 1');
    tick('Problem 2');
    tick('Problem 3');
    fireEvent.click(button('Post selected (2)'));
    expect(m.last()).toMatchObject({
      type: 'preview-post',
      body: { items: [{ fingerprint: a.fingerprint }, { fingerprint: c.fingerprint }] },
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Post selected is disabled with its reason when every ticked finding is posted', () => {
    const [a, b] = [finding(1), finding(2)];
    mount([a, b], { posts: [recordOf([a.fingerprint])] });
    tick('Problem 1');
    expect(button('Post selected (0)').disabled).toBe(true);
    expect(screen.getByText('The selected findings are already posted.')).toBeTruthy();
  });

  it('an edit turns the button into Update preview and Post is not offered until the preview is fresh', () => {
    const f = finding(1);
    const m = previewed([f]);
    type('Comment 1', 'A better comment.');
    expect(screen.queryByRole('button', { name: /^Post 1 comment/ })).toBeNull();
    expect(button('Update preview').disabled).toBe(false);
    // Typed back to what the service showed: the preview is the text again.
    type('Comment 1', m.preview.items[0]!.body);
    expect(button('Post 1 comment to GitHub')).toBeTruthy();
    type('Comment 1', 'A better comment.');
    fireEvent.click(button('Update preview'));
    expect(m.last()).toEqual({
      type: 'preview-post', ticket: expect.any(Number),
      body: { repo: 'acme/widgets', number: 1, reviewId: 'r_0000000001', items: [{ fingerprint: f.fingerprint, body: 'A better comment.' }] },
    });
    // While the new preview is coming, nothing can be posted.
    expect(screen.queryByRole('button', { name: /^Post 1 comment/ })).toBeNull();
    m.answer({ kind: 'preview', preview: previewOf([itemFor(f, { body: 'A better comment.' })], { previewId: 'pv_1111111111111111' }) });
    fireEvent.click(button('Post 1 comment to GitHub'));
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
    expect(button('Post 1 comment to GitHub')).toBeTruthy();
  });

  it('a mention shows the notice with the names', () => {
    previewed();
    type('Comment 1', 'Ask @alice and @acme/reviewers, not `@bob`.');
    expect(dialog().getByText('Mentions @alice, @acme/reviewers: they will be notified.')).toBeTruthy();
    type('Summary', 'Thanks @carol.');
    expect(dialog().getByText('Mentions @carol: they will be notified.')).toBeTruthy();
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
    fireEvent.click(button('Post 2 comments to GitHub'));
    const said = 'GitHub refused the comments: Line 10 is not part of the diff. Nothing was posted.';
    m.answer({ kind: 'refused', message: said });
    expect(dialog().getByRole('alert').textContent).toBe(said);
    expect(field('Comment 1').value).toBe('Edited first.');
    expect(field('Comment 2').value).toBe(m.preview.items[1]!.body);
    expect(field('Summary').value).toBe('Edited summary.');
    // A new preview of the kept texts comes before another post.
    expect(button('Update preview').disabled).toBe(false);
    expect(screen.queryByRole('button', { name: /^Post 2 comments/ })).toBeNull();
    // The next edit clears the sentence.
    type('Comment 1', 'Edited again.');
    expect(dialog().queryByRole('alert')).toBeNull();
  });

  it('a refused first preview says why, with Close', () => {
    const m = mount([finding(1)]);
    openDetail('Problem 1');
    fireEvent.click(button('Post comment'));
    m.answer({ kind: 'refused', message: 'This finding is already posted on this pull request: Problem 1.' });
    expect(dialog().getByRole('alert').textContent).toBe('This finding is already posted on this pull request: Problem 1.');
    fireEvent.click(button('Close'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('posted: says how many, links to the review, and marks the finding', () => {
    const f = finding(1);
    const m = previewed([f]);
    fireEvent.click(button('Post 1 comment to GitHub'));
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
    expect(button('Post comment').disabled).toBe(true);
  });

  it('an unknown outcome offers It was not posted, which forgets the record', () => {
    const f = finding(1);
    const m = previewed([f]);
    type('Comment 1', 'Kept text.');
    fireEvent.click(button('Update preview'));
    m.answer({ kind: 'preview', preview: previewOf([itemFor(f, { body: 'Kept text.' })]) });
    fireEvent.click(button('Post 1 comment to GitHub'));
    const record = recordOf([f.fingerprint], { outcome: 'unknown' });
    m.answer({ kind: 'unknown', message: UNKNOWN_SENTENCE, record }, { posts: [record] });
    const d = dialog();
    expect(d.getByRole('alert').textContent).toBe(UNKNOWN_SENTENCE);
    expect((d.getByRole('link', { name: 'Open the pull request' }) as HTMLAnchorElement).getAttribute('href')).toBe('https://github.com/acme/widgets/pull/1');
    fireEvent.click(button('It was not posted'));
    expect(m.last()).toEqual({ type: 'forget-post', ticket: expect.any(Number), id: record.id });
    m.answer({ kind: 'forgotten', id: record.id });
    expect(field('Comment 1').value).toBe('Kept text.');
    expect(button('Update preview').disabled).toBe(false);
  });

  it('an unknown record shows its mark on the finding and its card', () => {
    const f = finding(1);
    mount([f], { posts: [recordOf([f.fingerprint], { outcome: 'unknown' })] });
    expect(screen.getByText('Not known whether this was posted', { selector: '.finding-card *' })).toBeTruthy();
    openDetail('Problem 1');
    expect(screen.getByText('Not known whether this was posted')).toBeTruthy();
    expect(button('Post comment').disabled).toBe(true);
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
    expect(button('Post selected (1)').disabled).toBe(true);
    expect(screen.getByText(reason)).toBeTruthy();
    openDetail('Problem 1');
    expect(button('Post comment').disabled).toBe(true);
    expect(button('Post comment').getAttribute('aria-describedby')).toBe(screen.getByText(reason).id);
  });

  it('posting is disabled with its reason offline', () => {
    const shown = reviewState([finding(1)]);
    const m = mount([finding(1)]);
    tick('Problem 1');
    m.show({ kind: 'offline', review: { pr: shown.pr, latest: shown.latest, stale: false } });
    expect(button('Post selected (1)').disabled).toBe(true);
    expect(screen.getByText('Posting needs the Airlock service, which is not answering.')).toBeTruthy();
  });

  it('a second press during a post sends nothing and the sheet cannot be closed', () => {
    const f = finding(1);
    const m = previewed([f]);
    const post = button('Post 1 comment to GitHub');
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
    fireEvent.click(button('Post 1 comment to GitHub'));
    m.show(offlineOf(reviewState([f])));
    expect(screen.getByRole('dialog')).toBeTruthy();
    const record = recordOf([f.fingerprint]);
    m.show(reviewState([f], { posts: [record] }));
    expect(dialog().getByText('Posted 1 comment.')).toBeTruthy();
  });

  it('a post with no answer and no record when the service is back says so and keeps the texts', () => {
    const f = finding(1);
    const m = previewed([f]);
    fireEvent.click(button('Post 1 comment to GitHub'));
    m.show(offlineOf(reviewState([f])));
    m.show(reviewState([f]));
    expect(dialog().getByRole('alert').textContent).toBe('Airlock got no answer about this post and has no record of it. Look at the pull request before posting again.');
    expect(field('Comment 1').value).toBe(m.preview.items[0]!.body);
    expect(button('Update preview')).toBeTruthy();
  });

  it('closes on Escape and gives focus back to Post comment', () => {
    previewed();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button('Post comment'));
  });

  it('Cancel drops the draft: the next sheet asks for a new preview', () => {
    const m = previewed();
    type('Comment 1', 'Dropped.');
    fireEvent.click(button('Cancel'));
    fireEvent.click(button('Post comment'));
    expect(m.last().type).toBe('preview-post');
    expect(dialog().getByText('Getting the preview…')).toBeTruthy();
  });

  it('a review that is no longer the one on screen is not posted to', () => {
    const f = finding(1);
    const m = previewed([f]);
    m.show(reviewState([f], { doc: { id: 'r_0000000002' } }));
    expect(dialog().getByText('This review is no longer the one on screen, so these comments cannot be posted from it.')).toBeTruthy();
    expect(dialog().queryByRole('button', { name: /^Post 1 comment/ })).toBeNull();
    fireEvent.click(button('Close'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

