import { prRefFromUrl, type Depth, type Finding, type LatestReply, type PostRecord, type PrSummary, type ReviewDocument } from '@airlock/shared';
import { ServiceError, type ServiceClient } from '../client/service';
import { realTimers, type Timers } from '../client/timers';
import {
  isFor, POST_NOT_LEARNED, POST_UNKNOWN, reduce, withStage, type Action, type PanelState, type PostReply, type StageLine, type UserAction,
} from './reduce';
import { recordHolds } from './selection';
import type { SettingsStore } from './settings';
import type { TabWatcher } from './tab';

export type { PanelState, PostReply, StageLine, UserAction } from './reduce';
export { POST_NOT_LEARNED, POST_UNKNOWN } from './reduce';

export const LOST_MESSAGE = 'Airlock lost its connection to the review. Press Retry to look again.';
export const NOT_A_TOKEN = 'That is not a pairing token. Run "npm run service -- token" and paste the 64 characters it prints.';
export const TAB_UNREADABLE = 'Airlock could not read the address of this tab. Press Retry to read it again.';
export const RUN_STOPPED = 'The review that was running stopped when the Airlock service stopped. Start it again when you are ready.';
export const SHOWING_PROBLEM = 'Airlock had a problem showing this review.';
export const OFFLINE_RETRY_MS = 5_000;
/** After a post whose answer did not say what happened, the records are read again this often, this many times (90 s). */
export const POST_RECHECK_MS = 5_000;
export const POST_RECHECKS = 18;
/** While Ready or a review is on screen, how often the panel checks that the service still answers. */
export const WATCH_MS = OFFLINE_RETRY_MS;
/** Unanswered checks in a row before the panel says the service is not running: one missed beat changes nothing. */
export const MISSED_CHECKS = 2;
export const REATTACH_MS = 1_000;
/** Re-attaches in a row that bring no new event, and re-attaches in all for one run, before giving up. */
export const REATTACH_IN_A_ROW = 5;
export const REATTACH_IN_ALL = 20;
/**
 * The pairing token out of whatever was pasted (the command prints npm's own lines first): the one run of exactly 64
 * hexadecimal characters that is not part of a longer run, in lower case as the token is printed; null when there is
 * none, or more than one.
 */
export function tokenIn(pasted: string): string | null {
  const runs = (pasted.match(/[0-9a-fA-F]+/g) ?? []).filter((run) => run.length === 64);
  return runs.length === 1 && /^[0-9a-f]{64}$/.test(runs[0] as string) ? (runs[0] as string) : null;
}

export interface PanelDeps {
  client: ServiceClient;
  tab: TabWatcher;
  settings: SettingsStore;
  onState: (state: PanelState) => void;
  timers?: Timers;
  /** The clock, in milliseconds since 1970; `Date.now` unless a test passes its own. */
  now?: () => number;
}

type PrRef = { repo: string; number: number };

function refOf(url: string | undefined): PrRef | null {
  const ref = url === undefined ? null : prRefFromUrl(url);
  return ref === null ? null : { repo: ref.repo, number: ref.number };
}

function sameRef(a: PrRef | null, b: PrRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.repo === b.repo && a.number === b.number;
}

/**
 * Whether the stored review is the result of a run started or attached at `startedAt`: created at or after it.
 * Unknown start time: not known to be the result.
 */
function finishedSince(latest: LatestReply | null, startedAt: number | null): boolean {
  if (latest === null || startedAt === null) return false;
  const created = Date.parse(latest.document.createdAt);
  return Number.isFinite(created) && created >= startedAt;
}

function prOf(state: PanelState): PrSummary | null {
  switch (state.kind) {
    case 'ready': case 'running': case 'review': case 'problem':
      return state.pr;
    default:
      return null;
  }
}

