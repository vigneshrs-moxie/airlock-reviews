import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ReviewDocumentSchema } from '@airlock/shared';
import type {
  Brief, Candidate, ChangeMap, Depth, Dropped, Fact, FileDiff, FileFact, Finding, Link, ModelConfig, Neighbour, PrInfo,
  Question, ReviewDocument, ReviewEvent, ReviewRange, StageError,
} from '@airlock/shared';
import { UNKNOWN_USAGE } from '../agent/runner.js';
import type { AgentRequest, AgentResult, AgentRunner } from '../agent/runner.js';
import { anchorCandidates } from '../anchor/anchor.js';
import { fingerprint } from '../anchor/fingerprint.js';
import { buildBrief } from '../brief/brief.js';
import { challenge, type KeptCandidate } from '../challenge/challenge.js';
import type { ReadFile } from '../challenge/proof.js';
import { linkFacts, loadDiff, recheckBinary } from '../diff/parse.js';
import { runChecks } from '../facts/checks.js';
import { classifyFiles } from '../facts/classify.js';
import { fetchPr } from '../intake/pr.js';
import { prepareWorkspace, type Workspace } from '../intake/workspace.js';
import { runCohortLenses } from '../lenses/cohort-lens.js';
import {
  descriptionCutSentence, emptyResult, MAX_DESCRIPTION_CHARS, type LensContext, type LensStageResult,
} from '../lenses/context.js';
import { runSeams } from '../lenses/seams.js';
import { placeablePaths } from '../map/check.js';
import { findLinks } from '../map/links.js';
import { fallbackMap, buildChangeMap } from '../map/mapper.js';
import { findNeighbours } from '../map/neighbours.js';
import { mergeSameProblems, withMergedCount, type AnchoredCandidate } from '../merge/merge.js';
import type { Holdout, Pack } from '../packs/types.js';
import { runSweep } from '../rules/sweep.js';
import { decideVerdict, sameTextOnce, select, selfReviewText, type SelectResult } from '../select/select.js';
import { isSyncMerge } from '../shape/detect.js';
import { saveReview } from '../store/store.js';
import type { Exec } from '../util/exec.js';
import { limiter } from '../util/limit.js';
import { safeRead } from '../util/safe-read.js';
import { deepPass } from './deep.js';
import { choosePacks, ENGINE_SOURCE, preparePacks, stageRulesOf, type PreparedPacks } from './packs.js';
import { createStageLog, messageOf, type StageLog, type StageName } from './stages.js';

export interface ReviewRequest {
  repo: string;
  number: number;
  depth?: Depth;
  packIds?: string[];
  models?: Partial<ModelConfig>;
  explicit?: { baseSha: string; headSha: string };
  /** The pull request's title and description as they were when it was reviewed, in place of today's (the replay). */
  prText?: { title: string; body: string };
  holdout?: Holdout;
  /**
   * At standard and deep depth, whether a group's lenses may share one combined request: `no-read-tier` combines them for
   * a group with no file in the read tier and for the standalone group. Default `never`. Quick depth always combines.
   */
  combine?: 'never' | 'no-read-tier';
  packsDir: string;
  remoteUrl?: string;
  parallel?: number;
  /** Read the team kit from this folder instead of GitHub (tests and the replay). */
  kitDir?: string;
  /** The kit's version when `kitDir` is given; `pinned` otherwise. */
  kitSha?: string;
}

export interface EngineDeps {
  exec: Exec;
  runner: AgentRunner;
  now: () => Date;
  /** Stops the review: every command and request is given it, and an aborted review rejects with REVIEW_STOPPED. */
  signal?: AbortSignal;
}

/** One part of `<owner>/<name>`: letters, digits, `_`, `.` and `-`, and not only dots. */
const REPO_PART = /^(?!\.+$)[A-Za-z0-9_.-]+$/;

/** The repository and number go into a `gh api` path and a clone address, so they are checked before anything runs. */
function checkRequest(req: ReviewRequest): void {
  const parts = typeof req.repo === 'string' ? req.repo.split('/') : [];
  if (parts.length !== 2 || !parts.every((p) => REPO_PART.test(p))) {
    throw new Error(`The repository must be written as <owner>/<name>, got ${JSON.stringify(req.repo)}.`);
  }
  if (!Number.isSafeInteger(req.number) || req.number < 1) {
    throw new Error(`The pull request number must be a whole number of at least 1, got ${String(req.number)}.`);
  }
}

