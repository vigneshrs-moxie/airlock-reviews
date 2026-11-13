import type { ChangeMap, Depth, PrSummary } from '@airlock/shared';
import type { StageLine } from '../state/reduce';
import { STAGE_WORDS } from '../state/stage-words';

/**
 * Every stage the engine reports, in the order it runs them (the stage words are written in that order; the test of the
 * stage words pins the list against the engine's). A stage the engine skips is still reported, as skipped; only
 * `lenses-deep` is left out of a review that is not deep, and out of a deep review of a sync merge.
 */
const ALL_STAGES = Object.keys(STAGE_WORDS);
const DEEP_ONLY = 'lenses-deep';
/** Stages after the deep pass: once one is reported without it, the review has no deep pass. */
const AFTER_DEEP = new Set(['select', 'summary', 'store']);

/** One line of "Show the steps": a stage in words, and Done, Now or Next (Failed or Skipped when it was). */
export interface StepRow {
  stage: string;
  words: string;
  word: 'Done' | 'Now' | 'Next' | 'Failed' | 'Skipped';
  /** Why a failed stage failed; empty otherwise. */
  detail: string;
}

export interface Progress {
  /** How many stages have started: the step the review is on. 0 before the first is reported. */
  step: number;
  /** How many stages the review will run, as far as the panel knows; null when it cannot know. */
  total: number | null;
  /** The stage being worked on now, in words; null before the first is reported. */
  current: string | null;
  /** Every stage the review will run, in order, when the total is known; otherwise the ones reported so far. */
  rows: StepRow[];
}

const DONE_WORDS: Record<StageLine['status'], StepRow['word']> = { working: 'Now', done: 'Done', failed: 'Failed', skipped: 'Skipped' };

/**
 * The stages the review will run, from the depth this panel asked for and from what has been reported: a deep pass reported
 * means deep; a later stage reported without one means none. Null when neither tells, or when a stage the panel does not
 * know was reported (a newer engine), so the count would be a guess.
 */
function planOf(lines: readonly StageLine[], depth: Depth | undefined): string[] | null {
  if (lines.some((l) => !ALL_STAGES.includes(l.stage))) return null;
  const seen = new Set(lines.map((l) => l.stage));
  const deep = seen.has(DEEP_ONLY) ? true
    : lines.some((l) => AFTER_DEEP.has(l.stage)) ? false
      : depth === undefined ? null : depth === 'deep';
  if (deep === null) return null;
  return deep ? ALL_STAGES : ALL_STAGES.filter((s) => s !== DEEP_ONLY);
}

/** Where a running review is: its step, how many there are, the stage now, and every stage with its word. */
export function progressOf(lines: readonly StageLine[], depth?: Depth): Progress {
  const plan = planOf(lines, depth);
  const working = lines.filter((l) => l.status === 'working');
  // Stages can run side by side (the lenses and the sweep): the one started last is the one named.
  const now = working.at(-1) ?? lines.at(-1);
  const reported = (l: StageLine): StepRow => ({ stage: l.stage, words: l.words, word: DONE_WORDS[l.status], detail: l.status === 'failed' ? l.detail : '' });
  const byStage = new Map(lines.map((l) => [l.stage, l]));
  const rows = plan === null ? lines.map(reported) : plan.map((stage) => {
    const line = byStage.get(stage);
    return line === undefined ? { stage, words: STAGE_WORDS[stage as keyof typeof STAGE_WORDS], word: 'Next' as const, detail: '' } : reported(line);
  });
  return { step: lines.length, total: plan === null ? null : plan.length, current: now?.words ?? null, rows };
}

/** The progress in words: "Step 4 of 15", "Step 4" when the total is not known. */
export function stepWords({ step, total }: Pick<Progress, 'step' | 'total'>): string {
  return total === null ? `Step ${step}` : `Step ${step} of ${total}`;
}

/** Time in words: "45 s", "2 min 10 s", "1 h 5 min". */
export function elapsedWords(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "14 files in 3 groups", from the change map once it is known; null when it holds no file. */
export function filesAndGroups(map: ChangeMap | null): string | null {
  if (map === null) return null;
  const files = new Set([...map.cohorts.flatMap((c) => c.layers.flatMap((l) => l.files)), ...map.standalone]).size;
  if (files === 0) return null;
  const groups = map.cohorts.length;
  return groups === 0 ? count(files, 'file', 'files') : `${count(files, 'file', 'files')} in ${count(groups, 'group', 'groups')}`;
}

/** The pull request's quiet line on the start screen: "acme/widgets #7 · 3 files · 160 lines added, 20 removed". */
export function prLine(pr: Pick<PrSummary, 'repo' | 'number' | 'changedFiles' | 'additions' | 'deletions'>): string {
  return `${pr.repo} #${pr.number} · ${count(pr.changedFiles, 'file', 'files')} · ${count(pr.additions, 'line', 'lines')} added, ${pr.deletions} removed`;
}
