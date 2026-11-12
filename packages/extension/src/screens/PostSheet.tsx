import {
  checkCommentText, COMMENT_MAX, mentionsIn, SUMMARY_MAX, type PostPreviewBody, type PostPreviewItem, type PostPreviewReply, type PostRecord,
} from '@airlock/shared';
import { useEffect, useId, useRef } from 'react';
import { POST_NOT_LEARNED, POST_UNKNOWN, type PostReply, type UserAction } from '../state/reduce';
import type { SheetView } from './DismissSheet';
import { useAnnounce } from './Frame';
import { mentionNotice, whyNotPosting } from './PostedMark';
import { Sheet } from './Sheet';

export const POST_ONE_REVIEW = 'Airlock posts these as one review with the Comment action. It never approves or requests changes.';
export const EXACT_TEXT = 'This is the exact text. Nothing has been sent yet.';
export const GETTING_PREVIEW = 'Getting the preview…';
export const NO_PREVIEW = 'Airlock got no answer for the preview. Ask again when you are ready.';
export const OFFLINE_KEPT_POST = 'Airlock could not reach its service. Your comments are kept.';
export const NOT_THIS_REVIEW_POST = 'This review is no longer the one on screen, so these comments cannot be posted from it. Closing this loses the texts here.';
export const WAITING_FOR_RECORD = 'Waiting to hear whether GitHub accepted the comments…';
export const REVIEW_TEXT = "The review's own text, as it will be posted:";
export const REVIEW_TEXT_OLD = 'Update preview to see this again.';
export const PREVIEW_UPDATED = 'Preview updated.';
export const TO_SUMMARY = 'Put in the summary instead';

let tickets = 0;
/** A number no earlier request of this panel used, so the sheet knows its own answer. */
export const nextTicket = (): number => {
  tickets += 1;
  return tickets;
};

const comments = (n: number): string => `${n} comment${n === 1 ? '' : 's'}`;

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
}

/** What the person has done in the post sheet. Kept by the panel screen, so it outlives the sheet being out of sight. */
export interface PostDraft {
  /** The review the sheet was opened on; a preview is only ever asked of this one. */
  reviewId: string;
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
  /** The post in flight got no clear answer; the panel is reading the records until its record appears. */
  waiting: boolean;
  /** How many previews have come, so a fresh one after the first can be announced. */
  previews: number;
  /** The record the last post made, and for one whose outcome is not known, the sentence to show. */
  outcome: { record: PostRecord; message: string | null } | null;
}

/** A sheet just opened, waiting for the first preview asked for under `ticket`. */
export function newPostDraft(fingerprints: string[], reviewId: string, opener: string | 'selected', ticket: number): PostDraft {
  return {
    reviewId, fingerprints, opener, preview: null, texts: {}, summary: '', summaryTyped: false, toSummary: [], previewToSummary: [], spent: false,
    pending: { kind: 'preview', ticket, started: false, known: [], toSummary: [] }, said: null, look: false, waiting: false, previews: 0,
    outcome: null,
  };
}

/** The view the sheet sits over: the review, and the answer to the sheet's last request. */
export type PostSheetView = SheetView & { post?: PostReply | undefined; stale?: boolean | undefined };

/** The draft once the answer to its pending request has come. */
function absorb(draft: PostDraft, pending: PendingPost, reply: Exclude<PostReply, { kind: 'waiting' }>): PostDraft {
  const settled = { ...draft, pending: null, look: false, waiting: false };
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
    case 'posted': return { ...settled, said: null, outcome: { record: reply.record, message: null } };
    case 'unknown': return { ...settled, said: null, outcome: { record: reply.record, message: reply.message } };
    case 'unclear': return { ...settled, said: reply.message, look: true, spent: true };
    case 'forgotten': return { ...settled, said: null, outcome: null, spent: true };
  }
}