/** What runReview rejects with when its signal was aborted; the workspace has been disposed by then. */
export const REVIEW_STOPPED = 'The review was stopped.';

/** A runner that stops sending requests after the first usage-limit failure, and says why. */
interface UsageGate extends AgentRunner {
  /** The usage-limit message once a request has hit the limit, else null. */
  stoppedBy(): string | null;
}

/**
 * Wraps the runner for one review: each request carries the review's signal, and once any request fails on the usage
 * limit no further request is sent; each later one fails at once with the same message and kind.
 */
function usageGate(inner: AgentRunner, signal: AbortSignal | undefined): UsageGate {
  let stopped: string | null = null;
  return {
    stoppedBy: () => stopped,
    async run<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
      if (stopped !== null) return { ok: false, error: stopped, kind: 'usage-limit', usage: { ...UNKNOWN_USAGE } };
      const result = await inner.run(signal === undefined ? req : { ...req, signal });
      if (!result.ok && result.kind === 'usage-limit' && stopped === null) stopped = result.error;
      return result;
    },
  };
}

const DEFAULT_MODELS: ModelConfig = { main: 'claude-opus-5-5', challenger: 'claude-opus-5-5', sweep: 'claude-opus-5-5', effort: 'high' };
const DEFAULT_PARALLEL = 4;
const QUICK_CHECKED = 'not challenged (quick review)';
const CHALLENGE_FAILED = 'challenge did not complete';
const SYNC_MERGE_BRIEF: Brief = {
  whatItDoes: ['This branch only merges its target branch into itself, so only conflict resolutions need review.'], claims: [],
};
const EMPTY_SYNC_MERGE_BRIEF: Brief = {
  whatItDoes: ['This branch only merges its target branch into itself and changes no files.'], claims: [],
};
const EMPTY_BRIEF: Brief = { whatItDoes: [], claims: [] };
const EMPTY_MAP: ChangeMap = { cohorts: [], standalone: [], links: [] };
const NO_PACKS: PreparedPacks = { packs: [], missingHelpers: [], repoRules: [], questions: [], errors: [], limits: [] };
const CREDENTIAL_TROUBLE = /could not read (Username|Password)|Authentication failed|terminal prompts disabled|Permission denied \(publickey\)|Repository not found|returned error: 40[13]/i;

const hexId = (prefix: string, bytes: number): string => `${prefix}${randomBytes(bytes).toString('hex')}`;
const question = (text: string): Question => ({ text, cohortId: null, source: ENGINE_SOURCE });

/** Gives a fresh `c_` id to every candidate whose id is already in `used` or repeats an earlier one; `used` gains every id. */
export function withUniqueIds(candidates: Candidate[], used: Set<string>): Candidate[] {
  return candidates.map((c) => {
    if (!used.has(c.id)) { used.add(c.id); return c; }
    let id: string;
    do id = hexId('c_', 4); while (used.has(id));
    used.add(id);
    return { ...c, id };
  });
}

/** Prepares the workspace; a clone or fetch refused for lack of credentials says how to fix it. */
async function openWorkspace(exec: Exec, req: ReviewRequest, pr: PrInfo, reviewId: string): Promise<Workspace> {
  try {
    return await prepareWorkspace(exec, {
      repo: req.repo, remoteUrl: req.remoteUrl ?? `https://github.com/${req.repo}.git`, reviewId,
      ...(req.explicit ? { explicit: req.explicit } : {
        pr: { number: req.number, baseRef: pr.baseRef, headSha: pr.headSha, baseSha: pr.baseSha, ...(pr.merged === undefined ? {} : { merged: pr.merged }) },
      }),
    });
  } catch (err) {
    if (!CREDENTIAL_TROUBLE.test(messageOf(err))) throw err;
    throw new Error(`${messageOf(err).trim()}\nGit may not be signed in to GitHub. Run "gh auth setup-git" so git uses your GitHub CLI sign-in, then try again.`);
  }
}

