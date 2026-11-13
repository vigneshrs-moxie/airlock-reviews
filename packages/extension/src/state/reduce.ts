import {
  MESSAGE_MAX, type Brief, type ChangeMap, type Depth, type DismissBody, type Dismissal, type LatestReply, type PostPreviewBody,
  type PostPreviewReply, type PostRecord, type PrSummary, type ServiceEvent,
} from '@airlock/shared';
import { stageWords } from './stage-words';

/** Text from the service that is shown (an error, a failed review's message, a restore note) is cut to this many characters. */
export const NOTICE_MAX = MESSAGE_MAX;

/** A post whose reply did not say what happened, and whose record says it is not known. The service's 504 sentence. */
export const POST_UNKNOWN = 'Airlock could not tell whether GitHub accepted the comments. Look at the pull request before posting again.';
/** A post whose reply did not say what happened, and whose record did not appear while the panel waited for it. */
export const POST_NOT_LEARNED = 'Airlock could not learn what happened to this post. Look at the pull request before posting again.';

export interface StageLine {
  stage: string;
  words: string;
  status: 'working' | 'done' | 'failed' | 'skipped';
  detail: string;
}

export interface ReviewView {
  pr: PrSummary;
  latest: LatestReply;
  /** The pull request's head moved since this review. */
  stale: boolean;
}

/**
 * The answer to the post sheet's last request, with the ticket the sheet sent it under, so a sheet only takes its own.
 * - `preview`: the preview the service stored.
 * - `refused`: nothing was done, in the service's words (a preview, a post or a forget).
 * - `posted` and `unknown`: the record a post made; `unknown` with the sentence to show.
 * - `waiting`: a post whose answer did not say what happened; the panel is reading the records until one appears. The
 *   post is still in flight. `checking` after a 404: the panel is checking whether a copy of this post the browser sent
 *   earlier already went through, for a short while only.
 * - `unsent`: a post that never left the panel, because the proof that comes first failed; it can be tried again.
 * - `unclear`: a post whose record did not appear while the panel waited.
 * - `forgotten`: the unknown record is gone.
 * - `found`: asked to forget an unknown record, the service found the review on GitHub: the record, now posted, with
 *   the service's sentence. Nothing was forgotten.
 */
export type PostReply = { ticket: number } & (
  | { kind: 'preview'; preview: PostPreviewReply }
  | { kind: 'refused'; message: string }
  | { kind: 'posted'; record: PostRecord }
  | { kind: 'unknown'; message: string; record: PostRecord }
  | { kind: 'waiting'; checking?: true }
  | { kind: 'unsent'; message: string }
  | { kind: 'unclear'; message: string }
  | { kind: 'forgotten'; id: string }
  | { kind: 'found'; message: string; record: PostRecord }
);

/** Whether a post record is of this pull request (a repository name in any letter case, as on GitHub). */
export function isFor(record: Pick<PostRecord, 'repo' | 'number'>, pr: Pick<PrSummary, 'repo' | 'number'>): boolean {
  return record.repo.toLowerCase() === pr.repo.toLowerCase() && record.number === pr.number;
}

/** What a running review had shown when the service stopped answering. */
export interface Progress {
  pr: PrSummary;
  brief: Brief | null;
  map: ChangeMap | null;
  /** When the panel started the run, or attached to it (milliseconds since 1970); null when not known. */
  startedAt: number | null;
}

export type PanelState =
  | { kind: 'loading' }
  | { kind: 'no-pr' }
  /** `review`, `ready` or `progress`: what was on screen when the service stopped answering, kept readable. */
  | { kind: 'offline'; review?: ReviewView; ready?: PrSummary; progress?: Progress }
  /** `message`: the service's answer to a pairing attempt, or why the typed token was not sent. */
  | { kind: 'unpaired'; message?: string }
  /** `notice`: why the last action was refused. `busy`: an action is in flight. */
  | { kind: 'ready'; pr: PrSummary; notice?: string; busy?: boolean }
  /**
   * `depth`: the depth this panel asked for when it started the run; left out when it did not start it (an attach).
   * `startedAt`: when this panel asked for the run, or first attached to it (the panel's clock, milliseconds since 1970).
   */
  | { kind: 'running'; pr: PrSummary; stages: StageLine[]; brief: Brief | null; map: ChangeMap | null; depth?: Depth; startedAt?: number }
  /**
   * `notice`: why the last action was refused, or the note on the last restore. `busy`: an action is in flight. `post`: the
   * answer to the post sheet's last request.
   */
  | ({ kind: 'review'; notice?: string; busy?: boolean; post?: PostReply } & ReviewView)
  /** `brief` and `map`: what a failed review showed before it stopped. */
  | { kind: 'problem'; pr: PrSummary | null; message: string; brief?: Brief; map?: ChangeMap };

