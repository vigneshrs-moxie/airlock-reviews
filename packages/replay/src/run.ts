import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { limiter, runReview } from '@airlock/engine';
import type { AgentRequest, AgentResult, AgentRunner, EngineDeps, ReviewRequest } from '@airlock/engine';
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

/** One step of one case. The case's last event (`skipped`, `judged`, `failed` or `stopped`) carries its score. */
export type CaseEvent = {
  caseId: string;
  status: 'start' | 'skipped' | 'reviewed' | 'judged' | 'failed' | 'stopped';
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

/**
 * What a case folder's spent.json holds: one entry per review attempt, finished or not, and one per judge request, each
 * with what it spent. Appended to, never rewritten.
 */
const SpentSchema = z.array(z.object({
  step: z.enum(['review', 'judge']),
  /** For a review: it returned a document whose verdict is not `incomplete`. For the judge: its answer was usable. */
  finished: z.boolean(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  agentRuns: z.number(),
}));
type Spent = z.infer<typeof SpentSchema>[number];
type Usage = Pick<Spent, 'inputTokens' | 'outputTokens' | 'agentRuns'>;

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
  /** One per call that started at least one case, from its first case start to its last case end. */
  spans: z.array(z.object({ startedAt: z.string(), finishedAt: z.string() })).optional(),
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
 * Adds an entry to the case folder's spent.json, replacing the file atomically. A spent.json that cannot be read is
 * left as it is, so the case's counts fall back to its kept review's, marked about, rather than lose the earlier entries.
 */
async function recordSpent(dir: string, entry: Spent): Promise<void> {
  const path = join(dir, 'spent.json');
  const saved = await readSavedFile(path, SpentSchema);
  if (saved === 'unreadable') return;
  await writeAtomic(path, json([...(saved === 'missing' ? [] : saved), entry]));
}

/** A review document's own usage: the sum over its stages. */
const usageOf = (doc: ReviewDocument): Usage => ({
  inputTokens: doc.timings.reduce((n, t) => n + t.inputTokens, 0),
  outputTokens: doc.timings.reduce((n, t) => n + t.outputTokens, 0),
  agentRuns: doc.timings.reduce((n, t) => n + t.agentRuns, 0),
});

/** Wraps a runner to add up what its requests spend: for a review that rejects, and for the judge. */
function counting(inner: AgentRunner): { runner: AgentRunner; used: Usage; lastOk: () => boolean } {
  const used: Usage = { inputTokens: 0, outputTokens: 0, agentRuns: 0 };
  let ok = false;
  const runner: AgentRunner = {
    async run<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
      used.agentRuns++;
      const result = await inner.run(req);
      used.inputTokens += result.usage.inputTokens;
      used.outputTokens += result.usage.outputTokens;
      ok = result.ok;
      return result;
    },
  };
  return { runner, used, lastOk: () => ok };
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
/**
 * A case's score and details from its outcome, with what it spent from its folder's spent.json. Without a readable
 * spent.json the counts are the kept review's own, marked about; a case with no review of its own spent nothing known.
 */
async function scoreFolder(dir: string, c: ReplayCase, o: Outcome, run: RunInfo): Promise<Scored> {
  const scored = scoreOutcome(c, o, run);
  const spent = await readSavedFile(join(dir, 'spent.json'), SpentSchema);
  if (typeof spent === 'string') {
    const ownReview = o.kind !== 'not-done' || o.doc !== null;
    return { ...scored, score: { ...scored.score, usageAbout: ownReview } };
  }
  const tokens = (entries: Spent[]): number => entries.reduce((n, e) => n + e.inputTokens + e.outputTokens, 0);
  return {
    ...scored,
    score: {
      ...scored.score,
      inputTokens: spent.reduce((n, e) => n + e.inputTokens, 0),
      outputTokens: spent.reduce((n, e) => n + e.outputTokens, 0),
      agentRuns: spent.reduce((n, e) => n + e.agentRuns, 0),
      unfinishedTokens: tokens(spent.filter((e) => e.step === 'review' && !e.finished)),
      judgeTokens: tokens(spent.filter((e) => e.step === 'judge')),
      usageAbout: false,
    },
  };
}

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
    ...(previous?.spans === undefined ? {} : { spans: previous.spans }),
  };
  await writeAtomic(path, json(merged));
  return { run: merged, cases };
}

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
  const finish = async (c: ReplayCase, o: Outcome, status: CaseEvent['status'], message?: string): Promise<Scored> => {
    const scored = await scoreFolder(join(runDir, c.id), c, o, scoring);
    emit({ caseId: c.id, status, ...(message === undefined ? {} : { message }), score: scored.score });
    return scored;
  };

  // The judge reads nothing from disk: it runs in an empty folder made for this run.
  const judgeDir = await mkdtemp(join(tmpdir(), 'airlock-replay-judge-'));

  // Set when a review or the judge reaches Claude's usage limit: no case starts after that, so none is spoiled.
  let limitReachedIn: string | null = null;
  const notStarted = new Set<string>();
  // An exit signal does the same and more: the reviews in flight are stopped through it, and no judge request follows.
  const exitSignal = (): boolean => deps.signal?.aborted === true;
  let stoppedBySignal = false;

  // This call's span: from the first case it works on to the last one's end.
  let firstStart: string | undefined;
  let lastEnd: string | undefined;
  const stamp = (): string => deps.now().toISOString();

  /**
   * Works on one case until it is done: reviews it unless a finished review of it is saved, then judges it. A review
   * that comes back incomplete is saved, in place of the old one, and not judged. A case stopped by an exit signal
   * keeps its folder as it was before this call, apart from a review that finished. Never throws.
   */
  const processCase = async (c: ReplayCase): Promise<Scored> => {
    const dir = join(runDir, c.id);
    let kept: ReviewDocument | null = null;
    let lead = 'The case folder could not be prepared';
    let started = false;
    let made = false;
    /** Leaves the folder as it was (a folder this call made is removed while it is empty) and scores what is there. */
    const stop = async (): Promise<Scored> => {
      stoppedBySignal = true;
      if (made) await rmdir(dir).catch(() => undefined);
      return await finish(c, await readOutcome(dir, c), 'stopped');
    };
    try {
      const saved = await readOutcome(dir, c);
      if (saved.kind === 'done') return await finish(c, saved, 'skipped');
      if (limitReachedIn !== null || exitSignal()) {
        notStarted.add(c.id);
        if (exitSignal()) stoppedBySignal = true;
        return await scoreFolder(dir, c, saved, scoring);
      }

      firstStart = earlier(firstStart, stamp());
      started = true;
      emit({ caseId: c.id, status: 'start', ...(saved.kind === 'not-judged' ? { message: 'judging the saved review again' } : {}) });
      made = (await mkdir(dir, { recursive: true })) !== undefined;

      if (saved.kind === 'not-judged') {
        kept = saved.doc;
      } else {
        lead = 'The review failed';
        const counted = counting(deps.runner);
        let doc: ReviewDocument;
        try {
          doc = ReviewDocumentSchema.parse(await review(reviewRequest(c, opts), { ...engineDeps, runner: counted.runner }));
        } catch (err) {
          // No document says what this attempt spent, so its requests do; an attempt that sent none spent nothing.
          if (counted.used.agentRuns > 0) await recordSpent(dir, { step: 'review', finished: false, ...counted.used }).catch(() => undefined);
          throw err;
        }
        lead = 'Saving the review failed';
        // What the folder says about an earlier review goes before the new review is saved, so it is never read with it.
        await rm(join(dir, 'matches.json'), { force: true });
        await rm(join(dir, 'error.txt'), { recursive: true, force: true });
        await writeAtomic(join(dir, 'review.json'), json(doc));
        await recordSpent(dir, { step: 'review', finished: doc.verdict.label !== 'incomplete', ...usageOf(doc) });
        emit({ caseId: c.id, status: 'reviewed' });
        if (hitUsageLimit(doc)) limitReachedIn ??= c.id;
        if (doc.verdict.label === 'incomplete') {
          const reason = didNotFinish(doc);
          return await finish(c, { kind: 'not-done', doc, reason }, 'failed', reason);
        }
        kept = doc;
      }

      if (exitSignal()) return await stop();
      lead = 'The judge failed';
      const judging = counting(deps.runner);
      let matches: Match[];
      try {
        matches = await judgeCase(judging.runner, c, kept, judgeModel, judgeDir, deps.signal);
      } finally {
        if (judging.used.agentRuns > 0) {
          await recordSpent(dir, { step: 'judge', finished: judging.lastOk(), ...judging.used }).catch(() => undefined);
        }
      }
      lead = 'Saving the matches failed';
      await writeAtomic(join(dir, 'matches.json'), json(matches));
      await rm(join(dir, 'error.txt'), { recursive: true, force: true });
      return await finish(c, { kind: 'done', doc: kept, matches }, 'judged');
    } catch (err) {
      if (exitSignal()) return await stop();
      if (err instanceof UsageLimitError) limitReachedIn ??= c.id;
      const error = failureText(lead, err);
      await writeAtomic(join(dir, 'error.txt'), `${error}\n`).catch(() => undefined);
      return await finish(c, kept ? { kind: 'not-judged', doc: kept, reason: error } : { kind: 'not-done', doc: null, reason: error }, 'failed', error);
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
      : readOutcome(join(runDir, c.id), c).then((o) => scoreFolder(join(runDir, c.id), c, o, scoring)))));
  } finally {
    await rm(judgeDir, { recursive: true, force: true }).catch(() => undefined);
  }
  const results = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    // Not expected: processCase and readOutcome do not throw. Still, one case never stops the others.
    const c = opened.cases[i]!;
    return scoreOutcome(c, { kind: 'not-done', doc: null, reason: failureText('The case failed', r.reason) }, scoring);
  });
  if (firstStart !== undefined) {
    run = { ...run, spans: [...(run.spans ?? []), { startedAt: firstStart, finishedAt: lastEnd ?? firstStart }] };
    await writeAtomic(join(runDir, 'run.json'), json(run));
  }
  const summary: RunSummary = {
    ...summarise(runId, run.model, run.depth, results.map((r) => r.score), opened.cases, opts.dataset ?? opts.cases, { spans: run.spans ?? [] }),
    ...(stoppedBySignal ? { stopped: { reason: 'exit-signal' } } : limitReachedIn === null ? {} : {
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
  const results = await Promise.all(selected.map(async (c) => {
    const dir = join(runDir, c.id);
    return scoreFolder(dir, c, await readOutcome(dir, c), scoring);
  }));
  const summary = summarise(run.runId, run.model, run.depth, results.map((r) => r.score), selected, cases, {
    spans: run.spans ?? [], madeByEarlierVersion: madeByEarlierVersion(run),
  });
  const details: RunDetails = Object.fromEntries(selected.map((c, i) => [c.id, results[i]!.detail]));
  return { summary, details };
}
