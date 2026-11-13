import { prRefFromUrl, type Depth, type Finding, type LatestReply, type PostRecord, type PrSummary, type ReviewDocument } from '@airlock/shared';
import { ServiceError, type ServiceClient } from '../client/service';
import { realTimers, type Timers } from '../client/timers';
import type { PageHead, PageNotes } from './notes';
import {
  isFor, POST_NOT_LEARNED, POST_UNKNOWN, reduce, withStage, type Action, type PanelState, type PostReply, type ReviewView, type StageLine,
  type UserAction,
} from './reduce';

/** A post the proof stopped before the Pair screen: nothing was sent. Said in the post sheet once the review is back. */
export const POST_NOT_SENT_UNPROVEN = 'Nothing was sent: Airlock could not confirm it was talking to its own service.';
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
/** After a 404 on a post, the records are read again only this many times (20 s): most such previews really expired. */
export const POST_NO_PREVIEW_RECHECKS = 4;
/** What a 404 on a post comes to when no record of it appears. */
export const PREVIEW_EXPIRED = 'This preview has expired. Open the preview again.';
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
  /**
   * The notes on the tab's page, told which review is on screen with every state, and which commit the page shows: the
   * head read when the tab last loaded or moved within the pull request, or at the panel's first read of it.
   */
  notes?: Pick<PageNotes, 'review' | 'head'>;
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

/**
 * The review on screen, for the notes: the finished one, or the one kept while the service is away; null when none is;
 * undefined while loading, when what comes next is not known yet (so the notes on the page stay as they are meanwhile).
 */
