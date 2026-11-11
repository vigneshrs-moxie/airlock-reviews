import {
  prRefFromUrl,
  type Brief, type ChangeMap, type Depth, type DismissBody, type Dismissal, type LatestReply, type PrSummary,
  type ReviewDocument, type ServiceEvent,
} from '@airlock/shared';
import { ServiceError, type ServiceClient } from '../client/service';
import type { SettingsStore } from './settings';
import type { TabWatcher } from './tab';

/** Each stage the engine reports, in the prototype's words. A stage not listed here is shown by its own name. */
export const STAGE_WORDS = {
  intake: 'Reading the pull request',
  packs: 'Choosing the packs for this pull request',
  shape: 'Checking for a sync merge, a stack or a re-review',
  facts: 'Sorting the files and running the code checks',
  map: 'Mapping the change',
  brief: 'Working out what the pull request does',
  lenses: 'Looking through each lens',
  sweep: 'Checking each file against the pack rules',
  seams: 'Checking where the groups meet',
  anchor: 'Finding the lines for each finding',
  challenge: 'Challenging every finding',
  'lenses-deep': 'Taking a second, deeper look',
  select: 'Ranking and picking the top five',
  store: 'Saving the review',
} as const satisfies Record<string, string>;

export function stageWords(stage: string): string {
  return Object.hasOwn(STAGE_WORDS, stage) ? STAGE_WORDS[stage as keyof typeof STAGE_WORDS] : stage;
}

export const LOST_MESSAGE = 'Airlock lost its connection to the review. Press Retry to look again.';
export const NOT_A_TOKEN = 'That is not a pairing token. Run "airlock-service token" and paste the 64 characters it prints.';
export const OFFLINE_RETRY_MS = 5_000;
export const REATTACH_MS = 1_000;
export const REATTACH_LIMIT = 5;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

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

export type PanelState =
  | { kind: 'loading' }
  | { kind: 'no-pr' }
  /** `review` is the review that was on screen when the service stopped answering, kept readable. */
  | { kind: 'offline'; review?: ReviewView }
  /** `message` is the service's answer to a pairing attempt, or why the typed token was not sent. */
  | { kind: 'unpaired'; message?: string }
  | { kind: 'ready'; pr: PrSummary; earlier: LatestReply | null }
  | { kind: 'running'; pr: PrSummary; stages: StageLine[]; brief: Brief | null; map: ChangeMap | null }
  /** `notice` is the service's note on the last restore (the learned line was no longer there). */
  | ({ kind: 'review'; notice?: string } & ReviewView)
  /** `brief` and `map` are what a failed review showed before it stopped. */
  | { kind: 'problem'; pr: PrSummary | null; message: string; brief?: Brief; map?: ChangeMap };

export type UserAction =
  | { type: 'pair'; token: string }
  | { type: 'start'; depth: Depth; packIds?: string[] }
  | { type: 'show-earlier' }
  | { type: 'dismiss'; body: DismissBody }
  | { type: 'restore'; fingerprint: string }
  | { type: 'retry' };

/** What `reduce` applies: the one user action that needs no service, and the results of everything else. */
export type Action =
  | { type: 'show-earlier' }
  | { type: 'loading' }
  | { type: 'no-pr' }
  | { type: 'offline' }
  | { type: 'unpaired'; message?: string }
  | { type: 'loaded'; pr: PrSummary; latest: LatestReply | null }
  | { type: 'attached'; pr: PrSummary }
  /** `first`: the first event of an attach. The service replays from the start, so the stage list starts again. */
  | { type: 'event'; event: ServiceEvent; first: boolean }
  | { type: 'finished'; latest: LatestReply }
  | { type: 'problem'; message: string; pr?: PrSummary }
  | { type: 'dismissed'; dismissal: Dismissal }
  | { type: 'restored'; fingerprint: string; note: string | null };

function viewOf(pr: PrSummary, latest: LatestReply): ReviewView {
  return { pr, latest, stale: latest.document.pr.headSha !== pr.headSha };
}

function prOf(state: PanelState): PrSummary | null {
  switch (state.kind) {
    case 'ready': case 'running': case 'review': case 'problem':
      return state.pr;
    default:
      return null;
  }
}

