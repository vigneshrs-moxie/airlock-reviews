import {
  checkCommentText, COMMENT_MAX, mentionsIn, SUMMARY_MAX, type Finding, type PostPreviewBody, type PostPreviewItem, type PostPreviewReply,
  type PostRecord,
} from '@airlock/shared';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { isFor, POST_NOT_LEARNED, POST_UNKNOWN, type PostReply, type UserAction } from '../state/reduce';
import { recordHolds } from '../state/selection';
import type { SheetView } from './DismissSheet';
import { FileText, MessageSquare } from './FindingIcons';
import { useAnnounce } from './Frame';
import { ForgetAsk, mentionNotice, NO_POST_OFFLINE, WAIT, whyNotPosting } from './PostedMark';
import { Sheet } from './Sheet';
import { shortTitle } from './summary';

export const ONLY_COMMENTS = 'Airlock never approves, requests changes or merges.';
export const NOTHING_SENT = 'Nothing has been sent yet.';
/**
 * Who posts, where, and as what, with the promise that nothing else is done: one comment, or several in one review.
 * `nothingSent` adds that nothing has been sent yet.
 */
export function accountLine(viewer: string, pr: { repo: string; number: number }, n: number, nothingSent: boolean): string {
  const as = n === 1 ? 'as a comment' : `as ${n} comments in one review`;
  const line = `Posts as ${viewer} on ${pr.repo}#${pr.number}, ${as}. ${ONLY_COMMENTS}`;
  return nothingSent ? `${line} ${NOTHING_SENT}` : line;
}
export const GETTING_PREVIEW = 'Getting the preview…';
export const NO_PREVIEW = 'Airlock got no answer for the preview. Ask again when you are ready.';
export const OFFLINE_KEPT_POST = 'Airlock could not reach its service. Your comments are kept.';
export const NOT_THIS_REVIEW_POST = 'This review is no longer the one on screen, so these comments cannot be posted from it. Closing this loses the texts here.';
export const WAITING_FOR_RECORD = 'Waiting to hear whether GitHub accepted the comments…';
/** After a 404 on the post: a copy the browser sent earlier may have gone through. */
export const CHECKING_FOR_RECORD = 'Checking whether this post already went through…';
export const REVIEW_TEXT = "The review's own text, as it will be posted:";
export const REVIEW_TEXT_OLD = 'Update preview to see this again.';
export const PREVIEW_UPDATED = 'Preview updated.';
export const TO_SUMMARY = 'Put in the summary instead';
/** Over another pull request's review, while a post sent from this sheet had not been answered when the tab moved. */
export const postElsewhere = (pr: { repo: string; number: number }): string =>
  `A post of these comments to ${pr.repo}#${pr.number} was in flight when the tab moved. Go back to that pull request to see what happened.`;

let tickets = 0;
/** A number no earlier request of this panel used, so the sheet knows its own answer. */
export const nextTicket = (): number => {
  tickets += 1;
  return tickets;
};

const comments = (n: number): string => `${n} comment${n === 1 ? '' : 's'}`;
/** The sheet's title: how many comments, when there are several. */
export const sheetTitle = (n: number): string => (n === 1 ? 'Comment on GitHub' : `Comment on GitHub: ${comments(n)}`);

/** The post sheet's request in flight. */
export interface PendingPost {
  kind: 'preview' | 'post' | 'forget';
  ticket: number;
  /** The panel was seen busy, or away, since the request was sent: once it is settled again, the request has ended. */
  started: boolean;
  /** For a post: the ids of the records on screen when it was sent, so a record it made can be told apart. */
  known: string[];
  /** For a preview: the findings asked to go in the summary. */
  toSummary: string[];
  /** Whether a post had been sent from this sheet before this request, for a post that never left the panel. */
  wasSent: boolean;
}

