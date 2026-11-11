import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { limiter, runReview } from '@airlock/engine';
import type { EngineDeps, ReviewRequest } from '@airlock/engine';
import { DepthSchema, ReviewDocumentSchema } from '@airlock/shared';
import type { Depth, ReviewDocument } from '@airlock/shared';
import { z } from 'zod';
import type { ReplayCase } from './dataset.js';
import { judgeCase, mentionsUsageLimit, UsageLimitError } from './judge.js';
import type { Match } from './judge.js';
import { renderReport, stageWords } from './report.js';
import { scoreCase, summarise } from './score.js';
import type { CaseScore, RunSummary } from './score.js';

export interface ReplayOptions {
  /** The cases to review, judge or resume in this call. */
  cases: ReplayCase[];
  /**
   * The whole dataset (default `cases`). A run folder resumed with a narrower selection keeps the cases an earlier call
   * selected: they are looked up here and scored from their folders, so the summary and report cover all of them.
   * Without it, earlier cases that are not in `cases` stay listed in run.json but cannot be scored by this call.
   */
  dataset?: ReplayCase[];
  model: string;
  depth: Depth;
  /** The run is written under <outDir>/<runId>/. */
  outDir: string;
  /** Default: <YYYYMMDD-HHmmss of deps.now(), UTC>-<model>-<depth>, with anything outside [A-Za-z0-9._-] made `_`. */
  runId?: string;
  packsDir: string;
  /** The team kit, fetched once for the whole run and passed to every review. */
  kitDir: string;
  kitSha: string;
  /** Default 'claude-opus-5-5'. */
  judgeModel?: string;
  /** Default 1. */
  parallelCases?: number;
  /** How hard every model of every review works. Default 'high'. */
  effort?: ReplayEffort;
  /** The rule sweep's model. Default: `model`. */
  sweepModel?: string;
  /** Whether a group's lenses may share one request (see ReviewRequest.combine). Default 'never'. */
  combine?: ReplayCombine;
}

export const REPLAY_EFFORTS = ['low', 'medium', 'high'] as const;
export type ReplayEffort = (typeof REPLAY_EFFORTS)[number];
export const REPLAY_COMBINE = ['never', 'no-read-tier'] as const;
export type ReplayCombine = (typeof REPLAY_COMBINE)[number];

/**
 * The engine's dependencies; tests pass a fake `review`. `runner` must already retry a failed request (as
 * `withRetry(createSdkRunner(), 1)` does): the judge uses it as it is.
 */
export interface ReplayDeps extends EngineDeps { review?: typeof runReview }

/** One step of one case. The case's last event (`skipped`, `judged` or `failed`) carries its score. */
export type CaseEvent = {
  caseId: string;
  status: 'start' | 'skipped' | 'reviewed' | 'judged' | 'failed';
  message?: string;
  score?: CaseScore;
};

/** True when a stage of the review failed because Claude's usage limit was reached. */
const hitUsageLimit = (doc: ReviewDocument): boolean =>
  doc.stageErrors.some((e) => e.kind === 'usage-limit' || (e.kind === undefined && mentionsUsageLimit(e.message)));

/** Per case, the document and matches the report is rendered from. */
export type RunDetails = Record<string, { doc: ReviewDocument; matches: Match[] }>;

const DEFAULT_JUDGE_MODEL = 'claude-opus-5-5';
const FOLDER_NAME = /^[A-Za-z0-9._-]{1,100}$/;

const isFolderName = (name: string): boolean => FOLDER_NAME.test(name) && name !== '.' && name !== '..';

/** The folder beside the runs where the replay keeps Airlock's own data (`AIRLOCK_HOME`). */
export const HOME_FOLDER = 'home';

/** Throws unless `runId` can be used as a run folder name. */
export function checkRunId(runId: string): void {
  if (!isFolderName(runId)) {
    throw new Error(`The run id "${runId}" cannot be a folder name: use 1 to 100 letters, digits, ".", "_" or "-", and not "." or "..".`);
  }
  if (runId.toLowerCase() === HOME_FOLDER) {
    throw new Error(`The run id "${runId}" cannot be used: "${HOME_FOLDER}" is the folder where the replay keeps Airlock's own data (clones and saved reviews).`);
  }
}