function withStage(lines: StageLine[], event: Extract<ServiceEvent, { type: 'stage' }>): StageLine[] {
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

/** The panel's state after an action. Pure; an action that does not apply returns the same state object. */
export function reduce(state: PanelState, action: Action): PanelState {
  switch (action.type) {
    case 'show-earlier':
      return state.kind === 'ready' && state.earlier !== null ? { kind: 'review', ...viewOf(state.pr, state.earlier) } : state;
    case 'loading':
      return state.kind === 'loading' ? state : { kind: 'loading' };
    case 'no-pr':
      return state.kind === 'no-pr' ? state : { kind: 'no-pr' };
    case 'offline': {
      if (state.kind === 'offline') return state;
      if (state.kind === 'review') return { kind: 'offline', review: { pr: state.pr, latest: state.latest, stale: state.stale } };
      return { kind: 'offline' };
    }
    case 'unpaired':
      return action.message === undefined ? { kind: 'unpaired' } : { kind: 'unpaired', message: action.message };
    case 'loaded':
      return action.latest === null
        ? { kind: 'ready', pr: action.pr, earlier: null }
        : { kind: 'review', ...viewOf(action.pr, action.latest) };
    case 'attached':
      return { kind: 'running', pr: action.pr, stages: [], brief: null, map: null };
    case 'event': {
      if (state.kind !== 'running') return state;
      const base = action.first ? { ...state, stages: [] } : state;
      const event = action.event;
      switch (event.type) {
        case 'stage': return { ...base, stages: withStage(base.stages, event) };
        case 'brief': return { ...base, brief: event.brief };
        case 'map': return { ...base, map: event.map };
        case 'done': return base;
        case 'failed': return problemFrom(base, event.message);
      }
      return state;
    }
    case 'finished':
      return state.kind === 'running' ? { kind: 'review', ...viewOf(state.pr, action.latest) } : state;
    case 'problem':
      return problemFrom(state, action.message, action.pr);
    case 'dismissed': {
      if (state.kind !== 'review') return state;
      const { dismissals } = state.latest;
      const at = dismissals.findIndex((d) => d.fingerprint === action.dismissal.fingerprint);
      const next = at === -1 ? [...dismissals, action.dismissal] : dismissals.map((d, i) => (i === at ? action.dismissal : d));
      return { kind: 'review', ...viewOf(state.pr, { ...state.latest, dismissals: next }) };
    }
    case 'restored': {
      if (state.kind !== 'review') return state;
      const dismissals = state.latest.dismissals.filter((d) => d.fingerprint !== action.fingerprint);
      const view = viewOf(state.pr, { ...state.latest, dismissals });
      return action.note === null ? { kind: 'review', ...view } : { kind: 'review', ...view, notice: action.note };
    }
  }
}

function problemFrom(state: PanelState, message: string, pr?: PrSummary): PanelState {
  const problem: Extract<PanelState, { kind: 'problem' }> = { kind: 'problem', pr: pr ?? prOf(state), message };
  if (state.kind === 'running') {
    if (state.brief !== null) problem.brief = state.brief;
    if (state.map !== null) problem.map = state.map;
  }
  return problem;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
};

export interface PanelDeps {
  client: ServiceClient;
  tab: TabWatcher;
  settings: SettingsStore;
  onState: (state: PanelState) => void;
  timers?: Timers;
}

type PrRef = { repo: string; number: number };

function refOf(url: string | undefined): PrRef | null {
  const ref = url === undefined ? null : prRefFromUrl(url);
  return ref === null ? null : { repo: ref.repo, number: ref.number };
}

/**
 * Runs the panel beside one tab: loads the pull request the tab shows, follows a running review, and turns user
 * actions into calls to the service. Only one load or stream is live at a time; every awaited step checks that the
 * tab has not moved on since (`generation`), and late replies for an earlier pull request are dropped.
 */
export function startPanel(deps: PanelDeps): { dispatch(action: UserAction): void; stop(): void } {
  const { client, tab, settings } = deps;
  const timers = deps.timers ?? realTimers;
  let state: PanelState = { kind: 'loading' };
  let generation = 0;
  let stopped = false;
  let ref: PrRef | null | undefined;
  let stream = new AbortController();
  let busy: number | null = null;
  let offlineRetry: { handle: unknown } | null = null;
  const sleeping = new Set<unknown>();

  const emit = (next: PanelState): void => {
    if (stopped || next === state) return;
    state = next;
    deps.onState(next);
  };
  const apply = (action: Action): void => emit(reduce(state, action));
  const current = (g: number): boolean => g === generation && !stopped;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const handle = timers.setTimeout(() => {
        sleeping.delete(handle);
        resolve();
      }, ms);
      sleeping.add(handle);
    });

  const clearTimers = (): void => {
    if (offlineRetry !== null) timers.clearTimeout(offlineRetry.handle);
    offlineRetry = null;
    for (const handle of sleeping) timers.clearTimeout(handle);
    sleeping.clear();
  };

  const scheduleOfflineRetry = (g: number): void => {
    if (offlineRetry !== null || !current(g)) return;
    const retry = {
      handle: timers.setTimeout(() => {
        if (offlineRetry === retry) offlineRetry = null;
        if (current(g) && state.kind === 'offline') void load(g, true);
      }, OFFLINE_RETRY_MS),
    };
    offlineRetry = retry;
  };

  /** The one place a failed call becomes a state. */
  const fail = (g: number, error: unknown, pr?: PrSummary | null): void => {
    if (!current(g)) return;
    const known = pr ?? undefined;
    if (error instanceof ServiceError) {
      if (error.kind === 'offline') {
        apply({ type: 'offline' });
        scheduleOfflineRetry(g);
      } else if (error.kind === 'unpaired') {
        apply({ type: 'unpaired' });
      } else {
        apply({ type: 'problem', message: error.message, ...(known ? { pr: known } : {}) });
      }
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    apply({ type: 'problem', message: `Airlock had a problem: ${message}`, ...(known ? { pr: known } : {}) });
  };

  /** hello, then the pull request, then its running review or its latest stored one. `quiet` keeps the screen as it is until there is an answer. */
  const load = async (g: number, quiet: boolean): Promise<void> => {
    const target = ref;
    if (target === undefined) return;
    if (target === null) {
      apply({ type: 'no-pr' });
      return;
    }
    if (!quiet) apply({ type: 'loading' });
    let pr: PrSummary | undefined;
    try {
      const hello = await client.hello();
      if (!current(g)) return;
      if (hello === 'offline') {
        fail(g, new ServiceError('offline', 'The Airlock service is not answering.'));
        return;
      }
      const token = hello.paired ? await settings.getToken() : null;
      if (!current(g)) return;
      if (token === null) {
        apply({ type: 'unpaired' });
        return;
      }
      pr = await client.pr(target.repo, target.number);
      if (!current(g)) return;
      const runId = await client.running(target.repo, target.number);
      if (!current(g)) return;
      if (runId !== null) {
        await follow(g, pr, runId);
        return;
      }
      const latest = await client.latest(target.repo, target.number);
      if (!current(g)) return;
      apply({ type: 'loaded', pr, latest });
    } catch (error) {
      fail(g, error, pr);
    }
  };

  /** Follows a run's events to its end, re-attaching a lost stream; each attach replays from the first event. */
  const follow = async (g: number, pr: PrSummary, runId: string): Promise<void> => {
    const signal = stream.signal;
    apply({ type: 'attached', pr });
    let best = 0;
    let attempts = 0;
    for (;;) {
      const seen: { count: number; done: ReviewDocument | null } = { count: 0, done: null };
      let result: 'ended' | 'lost';
      try {
        result = await client.events(runId, (event) => {
          if (!current(g)) return;
          seen.count += 1;
          if (event.type === 'done') seen.done = event.document;
          apply({ type: 'event', event, first: seen.count === 1 });
        }, signal);
      } catch (error) {
        fail(g, error, pr);
        return;
      }
      if (!current(g)) return;
      if (seen.done !== null) {
        await finish(g, pr, seen.done);
        return;
      }
      if (result === 'ended') return;
      // Five tries in a row that bring nothing new; a try that brings new events starts the count again.
      if (seen.count > best) {
        best = seen.count;
        attempts = 0;
      }
      attempts += 1;
      if (attempts > REATTACH_LIMIT) {
        apply({ type: 'problem', message: LOST_MESSAGE });
        return;
      }
      await sleep(REATTACH_MS);
      if (!current(g)) return;
    }
  };

  /** Reads the stored review so its dismissals come with it; the event's own document when that fails. */
  const finish = async (g: number, pr: PrSummary, document: ReviewDocument): Promise<void> => {
    let latest: LatestReply | null = null;
    try {
      latest = await client.latest(pr.repo, pr.number);
    } catch {
      latest = null;
    }
    if (!current(g)) return;
    const same = latest !== null && latest.document.id === document.id;
    apply({ type: 'finished', latest: same && latest !== null ? latest : { document, dismissals: [] } });
  };

  /** A fresh load for the tab's current address; whatever was live before is dropped. */
  const begin = (quiet: boolean): void => {
    if (stopped) return;
    generation += 1;
    stream.abort();
    stream = new AbortController();
    clearTimers();
    void load(generation, quiet);
  };

  /** Runs one user action at a time; its failure goes through `fail`. */
  const act = (pr: PrSummary | null, work: (g: number) => Promise<void>): void => {
    if (busy === generation) return;
    const g = generation;
    busy = g;
    void work(g)
      .catch((error: unknown) => fail(g, error, pr))
      .finally(() => {
        if (busy === g) busy = null;
      });
  };

  const pair = async (g: number, typed: string): Promise<void> => {
    const token = typed.trim();
    if (!TOKEN_PATTERN.test(token)) {
      apply({ type: 'unpaired', message: NOT_A_TOKEN });
      return;
    }
    const reply = await client.pair(token);
    if ('error' in reply) {
      if (current(g)) apply({ type: 'unpaired', message: reply.error });
      return;
    }
    await settings.setToken(token);
    begin(false);
  };

  const start = async (g: number, pr: PrSummary, depth: Depth, packIds: string[] | undefined): Promise<void> => {
    const reply = await client.start({ repo: pr.repo, number: pr.number, depth, ...(packIds === undefined ? {} : { packIds }) });
    if (!current(g)) return;
    void follow(g, pr, reply.runId).catch((error: unknown) => fail(g, error, pr));
  };

  const dispatch = (action: UserAction): void => {
    if (stopped) return;
    const pr = prOf(state);
    switch (action.type) {
      case 'show-earlier':
        apply(action);
        return;
      case 'retry':
        if (state.kind === 'problem' || state.kind === 'offline') begin(state.kind === 'offline');
        return;
      case 'pair':
        if (state.kind === 'unpaired') act(null, (g) => pair(g, action.token));
        return;
      case 'start':
        if (pr !== null && (state.kind === 'ready' || state.kind === 'review' || state.kind === 'problem')) {
          act(pr, (g) => start(g, pr, action.depth, action.packIds));
        }
        return;
      case 'dismiss':
        if (state.kind === 'review' && action.body.repo === state.pr.repo && action.body.number === state.pr.number) {
          act(state.pr, async (g) => {
            const dismissal = await client.dismiss(action.body);
            if (current(g)) apply({ type: 'dismissed', dismissal });
          });
        }
        return;
      case 'restore':
        if (state.kind === 'review') {
          const { repo, number } = state.pr;
          act(state.pr, async (g) => {
            const reply = await client.restore({ repo, number, fingerprint: action.fingerprint });
            if (current(g)) apply({ type: 'restored', fingerprint: action.fingerprint, note: reply.note });
          });
        }
        return;
    }
  };

  // The screens have a state from the first moment, before the tab's address is known.
  deps.onState(state);

  const unsubscribe = tab.onChange((url) => {
    const next = refOf(url);
    if (ref !== undefined && sameRef(next, ref)) return;
    ref = next;
    begin(false);
  });

  tab.current().then(
    ({ url }) => {
      if (ref !== undefined) return;
      ref = refOf(url);
      begin(false);
    },
    () => emit({ kind: 'problem', pr: null, message: 'Airlock could not read the address of this tab.' }),
  );

  return {
    dispatch,
    stop() {
      if (stopped) return;
      stopped = true;
      generation += 1;
      stream.abort();
      clearTimers();
      unsubscribe();
    },
  };
}

function sameRef(a: PrRef | null, b: PrRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.repo === b.repo && a.number === b.number;
}
