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
  lostAt: Record<LostStage, number>;
  crossFileKnown: number;
  crossFileInTop: number;
  findingsShown: number;
  blockOrFixShown: number;
  ms: number;
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
  /** Over positive cases only, as are the recalls. */
  knownTotal: number;
  inTopTotal: number;
  recallTop: number;
  recallShown: number;
  recallTopDefects: number;
  crossFileRecallTop: number;
  negativesWithBlockOrFix: number;
  incompleteCases: string[];
  totals: { ms: number; inputTokens: number; outputTokens: number; agentRuns: number };
  meets: { halfInTop: boolean; cleanControls: true | 'needs a human look' };
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

/** Scores one case from its review document and the judge's matches. */
export function scoreCase(c: ReplayCase, doc: ReviewDocument, matches: Match[]): CaseScore {
  const byKnown = new Map(matches.map((m) => [m.knownId, m]));
  const s: CaseScore = {
    caseId: c.id, kind: c.kind, known: c.known.length, knownDefects: 0, inTop: 0, shown: 0, raised: 0,
    defectsInTop: 0, defectsShown: 0, partialInTop: 0, asQuestion: 0,
    lostAt: { lenses: 0, schema: 0, anchor: 0, challenge: 0, select: 0 },
    crossFileKnown: 0, crossFileInTop: 0, findingsShown: doc.findings.length,
    blockOrFixShown: doc.findings.filter((f) => f.severity === 'block' || f.severity === 'fix').length,
    ms: 0, inputTokens: 0, outputTokens: 0, agentRuns: 0, verdict: doc.verdict.label,
  };
  for (const t of doc.timings) {
    s.ms += t.ms;
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
const sum = (scores: CaseScore[], pick: (s: CaseScore) => number): number => scores.reduce((n, s) => n + pick(s), 0);

/**
 * Totals a run. Recalls are over positive cases only (0 when there are none); the kind of
 * each case is taken from `cases`, and a score with no case there is an error.
 */
export function summarise(runId: string, model: string, depth: Depth, scores: CaseScore[], cases: ReplayCase[]): RunSummary {
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
  return {
    runId, model, depth, cases: scores, knownTotal, inTopTotal, recallTop,
    recallShown: ratio(sum(positive, (s) => s.shown), knownTotal),
    recallTopDefects: ratio(sum(positive, (s) => s.defectsInTop), sum(positive, (s) => s.knownDefects)),
    crossFileRecallTop: ratio(sum(positive, (s) => s.crossFileInTop), sum(positive, (s) => s.crossFileKnown)),
    negativesWithBlockOrFix,
    incompleteCases: scores.filter((s) => s.verdict === 'incomplete').map((s) => s.caseId),
    totals: {
      ms: sum(scores, (s) => s.ms), inputTokens: sum(scores, (s) => s.inputTokens),
      outputTokens: sum(scores, (s) => s.outputTokens), agentRuns: sum(scores, (s) => s.agentRuns),
    },
    meets: { halfInTop: recallTop >= 0.5, cleanControls: negativesWithBlockOrFix === 0 ? true : 'needs a human look' },
  };
}