/** What the person has done in the post sheet. Kept by the panel screen, so it outlives the sheet being out of sight. */
export interface PostDraft {
  /** The review the sheet was opened on; a preview is only ever asked of this one. */
  reviewId: string;
  /** Its pull request: a request's ending is judged only against this pull request's records. */
  pr: { repo: string; number: number };
  /** The findings asked for, by fingerprint, in order. */
  fingerprints: string[];
  /** Whose Post button opened the sheet: a finding's id, or the selection bar. */
  opener: string | 'selected';
  /** The service's last preview; null until the first comes. */
  preview: PostPreviewReply | null;
  /** The comment fields, by fingerprint. */
  texts: Record<string, string>;
  summary: string;
  /** The person typed in the summary, so it is sent as typed; until then the service writes it. */
  summaryTyped: boolean;
  /** The findings the person put in the summary. */
  toSummary: string[];
  /** `toSummary` as it was when the shown preview was asked for. */
  previewToSummary: string[];
  /** The shown preview is not to be posted (a post of it was refused, forgotten, or not answered): a new one comes first. */
  spent: boolean;
  pending: PendingPost | null;
  /** Why the last request was refused, or that a post's outcome is not known and left no record. */
  said: string | null;
  /** `said` asks the person to look at the pull request. */
  look: boolean;
  /** The post in flight got no clear answer; the panel is reading the records until its record appears, saying this. */
  waiting: string | null;
  /** How many previews have come, so a fresh one after the first can be announced. */
  previews: number;
  /** A post was sent from this sheet, so it no longer says that nothing has been sent. */
  sent: boolean;
  /** The record the last post made, and for one whose outcome is not known, the sentence to show. */
  outcome: { record: PostRecord; message: string | null } | null;
}

/** A sheet just opened on `reviewId` of `pr`, waiting for the first preview asked for under `ticket`. */
export function newPostDraft(
  fingerprints: string[], reviewId: string, opener: string | 'selected', ticket: number, pr: { repo: string; number: number },
): PostDraft {
  return {
    reviewId, pr: { repo: pr.repo, number: pr.number }, fingerprints, opener, preview: null, texts: {}, summary: '', summaryTyped: false,
    toSummary: [], previewToSummary: [], spent: false,
    pending: { kind: 'preview', ticket, started: false, known: [], toSummary: [], wasSent: false }, said: null, look: false, waiting: null,
    previews: 0, sent: false, outcome: null,
  };
}

/** The view the sheet sits over: the review, and the answer to the sheet's last request. */
export type PostSheetView = SheetView & { post?: PostReply | undefined; stale?: boolean | undefined };

/** The draft once the answer to its pending request has come. */
function absorb(draft: PostDraft, pending: PendingPost, reply: Exclude<PostReply, { kind: 'waiting' }>): PostDraft {
  const settled = { ...draft, pending: null, look: false, waiting: null };
  switch (reply.kind) {
    case 'preview': {
      const { preview } = reply;
      const ids = preview.items.map((item) => item.fingerprint);
      const toSummary = pending.toSummary.filter((fp) => ids.includes(fp));
      return {
        ...settled, preview, texts: Object.fromEntries(preview.items.map((item) => [item.fingerprint, item.body])), summary: preview.summary,
        toSummary, previewToSummary: toSummary, spent: false, said: null, outcome: null, previews: draft.previews + 1,
      };
    }
    case 'refused': return { ...settled, said: reply.message, spent: draft.spent || pending.kind === 'post' };
    // Nothing left the panel: the same preview can be posted again.
    case 'unsent': return { ...settled, said: reply.message, sent: pending.wasSent };
    case 'posted': return { ...settled, said: null, outcome: { record: reply.record, message: null } };
    case 'unknown': return { ...settled, said: null, outcome: { record: reply.record, message: reply.message } };
    case 'unclear': return { ...settled, said: reply.message, look: true, spent: true };
    case 'forgotten': return { ...settled, said: null, outcome: null, spent: true };
    // GitHub has the review: it was posted after all, and the service's sentence says so.
    case 'found': return { ...settled, said: reply.message, outcome: { record: reply.record, message: null } };
  }
}