/** Runs a lens-like stage and records its usage and errors. */
function lensStage(log: StageLog, stage: StageName, fn: () => Promise<LensStageResult>): Promise<LensStageResult> {
  return log.run(stage, async (rec) => {
    const r = await fn();
    rec.usage(r.usage);
    rec.error(...r.errors);
    return r;
  }).then((r) => r ?? emptyResult());
}

/**
 * Findings when the select stage itself threw: every kept item under also found, the questions with the same text reduced
 * to one, and a verdict from the errors.
 */
function fallbackSelection(
  pr: PrInfo, depth: Depth, packs: Pack[], kept: KeptCandidate[], questions: Question[], log: StageLog,
): SelectResult {
  const findings: Finding[] = kept.map((k) => ({ ...k, fingerprint: fingerprint(k), bucket: 'also', rank: null, status: null }));
  const left = sameTextOnce(questions);
  const verdict = decideVerdict(pr, findings, log.errors, false, left.length);
  return {
    findings, dropped: [], questions: left, verdict, whoseCall: [], checksAfterMerge: [],
    selfReviewText: selfReviewText(pr, depth, packs.map((p) => p.title), verdict), notes: [], limits: [], errors: [], usage: [],
  };
}

/** The stage error that keeps a sync merge from being reported as reviewed. */
const unreviewedMerge = (changed: number): string =>
  `This pull request only merges another branch in. Airlock did not review it: ${changed === 1 ? '1 changed file was' : `${changed} changed files were`} not looked at.`;

/**
 * For a live pull request (no explicit range): when the diff has no files but GitHub lists changed files, the sentence for
 * a stage error, since nothing was reviewed; otherwise null.
 */
function emptyDiff(files: FileDiff[], pr: PrInfo, explicit: boolean): string | null {
  if (explicit || files.length > 0 || pr.changedFiles <= 0) return null;
  const listed = pr.changedFiles === 1 ? '1 changed file' : `${pr.changedFiles} changed files`;
  return `GitHub lists ${listed} for this pull request, but the diff Airlock computed is empty. Nothing was reviewed.`;
}

/** Most paths named in the stage error for a pull request none of whose changed files could be reviewed. */
const MAX_UNREVIEWED_NAMED = 5;

/**
 * Nothing looked at is never clean: when the pull request changes files and every one of them is ignored, the sentence
 * for a stage error naming them; otherwise null.
 */
function notReviewed(files: FileDiff[], tiers: FileFact[]): string | null {
  if (files.length === 0 || placeablePaths(files, tiers).length > 0) return null;
  const named = files.slice(0, MAX_UNREVIEWED_NAMED).map((f) => f.path).join(', ');
  const more = files.length > MAX_UNREVIEWED_NAMED ? '…' : '';
  return `${files.length === 1 ? '1 changed file was' : `${files.length} changed files were`} not reviewed: ${named}${more}`;
}

interface Settings { depth: Depth; models: ModelConfig; parallel: number; combine: 'never' | 'no-read-tier' }

interface Reviewed {
  range: ReviewRange; packs: Pack[]; tiers: FileFact[]; facts: Fact[]; map: ChangeMap; brief: Brief; questions: Question[];
  candidates: Candidate[]; dropped: Dropped[]; selection: SelectResult; limits: string[]; notes: string[];
}

