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
import { judgeCase } from './judge.js';
import type { Match } from './judge.js';
import { renderReport } from './report.js';
import { scoreCase, summarise } from './score.js';
import type { CaseScore, RunSummary } from './score.js';

export interface ReplayOptions {
  /** The cases to review, judge or resume in this call. */
  cases: ReplayCase[];
  /**
   * The whole dataset (default `cases`). A run folder resumed with a narrower selection keeps the cases an earlier call
   * selected: they are looked up here and scored from their folders, so the summary and report cover all of them.
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
}

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
}));

const RunFileSchema = z.object({
  runId: z.string(),
  model: z.string(),
  depth: DepthSchema,
  judgeModel: z.string(),
  kitSha: z.string(),
  caseIds: z.array(z.string()),
  startedAt: z.string(),
});
type RunFile = z.infer<typeof RunFileSchema>;

/** What happened to one case, from the run or read back from its folder. */
type Outcome =
  | { kind: 'judged'; doc: ReviewDocument; matches: Match[] }
  | { kind: 'judge-failed'; doc: ReviewDocument; error: string }
  | { kind: 'review-failed'; error: string };

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

/** Parses a JSON file with `schema`; null when the file is missing, is not JSON or does not match. */
async function readValid<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  const text = await readText(path);
  if (text === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** True when a saved review is of this case's pull request at its two commits. */
const reviewsCase = (doc: ReviewDocument, c: ReplayCase): boolean =>
  doc.pr.repo === c.repo && doc.pr.number === c.pr && doc.range.baseSha === c.baseSha && doc.range.headSha === c.headSha;

/**
 * The case folder's saved review and matches. The review counts only when it is of this case; the matches only with
 * that review and when they answer exactly the case's known problems.
 */
async function readSaved(dir: string, c: ReplayCase): Promise<{ doc: ReviewDocument | null; matches: Match[] | null }> {
  const saved = await readValid(join(dir, 'review.json'), ReviewDocumentSchema);
  const doc = saved !== null && reviewsCase(saved, c) ? saved : null;
  const matches = doc === null ? null : await readValid(join(dir, 'matches.json'), MatchesSchema);
  const answersCase = matches !== null && matches.length === c.known.length && matches.every((m, i) => m.knownId === c.known[i]!.id);
  return { doc, matches: answersCase ? matches : null };
}

/**
 * A valid document for a case whose review did not finish: verdict `incomplete`, no findings and one intake stage error.
 * Never saved; the run and `loadRun` both build it from the case and error.txt.
 */
function notFinishedDocument(c: ReplayCase, run: { model: string; depth: Depth; createdAt: string }, message: string): ReviewDocument {
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
    models: { main: run.model, challenger: run.model, sweep: run.model, effort: 'high' },
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
type RunInfo = { model: string; depth: Depth; createdAt: string };

/**
 * The score and report details of one case. A case that did not finish (its review or its judge failed) is scored
 * `incomplete` with every known problem not found and lost at no stage, since it was never judged:
 * - a review that did not finish is scored from the stand-in document;
 * - a review whose judge failed is scored as real but unjudged, and the report's copy of its document gains a `judge`
 *   stage error so the report says why.
 * Saved matches that cannot be scored against their review count as a failed judge.
 */
function scoreOutcome(c: ReplayCase, o: Outcome, run: RunInfo): Scored {
  switch (o.kind) {
    case 'judged':
      try {
        return { score: scoreCase(c, o.doc, o.matches), detail: { doc: o.doc, matches: o.matches } };
      } catch (err) {
        return scoreOutcome(c, { kind: 'judge-failed', doc: o.doc, error: failureText('The matches could not be scored', err) }, run);
      }
    case 'judge-failed': {
      const matches = notJudged(c, 'Not judged: the judge did not finish on this pull request.');
      const score: CaseScore = { ...scoreCase(c, o.doc, matches), verdict: 'incomplete', lostAt: { ...NOT_LOST } };
      const doc: ReviewDocument = { ...o.doc, stageErrors: [...o.doc.stageErrors, { stage: 'judge', cohortId: null, message: o.error }] };
      return { score, detail: { doc, matches } };
    }
    case 'review-failed': {
      const doc = notFinishedDocument(c, run, o.error);
      const matches = notJudged(c, 'Not judged: the review did not finish.');
      return { score: { ...scoreCase(c, doc, matches), lostAt: { ...NOT_LOST } }, detail: { doc, matches } };
    }
  }
}

function defaultRunId(now: Date, model: string, depth: Depth): string {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  return `${stamp}-${model}-${depth}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
}

const COMPARED = [['model', 'model'], ['depth', 'depth'], ['judgeModel', 'judge model'], ['kitSha', 'kit version']] as const;

/** The dataset's cases with these ids, in dataset order; throws for an id the dataset does not have. */
function inDatasetOrder(ids: Iterable<string>, dataset: ReplayCase[], runDir: string): ReplayCase[] {
  const wanted = new Set(ids);
  const known = new Set(dataset.map((c) => c.id));
  for (const id of wanted) if (!known.has(id)) throw new Error(`The run in ${runDir} has case ${id}, which is not in the dataset.`);
  return dataset.filter((c) => wanted.has(c.id));
}

/**
 * Creates the run folder and writes run.json, or checks an existing run.json against this run. Refuses a folder made
 * with another model, depth, judge model or kit version, and a folder with case folders but no run.json. A resumed run
 * keeps its start time and its cases: run.json lists the earlier cases and this call's, in dataset order.
 */
async function openRunFolder(runDir: string, run: RunFile, dataset: ReplayCase[]): Promise<{ run: RunFile; cases: ReplayCase[] }> {
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
    const prev = previous;
    const differences = COMPARED.filter(([key]) => prev[key] !== run[key]).map(([key, words]) => `${words} ${prev[key]}, not ${run[key]}`);
    if (differences.length > 0) {
      throw new Error(
        `The run folder ${runDir} was made with ${differences.join('; ')}. ` +
          'Mixing them in one run would make the numbers meaningless. Use another run id.',
      );
    }
  }
  const cases = inDatasetOrder([...(previous?.caseIds ?? []), ...run.caseIds], dataset, runDir);
  checkCases(cases);
  const merged: RunFile = { ...run, caseIds: cases.map((c) => c.id), startedAt: previous?.startedAt ?? run.startedAt };
  await writeAtomic(path, json(merged));
  return { run: merged, cases };
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
    models: { main: opts.model, challenger: opts.model, sweep: opts.model },
    explicit: { baseSha: c.baseSha, headSha: c.headSha },
    prText: { title: c.titleAtReview, body: c.bodyAtReview },
    holdout: { pr: c.pr, reviewedAt: c.reviewedAt },
    packsDir: opts.packsDir,
    kitDir: opts.kitDir,
    kitSha: opts.kitSha,
  };
}

/** What a case folder holds: judged, reviewed but not judged, or not reviewed (with error.txt's text when there is one). */
async function readOutcome(dir: string, c: ReplayCase): Promise<Outcome> {
  try {
    const saved = await readSaved(dir, c);
    if (saved.doc && saved.matches) return { kind: 'judged', doc: saved.doc, matches: saved.matches };
    const error = (await readText(join(dir, 'error.txt')))?.trim();
    if (saved.doc) return { kind: 'judge-failed', doc: saved.doc, error: error || 'The review was saved but not judged.' };
    if (error) return { kind: 'review-failed', error };
  } catch {
    // An unreadable case folder is a case with no usable outcome.
  }
  return { kind: 'review-failed', error: NOT_RUN };
}

const NOT_RUN = 'This case has not been run.';

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
    runId, model: opts.model, depth: opts.depth, judgeModel, kitSha: opts.kitSha,
    caseIds: opts.cases.map((c) => c.id), startedAt: now.toISOString(),
  }, opts.dataset ?? opts.cases);
  const { run } = opened;
  const scoring: RunInfo = { model: run.model, depth: run.depth, createdAt: run.startedAt };

  const review = deps.review ?? runReview;
  const engineDeps: EngineDeps = { exec: deps.exec, runner: deps.runner, now: deps.now };
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

  /** Reviews (unless a saved review is reused) and judges one case. Never throws. */
  const processCase = async (c: ReplayCase): Promise<Scored> => {
    const dir = join(runDir, c.id);
    let kept: ReviewDocument | null = null;
    let lead = 'The review failed';
    try {
      const saved = await readSaved(dir, c);
      if (saved.doc && saved.matches) return finish(c, { kind: 'judged', doc: saved.doc, matches: saved.matches }, 'skipped');

      emit({ caseId: c.id, status: 'start', ...(saved.doc ? { message: 'judging the saved review again' } : {}) });
      await mkdir(dir, { recursive: true });
      await rm(join(dir, 'error.txt'), { force: true });
      await rm(join(dir, 'matches.json'), { force: true });

      if (saved.doc) {
        kept = saved.doc;
      } else {
        await rm(join(dir, 'review.json'), { force: true });
        const doc = ReviewDocumentSchema.parse(await review(reviewRequest(c, opts), engineDeps));
        lead = 'Saving the review failed';
        await writeAtomic(join(dir, 'review.json'), json(doc));
        kept = doc;
        emit({ caseId: c.id, status: 'reviewed' });
      }

      lead = 'The judge failed';
      const matches = await judgeCase(deps.runner, c, kept, judgeModel, judgeDir);
      lead = 'Saving the matches failed';
      await writeAtomic(join(dir, 'matches.json'), json(matches));
      return finish(c, { kind: 'judged', doc: kept, matches }, 'judged');
    } catch (err) {
      const error = failureText(lead, err);
      await writeAtomic(join(dir, 'error.txt'), `${error}\n`).catch(() => undefined);
      return finish(c, kept ? { kind: 'judge-failed', doc: kept, error } : { kind: 'review-failed', error }, 'failed', error);
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
    return scoreOutcome(c, { kind: 'review-failed', error: failureText('The case failed', r.reason) }, scoring);
  });
  const summary = summarise(runId, run.model, run.depth, results.map((r) => r.score), opened.cases);
  const details: RunDetails = Object.fromEntries(opened.cases.map((c, i) => [c.id, results[i]!.detail]));
  await saveRunReport(runDir, summary, opened.cases, details);
  return summary;
}

/** Rebuilds the summary and the report details of a finished or part-finished run from its folder. */
export async function loadRun(runDir: string, cases: ReplayCase[]): Promise<{ summary: RunSummary; details: RunDetails }> {
  const text = await readText(join(runDir, 'run.json'));
  if (text === null) throw new Error(`${runDir} is not a replay run folder: it has no run.json.`);
  let run: RunFile;
  try {
    run = RunFileSchema.parse(JSON.parse(text));
  } catch {
    throw new Error(`${join(runDir, 'run.json')} cannot be read.`);
  }
  const byId = new Map(cases.map((c) => [c.id, c]));
  const selected = run.caseIds.map((id) => {
    const c = byId.get(id);
    if (!c) throw new Error(`The run in ${runDir} has case ${id}, which is not in the dataset.`);
    return c;
  });
  checkCases(selected);
  const scoring: RunInfo = { model: run.model, depth: run.depth, createdAt: run.startedAt };
  const results = await Promise.all(selected.map(async (c) => scoreOutcome(c, await readOutcome(join(runDir, c.id), c), scoring)));
  const summary = summarise(run.runId, run.model, run.depth, results.map((r) => r.score), selected);
  const details: RunDetails = Object.fromEntries(selected.map((c, i) => [c.id, results[i]!.detail]));
  return { summary, details };
}