/** The draft when its request ended with no answer for it (the service went away, or the pairing did). */
function unanswered(
  draft: PostDraft, pending: PendingPost, posts: readonly PostRecord[], findings: readonly Pick<Finding, 'fingerprint' | 'aliases'>[],
): PostDraft {
  const settled = { ...draft, pending: null, look: false, waiting: null };
  if (pending.kind !== 'post') return draft.preview === null ? { ...settled, said: NO_PREVIEW } : settled;
  // What the records say: one this post made, on its pull request, holding one of its findings, by the same rule as the marks.
  const sent = draft.preview?.items.map((item) => item.fingerprint) ?? draft.fingerprints;
  const posted = sent.map((fingerprint) => findings.find((f) => f.fingerprint === fingerprint) ?? { fingerprint });
  const record = posts.find((r) => isFor(r, draft.pr) && !pending.known.includes(r.id) && posted.some((f) => recordHolds(r, f)));
  if (record === undefined) return { ...settled, said: POST_NOT_LEARNED, look: true, spent: true };
  return { ...settled, said: null, outcome: { record, message: record.outcome === 'posted' ? null : POST_UNKNOWN } };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/** Where a comment on a line shows, in words. */
function lineOf(item: PostPreviewItem): string {
  // The service always gives an inline comment its line (posts/preview.ts); the contract allows none, so it is handled.
  if (item.line === null) return `${item.path}.`;
  return item.startLine === null ? `${item.path}, line ${item.line}.` : `${item.path}, lines ${item.startLine} to ${item.line}.`;
}

export const ON_THE_LINE = 'On the line';
export const IN_THE_SUMMARY = 'In the review summary';
export const SHOWS_NEXT_TO_CODE = 'It shows in Files changed, next to the code.';
export const NAMES_FILE_AND_LINE = 'The comment names the file and line.';

/** Where one comment goes: on its line, or in the review summary with the reason, and the control that moves it. */
function Destination({ item, heading, movable }: { item: PostPreviewItem; heading: string; movable: ReactNode }) {
  const inline = item.placement === 'inline';
  const summaryLine = [item.whySummary, item.line === null ? 'The comment names the file.' : NAMES_FILE_AND_LINE].filter((s) => s !== null).join(' ');
  return (
    <div className="ap-dest" data-placement={item.placement}>
      {inline ? <MessageSquare /> : <FileText />}
      <div>
        <p className="title">{heading}</p>
        <p><strong>{inline ? ON_THE_LINE : IN_THE_SUMMARY}</strong></p>
        <p>{inline ? `${lineOf(item)} ${SHOWS_NEXT_TO_CODE}` : summaryLine}</p>
        {movable}
      </div>
    </div>
  );
}

/**
 * A text field with its count, the reason it cannot be posted, and who it names. `names`: the service's list for text
 * it has shown; without it, the names in the field as typed.
 */
function TextField({ label, value, max, locked, names: given, onChange }: {
  label: string; value: string; max: number; locked: boolean; names?: readonly string[] | undefined; onChange: (value: string) => void;
}) {
  const id = useId();
  const problemId = useId();
  const problem = checkCommentText(value, max);
  const names = given ?? mentionsIn(value);
  return (
    <>
      <label htmlFor={id} className="label">{label}</label>
      <textarea
        id={id} className="input" rows={4} value={value} spellCheck={false} readOnly={locked}
        {...(problem === null ? {} : { 'aria-describedby': problemId, 'aria-invalid': true })}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="muted">{`${[...value].length} of ${max}`}</p>
      {problem !== null && <p id={problemId} className="detail">{problem}</p>}
      {names.length > 0 && <p className="notice">{mentionNotice(names)}</p>}
    </>
  );
}

/**
 * Posting chosen findings as one review: the service's preview, every text editable, then the post. What is posted is
 * always the preview the service last showed: after any edit the main button asks for a new one.
 */
export function PostSheet({ draft, onDraft, view, dispatch, active, onClose }: {
  draft: PostDraft;
  onDraft: (next: PostDraft) => void;
  view: PostSheetView;
  dispatch: (action: UserAction) => void;
  /** False while the sheet is kept out of sight. */
  active: boolean;
  /** Cancel, Close or Done: the draft is dropped. */
  onClose: () => void;
}) {
  const { pr, latest, offline } = view;
  const { preview, pending, outcome } = draft;
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const announce = useAnnounce();
  const busy = view.busy === true;
  const current = latest.document.id === draft.reviewId;
  // The view is of another pull request (the tab moved): a request of this sheet is not judged by its records.
  const elsewhere = !isFor(draft.pr, pr);

  // Takes the answer to this sheet's own request, or sees that the request ended without one.
  useEffect(() => {
    if (pending === null) return;
    const reply = view.post !== undefined && view.post.ticket === pending.ticket ? view.post : undefined;
    if (reply !== undefined && reply.kind !== 'waiting') onDraft(absorb(draft, pending, reply));
    else if (reply !== undefined && draft.waiting === null) {
      onDraft({ ...draft, waiting: reply.checking === true ? CHECKING_FOR_RECORD : WAITING_FOR_RECORD, pending: { ...pending, started: true } });
    }
    else if (!pending.started && (busy || offline)) onDraft({ ...draft, pending: { ...pending, started: true } });
    else if (pending.started && !busy && !offline && !elsewhere) onDraft(unanswered(draft, pending, latest.posts, latest.document.findings));
  }, [draft, pending, view.post, busy, offline, elsewhere, latest.posts, latest.document.findings, onDraft]);

  const showing = outcome !== null ? (outcome.record.outcome === 'posted' ? 'posted' : 'unknown')
    : !current ? 'stale' : preview === null ? 'waiting' : 'form';

  const posted = outcome !== null && outcome.record.outcome === 'posted' ? `Posted ${comments(outcome.record.items.length)}.` : null;
  const unknown = outcome !== null && outcome.record.outcome !== 'posted' ? outcome.message ?? POST_UNKNOWN : null;
  useEffect(() => { if (posted !== null) announce(posted); }, [announce, posted]);
  useEffect(() => { if (unknown !== null) announce(unknown); }, [announce, unknown]);
  useEffect(() => { if (offline) announce(OFFLINE_KEPT_POST); }, [announce, offline]);

  // The control that had focus is gone when the sheet changes what it shows; focus goes to its heading. Out of sight the
  // move waits and is not used up.
  const was = useRef(showing);
  useEffect(() => {
    if (!active || was.current === showing) return;
    was.current = showing;
    heading.current?.focus();
  }, [showing, active]);

  // A post in flight cannot be left, offline included: its outcome is shown when it is known. Over another pull request
  // it can: that pull request's own marks say what happened when the tab is back.
  const inFlight = busy || (pending?.kind === 'post' && !elsewhere);
  const close = (): void => { if (!inFlight) onClose(); };
  const canSend = current && !busy && !offline && pending === null;
  // Why nothing can be posted from this review now, as it is on screen while the sheet is open.
  const blocked = whyNotPosting(pr, view.stale === true, offline);
  const blockedId = useId();
  const mainButton = useRef<HTMLButtonElement>(null);

  // A fresh preview after the first is said, and focus goes to the button that now posts it.
  const seenPreviews = useRef(draft.previews);
  useEffect(() => {
    if (seenPreviews.current === draft.previews) return;
    const again = seenPreviews.current > 0;
    seenPreviews.current = draft.previews;
    if (!again || !active) return;
    announce(PREVIEW_UPDATED);
    mainButton.current?.focus();
  }, [draft.previews, active, announce]);

  const edited = preview !== null && (
    preview.items.some((item) => draft.texts[item.fingerprint] !== item.body)
    || draft.summary !== preview.summary
    || !sameSet(draft.toSummary, draft.previewToSummary)
  );
  const needsUpdate = edited || draft.spent;
  const problems = preview !== null && (
    preview.items.some((item) => checkCommentText(draft.texts[item.fingerprint] ?? '') !== null)
    || checkCommentText(draft.summary, SUMMARY_MAX) !== null
  );

  const request = (kind: PendingPost['kind'], action: (ticket: number) => UserAction): void => {
    const ticket = nextTicket();
    onDraft({
      ...draft, said: null, look: false, sent: draft.sent || kind === 'post',
      pending: { kind, ticket, started: false, known: latest.posts.map((r) => r.id), toSummary: draft.toSummary, wasSent: draft.sent },
    });
    dispatch(action(ticket));
  };
  const askAgain = (): void => {
    if (!canSend) return;
    const items = draft.fingerprints.map((fingerprint) => ({ fingerprint }));
    request('preview', (ticket) => ({ type: 'preview-post', ticket, body: { repo: pr.repo, number: pr.number, reviewId: draft.reviewId, items } }));
  };
  const update = (): void => {
    if (!canSend || preview === null || problems || blocked !== null) return;
    const body: PostPreviewBody = {
      repo: pr.repo, number: pr.number, reviewId: draft.reviewId,
      items: preview.items.map((item) => ({
        fingerprint: item.fingerprint, body: draft.texts[item.fingerprint] ?? item.body,
        ...(draft.toSummary.includes(item.fingerprint) ? { placement: 'summary' as const } : {}),
      })),
      ...(draft.summaryTyped ? { summary: draft.summary } : {}),
    };
    request('preview', (ticket) => ({ type: 'preview-post', ticket, body }));
  };
  const post = (): void => {
    if (!canSend || preview === null || needsUpdate || problems || blocked !== null) return;
    const fingerprints = preview.items.map((item) => item.fingerprint);
    request('post', (ticket) => ({ type: 'post', ticket, previewId: preview.previewId, fingerprints }));
  };
  const forget = (): void => {
    if (!canSend || outcome === null) return;
    const { id } = outcome.record;
    request('forget', (ticket) => ({ type: 'forget-post', ticket, id }));
  };

  // Every edit clears the sentence about the last request.
  const editText = (fingerprint: string, value: string): void => onDraft({ ...draft, said: null, look: false, texts: { ...draft.texts, [fingerprint]: value } });
  const editSummary = (value: string): void => onDraft({ ...draft, said: null, look: false, summary: value, summaryTyped: true });
  const choose = (fingerprint: string, toSummary: boolean): void => onDraft({
    ...draft, said: null, look: false, toSummary: toSummary ? [...draft.toSummary, fingerprint] : draft.toSummary.filter((fp) => fp !== fingerprint),
  });

  // Built by code from the pull request on screen, never from text.
  const pullAddress = `https://github.com/${pr.repo}/pull/${pr.number}`;
  const pullLink = <p><a href={pullAddress} target="_blank" rel="noopener noreferrer">Open the pull request</a></p>;
  const saidLine = draft.said !== null && (
    <>
      <p role="alert" className="notice">{draft.said}</p>
      {draft.look && pullLink}
    </>
  );
  const offlineLine = offline && <p className="notice">{OFFLINE_KEPT_POST}</p>;
  const shell = (children: React.ReactNode) => (
    <Sheet labelledBy={titleId} initialFocus={heading} returnFocus={false} active={active} bottom onClose={close}>
      <div className="ap-sheet">
        <h2 className="ap-sheet-title" id={titleId} tabIndex={-1} ref={heading}>{sheetTitle(preview?.items.length ?? draft.fingerprints.length)}</h2>
        {children}
      </div>
    </Sheet>
  );

  if (showing === 'posted' && outcome !== null) {
    return shell(
      <>
        {saidLine}
        <p>{posted}</p>
        {outcome.record.url !== null && <p><a href={outcome.record.url} target="_blank" rel="noopener noreferrer">Open on GitHub</a></p>}
        <div className="actions">
          <button type="button" className="btn primary" disabled={inFlight} onClick={onClose}>Done</button>
        </div>
      </>,
    );
  }

  if (showing === 'unknown' && outcome !== null) {
    return shell(
      <>
        <p role="alert" className="notice">{unknown}</p>
        {pullLink}
        {saidLine}
        {offlineLine}
        <ForgetAsk blocked={canSend ? null : !current ? NOT_THIS_REVIEW_POST : offline ? NO_POST_OFFLINE : WAIT} onForget={forget} />
        <div className="actions">
          <button type="button" className="btn" disabled={inFlight} onClick={onClose}>Close</button>
        </div>
      </>,
    );
  }

  if (showing === 'stale') {
    return shell(
      <>
        <p role="alert" className="notice">{NOT_THIS_REVIEW_POST}</p>
        {pending?.kind === 'post' && elsewhere && <p className="notice">{postElsewhere(draft.pr)}</p>}
        {saidLine}
        <div className="actions">
          <button type="button" className="btn" disabled={inFlight} onClick={onClose}>Close</button>
        </div>
      </>,
    );
  }

  if (showing === 'waiting' || preview === null) {
    return shell(
      <>
        {pending !== null ? <p role="status">{GETTING_PREVIEW}</p> : saidLine}
        {offlineLine}
        <div className="actions">
          {pending === null && <button type="button" className="btn primary" disabled={!canSend} onClick={askAgain}>Ask again</button>}
          <button type="button" className="btn" disabled={inFlight} onClick={onClose}>{pending === null ? 'Close' : 'Cancel'}</button>
        </div>
      </>,
    );
  }

  const locked = pending !== null || busy;
  // Names for a fresh preview are the service's; a field with unsent edits counts its own.
  // The review's own text: the service's list for it, unless the summary or a comment placed in the summary has unsent
  // edits; those fields then say their own names.
  const reviewTextEdited = draft.summary !== preview.summary
    || preview.items.some((item) => item.placement === 'summary' && draft.texts[item.fingerprint] !== item.body);
  const reviewNames = reviewTextEdited ? [] : preview.reviewBodyMentions;
  const mainDisabled = !canSend || problems || blocked !== null;
  const describedByBlock = blocked === null ? {} : { 'aria-describedby': blockedId };
  const n = preview.items.length;
  const several = n > 1;
  // Each comment is headed by its finding's short title (the service's title when the finding is not on screen); the
  // text that is posted is the field's, never this.
  const headingOf = (item: PostPreviewItem): string => {
    const found = latest.document.findings.find((f) => f.fingerprint === item.fingerprint || (f.aliases ?? []).includes(item.fingerprint));
    return shortTitle(found ?? { title: item.title });
  };
  const toSummaryControl = (item: PostPreviewItem): ReactNode => {
    const movable = item.placement === 'inline' || draft.previewToSummary.includes(item.fingerprint) || draft.toSummary.includes(item.fingerprint);
    if (!movable) return null;
    return (
      <label className="choice">
        <input
          type="checkbox" checked={draft.toSummary.includes(item.fingerprint)} disabled={locked}
          onChange={(e) => choose(item.fingerprint, e.target.checked)}
        />
        <span>{TO_SUMMARY}</span>
      </label>
    );
  };
  return shell(
    <>
      <div className="ap-group">
        <p className="label">{several ? 'Where they go' : 'Where it goes'}</p>
        {preview.items.map((item) => <Destination key={item.fingerprint} item={item} heading={headingOf(item)} movable={toSummaryControl(item)} />)}
      </div>
      <div className="ap-group">
        <p className="label">The exact text</p>
        {preview.items.map((item, i) => (
          <div key={item.fingerprint} className="ap-field">
            {several && <p className="muted">{headingOf(item)}</p>}
            <TextField
              label={`Comment ${i + 1}`} value={draft.texts[item.fingerprint] ?? ''} max={COMMENT_MAX} locked={locked}
              names={draft.texts[item.fingerprint] === item.body ? item.mentions : undefined}
              onChange={(value) => editText(item.fingerprint, value)}
            />
          </div>
        ))}
        <div className="ap-field">
          <TextField
            label="Summary" value={draft.summary} max={SUMMARY_MAX} locked={locked}
            // The summary as the service showed it is counted in the review's own text below.
            names={draft.summary === preview.summary ? [] : undefined} onChange={editSummary}
          />
        </div>
        <div className="ap-field">
          <p className="label">{REVIEW_TEXT}</p>
          <div className={edited ? 'quote muted' : 'quote'} data-review-body data-stale={edited ? 'true' : 'false'}>{preview.reviewBody}</div>
          {edited && <p className="muted">{REVIEW_TEXT_OLD}</p>}
          {reviewNames.length > 0 && <p className="notice">{mentionNotice(reviewNames)}</p>}
        </div>
      </div>
      <p className="muted">{accountLine(preview.viewer, pr, n, !needsUpdate && pending === null && !draft.sent)}</p>
      {saidLine}
      {offlineLine}
      {draft.waiting !== null && pending?.kind === 'post' && <p role="status">{draft.waiting}</p>}
      <div className="ap-buttons">
        {needsUpdate
          ? <button type="button" className="btn primary" ref={mainButton} disabled={mainDisabled} {...describedByBlock} onClick={update}>Update preview</button>
          : (
            <button type="button" className="btn primary" ref={mainButton} disabled={mainDisabled} {...describedByBlock} onClick={post}>
              {several ? `Post ${comments(n)}` : 'Post comment'}
            </button>
          )}
        <button type="button" className="btn" disabled={inFlight} onClick={onClose}>Cancel</button>
      </div>
      {blocked !== null && <p className="muted" id={blockedId}>{blocked}</p>}
    </>,
  );
}

/** Where focus goes after the post sheet is closed: the Post button that opened it, else the finding or the list it was on. */
export function focusAfterPost(draft: Pick<PostDraft, 'opener'>): HTMLElement | null {
  const find = (attr: string, value?: string): HTMLElement | null =>
    [...document.querySelectorAll<HTMLElement>(`[${attr}]`)].find((n) => value === undefined || n.getAttribute(attr) === value) ?? null;
  const usable = (node: HTMLElement | null): HTMLElement | null => (node !== null && !node.hasAttribute('disabled') ? node : null);
  const own = draft.opener === 'selected' ? usable(find('data-post-selected')) : usable(find('data-post-for', draft.opener));
  return own
    ?? find('data-focus', 'detail')
    ?? find('data-focus', 'findings')
    ?? find('data-focus', 'verdict');
}
