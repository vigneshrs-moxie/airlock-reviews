import type {
  Brief, ChangeMap, Depth, DismissBody, Dismissal, LatestReply, PrSummary, ServiceEvent,
} from '@airlock/shared';
import { stageWords } from './stage-words';

/** Text from the service that is shown (an error, a failed review's message, a restore note) is cut to this many characters. */
export const NOTICE_MAX = 300;

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

/** What a running review had shown when the service stopped answering. */
export interface Progress {
  pr: PrSummary;
  brief: Brief | null;
  map: ChangeMap | null;
}

export type PanelState =
  | { kind: 'loading' }
  | { kind: 'no-pr' }
  /** `review` or `progress`: what was on screen when the service stopped answering, kept readable. */
  | { kind: 'offline'; review?: ReviewView; progress?: Progress }
  /** `message`: the service's answer to a pairing attempt, or why the typed token was not sent. */
  | { kind: 'unpaired'; message?: string }
  /** `notice`: why the last action was refused. `busy`: an action is in flight. */
  | { kind: 'ready'; pr: PrSummary; notice?: string; busy?: boolean }
  | { kind: 'running'; pr: PrSummary; stages: StageLine[]; brief: Brief | null; map: ChangeMap | null }
  /** `notice`: why the last action was refused, or the note on the last restore. `busy`: an action is in flight. */
  | ({ kind: 'review'; notice?: string; busy?: boolean } & ReviewView)
  /** `brief` and `map`: what a failed review showed before it stopped. */
  | { kind: 'problem'; pr: PrSummary | null; message: string; brief?: Brief; map?: ChangeMap };

export type UserAction =
  | { type: 'pair'; token: string }
  | { type: 'start'; depth: Depth; packIds?: string[] }
  | { type: 'dismiss'; body: DismissBody }
  | { type: 'restore'; fingerprint: string }
  | { type: 'retry' };

/** The results of calls to the service, and the events of a review, that change the state. */
export type Action =
  | { type: 'loading' }
  | { type: 'no-pr' }
  | { type: 'offline' }
  | { type: 'unpaired'; message?: string }
  | { type: 'loaded'; pr: PrSummary; latest: LatestReply | null }
  | { type: 'attached'; pr: PrSummary }
  /** The stage list to show, built by the runtime from the stream's stage events. */
  | { type: 'stages'; stages: StageLine[] }
  | { type: 'event'; event: Exclude<ServiceEvent, { type: 'stage' }> }
  | { type: 'finished'; latest: LatestReply }
  | { type: 'problem'; message: string; pr?: PrSummary }
  | { type: 'busy'; busy: boolean }
  | { type: 'refused'; message: string }
  | { type: 'dismissed'; dismissal: Dismissal }
  | { type: 'restored'; fingerprint: string; note: string | null };

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

function reviewOf(pr: PrSummary, latest: LatestReply): PanelState {
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
      if (state.kind === 'running') return { kind: 'offline', progress: { pr: state.pr, brief: state.brief, map: state.map } };
      return { kind: 'offline' };
    case 'unpaired':
      return action.message === undefined ? { kind: 'unpaired' } : { kind: 'unpaired', message: clip(action.message) };
    case 'loaded':
      return action.latest === null ? { kind: 'ready', pr: action.pr } : reviewOf(action.pr, action.latest);
    case 'attached':
      return { kind: 'running', pr: action.pr, stages: [], brief: null, map: null };
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
  }
}