function reviewOnScreen(state: PanelState): ReviewView | null | undefined {
  if (state.kind === 'loading') return undefined;
  if (state.kind === 'review') return { pr: state.pr, latest: state.latest, stale: state.stale };
  if (state.kind === 'offline') return state.review ?? null;
  return null;
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
  /** An answer for the post sheet that the Pair screen came before: given with the pull request's review when it is back. */
  let carried: { ref: PrRef; reply: PostReply } | null = null;
  /** The post records and dismissals last on screen, and whose they are, for a finished review whose own read fails. */
  let records: { repo: string; number: number; posts: PostRecord[]; dismissals: LatestReply['dismissals'] } | null = null;
  const sleeping = new Set<unknown>();
  /**
   * The runs this panel started (not ones the service reused): the depth asked for and when it was asked, so attaching to
   * the same run again (after the tab moved and came back, or the service came back) keeps its step total and its time.
   */
  const ownRuns = new Map<string, { depth: Depth; startedAt: number }>();
  /**
   * The commit the tab's page shows, as best the panel knows: `unset` until the first read of this pull request,
   * `unknown` when the read made after the page loaded or moved failed (or the service was away then).
   */
  let page: { kind: 'unset' } | { kind: 'unknown' } | { kind: 'known'; sha: string } = { kind: 'unset' };
  /** The read of the head after the tab loaded or moved: only the newest one's answer counts. */
  let headRead: AbortController | null = null;
  /** The tab's address as last heard, without its fragment (a jump changes only the fragment). */
  let heard: string | undefined;

  const emit = (next: PanelState): void => {
    if (stopped || next === state) return;
    state = next;
    if (next.kind === 'review') {
      records = { repo: next.pr.repo, number: next.pr.number, posts: next.latest.posts, dismissals: next.latest.dismissals };
    }
    deps.onState(next);
    deps.notes?.review(reviewOnScreen(next));
  };
  const apply = (action: Action): void => emit(reduce(state, action));
  /** Tells the notes which commit the page shows; while it is being read, or not read yet, they wait. */
  const tellPage = (): void => {
    const told: PageHead = headRead !== null || page.kind === 'unset' ? { state: 'reading' }
      : page.kind === 'unknown' ? { state: 'unknown' } : { state: 'known', sha: page.sha };
    deps.notes?.head(told);
  };
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
      // The panel's first read of this pull request is its best guess at what a page already open shows. A later load of
      // its own (Retry, the service back) does not change it: the page did not load again.
      if (page.kind === 'unset') {
        page = { kind: 'known', sha: pr.headSha };
        tellPage();
      }
      const runId = await client.running(target.repo, target.number, signal);
      if (!current(g)) return;
      if (runId !== null) {
        const own = ownRuns.get(runId);
        await follow(g, pr, runId, own?.startedAt ?? now(), own?.depth);
        return;
      }
      const latest = await client.latest(target.repo, target.number, signal);
      if (!current(g)) return;
      // The run that was showing is gone: unless this stored review is its result, say that it stopped.
      const lost = cutOff !== null && !finishedSince(latest, cutOff.startedAt);
      const owed = latest !== null && carried !== null && sameRef(carried.ref, target) ? carried.reply : undefined;
      if (owed !== undefined) carried = null;
      apply({ type: 'loaded', pr, latest, ...(lost ? { notice: RUN_STOPPED } : {}), ...(owed === undefined ? {} : { post: owed }) });
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
  const follow = async (g: number, pr: PrSummary, runId: string, startedAt: number, depth?: Depth): Promise<void> => {
    const signal = live.signal;
    apply({ type: 'attached', pr, startedAt, ...(depth === undefined ? {} : { depth }) });
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

  /**
   * Reads the stored review so its dismissals and post records come with it. When that fails, the event's own document,
   * with the records last on screen for this pull request (never an empty list in their place).
   */
  const finish = async (g: number, pr: PrSummary, document: ReviewDocument): Promise<void> => {
    let latest: LatestReply | null = null;
    try {
      latest = await client.latest(pr.repo, pr.number, live.signal);
    } catch {
      latest = null;
    }
    if (!current(g)) return;
    const same = latest !== null && latest.document.id === document.id;
    const kept = records !== null && isFor(records, pr) ? records : { posts: [], dismissals: [] };
    apply({ type: 'finished', latest: same && latest !== null ? latest : { document, dismissals: kept.dismissals, posts: kept.posts } });
    // The head may have moved during the run: `stale` is worked out from a read made now, quietly. The page's commit is
    // not changed by it: the page did not load again.
    client.pr(pr.repo, pr.number, live.signal).then(
      (fresh) => { if (current(g)) apply({ type: 'head', pr: fresh }); },
      () => undefined,
    );
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
        heard ??= url?.split('#')[0];
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
  /** A refusal in the service's words, as the post sheet's answer; anything else is thrown on to `act`. */
  const refusal = (ticket: number, error: unknown): PostReply => {
    if (!(error instanceof ServiceError && error.kind === 'problem')) throw error;
    return { ticket, kind: 'refused', message: error.message };
  };
  /**
   * The post records as the service now has them, shown before the answer that follows, so the action stays in flight
   * (and the buttons say to wait) until they are on screen.
   */
  const reread = async (g: number, pr: PrSummary): Promise<void> => {
    const posts = await readPosts(pr);
    if (posts !== null && current(g)) apply({ type: 'posts', posts });
  };

  /**
   * Posts a stored preview, once. When the reply does not say what happened, the post records do: the panel reads them
   * now and every POST_RECHECK_MS for POST_RECHECKS more reads, while the post stays in flight, until the record this post
   * made (one not on screen before, holding one of its findings) appears. The records shown are always the ones last
   * read. A read that fails counts as a read with nothing in it; only a refused pairing stops the wait. With no record at
   * the end, the panel says it could not learn what happened, and nothing is sent again.
   *
   * A 404 (`no-preview`) is checked the same way, but only for POST_NO_PREVIEW_RECHECKS more reads: the browser may have
   * sent the post a second time by itself, and the first copy, which took the preview, may be posting or have posted.
   * When no record appears the preview expired. A first copy that finishes later still shows: the records are read
   * again on the next load and action, and the service refuses a new preview of findings a record holds.
   */
  const post = async (
    g: number, pr: PrSummary, known: ReadonlySet<string>, findings: readonly Pick<Finding, 'fingerprint' | 'aliases'>[],
    action: Extract<UserAction, { type: 'post' }>,
  ): Promise<void> => {
    const { ticket } = action;
    const sent = await client.post({ previewId: action.previewId });
    if (sent.outcome === 'unsent') {
      // The proof came first and failed, so nothing was sent: said as such, and the post can be tried again. What answers
      // could not prove it holds the token: the Pair screen, as everywhere, and the sheet hears it when the review is back.
      if (sent.why !== 'unproven' && sent.why !== 'unpaired') { answer(g, { ticket, kind: 'unsent', message: sent.message }); return; }
      carried = { ref: { repo: pr.repo, number: pr.number }, reply: { ticket, kind: 'unsent', message: POST_NOT_SENT_UNPROVEN } };
      throw new ServiceError(sent.why, sent.message);
    }
    // A record for another pull request is not this post's answer: its address is not shown here.
    if (sent.outcome === 'posted' && isFor(sent.record, pr)) { answer(g, { ticket, kind: 'posted', record: sent.record }); return; }
    if (sent.outcome === 'refused') {
      // A refusal may leave a record the service could not clear: the records are read again, so it can be forgotten.
      await reread(g, pr);
      answer(g, { ticket, kind: 'refused', message: sent.message });
      return;
    }
    const said = sent.outcome === 'unclear' ? sent.message ?? POST_UNKNOWN : POST_UNKNOWN;
    // A server error that said something other than its 504: its sentence is kept for the end of the wait.
    const problem = sent.outcome === 'unclear' && sent.status !== undefined && sent.status !== 504 ? sent.message : undefined;
    const checking = sent.outcome === 'no-preview';
    const noRecord: PostReply = checking ? { ticket, kind: 'refused', message: PREVIEW_EXPIRED }
      : { ticket, kind: 'unclear', message: problem === undefined ? POST_NOT_LEARNED : `${problem} ${POST_NOT_LEARNED}` };
    const rechecks = checking ? POST_NO_PREVIEW_RECHECKS : POST_RECHECKS;
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
      if (read >= rechecks) {
        answer(g, noRecord);
        return;
      }
      if (read === 0) answer(g, checking ? { ticket, kind: 'waiting', checking: true } : { ticket, kind: 'waiting' });
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
    // A run the service reused was started by someone else, perhaps at another depth: its depth is not known here.
    if (!reply.reused) ownRuns.set(reply.runId, { depth, startedAt });
    void follow(g, pr, reply.runId, startedAt, reply.reused ? undefined : depth).catch((error: unknown) => fail(g, error, pr));
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
          const shown = state.pr;
          act(shown, async (g) => {
            let reply: PostReply;
            try {
              reply = { ticket: action.ticket, kind: 'preview', preview: await client.previewPost(action.body) };
            } catch (error) {
              reply = refusal(action.ticket, error);
              // A refused preview may name a record not on screen (posted from another panel, or not cleared): read them.
              await reread(g, shown);
            }
            answer(g, reply);
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
            let reply: PostReply;
            try {
              const done = await client.forgetPost({ repo, number, id: action.id });
              // GitHub has the review: nothing was forgotten, and the record is now posted.
              reply = done.found !== undefined
                ? { ticket: action.ticket, kind: 'found', message: done.found.message, record: done.found.record }
                : { ticket: action.ticket, kind: 'forgotten', id: action.id };
            } catch (error) {
              reply = refusal(action.ticket, error);
            }
            // Then, forgotten, found or refused, the records as the service now has them, before the answer: the forget is in
            // flight until they are on screen, so a press meanwhile waits rather than being dropped.
            await reread(g, shown);
            answer(g, reply);
          });
        }
        return;
    }
  };

  /**
   * The tab finished loading again at the same pull request, or moved within it (GitHub changes tabs inside the page), and
   * may now show newer commits: the pull request is read again quietly, whatever is on screen, and its head is taken as
   * the commit the page shows. With a review on screen, `stale` is worked out again from it too (nothing on screen changes
   * but what the answer changes; a sheet, a notice and an action in flight stay); a running review is not touched. The
   * notes wait for the answer. A read that fails, or a load while the service is away, leaves the page's commit unknown,
   * and the notes are cleared. A newer trigger replaces a read in flight, and only its answer counts.
   */
  const readHead = (): void => {
    const target = ref;
    if (target === undefined || target === null) return;
    headRead?.abort();
    headRead = null;
    // Not paired: nothing can be read; the first read once paired is the best guess, as for a panel just opened.
    if (state.kind === 'unpaired') {
      page = { kind: 'unset' };
      tellPage();
      return;
    }
    if (state.kind === 'offline') {
      page = { kind: 'unknown' };
      tellPage();
      return;
    }
    const read = new AbortController();
    headRead = read;
    tellPage();
    const newest = (): boolean => headRead === read && !stopped;
    client.pr(target.repo, target.number, read.signal).then(
      (pr) => {
        if (!newest()) return;
        headRead = null;
        // The panel went away from the service meanwhile: the answer is not trusted, as a load at that moment would not be.
        if (state.kind === 'offline') page = { kind: 'unknown' };
        else {
          page = { kind: 'known', sha: pr.headSha };
          apply({ type: 'head', pr });
        }
        tellPage();
      },
      () => {
        if (!newest()) return;
        headRead = null;
        page = { kind: 'unknown' };
        tellPage();
      },
    );
  };

  // The screens have a state from the first moment, before the tab's address is known.
  deps.onState(state);

  const unsubscribe = tab.onChange((url, status) => {
    const next = refOf(url);
    const path = url?.split('#')[0];
    const moved = path !== heard;
    heard = path;
    if (ref !== undefined && sameRef(next, ref)) {
      // A page that is still loading is read when it is complete.
      if (status === 'complete' || (moved && status !== 'loading')) readHead();
      return;
    }
    ref = next;
    // Another pull request, or none: what its page shows is read with it.
    headRead?.abort();
    headRead = null;
    page = { kind: 'unset' };
    tellPage();
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
      headRead?.abort();
      clearTimers();
      unsubscribe();
    },
  };
}