/**
 * Runs the panel beside one tab: loads the pull request the tab shows, follows a running review, and turns user
 * actions into calls to the service. Only one load or stream is live at a time. Each load has a generation and an
 * `AbortController`: moving to another pull request aborts the old one's reads and stream, and every awaited step
 * checks the generation, so a late reply for an earlier pull request is dropped.
 */
export function startPanel(deps: PanelDeps): { dispatch(action: UserAction): void; stop(): void } {
  const { client, tab, settings } = deps;
  const timers = deps.timers ?? realTimers;
  const now = deps.now ?? Date.now;
  let state: PanelState = { kind: 'loading' };
  let generation = 0;
  let stopped = false;
  /** The pull request the tab shows; null when none; undefined until the tab has been read. */
  let ref: PrRef | null | undefined;
  let live = new AbortController();
  let busy: number | null = null;
  let offlineRetry: { handle: unknown } | null = null;
  /** The latest check of the service: a check that is not the latest stops, so there is one at a time. */
  let watching = 0;
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

  /** `startedAt`: when the running review on screen was started or attached, kept with what it showed. */
  const wentOffline = (g: number, startedAt?: number): void => {
    if (!current(g)) return;
    apply(startedAt === undefined ? { type: 'offline' } : { type: 'offline', startedAt });
    if (offlineRetry !== null) return;
    const retry = {
      handle: timers.setTimeout(() => {
        if (offlineRetry === retry) offlineRetry = null;
        if (current(g) && state.kind === 'offline') void load(g, true);
      }, OFFLINE_RETRY_MS),
    };
    offlineRetry = retry;
  };

  /**
   * While Ready or a review is on screen nothing else asks the service anything, so this checks every few seconds that
   * it still answers. MISSED_CHECKS unanswered checks in a row go offline (keeping the screen), and the offline retry
   * brings it back; an answered check starts the count again, and an answer that says the service is not paired goes to
   * the Pair screen. An answer that cannot prove it holds the stored token goes to the Pair screen with that sentence,
   * and the token is not sent again until a proof matches. It skips a check while an action is in flight, and stops when
   * the screen is neither, or a newer check or load replaces it.
   */
  const watch = (g: number, missed = 0): void => {
    const mine = ++watching;
    const settled = (): boolean => current(g) && mine === watching && (state.kind === 'ready' || state.kind === 'review');
    void sleep(WATCH_MS).then(async () => {
      if (!settled()) return;
      let unanswered = missed;
      if (busy !== g) {
        let hello: Awaited<ReturnType<ServiceClient['hello']>> | null;
        try {
          hello = await client.hello(live.signal);
        } catch (error) {
          if (error instanceof ServiceError && error.kind === 'unproven') {
            if (settled()) fail(g, error);
            return;
          }
          // An answer that is not a hello is still an answer; the next action says what is wrong.
          hello = null;
        }
        if (!settled()) return;
        if (hello === 'offline') {
          unanswered += 1;
          if (unanswered >= MISSED_CHECKS) {
            wentOffline(g);
            return;
          }
        } else {
          unanswered = 0;
          if (hello !== null && !hello.paired) {
            apply({ type: 'unpaired' });
            return;
          }
        }
      }
      watch(g, unanswered);
    });
  };

  /**
   * The one place a failed call becomes a state. What answers could not prove it holds the token: the Pair screen with
   * that sentence, as the same happens when the token was replaced with `token --new` and only a new one will do.
   */
  const fail = (g: number, error: unknown, pr?: PrSummary | null): void => {
    if (!current(g)) return;
    const known = pr === null || pr === undefined ? {} : { pr };
    if (error instanceof ServiceError) {
      if (error.kind === 'offline') wentOffline(g);
      else if (error.kind === 'unpaired') apply({ type: 'unpaired' });
      else if (error.kind === 'unproven') apply({ type: 'unpaired', message: error.message });
      else apply({ type: 'problem', message: error.message, ...known });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    apply({ type: 'problem', message: `Airlock had a problem: ${message}`, ...known });
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
    // A reload after the service came back, while a running review's progress is kept on screen.
    const cutOff = state.kind === 'offline' && state.progress !== undefined
      && state.progress.pr.repo === target.repo && state.progress.pr.number === target.number
      ? state.progress
      : null;
    const signal = live.signal;
    let pr: PrSummary | undefined;
    try {
      const hello = await client.hello(signal);
      if (!current(g)) return;
      if (hello === 'offline') {
        wentOffline(g);
        return;
      }
      const token = hello.paired ? await settings.getToken() : null;
      if (!current(g)) return;
      if (token === null) {
        apply({ type: 'unpaired' });
        return;
      }
      pr = await client.pr(target.repo, target.number, signal);
      if (!current(g)) return;
      const runId = await client.running(target.repo, target.number, signal);
      if (!current(g)) return;
      if (runId !== null) {
        await follow(g, pr, runId, now());
        return;
      }
      const latest = await client.latest(target.repo, target.number, signal);
      if (!current(g)) return;
      // The run that was showing is gone: unless this stored review is its result, say that it stopped.
      const lost = cutOff !== null && !finishedSince(latest, cutOff.startedAt);
      apply(lost ? { type: 'loaded', pr, latest, notice: RUN_STOPPED } : { type: 'loaded', pr, latest });
      watch(g);
    } catch (error) {
      fail(g, error, pr);
    }
  };

  /**
   * Follows a run's events to its end. Each attach replays from the first event; its stage list replaces the one
   * shown only once it is at least as long, so a re-attach never flickers. A stream that broke at the network level
   * is followed by one hello: no answer means offline (the retry then reloads); an answer means re-attach.
   */
  const follow = async (g: number, pr: PrSummary, runId: string, startedAt: number): Promise<void> => {
    const signal = live.signal;
    apply({ type: 'attached', pr });
    let best = 0;
    let inARow = 0;
    let inAll = 0;
    for (;;) {
      const seen = { count: 0, done: null as ReviewDocument | null, stages: [] as StageLine[], showing: false };
      let result: 'ended' | 'lost' | 'offline';
      try {
        result = await client.events(runId, (event) => {
          if (!current(g)) return;
          seen.count += 1;
          if (event.type === 'stage') {
            seen.stages = withStage(seen.stages, event);
            if (!seen.showing && state.kind === 'running' && seen.stages.length >= state.stages.length) seen.showing = true;
            if (seen.showing) apply({ type: 'stages', stages: seen.stages });
            return;
          }
          if (event.type === 'done') seen.done = event.document;
          apply({ type: 'event', event });
        }, signal);
      } catch (error) {
        if (error instanceof ServiceError) fail(g, error, pr);
        // The panel's own failure to show an event: say so, and do not re-attach to fail the same way again.
        else if (current(g)) apply({ type: 'problem', message: SHOWING_PROBLEM });
        return;
      }
      if (!current(g)) return;
      if (seen.done !== null) {
        await finish(g, pr, seen.done);
        return;
      }
      if (result === 'ended') return;
      if (result === 'offline') {
        let hello: Awaited<ReturnType<ServiceClient['hello']>>;
        try {
          hello = await client.hello(signal);
        } catch (error) {
          fail(g, error, pr);
          return;
        }
        if (!current(g)) return;
        if (hello === 'offline') {
          wentOffline(g, startedAt);
          return;
        }
      }
      if (seen.count > best) {
        best = seen.count;
        inARow = 0;
      }
      inARow += 1;
      inAll += 1;
      if (inARow > REATTACH_IN_A_ROW || inAll > REATTACH_IN_ALL) {
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
      latest = await client.latest(pr.repo, pr.number, live.signal);
    } catch {
      latest = null;
    }
    if (!current(g)) return;
    const same = latest !== null && latest.document.id === document.id;
    apply({ type: 'finished', latest: same && latest !== null ? latest : { document, dismissals: [], posts: [] } });
    watch(g);
  };

  /** A fresh load for the tab's current address; whatever was live before is aborted and dropped. */
  const begin = (quiet: boolean): void => {
    if (stopped) return;
    generation += 1;
    live.abort();
    live = new AbortController();
    clearTimers();
    void load(generation, quiet);
  };

  const readTab = (): void => {
    tab.current().then(
      ({ url }) => {
        if (stopped || ref !== undefined) return;
        ref = refOf(url);
        begin(false);
      },
      () => {
        if (ref === undefined) emit({ kind: 'problem', pr: null, message: TAB_UNREADABLE });
      },
    );
  };

  /**
   * Runs one user action at a time, marking ready or review busy meanwhile. A refusal in the service's words keeps
   * ready or review on screen with a notice; not paired and offline go through `fail` as everywhere else.
   */
  const act = (pr: PrSummary | null, work: (g: number) => Promise<void>): void => {
    if (busy === generation) return;
    const g = generation;
    busy = g;
    apply({ type: 'busy', busy: true });
    void work(g)
      .catch((error: unknown) => {
        if (!current(g)) return;
        const refusal = error instanceof ServiceError && error.kind === 'problem';
        if (refusal && (state.kind === 'ready' || state.kind === 'review')) apply({ type: 'refused', message: error.message });
        else fail(g, error, pr);
      })
      .finally(() => {
        if (busy !== g) return;
        busy = null;
        if (current(g)) apply({ type: 'busy', busy: false });
      });
  };

  const pair = async (g: number, typed: string): Promise<void> => {
    const token = tokenIn(typed);
    if (token === null) {
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

  const answer = (g: number, reply: PostReply): void => {
    if (current(g)) apply({ type: 'post-reply', reply });
  };
  /** A refusal in the service's words is the post sheet's to show; anything else goes on to `act`. */
  const refusedOr = (g: number, ticket: number, error: unknown): void => {
    if (!(error instanceof ServiceError && error.kind === 'problem')) throw error;
    answer(g, { ticket, kind: 'refused', message: error.message });
  };

  /**
   * Posts a stored preview, once. When the reply does not say what happened, the post records do: the panel reads them
   * now and every POST_RECHECK_MS for POST_RECHECKS more reads, while the post stays in flight, until the record this post
   * made (one not on screen before, holding one of its findings) appears. The records shown are always the ones last
   * read. A read that fails counts as a read with nothing in it; only a refused pairing stops the wait. With no record at
   * the end, the panel says it could not learn what happened, and nothing is sent again.
   */
  const post = async (
    g: number, pr: PrSummary, known: ReadonlySet<string>, findings: readonly Pick<Finding, 'fingerprint' | 'aliases'>[],
    action: Extract<UserAction, { type: 'post' }>,
  ): Promise<void> => {
    const { ticket } = action;
    const sent = await client.post({ previewId: action.previewId });
    // A record for another pull request is not this post's answer: its address is not shown here.
    if (sent.outcome === 'posted' && isFor(sent.record, pr)) { answer(g, { ticket, kind: 'posted', record: sent.record }); return; }
    if (sent.outcome === 'refused') { answer(g, { ticket, kind: 'refused', message: sent.message }); return; }
    const said = sent.outcome === 'unclear' ? sent.message ?? POST_UNKNOWN : POST_UNKNOWN;
    const mine = (r: PostRecord): boolean => isFor(r, pr) && !known.has(r.id) && findings.some((f) => recordHolds(r, f));
    for (let read = 0; ; read += 1) {
      if (read > 0) {
        await sleep(POST_RECHECK_MS);
        if (!current(g)) return;
      }
      const posts = await readPosts(pr);
      if (!current(g)) return;
      if (posts !== null) apply({ type: 'posts', posts });
      const record = posts?.find(mine);
      if (record !== undefined) {
        answer(g, record.outcome === 'posted' ? { ticket, kind: 'posted', record } : { ticket, kind: 'unknown', message: said, record });
        return;
      }
      if (read >= POST_RECHECKS) {
        answer(g, { ticket, kind: 'unclear', message: POST_NOT_LEARNED });
        return;
      }
      if (read === 0) answer(g, { ticket, kind: 'waiting' });
    }
  };

  /**
   * The post records of the pull request; null when they could not be read, or when there is no stored review to read
   * them with (the records on screen then stay as they are). A refused pairing is thrown.
   */
  const readPosts = async (pr: PrSummary): Promise<PostRecord[] | null> => {
    let latest: LatestReply | null;
    try {
      latest = await client.latest(pr.repo, pr.number, live.signal);
    } catch (error) {
      if (error instanceof ServiceError && error.kind === 'unpaired') throw error;
      return null;
    }
    return latest === null ? null : latest.posts.filter((r) => isFor(r, pr));
  };

  const start = async (g: number, pr: PrSummary, depth: Depth, packIds: string[] | undefined, since?: 'last'): Promise<void> => {
    const startedAt = now();
    const reply = await client.start({ repo: pr.repo, number: pr.number, depth, ...(packIds === undefined ? {} : { packIds }), ...(since === undefined ? {} : { since }) });
    if (!current(g)) return;
    void follow(g, pr, reply.runId, startedAt).catch((error: unknown) => fail(g, error, pr));
  };

  const dispatch = (action: UserAction): void => {
    if (stopped) return;
    const pr = prOf(state);
    switch (action.type) {
      case 'retry':
        if (state.kind !== 'problem' && state.kind !== 'offline') return;
        if (ref === undefined) readTab();
        else begin(state.kind === 'offline');
        return;
      case 'pair':
        if (state.kind === 'unpaired') act(null, (g) => pair(g, action.token));
        return;
      case 'start':
        if (pr !== null && (state.kind === 'ready' || state.kind === 'review' || state.kind === 'problem')) {
          act(pr, (g) => start(g, pr, action.depth, action.packIds, action.since));
        }
        return;
      case 'dismiss':
        if (state.kind === 'review' && action.body.repo === state.pr.repo && action.body.number === state.pr.number) {
          // Not aborted when the tab moves: once sent, the service records it; only the reply is dropped.
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
      // Posting: only from a finished review that is live, for the pull request on screen. Like a dismissal, a request
      // already sent is not aborted when the tab moves; only its answer is dropped.
      case 'preview-post':
        if (state.kind === 'review' && action.body.repo === state.pr.repo && action.body.number === state.pr.number) {
          act(state.pr, async (g) => {
            try {
              answer(g, { ticket: action.ticket, kind: 'preview', preview: await client.previewPost(action.body) });
            } catch (error) {
              refusedOr(g, action.ticket, error);
            }
          });
        }
        return;
      case 'post':
        if (state.kind === 'review') {
          const known = new Set(state.latest.posts.map((r) => r.id));
          const shown = state.pr;
          // The findings posted, with their aliases, as the review on screen knows them.
          const { findings } = state.latest.document;
          const posted = action.fingerprints.map((fingerprint) => findings.find((f) => f.fingerprint === fingerprint) ?? { fingerprint });
          act(shown, (g) => post(g, shown, known, posted, action));
        }
        return;
      case 'forget-post':
        if (state.kind === 'review') {
          const shown = state.pr;
          const { repo, number } = shown;
          act(shown, async (g) => {
            try {
              await client.forgetPost({ repo, number, id: action.id });
              answer(g, { ticket: action.ticket, kind: 'forgotten', id: action.id });
            } catch (error) {
              refusedOr(g, action.ticket, error);
            }
            // Then, forgotten or refused, the records as the service now has them.
            const posts = await readPosts(shown);
            if (posts !== null && current(g)) apply({ type: 'posts', posts });
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
  readTab();

  return {
    dispatch,
    stop() {
      if (stopped) return;
      stopped = true;
      generation += 1;
      live.abort();
      clearTimers();
      unsubscribe();
    },
  };
}