export type UserAction =
  | { type: 'pair'; token: string }
  /** `since: 'last'`: review only what was pushed since the last review. */
  | { type: 'start'; depth: Depth; packIds?: string[]; since?: 'last' }
  | { type: 'dismiss'; body: DismissBody }
  | { type: 'restore'; fingerprint: string }
  /** The post sheet's requests; each answer comes back as the review's `post`, under the same ticket. */
  | { type: 'preview-post'; ticket: number; body: PostPreviewBody }
  /** `fingerprints`: the preview's findings, to find its record by when the reply does not say what happened. */
  | { type: 'post'; ticket: number; previewId: string; fingerprints: string[] }
  | { type: 'forget-post'; ticket: number; id: string }
  | { type: 'retry' };

/** The results of calls to the service, and the events of a review, that change the state. */
export type Action =
  | { type: 'loading' }
  | { type: 'no-pr' }
  /** `startedAt`: when the run that was showing was started or attached, kept in `progress`. */
  | { type: 'offline'; startedAt?: number }
  | { type: 'unpaired'; message?: string }
  /**
   * `notice`: said on the screen it lands on (a running review was lost with the service). `post`: an answer for the post
   * sheet that could not be given while the review was away (a post never sent before the Pair screen).
   */
  | { type: 'loaded'; pr: PrSummary; latest: LatestReply | null; notice?: string; post?: PostReply }
  /** `depth`: the depth asked for, when this panel started the run it attached to. `startedAt`: when it was asked for or attached. */
  | { type: 'attached'; pr: PrSummary; depth?: Depth; startedAt?: number }
  /** The pull request read again while its review is on screen: the review's `stale` is worked out again from it. */
  | { type: 'head'; pr: PrSummary }
  /** The stage list to show, built by the runtime from the stream's stage events. */
  | { type: 'stages'; stages: StageLine[] }
  | { type: 'event'; event: Exclude<ServiceEvent, { type: 'stage' }> }
  | { type: 'finished'; latest: LatestReply }
  | { type: 'problem'; message: string; pr?: PrSummary }
  | { type: 'busy'; busy: boolean }
  | { type: 'refused'; message: string }
  | { type: 'dismissed'; dismissal: Dismissal }
  | { type: 'restored'; fingerprint: string; note: string | null }
  | { type: 'post-reply'; reply: PostReply }
  /** The post records just read for the pull request on screen; they replace the ones shown. */
  | { type: 'posts'; posts: PostRecord[] };

/** At most `NOTICE_MAX` characters, ending in `…` when cut. Counts code points, so a character is never split. */
export function clip(text: string): string {
  const chars = [...text];
  return chars.length <= NOTICE_MAX ? text : `${chars.slice(0, NOTICE_MAX - 1).join('')}…`;
}

/** The stage list after one stage event: one line per stage, in order of first appearance, with its latest status. */
export function withStage(lines: StageLine[], event: Extract<ServiceEvent, { type: 'stage' }>): StageLine[] {
  const skipped = event.status === 'done' && event.detail.startsWith('skipped:');
  const line: StageLine = {
    stage: event.stage,
    words: stageWords(event.stage),
    status: event.status === 'start' ? 'working' : event.status === 'error' ? 'failed' : skipped ? 'skipped' : 'done',
    detail: skipped ? event.detail.slice('skipped:'.length).trim() : event.detail,
  };
  const at = lines.findIndex((l) => l.stage === event.stage);
  return at === -1 ? [...lines, line] : lines.map((l, i) => (i === at ? line : l));
}

/**
 * Whether `Review the push` is offered: the service reviews a push from its last stored review (`/pr`'s `lastReview`), and
 * refuses when there is none or when that review is already of the pull request's head.
 */
export const pushReviewable = ({ lastReview, headSha }: Pick<PrSummary, 'lastReview' | 'headSha'>): boolean =>
  lastReview !== null && lastReview.headSha.toLowerCase() !== headSha.toLowerCase();

function reviewOf(pr: PrSummary, latest: LatestReply): Extract<PanelState, { kind: 'review' }> {
  return { kind: 'review', pr, latest, stale: latest.document.pr.headSha !== pr.headSha };
}

function prOf(state: PanelState): PrSummary | null {
  switch (state.kind) {
    case 'ready': case 'running': case 'review': case 'problem':
      return state.pr;
    default:
      return null;
  }
}

function problemFrom(state: PanelState, message: string, pr?: PrSummary): PanelState {
  const problem: Extract<PanelState, { kind: 'problem' }> = { kind: 'problem', pr: pr ?? prOf(state), message: clip(message) };
  if (state.kind === 'running') {
    if (state.brief !== null) problem.brief = state.brief;
    if (state.map !== null) problem.map = state.map;
  }
  return problem;
}

