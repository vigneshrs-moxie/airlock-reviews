import type { Depth, Dropped, ReviewDocument, VerdictLabel } from '@airlock/shared';
import type { ReplayCase } from './dataset.js';
import type { Match } from './judge.js';

/** The stage at which a known problem was lost: never found by a lens, or dropped at a stage. */
export type LostStage = 'lenses' | Dropped['stage'];

export interface CaseScore {
  caseId: string;
  kind: ReplayCase['kind'];
  known: number;
  /** Known problems whose `defect` is not false. */
  knownDefects: number;
  inTop: number;
  /** In the top five or under Also found. */
  shown: number;
  /** Matched by anything at all, including a dropped item or a question. */
  raised: number;
  defectsInTop: number;
  defectsShown: number;
  partialInTop: number;
  asQuestion: number;
  /** Known problems whose matched item is also the match for another known problem of the case. */
  sharedMatches: number;
  lostAt: Record<LostStage, number>;
  crossFileKnown: number;
  crossFileInTop: number;
  findingsShown: number;
  blockOrFixShown: number;
  /** The review's elapsed time: from its start to its end when it records both, else the sum of its stages' times. */
  ms: number;
  /** True when `ms` is the sum of stage times, which can overlap, so it is only about the time that passed. */
  msSummed: boolean;
  inputTokens: number;
  outputTokens: number;
  agentRuns: number;
  verdict: VerdictLabel;
}

export interface RunSummary {
  runId: string;
  model: string;
  depth: Depth;
  cases: CaseScore[];
  /** Scores of the secondary cases in the run, also in `cases`; no headline figure counts them. */
  secondary: CaseScore[];
  /** Known problems of every positive case in the dataset, whether run or not. */
  datasetKnownTotal: number;
  /** Positive cases in the dataset. */
  datasetPositives: number;
  /** Ids of the dataset's positive cases that are not in this run, in dataset order. */
  positivesNotRun: string[];
  /** Over positive cases in the run only, as are the recalls. */
  knownTotal: number;
  inTopTotal: number;
  recallTop: number;
  recallShown: number;
  recallTopDefects: number;
  crossFileRecallTop: number;
  /** Over positive cases only. */
  sharedMatches: number;
  negativesWithBlockOrFix: number;
  incompleteCases: string[];
  /** Positive cases whose review did not finish; their known problems stay in the recall denominator. */
  positivesIncomplete: number;
  negativesIncomplete: number;
  /**
   * True when the run folder was made by an earlier version of the replay, whose reviews read today's descriptions and
   * whose judge saw where each finding was placed: its first test then has no answer that can be compared.
   */
  madeByEarlierVersion: boolean;
  /** From the first case start to the last case end of the run, over every call that worked on it; null when not known. */
  wallClock: { startedAt: string; finishedAt: string } | null;
  /** `ms` is the wall clock when there is one, else the sum of the cases' times (`msSummed`). */
  totals: { ms: number; msSummed: boolean; inputTokens: number; outputTokens: number; agentRuns: number };
  /**
   * Present when the run stopped early because Claude's usage limit was reached during `caseId`: the cases in
   * `notStarted` were left untouched. Only the run itself knows this; a summary rebuilt from the folder does not have it.
   */
  stopped?: { reason: 'usage-limit'; caseId: string; notStarted: string[] };
  meets: {
    /**
     * 'not tested' when the run has no positive cases; 'not comparable' when the run folder was made by an earlier
     * version. true or false only when every positive case in the dataset is in the run and finished; otherwise
     * 'yes so far' or 'no so far'.
     */
    halfInTop: boolean | 'yes so far' | 'no so far' | 'not tested' | 'not comparable';
    /**
     * 'not tested' with no negative cases; else 'needs a human look' when one shows a Block or Fix;
     * else 'incomplete' when one's review did not finish; else true.
     */
    cleanControls: true | 'needs a human look' | 'not tested' | 'incomplete';
  };
}