const MatchesSchema = z.array(z.object({
  knownId: z.string(),
  where: z.enum(['top', 'also', 'dropped', 'candidate', 'question', 'none']),
  itemId: z.string().nullable(),
  partial: z.boolean(),
  reason: z.string(),
  others: z.array(z.object({
    itemId: z.string(),
    where: z.enum(['top', 'also', 'dropped', 'candidate', 'question']),
    partial: z.boolean(),
  })).optional(),
}));

/**
 * The version of the run folder's rules. 2: each review reads the description as it stood at review time, and the judge
 * does not see where an item ended up. A folder of an earlier version is never continued, only reported.
 */
const RUN_FORMAT = 2;

/** A run folder made by an earlier version of the replay was given to `run`: it can be reported, never continued. */
export class EarlierRunFolderError extends Error {}

const RunFileSchema = z.object({
  /** Absent in a run.json written before format 2. */
  format: z.number().int().optional(),
  runId: z.string(),
  model: z.string(),
  depth: DepthSchema,
  judgeModel: z.string(),
  kitSha: z.string(),
  /**
   * Absent in a run.json written before they were recorded, which is always before format 2: `report` then reads the
   * effort as `high` and the sweep model as the main model, as those runs used.
   */
  effort: z.enum(REPLAY_EFFORTS).optional(),
  sweepModel: z.string().optional(),
  combine: z.enum(REPLAY_COMBINE).optional(),
  caseIds: z.array(z.string()),
  startedAt: z.string(),
  /** When the first case the run worked on started, and when the last one ended, over every call. */
  casesStartedAt: z.string().optional(),
  casesFinishedAt: z.string().optional(),
});
type RunFile = z.infer<typeof RunFileSchema>;

/**
 * What happened to one case, from the run or read back from its folder:
 * - `done`: a finished review of this case (verdict not `incomplete`) with matches that score against it;
 * - `not-judged`: a finished review of this case without usable matches; it is judged again, not reviewed again;
 * - `not-done`: no finished review of this case; it is reviewed again. `doc` is the saved review when it is this
 *   case's but did not finish, else null. `reason` says why in words that are true for the folder's state.
 */
type Outcome =
  | { kind: 'done'; doc: ReviewDocument; matches: Match[] }
  | { kind: 'not-judged'; doc: ReviewDocument; reason: string }
  | { kind: 'not-done'; doc: ReviewDocument | null; reason: string };

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The text of error.txt: which step failed and why, without saying it twice. */
function failureText(lead: string, err: unknown): string {
  const message = messageOf(err).trim();
  return message.startsWith(lead) ? message : `${lead}: ${message}`;
}