/** Every stage from packs to select, inside the workspace. */
async function reviewInWorkspace(
  req: ReviewRequest, deps: EngineDeps & { gate: UsageGate }, log: StageLog, settings: Settings, pr: PrInfo, ws: Workspace,
  files: FileDiff[], diffFacts: Fact[], chosen: { packs: Pack[]; errors: StageError[]; ms: number },
): Promise<Reviewed> {
  const { exec, runner } = deps;
  /** After the usage limit, a stage that needs a model records once why it did not run, and is skipped. */
  const limitedOut = async (stage: StageName): Promise<boolean> => {
    const why = deps.gate.stoppedBy();
    if (why === null) return false;
    await log.run(stage, async (rec) => rec.error({ stage, cohortId: null, message: `${why}. This stage was not run.`, kind: 'usage-limit' }));
    return true;
  };
  const { depth, models } = settings;
  const run = limiter(settings.parallel);
  const capped: AgentRunner = { run: <T>(r: AgentRequest<T>) => run(() => runner.run(r)) };
  const readHead = (path: string): Promise<string | null> => safeRead(ws.headDir, path);
  const readBoth: ReadFile = (where, path) => safeRead(where === 'head' ? ws.headDir : ws.baseDir, path);
  // The stages' questions go through selection, which merges repeats; the engine's own are added after it, unmerged.
  const questions: Question[] = [];
  const engineQuestions: Question[] = [];
  // What a model was not shown because of a size limit, as plain sentences, in the order the stages ran.
  const limits: string[] = [];

  const prepared = (await log.run('packs', async (rec) => {
    rec.error(...chosen.errors);
    const p = await preparePacks(chosen.packs, {
      exec, kitDir: req.kitDir, kitSha: req.kitSha, holdout: req.holdout, baseDir: ws.baseDir, changedPaths: files.map((f) => f.path),
    });
    rec.error(...p.errors);
    return p;
  }, { extraMs: chosen.ms })) ?? NO_PACKS;
  const { packs } = prepared;
  engineQuestions.push(...prepared.questions);
  limits.push(...prepared.limits);

  const sync = (await log.run('shape', async (rec) => {
    const merged = await isSyncMerge(exec, ws.headDir, ws.range, null);
    // A merge that changes no files leaves nothing unreviewed.
    if (merged && files.length > 0) rec.error({ stage: 'shape', cohortId: null, message: unreviewedMerge(files.length) });
    return merged;
  })) ?? false;
  const range: ReviewRange = sync ? { ...ws.range, kind: 'sync-merge' } : ws.range;

  const gathered = (await log.run('facts', async (rec) => {
    const tiers = await rec.attempt(() => classifyFiles(files, packs), [] as FileFact[]);
    const unreviewed = notReviewed(files, tiers) ?? emptyDiff(files, pr, req.explicit !== undefined);
    if (unreviewed !== null) rec.error({ stage: 'facts', cohortId: null, message: unreviewed });
    const facts = [...diffFacts, ...await rec.attempt(() => runChecks(files, packs, readHead), [] as Fact[])];
    const found = await rec.attempt(
      () => findLinks(exec, ws.headDir, files, packs), { links: [] as Link[], skippedNames: 0, limits: [] as string[] },
    );
    const neighbours = await rec.attempt(() => findNeighbours(exec, ws.headDir, files, found.links, packs), [] as Neighbour[]);
    return { tiers, facts, links: found.links, neighbours, skippedNames: found.skippedNames, limits: found.limits };
  })) ?? { tiers: [], facts: [], links: [], neighbours: [], skippedNames: 0, limits: [] };
  const { tiers, facts } = gathered;
  limits.push(...gathered.limits);
  if (gathered.skippedNames > 0) {
    engineQuestions.push(question(`${gathered.skippedNames} changed names were not searched for callers because the pull request is very large.`));
  }

  const skipWhy = sync ? 'sync merge' : 'quick depth';
  let map = EMPTY_MAP;
  let brief = EMPTY_BRIEF;
  if (sync) {
    log.skip('map', skipWhy);
    log.emit({ type: 'map', map }); // empty, so a listener waiting for the map is not left hanging
    log.skip('brief', skipWhy);
    // A merge with no files is one that changes nothing only when GitHub agrees (or the range was given explicitly).
    const nothingChanged = files.length === 0 && emptyDiff(files, pr, req.explicit !== undefined) === null;
    brief = nothingChanged ? EMPTY_SYNC_MERGE_BRIEF : files.length === 0 ? EMPTY_BRIEF : SYNC_MERGE_BRIEF;
  } else {
    map = ((await limitedOut('map')) ? undefined : await log.run('map', async (rec) => {
      const r = await buildChangeMap(capped, {
        pr, files, facts: tiers, links: gathered.links, neighbours: gathered.neighbours, headDir: ws.headDir,
        model: models.main, effort: models.effort,
      });
      rec.usage(r.usage);
      limits.push(...r.limits);
      if (r.error !== null) rec.error({ stage: 'map', cohortId: null, message: r.error, ...(r.errorKind ? { kind: r.errorKind } : {}) });
      return r.map;
    })) ?? fallbackMap(files, tiers, gathered.links);
    log.emit({ type: 'map', map });
    brief = ((await limitedOut('brief')) ? undefined : await log.run('brief', async (rec) => {
      const r = await buildBrief(capped, { pr, map, files, headDir: ws.headDir, baseDir: ws.baseDir, model: models.main, effort: models.effort });
      rec.usage(r.usage);
      limits.push(...r.limits);
      if (r.error !== null) rec.error({ stage: 'brief', cohortId: null, message: r.error, ...(r.errorKind ? { kind: r.errorKind } : {}) });
      return r.brief;
    })) ?? EMPTY_BRIEF;
  }
  log.emit({ type: 'brief', brief });

  const ctx: LensContext = {
    pr, map, files, tiers, facts, brief, packs, repoRules: prepared.repoRules, missingHelpers: prepared.missingHelpers,
    headDir: ws.headDir, baseDir: ws.baseDir, models, run,
  };
  const quick = depth === 'quick';
  // Quick depth is one combined lens request per group; the other depths combine only when the request says so.
  const lensCombine: Pick<LensContext, 'combine'> = quick ? { combine: 'all' }
    : settings.combine === 'no-read-tier' ? { combine: 'no-read-tier' } : {};
  let lensR = emptyResult();
  let sweepR = emptyResult();
  let seamsR = emptyResult();
  if (sync) {
    for (const stage of ['lenses', 'sweep', 'seams'] as const) log.skip(stage, skipWhy);
  } else {
    // Lenses and sweep run side by side; both go through the same parallel cap.
    // Checked without waiting, so the two stages start in the same order as always.
    const limited = (): boolean => deps.gate.stoppedBy() !== null;
    const lenses = (): Promise<LensStageResult> => (limited() ? limitedOut('lenses').then(emptyResult)
      : lensStage(log, 'lenses', () => runCohortLenses(runner, { ...ctx, ...lensCombine })));
    const sweep = (): Promise<LensStageResult> => (limited() ? limitedOut('sweep').then(emptyResult)
      : lensStage(log, 'sweep', () => runSweep(runner, ctx)));
    [lensR, sweepR] = await Promise.all([lenses(), quick ? (log.skip('sweep', skipWhy), emptyResult()) : sweep()]);
    if (quick) log.skip('seams', skipWhy);
    else if (!(await limitedOut('seams'))) {
      seamsR = await lensStage(log, 'seams', () => runSeams(runner, ctx, [...lensR.candidates, ...sweepR.candidates]));
    }
    // Every request from the lenses on carries the description through prBlock, cut at the same length.
    const cut = descriptionCutSentence('lenses and the stages after them', pr.body, MAX_DESCRIPTION_CHARS);
    if (cut !== null) limits.push(cut);
  }
  limits.push(...lensR.limits, ...sweepR.limits, ...seamsR.limits);
  questions.push(...lensR.questions, ...sweepR.questions, ...seamsR.questions);
  const usedIds = new Set<string>();
  const candidates = withUniqueIds([...lensR.candidates, ...sweepR.candidates, ...seamsR.candidates], usedIds);
  const schemaDropped = [...lensR.dropped, ...sweepR.dropped, ...seamsR.dropped];

  let anchored: AnchoredCandidate[] = [];
  const anchorDropped: Dropped[] = [];
  if (sync) log.skip('anchor', skipWhy);
  else {
    const r = await log.run('anchor', () => anchorCandidates(candidates, files, readHead));
    anchored = r?.anchored ?? [];
    anchorDropped.push(...(r?.dropped ?? []));
  }

  // Code proposes clusters at the same place and the model says which are the same problem; only then are they merged,
  // before the challenge, so each problem is challenged once.
  const mergeDropped: Dropped[] = [];
  const mergeNotes: string[] = [];
  if (sync || quick) log.skip('merge', skipWhy);
  else if (!(await limitedOut('merge'))) {
    const r = await log.run('merge', async (rec) => {
      const out = await mergeSameProblems(runner, ctx, anchored);
      rec.usage(out.usage);
      rec.error(...out.errors);
      return out;
    });
    if (r !== undefined) {
      anchored = r.items;
      mergeDropped.push(...r.dropped);
      mergeNotes.push(...r.notes);
    }
  }

  let kept: KeptCandidate[];
  const challengeDropped: Dropped[] = [];
  if (sync || quick) {
    log.skip('challenge', skipWhy);
    kept = anchored.map((c) => ({ ...c, checked: QUICK_CHECKED }));
  } else if (await limitedOut('challenge')) {
    kept = anchored.map((c) => ({ ...c, checked: CHALLENGE_FAILED }));
  } else {
    const r = await log.run('challenge', async (rec) => {
      const out = await challenge(runner, ctx, anchored, readBoth);
      rec.usage(out.usage);
      rec.error(...out.errors);
      limits.push(...out.limits);
      return out;
    });
    kept = r?.kept ?? anchored.map((c) => ({ ...c, checked: CHALLENGE_FAILED }));
    challengeDropped.push(...withMergedCount(r?.dropped ?? [], mergeDropped));
  }

  if (depth === 'deep' && !sync && !(await limitedOut('lenses-deep'))) {
    const known = [...kept, ...[...schemaDropped, ...anchorDropped, ...mergeDropped, ...challengeDropped].map((d) => d.candidate)];
    await log.run('lenses-deep', (rec) => deepPass(rec, {
      runner, ctx, seen: new Set(known.map(fingerprint)), uniqueIds: (c) => withUniqueIds(c, usedIds), readHead, readBoth,
    }, { candidates, questions, schemaDropped, anchorDropped, challengeDropped, kept, limits }));
  }

  // Select always runs, so the document has a verdict; it is told every error so far. On a sync merge it asks no model,
  // and after the usage limit it is replaced by the fallback, which asks none either.
  const selection = ((await limitedOut('select')) ? undefined : await log.run('select', async (rec) => {
    const r = await select(runner, ctx, kept, questions, [...log.errors], depth, sync);
    rec.usage(r.usage);
    rec.error(...r.errors);
    return r;
  })) ?? fallbackSelection(pr, depth, packs, kept, questions, log);

  limits.push(...selection.limits);
  return {
    range, packs, tiers, facts, map, brief, questions: [...selection.questions, ...engineQuestions], candidates, selection,
    dropped: [...schemaDropped, ...anchorDropped, ...mergeDropped, ...challengeDropped, ...selection.dropped], limits,
    notes: [...mergeNotes, ...selection.notes],
  };
}