/** Where a match left its known problem, if it was lost: null when it was shown or came back as a question. */
function lostStage(doc: ReviewDocument, m: Match | undefined): LostStage | null {
  switch (m?.where ?? 'none') {
    case 'none':
      return 'lenses';
    case 'candidate':
      return 'select';
    case 'dropped': {
      const entry = doc.dropped.find((d) => d.candidate.id === m!.itemId);
      if (!entry) throw new Error(`Match for ${m!.knownId} names dropped item ${m!.itemId}, which the review does not have`);
      return entry.stage;
    }
    default:
      return null;
  }
}

/**
 * The items that are the match for more than one of the case's known problems, each with
 * those known ids in the case's order.
 */
export function sharedMatchItems(c: ReplayCase, matches: Match[]): Map<string, string[]> {
  const byKnown = new Map(matches.map((m) => [m.knownId, m]));
  const byItem = new Map<string, string[]>();
  for (const k of c.known) {
    const itemId = byKnown.get(k.id)?.itemId;
    if (itemId == null) continue;
    byItem.set(itemId, [...(byItem.get(itemId) ?? []), k.id]);
  }
  for (const [itemId, knownIds] of byItem) if (knownIds.length < 2) byItem.delete(itemId);
  return byItem;
}

/** Milliseconds from `startedAt` to `finishedAt`; null when either cannot be read or the end comes first. */
function between(startedAt: string | undefined, finishedAt: string): number | null {
  if (startedAt === undefined) return null;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Scores one case from its review document and the judge's matches. */
export function scoreCase(c: ReplayCase, doc: ReviewDocument, matches: Match[]): CaseScore {
  const byKnown = new Map(matches.map((m) => [m.knownId, m]));
  const s: CaseScore = {
    caseId: c.id, kind: c.kind, known: c.known.length, knownDefects: 0, inTop: 0, shown: 0, raised: 0,
    defectsInTop: 0, defectsShown: 0, partialInTop: 0, asQuestion: 0,
    sharedMatches: sum([...sharedMatchItems(c, matches).values()], (ids) => ids.length),
    lostAt: { lenses: 0, schema: 0, anchor: 0, merge: 0, challenge: 0, select: 0 },
    crossFileKnown: 0, crossFileInTop: 0, findingsShown: doc.findings.length,
    blockOrFixShown: doc.findings.filter((f) => f.severity === 'block' || f.severity === 'fix').length,
    ms: 0, msSummed: false, inputTokens: 0, outputTokens: 0, agentRuns: 0, verdict: doc.verdict.label,
  };
  // `createdAt` is when the document was assembled, at the review's end, once the review records its start.
  const elapsed = between(doc.startedAt, doc.createdAt);
  s.ms = elapsed ?? sum(doc.timings, (t) => t.ms);
  s.msSummed = elapsed === null;
  for (const t of doc.timings) {
    s.inputTokens += t.inputTokens;
    s.outputTokens += t.outputTokens;
    s.agentRuns += t.agentRuns;
  }
  for (const k of c.known) {
    const m = byKnown.get(k.id);
    const where = m?.where ?? 'none';
    const isDefect = k.defect !== false;
    const inTop = where === 'top';
    const shown = inTop || where === 'also';
    if (isDefect) s.knownDefects++;
    if (k.crossFile) s.crossFileKnown++;
    if (inTop) {
      s.inTop++;
      if (isDefect) s.defectsInTop++;
      if (k.crossFile) s.crossFileInTop++;
      if (m!.partial) s.partialInTop++;
    }
    if (shown) {
      s.shown++;
      if (isDefect) s.defectsShown++;
    }
    if (where !== 'none') s.raised++;
    if (where === 'question') s.asQuestion++;
    const lost = lostStage(doc, m);
    if (lost !== null) s.lostAt[lost]++;
  }
  return s;
}

const ratio = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);
function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((n, item) => n + pick(item), 0);
}