/** Ready or review without `busy` and `notice`. */
function settled<S extends Extract<PanelState, { kind: 'ready' | 'review' }>>(state: S): S {
  const { busy: _busy, notice: _notice, ...rest } = state;
  return rest as S;
}

/** The panel's state after an action. Pure; an action that does not apply returns the same state object. */
export function reduce(state: PanelState, action: Action): PanelState {
  switch (action.type) {
    case 'loading':
      return state.kind === 'loading' ? state : { kind: 'loading' };
    case 'no-pr':
      return state.kind === 'no-pr' ? state : { kind: 'no-pr' };
    case 'offline':
      if (state.kind === 'offline') return state;
      if (state.kind === 'review') return { kind: 'offline', review: { pr: state.pr, latest: state.latest, stale: state.stale } };
      if (state.kind === 'ready') return { kind: 'offline', ready: state.pr };
      if (state.kind === 'running') {
        return { kind: 'offline', progress: { pr: state.pr, brief: state.brief, map: state.map, startedAt: action.startedAt ?? null } };
      }
      return { kind: 'offline' };
    case 'unpaired':
      return action.message === undefined ? { kind: 'unpaired' } : { kind: 'unpaired', message: clip(action.message) };
    case 'loaded': {
      const landed = action.latest === null ? { kind: 'ready' as const, pr: action.pr }
        : { ...reviewOf(action.pr, action.latest), ...(action.post === undefined ? {} : { post: action.post }) };
      return action.notice === undefined ? landed : { ...landed, notice: clip(action.notice) };
    }
    case 'attached':
      return {
        kind: 'running', pr: action.pr, stages: [], brief: null, map: null,
        ...(action.depth === undefined ? {} : { depth: action.depth }), ...(action.startedAt === undefined ? {} : { startedAt: action.startedAt }),
      };
    case 'head': {
      if (state.kind !== 'review' || !isFor(action.pr, state.pr)) return state;
      const { stale } = reviewOf(action.pr, state.latest);
      if (stale === state.stale && JSON.stringify(action.pr) === JSON.stringify(state.pr)) return state;
      // Everything else stays: a notice, an action in flight, the post sheet's answer.
      return { ...state, pr: action.pr, stale };
    }
    case 'stages':
      return state.kind === 'running' ? { ...state, stages: action.stages } : state;
    case 'event': {
      if (state.kind !== 'running') return state;
      const event = action.event;
      switch (event.type) {
        case 'brief': return { ...state, brief: event.brief };
        case 'map': return { ...state, map: event.map };
        case 'done': return state;
        case 'failed': return problemFrom(state, event.message);
      }
      return state;
    }
    case 'finished':
      return state.kind === 'running' ? reviewOf(state.pr, action.latest) : state;
    case 'problem':
      return problemFrom(state, action.message, action.pr);
    case 'busy': {
      if (state.kind !== 'ready' && state.kind !== 'review') return state;
      if (action.busy) return state.busy === true ? state : { ...state, busy: true };
      if (state.busy === undefined) return state;
      const { busy: _busy, ...rest } = state;
      return rest;
    }
    case 'refused':
      if (state.kind !== 'ready' && state.kind !== 'review') return state;
      return { ...settled(state), notice: clip(action.message) };
    case 'dismissed': {
      if (state.kind !== 'review') return state;
      const { dismissals } = state.latest;
      const at = dismissals.findIndex((d) => d.fingerprint === action.dismissal.fingerprint);
      const next = at === -1 ? [...dismissals, action.dismissal] : dismissals.map((d, i) => (i === at ? action.dismissal : d));
      return { ...settled(state), latest: { ...state.latest, dismissals: next } };
    }
    case 'restored': {
      if (state.kind !== 'review') return state;
      const dismissals = state.latest.dismissals.filter((d) => d.fingerprint !== action.fingerprint);
      const next = { ...settled(state), latest: { ...state.latest, dismissals } };
      return action.note === null ? next : { ...next, notice: clip(action.note) };
    }
    case 'posts':
      return state.kind === 'review' ? { ...state, latest: { ...state.latest, posts: action.posts } } : state;
    case 'post-reply': {
      if (state.kind !== 'review') return state;
      const reply = action.reply;
      // The post is still in flight: it stays busy.
      if (reply.kind === 'waiting') return { ...state, post: reply };
      let posts = state.latest.posts;
      if (reply.kind === 'posted' || reply.kind === 'unknown' || reply.kind === 'found') {
        const { record } = reply;
        if (isFor(record, state.pr)) posts = [...posts.filter((p) => p.id !== record.id), record];
      }
      if (reply.kind === 'forgotten') posts = posts.filter((p) => p.id !== reply.id);
      const said = 'message' in reply ? { ...reply, message: clip(reply.message) } : reply;
      return { ...settled(state), latest: { ...state.latest, posts }, post: said };
    }
  }
}