/** The draft when its request ended with no answer for it (the service went away, or the pairing did). */
function unanswered(draft: PostDraft, pending: PendingPost, posts: readonly PostRecord[]): PostDraft {
  const settled = { ...draft, pending: null, look: false, waiting: false };
  if (pending.kind !== 'post') return draft.preview === null ? { ...settled, said: NO_PREVIEW } : settled;
  // What the records say: one this post made, holding one of its findings.
  const sent = draft.preview?.items.map((item) => item.fingerprint) ?? draft.fingerprints;
  const record = posts.find((r) => !pending.known.includes(r.id) && r.items.some((item) => sent.includes(item.fingerprint)));
  if (record === undefined) return { ...settled, said: POST_NOT_LEARNED, look: true, spent: true };
  return { ...settled, said: null, outcome: { record, message: record.outcome === 'posted' ? null : POST_UNKNOWN } };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/** Where a comment goes, in words. */
function placeOf(item: PostPreviewItem): string {
  if (item.placement === 'summary') return item.whySummary === null ? 'In the summary' : `In the summary: ${item.whySummary}`;
  if (item.line === null) return `On ${item.path}`;
  return item.startLine === null ? `On ${item.path}, line ${item.line}` : `On ${item.path}, lines ${item.startLine} to ${item.line}`;
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

  // Takes the answer to this sheet's own request, or sees that the request ended without one.
  useEffect(() => {
    if (pending === null) return;
    const reply = view.post !== undefined && view.post.ticket === pending.ticket ? view.post : undefined;
    if (reply !== undefined && reply.kind !== 'waiting') onDraft(absorb(draft, pending, reply));
    else if (reply !== undefined && !draft.waiting) onDraft({ ...draft, waiting: true, pending: { ...pending, started: true } });
    else if (!pending.started && (busy || offline)) onDraft({ ...draft, pending: { ...pending, started: true } });
    else if (pending.started && !busy && !offline) onDraft(unanswered(draft, pending, latest.posts));
  }, [draft, pending, view.post, busy, offline, latest.posts, onDraft]);

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

  // A post in flight cannot be left, offline included: its outcome is shown when it is known.
  const inFlight = busy || pending?.kind === 'post';
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
      ...draft, said: null, look: false,
      pending: { kind, ticket, started: false, known: latest.posts.map((r) => r.id), toSummary: draft.toSummary },
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
    <Sheet labelledBy={titleId} initialFocus={heading} returnFocus={false} active={active} onClose={close}>
      <h2 className="title" id={titleId} tabIndex={-1} ref={heading}>Post to GitHub</h2>
      {children}
    </Sheet>
  );

  if (showing === 'posted' && outcome !== null) {
    return shell(
      <>
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
        <div className="actions">
          <button type="button" className="btn" disabled={!canSend} onClick={forget}>It was not posted</button>
          <button type="button" className="btn" disabled={inFlight} onClick={onClose}>Close</button>
        </div>
      </>,
    );
  }

  if (showing === 'stale') {
    return shell(
      <>
        <p role="alert" className="notice">{NOT_THIS_REVIEW_POST}</p>
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
  const reviewNames = edited ? [] : mentionsIn(preview.reviewBody);
  const mainDisabled = !canSend || problems || blocked !== null;
  const describedByBlock = blocked === null ? {} : { 'aria-describedby': blockedId };
  return shell(
    <>
      <p>{`Posts as ${preview.viewer} on ${pr.repo}#${pr.number}.`}</p>
      {!needsUpdate && <p className="muted">{EXACT_TEXT}</p>}
      {preview.items.map((item, i) => {
        const movable = item.placement === 'inline' || draft.previewToSummary.includes(item.fingerprint) || draft.toSummary.includes(item.fingerprint);
        return (
          <section key={item.fingerprint} className="part">
            <p className="title">{item.title}</p>
            <p className="muted">{placeOf(item)}</p>
            <TextField
              label={`Comment ${i + 1}`} value={draft.texts[item.fingerprint] ?? ''} max={COMMENT_MAX} locked={locked}
              names={draft.texts[item.fingerprint] === item.body ? item.mentions : undefined}
              onChange={(value) => editText(item.fingerprint, value)}
            />
            {movable && (
              <label className="choice">
                <input
                  type="checkbox" checked={draft.toSummary.includes(item.fingerprint)} disabled={locked}
                  onChange={(e) => choose(item.fingerprint, e.target.checked)}
                />
                <span>{TO_SUMMARY}</span>
              </label>
            )}
          </section>
        );
      })}
      <section className="part">
        <TextField
          label="Summary" value={draft.summary} max={SUMMARY_MAX} locked={locked}
          // The summary as the service showed it is counted in the review's own text below.
          names={draft.summary === preview.summary ? [] : undefined} onChange={editSummary}
        />
      </section>
      <section className="part">
        <p className="label">{REVIEW_TEXT}</p>
        <div className={edited ? 'quote muted' : 'quote'} data-review-body data-stale={edited ? 'true' : 'false'}>{preview.reviewBody}</div>
        {edited && <p className="muted">{REVIEW_TEXT_OLD}</p>}
        {reviewNames.length > 0 && <p className="notice">{mentionNotice(reviewNames)}</p>}
      </section>
      <p>{POST_ONE_REVIEW}</p>
      {saidLine}
      {offlineLine}
      {draft.waiting && pending?.kind === 'post' && <p role="status">{WAITING_FOR_RECORD}</p>}
      <div className="actions">
        {needsUpdate
          ? <button type="button" className="btn primary" ref={mainButton} disabled={mainDisabled} {...describedByBlock} onClick={update}>Update preview</button>
          : (
            <button type="button" className="btn primary" ref={mainButton} disabled={mainDisabled} {...describedByBlock} onClick={post}>
              {`Post ${comments(preview.items.length)} to GitHub`}
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