/** Writes under a temporary name in the same folder, then renames, so a reader never sees half a file. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, text);
    await rename(temporary, path);
  } catch (err) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw err;
  }
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** A JSON file parsed with `schema`: 'missing' when there is no file; 'unreadable' when it cannot be read, is not JSON or does not match. */
async function readSavedFile<T>(path: string, schema: z.ZodType<T>): Promise<T | 'missing' | 'unreadable'> {
  try {
    const text = await readText(path);
    if (text === null) return 'missing';
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** True when a saved review is of this case's pull request at its two commits. */
const reviewsCase = (doc: ReviewDocument, c: ReplayCase): boolean =>
  doc.pr.repo === c.repo && doc.pr.number === c.pr && doc.range.baseSha === c.baseSha && doc.range.headSha === c.headSha;

/** True when matches answer exactly the case's known problems, in order, and can be scored against `doc`. */
function scorable(c: ReplayCase, doc: ReviewDocument, matches: Match[]): boolean {
  if (matches.length !== c.known.length || !matches.every((m, i) => m.knownId === c.known[i]!.id)) return false;
  try {
    scoreCase(c, doc, matches);
    return true;
  } catch {
    return false;
  }
}

const NOT_RUN = 'This case has not been run.';
const OTHER_COMMITS = 'The saved review is for other commits.';
const UNREADABLE = 'The saved review cannot be read.';
const NOT_JUDGED = 'The review finished but was not judged.';

/** "The review did not finish (lenses, sweep)." from the stages that failed. */
function didNotFinish(doc: ReviewDocument): string {
  const stages = [...new Set(doc.stageErrors.map((e) => stageWords(e.stage)))];
  return stages.length === 0 ? 'The review did not finish.' : `The review did not finish (${stages.join(', ')}).`;
}

/**
 * Reads a case folder and says whether the case is done; the one rule used by the run and by `loadRun`. A case is done
 * when it has a saved review of this case (repository, number and both commits) whose verdict is not `incomplete`,
 * and saved matches that score against it. error.txt, when there is one, explains a case that is not done; one that
 * cannot be read is ignored. Never throws.
 */
async function readOutcome(dir: string, c: ReplayCase): Promise<Outcome> {
  const error = await readText(join(dir, 'error.txt')).then((t) => t?.trim() || null, () => null);
  const review = await readSavedFile(join(dir, 'review.json'), ReviewDocumentSchema);
  if (typeof review !== 'string' && reviewsCase(review, c) && review.verdict.label !== 'incomplete') {
    const matches = await readSavedFile(join(dir, 'matches.json'), MatchesSchema);
    if (typeof matches !== 'string' && scorable(c, review, matches)) return { kind: 'done', doc: review, matches };
    return { kind: 'not-judged', doc: review, reason: error ?? NOT_JUDGED };
  }
  // A later attempt that failed explains the case better than the review it would have replaced.
  if (error !== null) return { kind: 'not-done', doc: null, reason: error };
  if (review === 'missing') return { kind: 'not-done', doc: null, reason: NOT_RUN };
  if (review === 'unreadable') return { kind: 'not-done', doc: null, reason: UNREADABLE };
  if (!reviewsCase(review, c)) return { kind: 'not-done', doc: null, reason: OTHER_COMMITS };
  return { kind: 'not-done', doc: review, reason: didNotFinish(review) };
}

/**
 * A valid document for a case whose review did not finish: verdict `incomplete`, no findings and one intake stage error.
 * Never saved; the run and `loadRun` both build it from the case and error.txt.
 */
function notFinishedDocument(c: ReplayCase, run: RunInfo, message: string): ReviewDocument {
  return {
    schemaVersion: 1,
    id: `not-finished-${c.id}`,
    createdAt: run.createdAt,
    pr: {
      repo: c.repo, number: c.pr, title: c.title, body: '', author: '', viewer: '', baseRef: '', headRef: '',
      baseSha: c.baseSha, headSha: c.headSha, isFork: false, additions: 0, deletions: 0, changedFiles: 0,
      url: `https://github.com/${c.repo}/pull/${c.pr}`, stage: 'other',
    },
    range: { baseSha: c.baseSha, headSha: c.headSha, kind: 'explicit' },
    depth: run.depth,
    packs: [],
    models: { main: run.model, challenger: run.model, sweep: run.sweepModel, effort: run.effort },
    files: [],
    facts: [],
    map: { cohorts: [], standalone: [], links: [] },
    brief: { whatItDoes: [], claims: [] },
    verdict: { label: 'incomplete', sentence: 'The review did not finish.', counts: { block: 0, fix: 0, ask: 0, note: 0 } },
    findings: [],
    questions: [],
    dropped: [],
    candidates: [],
    whoseCall: [],
    checksAfterMerge: [],
    selfReviewText: '',
    stageErrors: [{ stage: 'intake', cohortId: null, message }],
    timings: [],
  };
}

/** Every known problem of the case as not found, with the reason it was not judged. */
const notJudged = (c: ReplayCase, reason: string): Match[] =>
  c.known.map((k) => ({ knownId: k.id, where: 'none', itemId: null, partial: false, reason }));

const NOT_LOST: CaseScore['lostAt'] = { lenses: 0, schema: 0, anchor: 0, merge: 0, challenge: 0, select: 0 };

type Scored = { score: CaseScore; detail: { doc: ReviewDocument; matches: Match[] } };
type RunInfo = { model: string; sweepModel: string; effort: ReplayEffort; depth: Depth; createdAt: string };

/** How a run's cases are scored; a run.json written before effort and sweep model were recorded reads as `high` and the main model (`report` only). */
const runInfo = (run: RunFile): RunInfo =>
  ({ model: run.model, sweepModel: run.sweepModel ?? run.model, effort: run.effort ?? 'high', depth: run.depth, createdAt: run.startedAt });

/**
 * The score and report details of one case. A case that is not done is scored `incomplete` with every known problem
 * not found and lost at no stage, since it was never judged:
 * - with no review of its own that it could keep, it is scored from the stand-in document, whose stage error is the reason;
 * - a saved review that did not finish is scored from that review, whose stage errors say which stages failed;
 * - a finished review that was not judged is scored as real but unjudged, and the report's copy of its document gains
 *   a `judge` stage error so the report says why.
 */
function scoreOutcome(c: ReplayCase, o: Outcome, run: RunInfo): Scored {
  switch (o.kind) {
    case 'done':
      try {
        return { score: scoreCase(c, o.doc, o.matches), detail: { doc: o.doc, matches: o.matches } };
      } catch (err) {
        return scoreOutcome(c, { kind: 'not-judged', doc: o.doc, reason: failureText('The matches could not be scored', err) }, run);
      }
    case 'not-judged': {
      const matches = notJudged(c, 'Not judged: the judge did not finish on this pull request.');
      const score: CaseScore = { ...scoreCase(c, o.doc, matches), verdict: 'incomplete', lostAt: { ...NOT_LOST } };
      const doc: ReviewDocument = { ...o.doc, stageErrors: [...o.doc.stageErrors, { stage: 'judge', cohortId: null, message: o.reason }] };
      return { score, detail: { doc, matches } };
    }
    case 'not-done': {
      const doc = o.doc ?? notFinishedDocument(c, run, o.reason);
      const matches = notJudged(c, 'Not judged: the review did not finish.');
      return { score: { ...scoreCase(c, doc, matches), verdict: 'incomplete', lostAt: { ...NOT_LOST } }, detail: { doc, matches } };
    }
  }
}

function defaultRunId(now: Date, model: string, depth: Depth): string {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  return `${stamp}-${model}-${depth}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
}

const COMPARED = [
  ['model', 'model'], ['depth', 'depth'], ['judgeModel', 'judge model'], ['kitSha', 'kit version'],
  ['effort', 'effort'], ['sweepModel', 'sweep model'], ['combine', 'combine'],
] as const;

const madeByEarlierVersion = (run: RunFile): boolean => (run.format ?? 1) < RUN_FORMAT;

/** The dataset's cases with these ids, in dataset order; throws for an id the dataset does not have. */
function inDatasetOrder(ids: Iterable<string>, dataset: ReplayCase[], runDir: string): ReplayCase[] {
  const wanted = new Set(ids);
  const known = new Set(dataset.map((c) => c.id));
  for (const id of wanted) if (!known.has(id)) throw new Error(`The run in ${runDir} has case ${id}, which is not in the dataset.`);
  return dataset.filter((c) => wanted.has(c.id));
}

/**
 * Creates the run folder and writes run.json, or checks an existing run.json against this run. Refuses, before writing
 * anything, a folder made by an earlier version of the replay, a folder made with another model, depth, judge model,
 * kit version, effort, sweep model or combine setting, and a folder with case folders but no run.json. A resumed run
 * keeps its start time and its cases: run.json lists the earlier cases and this call's, in dataset order. Without a
 * `dataset`, earlier cases that are not among this call's cannot be scored: they stay in run.json, after the others,
 * and are left out of the cases returned.
 */
async function openRunFolder(runDir: string, run: RunFile, dataset: ReplayCase[] | undefined, selected: ReplayCase[]): Promise<{ run: RunFile; cases: ReplayCase[] }> {
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, 'run.json');
  const text = await readText(path);
  let previous: RunFile | null = null;
  if (text === null) {
    const entries = await readdir(runDir, { withFileTypes: true });
    if (entries.some((e) => e.isDirectory())) {
      throw new Error(`The run folder ${runDir} has case folders but no run.json, so it cannot be checked that they belong to this run. Use another run id.`);
    }
  } else {
    try {
      previous = RunFileSchema.parse(JSON.parse(text));
    } catch {
      throw new Error(`The run folder ${runDir} has a run.json that cannot be read. Use another run id.`);
    }
    if (madeByEarlierVersion(previous)) {
      throw new EarlierRunFolderError(
        `The run folder ${run.runId} was made by an earlier version of the replay: its reviews read today's descriptions ` +
          'and its judge saw where each finding was placed. Start a new run with another --run id.',
      );
    }
    const prev = previous;
    const differences = COMPARED.filter(([key]) => prev[key] !== run[key]).map(([key, words]) => `${words} ${prev[key]}, not ${run[key]}`);
    if (differences.length > 0) {
      throw new Error(
        `The run folder ${runDir} was made with ${differences.join('; ')}. ` +
          'Mixing them in one run would make the numbers meaningless. Use another run id.',
      );
    }
  }
  const known = new Set((dataset ?? selected).map((c) => c.id));
  const unknown = dataset === undefined ? (previous?.caseIds ?? []).filter((id) => !known.has(id)) : [];
  const cases = inDatasetOrder([...(previous?.caseIds ?? []).filter((id) => !unknown.includes(id)), ...run.caseIds], dataset ?? selected, runDir);
  checkCases(cases);
  const merged: RunFile = {
    ...run, caseIds: [...cases.map((c) => c.id), ...unknown], startedAt: previous?.startedAt ?? run.startedAt,
    ...(previous?.casesStartedAt === undefined ? {} : { casesStartedAt: previous.casesStartedAt }),
    ...(previous?.casesFinishedAt === undefined ? {} : { casesFinishedAt: previous.casesFinishedAt }),
  };
  await writeAtomic(path, json(merged));
  return { run: merged, cases };
}