/**
 * Totals a run. Recalls are over positive cases only (0 when there are none); the kind of
 * each case is taken from `cases`, and a score with no case there is an error. `dataset` is the
 * whole dataset (default `cases`): the summary says how much of it the run covers, and `recorded` what the run folder
 * records: its wall clock, and whether an earlier version of the replay made it.
 */
export function summarise(
  runId: string, model: string, depth: Depth, scores: CaseScore[], cases: ReplayCase[], dataset: ReplayCase[] = cases,
  recorded: { wallClock?: RunSummary['wallClock']; madeByEarlierVersion?: boolean } = {},
): RunSummary {
  const wallClock = recorded.wallClock ?? null;
  const madeByEarlierVersion = recorded.madeByEarlierVersion ?? false;
  const kindOf = new Map(cases.map((c) => [c.id, c.kind]));
  const kind = (s: CaseScore): ReplayCase['kind'] => {
    const k = kindOf.get(s.caseId);
    if (k === undefined) throw new Error(`Score for ${s.caseId} has no replay case`);
    return k;
  };
  const positive = scores.filter((s) => kind(s) === 'positive');
  const negative = scores.filter((s) => kind(s) === 'negative');

  const knownTotal = sum(positive, (s) => s.known);
  const inTopTotal = sum(positive, (s) => s.inTop);
  const recallTop = ratio(inTopTotal, knownTotal);
  const negativesWithBlockOrFix = negative.filter((s) => s.blockOrFixShown > 0).length;
  const incomplete = (s: CaseScore): boolean => s.verdict === 'incomplete';
  const negativesIncomplete = negative.filter(incomplete).length;
  const datasetPositives = dataset.filter((c) => c.kind === 'positive');
  const run = new Set(scores.map((s) => s.caseId));
  const positivesNotRun = datasetPositives.filter((c) => !run.has(c.id)).map((c) => c.id);
  const wholeDataset = positivesNotRun.length === 0 && !positive.some(incomplete);
  const half = recallTop >= 0.5;
  const wallMs = wallClock === null ? null : between(wallClock.startedAt, wallClock.finishedAt);
  return {
    runId, model, depth, cases: scores, secondary: scores.filter((s) => kind(s) === 'secondary'),
    datasetKnownTotal: sum(datasetPositives, (c) => c.known.length), datasetPositives: datasetPositives.length, positivesNotRun,
    knownTotal, inTopTotal, recallTop,
    recallShown: ratio(sum(positive, (s) => s.shown), knownTotal),
    recallTopDefects: ratio(sum(positive, (s) => s.defectsInTop), sum(positive, (s) => s.knownDefects)),
    crossFileRecallTop: ratio(sum(positive, (s) => s.crossFileInTop), sum(positive, (s) => s.crossFileKnown)),
    sharedMatches: sum(positive, (s) => s.sharedMatches),
    negativesWithBlockOrFix,
    incompleteCases: scores.filter(incomplete).map((s) => s.caseId),
    positivesIncomplete: positive.filter(incomplete).length,
    negativesIncomplete,
    madeByEarlierVersion,
    wallClock,
    totals: {
      ms: wallMs ?? sum(scores, (s) => s.ms), msSummed: wallMs === null, inputTokens: sum(scores, (s) => s.inputTokens),
      outputTokens: sum(scores, (s) => s.outputTokens), agentRuns: sum(scores, (s) => s.agentRuns),
    },
    meets: {
      halfInTop: positive.length === 0 ? 'not tested'
        : madeByEarlierVersion ? 'not comparable'
          : wholeDataset ? half : half ? 'yes so far' : 'no so far',
      cleanControls: negative.length === 0 ? 'not tested'
        : negativesWithBlockOrFix > 0 ? 'needs a human look'
          : negativesIncomplete > 0 ? 'incomplete'
            : true,
    },
  };
}