/**
 * Reviews one pull request: every stage in order, then the document is checked against the schema, saved and returned.
 * A stage that fails becomes a stage error and the verdict `incomplete`; only a pull request that cannot be fetched or a
 * workspace that cannot be prepared rejects. The workspace is always disposed.
 */
export async function runReview(req: ReviewRequest, deps: EngineDeps, onEvent?: (e: ReviewEvent) => void): Promise<ReviewDocument> {
  checkRequest(req);
  const { signal } = deps;
  if (signal?.aborted) throw new Error(REVIEW_STOPPED);
  try {
    return await reviewOnce(req, deps, onEvent);
  } catch (err) {
    if (signal?.aborted) throw new Error(REVIEW_STOPPED);
    throw err;
  }
}

async function reviewOnce(req: ReviewRequest, given: EngineDeps, onEvent?: (e: ReviewEvent) => void): Promise<ReviewDocument> {
  const parallel = req.parallel ?? DEFAULT_PARALLEL;
  if (!Number.isInteger(parallel) || parallel < 1) throw new RangeError(`parallel must be a whole number of at least 1, got ${parallel}`);
  const models = Object.fromEntries(Object.entries(req.models ?? {}).filter(([, v]) => v !== undefined)) as Partial<ModelConfig>;
  const settings: Settings = {
    depth: req.depth ?? 'standard', models: { ...DEFAULT_MODELS, ...models }, parallel, combine: req.combine ?? 'never',
  };
  const id = hexId('r_', 5);
  const startedAt = given.now().toISOString();
  const { signal } = given;
  const log = createStageLog(onEvent, signal, given.now);
  // Every command and every request carries the review's signal; every request goes through the usage gate.
  const exec: Exec = signal === undefined ? given.exec : (cmd, args, opts) => given.exec(cmd, args, { signal, ...opts });
  const gate = usageGate(given.runner, signal);
  const deps: EngineDeps & { gate: UsageGate } = { ...given, exec, runner: gate, gate };

  // Packs are chosen first because their stage rules are needed to fetch the pull request; the time counts under packs.
  const choiceStarted = performance.now();
  const chosen = await choosePacks(req.packsDir, req.repo, req.packIds);
  const choiceMs = performance.now() - choiceStarted;

  // Kept outside the stage so a workspace opened just before a stop is still disposed.
  let opened: Workspace | undefined;
  let intake: { pr: PrInfo; ws: Workspace; files: FileDiff[]; diffFacts: Fact[] };
  let reviewed: Reviewed;
  try {
    intake = (await log.run('intake', async (rec) => {
      const live = await fetchPr(exec, req.repo, req.number, stageRulesOf(chosen.packs));
      // The title and description as they were when the pull request was reviewed, when given, replace today's everywhere.
      const fetched = req.prText ? { ...live, title: req.prText.title, body: req.prText.body } : live;
      const ws = await openWorkspace(exec, req, fetched, id);
      opened = ws;
      const pr = req.explicit ? { ...fetched, baseSha: ws.range.baseSha, headSha: ws.range.headSha } : fetched;
      const loaded = await rec.attempt(async () => recheckBinary(
        await loadDiff(exec, ws.gitDir, ws.range),
        (path, bytes) => safeRead(ws.headDir, path, { firstBytes: bytes }),
      ), { files: [] as FileDiff[], facts: [] as Fact[] });
      return { pr, ws, files: loaded.files, diffFacts: [...loaded.facts, ...linkFacts(loaded.files)] };
    }, { rethrow: true }))!;
    reviewed = await reviewInWorkspace(
      req, deps, log, settings, intake.pr, intake.ws, intake.files, intake.diffFacts, { ...chosen, ms: choiceMs },
    );
  } finally {
    await (opened as Workspace | undefined)?.dispose().catch(() => undefined);
  }

  const { selection } = reviewed;
  // `createdAt` is when the document is assembled, at the end; `startedAt` is when the review began.
  const draft = (): ReviewDocument => ({
    schemaVersion: 1, id, createdAt: given.now().toISOString(), startedAt, pr: intake.pr, range: reviewed.range, depth: settings.depth,
    packs: reviewed.packs.map((p) => ({ id: p.id, version: p.version })), models: settings.models,
    files: reviewed.tiers, facts: reviewed.facts, map: reviewed.map, brief: reviewed.brief, verdict: selection.verdict,
    findings: selection.findings, questions: reviewed.questions, dropped: reviewed.dropped, candidates: reviewed.candidates,
    whoseCall: selection.whoseCall, checksAfterMerge: selection.checksAfterMerge, selfReviewText: selection.selfReviewText,
    stageErrors: [...log.errors], timings: log.timings(), limits: reviewed.limits, notes: reviewed.notes,
  });
  // A draft that fails the schema is the engine's own fault, so it rejects rather than becoming a stage error.
  const engineFault: { error: Error | null } = { error: null };
  const checked = (doc: ReviewDocument): ReviewDocument => {
    const parsed = ReviewDocumentSchema.safeParse(doc);
    if (parsed.success) return parsed.data;
    engineFault.error = new Error(`Airlock built a review document that does not match its own schema: ${parsed.error.message}`);
    throw engineFault.error;
  };
  // The store stage's own timing is its time up to the write, since the saved document carries it.
  let document = await log.run('store', async () => {
    const doc = checked(draft());
    await saveReview(doc);
    return doc;
  });
  if (engineFault.error) throw engineFault.error;
  if (document === undefined) {
    // Not saved: the review is returned, but never as a complete one, and its self-review text says so.
    const doc = draft();
    const verdict = decideVerdict(doc.pr, doc.findings, doc.stageErrors, false, selection.questions.length);
    const text = selfReviewText(doc.pr, doc.depth, reviewed.packs.map((p) => p.title), verdict);
    document = checked({ ...doc, verdict, selfReviewText: text });
  }
  log.emit({ type: 'done', document });
  return document;
}