/** The run's wall clock from run.json, when it has both ends. */
const wallClockOf = (run: RunFile): RunSummary['wallClock'] =>
  run.casesStartedAt !== undefined && run.casesFinishedAt !== undefined ? { startedAt: run.casesStartedAt, finishedAt: run.casesFinishedAt } : null;

/** The earlier or later of two ISO times, either of which may be missing. */
function earlier(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined || b === undefined) return a ?? b;
  return Date.parse(b) < Date.parse(a) ? b : a;
}
function later(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined || b === undefined) return a ?? b;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** Writes summary.json and report.md into the run folder and returns the report's path. */
export async function saveRunReport(runDir: string, summary: RunSummary, cases: ReplayCase[], details: RunDetails): Promise<string> {
  await writeAtomic(join(runDir, 'summary.json'), json(summary));
  const reportPath = join(runDir, 'report.md');
  await writeAtomic(reportPath, renderReport(summary, cases, details));
  return reportPath;
}

function checkCases(cases: ReplayCase[]): void {
  const seen = new Set<string>();
  for (const c of cases) {
    if (!isFolderName(c.id)) throw new Error(`The replay case id "${c.id}" cannot be a folder name.`);
    if (seen.has(c.id)) throw new Error(`The replay case id "${c.id}" is selected twice.`);
    seen.add(c.id);
  }
}

/**
 * The request for one case. Only the case's pull request, commits, its title and description at review time and the
 * hold-out: never its known problems, never packIds.
 */
function reviewRequest(c: ReplayCase, opts: ReplayOptions): ReviewRequest {
  return {
    repo: c.repo,
    number: c.pr,
    depth: opts.depth,
    combine: opts.combine ?? 'never',
    models: { main: opts.model, challenger: opts.model, sweep: opts.sweepModel ?? opts.model, effort: opts.effort ?? 'high' },
    explicit: { baseSha: c.baseSha, headSha: c.headSha },
    prText: { title: c.titleAtReview, body: c.bodyAtReview },
    holdout: { pr: c.pr, reviewedAt: c.reviewedAt },
    packsDir: opts.packsDir,
    kitDir: opts.kitDir,
    kitSha: opts.kitSha,
  };
}

/**
 * Replays past pull requests through the review pipeline, judges each review against the case's known problems and
 * scores the run. Resumes a run folder left by an earlier call; the summary and report cover every case the run has
 * selected so far. One case never stops the others: anything that goes wrong with it makes it unfinished. Rejects
 * for bad options, and for a problem with the run folder itself only after every case has settled.
 */
export async function runReplay(opts: ReplayOptions, deps: ReplayDeps, onCase?: (e: CaseEvent) => void): Promise<RunSummary> {
  const parallel = opts.parallelCases ?? 1;
  if (!Number.isInteger(parallel) || parallel < 1) throw new RangeError(`parallelCases must be a whole number of at least 1, got ${parallel}`);
  const now = deps.now();
  const runId = opts.runId ?? defaultRunId(now, opts.model, opts.depth);
  checkRunId(runId);
  checkCases(opts.cases);
  const judgeModel = opts.judgeModel ?? DEFAULT_JUDGE_MODEL;
  const runDir = join(opts.outDir, runId);
  const opened = await openRunFolder(runDir, {
    format: RUN_FORMAT, runId, model: opts.model, depth: opts.depth, judgeModel, kitSha: opts.kitSha,
    effort: opts.effort ?? 'high', sweepModel: opts.sweepModel ?? opts.model, combine: opts.combine ?? 'never',
    caseIds: opts.cases.map((c) => c.id), startedAt: now.toISOString(),
  }, opts.dataset, opts.cases);
  let { run } = opened;
  const scoring = runInfo(run);

  const review = deps.review ?? runReview;
  const engineDeps: EngineDeps = { exec: deps.exec, runner: deps.runner, now: deps.now, ...(deps.signal ? { signal: deps.signal } : {}) };
  const emit = (e: CaseEvent): void => {
    try { onCase?.(e); } catch { /* a listener's failure is not the case's */ }
  };
  const finish = (c: ReplayCase, o: Outcome, status: CaseEvent['status'], message?: string): Scored => {
    const scored = scoreOutcome(c, o, scoring);
    emit({ caseId: c.id, status, ...(message === undefined ? {} : { message }), score: scored.score });
    return scored;
  };

  // The judge reads nothing from disk: it runs in an empty folder made for this run.
  const judgeDir = await mkdtemp(join(tmpdir(), 'airlock-replay-judge-'));

  // Set when a review or the judge reaches Claude's usage limit: no case starts after that, so none is spoiled.
  let limitReachedIn: string | null = null;
  const notStarted = new Set<string>();

  // The run's own wall clock: from the first case this call works on to the last one's end.
  let firstStart: string | undefined;
  let lastEnd: string | undefined;
  const stamp = (): string => deps.now().toISOString();

  /**
   * Works on one case until it is done: reviews it unless a finished review of it is saved, then judges it. A review
   * that comes back incomplete is saved, in place of the old one, and not judged. Never throws.
   */
  const processCase = async (c: ReplayCase): Promise<Scored> => {
    const dir = join(runDir, c.id);
    let kept: ReviewDocument | null = null;
    let lead = 'The case folder could not be prepared';
    let started = false;
    try {
      const saved = await readOutcome(dir, c);
      if (saved.kind === 'done') return finish(c, saved, 'skipped');
      if (limitReachedIn !== null) {
        notStarted.add(c.id);
        return scoreOutcome(c, saved, scoring);
      }

      firstStart = earlier(firstStart, stamp());
      started = true;
      emit({ caseId: c.id, status: 'start', ...(saved.kind === 'not-judged' ? { message: 'judging the saved review again' } : {}) });
      await mkdir(dir, { recursive: true });
      await rm(join(dir, 'error.txt'), { recursive: true, force: true });
      await rm(join(dir, 'matches.json'), { force: true });

      if (saved.kind === 'not-judged') {
        kept = saved.doc;
      } else {
        lead = 'The review failed';
        const doc = ReviewDocumentSchema.parse(await review(reviewRequest(c, opts), engineDeps));
        lead = 'Saving the review failed';
        await writeAtomic(join(dir, 'review.json'), json(doc));
        emit({ caseId: c.id, status: 'reviewed' });
        if (hitUsageLimit(doc)) limitReachedIn ??= c.id;
        if (doc.verdict.label === 'incomplete') {
          const reason = didNotFinish(doc);
          return finish(c, { kind: 'not-done', doc, reason }, 'failed', reason);
        }
        kept = doc;
      }

      lead = 'The judge failed';
      const matches = await judgeCase(deps.runner, c, kept, judgeModel, judgeDir);
      lead = 'Saving the matches failed';
      await writeAtomic(join(dir, 'matches.json'), json(matches));
      return finish(c, { kind: 'done', doc: kept, matches }, 'judged');
    } catch (err) {
      if (err instanceof UsageLimitError) limitReachedIn ??= c.id;
      const error = failureText(lead, err);
      await writeAtomic(join(dir, 'error.txt'), `${error}\n`).catch(() => undefined);
      return finish(c, kept ? { kind: 'not-judged', doc: kept, reason: error } : { kind: 'not-done', doc: null, reason: error }, 'failed', error);
    } finally {
      if (started) lastEnd = later(lastEnd, stamp());
    }
  };

  const selected = new Set(opts.cases.map((c) => c.id));
  const slot = limiter(parallel);
  let settled: PromiseSettledResult<Scored>[];
  try {
    settled = await Promise.allSettled(opened.cases.map((c) => (selected.has(c.id)
      ? slot(() => processCase(c))
      : readOutcome(join(runDir, c.id), c).then((o) => scoreOutcome(c, o, scoring)))));
  } finally {
    await rm(judgeDir, { recursive: true, force: true }).catch(() => undefined);
  }
  const results = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    // Not expected: processCase and readOutcome do not throw. Still, one case never stops the others.
    const c = opened.cases[i]!;
    return scoreOutcome(c, { kind: 'not-done', doc: null, reason: failureText('The case failed', r.reason) }, scoring);
  });
  const casesStartedAt = earlier(run.casesStartedAt, firstStart);
  const casesFinishedAt = later(run.casesFinishedAt, lastEnd);
  if (casesStartedAt !== run.casesStartedAt || casesFinishedAt !== run.casesFinishedAt) {
    run = {
      ...run,
      ...(casesStartedAt === undefined ? {} : { casesStartedAt }),
      ...(casesFinishedAt === undefined ? {} : { casesFinishedAt }),
    };
    await writeAtomic(join(runDir, 'run.json'), json(run));
  }
  const summary: RunSummary = {
    ...summarise(runId, run.model, run.depth, results.map((r) => r.score), opened.cases, opts.dataset ?? opts.cases, { wallClock: wallClockOf(run) }),
    ...(limitReachedIn === null ? {} : {
      stopped: { reason: 'usage-limit', caseId: limitReachedIn, notStarted: opened.cases.filter((c) => notStarted.has(c.id)).map((c) => c.id) },
    }),
  };
  const details: RunDetails = Object.fromEntries(opened.cases.map((c, i) => [c.id, results[i]!.detail]));
  await saveRunReport(runDir, summary, opts.dataset ?? opened.cases, details);
  return summary;
}

/**
 * Rebuilds the summary and the report details of a finished or part-finished run from its folder, including one made
 * by an earlier version of the replay, whose first test then reads `not comparable`.
 */
export async function loadRun(runDir: string, cases: ReplayCase[]): Promise<{ summary: RunSummary; details: RunDetails }> {
  const text = await readText(join(runDir, 'run.json'));
  if (text === null) throw new Error(`${runDir} is not a replay run folder: it has no run.json.`);
  let run: RunFile;
  try {
    run = RunFileSchema.parse(JSON.parse(text));
  } catch {
    throw new Error(`${join(runDir, 'run.json')} cannot be read.`);
  }
  const selected = inDatasetOrder(run.caseIds, cases, runDir);
  checkCases(selected);
  const scoring = runInfo(run);
  const results = await Promise.all(selected.map(async (c) => scoreOutcome(c, await readOutcome(join(runDir, c.id), c), scoring)));
  const summary = summarise(run.runId, run.model, run.depth, results.map((r) => r.score), selected, cases, {
    wallClock: wallClockOf(run), madeByEarlierVersion: madeByEarlierVersion(run),
  });
  const details: RunDetails = Object.fromEntries(selected.map((c, i) => [c.id, results[i]!.detail]));
  return { summary, details };
}
