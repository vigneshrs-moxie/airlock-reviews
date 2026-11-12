import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
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
import { binarySourcePaths, binarySourceSentence, classifyFiles } from '../facts/classify.js';
import { fetchPr } from '../intake/pr.js';
import { prepareWorkspace, type Workspace } from '../intake/workspace.js';
import { runCohortLenses } from '../lenses/cohort-lens.js';
import {
  descriptionCutSentence, emptyResult, MAX_DESCRIPTION_CHARS, tierOf, type LensContext, type LensStageResult,
} from '../lenses/context.js';
import { runSeams } from '../lenses/seams.js';
import { placeablePaths } from '../map/check.js';
import { findLinks } from '../map/links.js';
import { fallbackMap, buildChangeMap } from '../map/mapper.js';
import { findNeighbours } from '../map/neighbours.js';
import { mergeSameProblems, withMergedCount, type AnchoredCandidate } from '../merge/merge.js';
import type { Holdout, Pack } from '../packs/types.js';
import { carryOver, mergeIntoCarried, unaccounted } from '../rereview/carry.js';
import { confirmFixed, fixedByCode, leftOpen, needsCheck, type FixedCheckResult } from '../rereview/fixed.js';
import type { RereviewPlan } from '../rereview/range.js';
import { runSweep } from '../rules/sweep.js';
import { decideVerdict, sameTextOnce, select, selfReviewText, type RereviewText, type SelectResult } from '../select/select.js';
import { mergeNote, mergeNoteBlock, settledSentence, type MergeScope } from '../shape/merge-range.js';
import { reviewById, saveReview } from '../store/store.js';
import type { Exec } from '../util/exec.js';
import { limiter } from '../util/limit.js';
import { presentAt, safeRead } from '../util/safe-read.js';
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
  /** Read the first selected kit pack's kit from this folder instead of GitHub (tests and the replay); others are synced. */
  kitDir?: string;
  /** The kit's version when `kitDir` is given; `pinned` otherwise. */
  kitSha?: string;
  /**
   * Review again after the stored review `reviewId` of this pull request: only what was pushed since, when it can be
   * reviewed alone, and what became of each earlier finding. Not with `explicit`.
   */
  since?: { reviewId: string };
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
/** The brief of a merge git made without conflicts and nothing changed by hand; a given range names no branch. */
function cleanMergeBrief(scope: MergeScope, base: string): Brief {
  const what = scope === 'given range' ? 'This range is only a merge.'
    : `${scope === 'push' ? 'This push' : 'This pull request'} only merges ${base} into the branch.`;
  return { whatItDoes: [`${what} Git merged it without conflicts and nothing was changed by hand.`], claims: [] };
}
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

/** What a re-review fails with when the pull request's head is the earlier review's head. */
export const NOTHING_PUSHED = 'Nothing was pushed since the last review.';

/** The stored review a re-review continues: one of this repository and number, or the review fails before any model call. */
async function earlierReview(req: ReviewRequest, reviewId: string): Promise<ReviewDocument> {
  if (req.explicit !== undefined) throw new Error('A re-review covers what was pushed since the last review, so it cannot be given a range.');
  const doc = await reviewById(req.repo, req.number, reviewId);
  if (doc === null || doc.pr.repo !== req.repo || doc.pr.number !== req.number) {
    throw new Error(`There is no stored review ${reviewId} of this pull request.`);
  }
  return doc;
}

/** Prepares the workspace; a clone or fetch refused for lack of credentials says how to fix it. */
async function openWorkspace(exec: Exec, req: ReviewRequest, pr: PrInfo, reviewId: string, previous: ReviewDocument | null): Promise<Workspace> {
  try {
    return await prepareWorkspace(exec, {
      repo: req.repo, remoteUrl: req.remoteUrl ?? `https://github.com/${req.repo}.git`, reviewId,
      ...(req.explicit ? { explicit: req.explicit } : {
        pr: { number: req.number, baseRef: pr.baseRef, headSha: pr.headSha, baseSha: pr.baseSha, ...(pr.merged === undefined ? {} : { merged: pr.merged }) },
        ...(previous === null ? {} : { rereview: { previous, pr } }),
      }),
    });
  } catch (err) {
    if (!CREDENTIAL_TROUBLE.test(messageOf(err))) throw err;
    throw new Error(`${messageOf(err).trim()}\nGit may not be signed in to GitHub. Run "gh auth setup-git" so git uses your GitHub CLI sign-in, then try again.`);
  }
}

/**
 * Wraps the runner for a review of what was changed by hand in a merge: every request is told so once, as the fixed
 * mergeNote of its scope after its own instructions (after the boundary, so the cached part is unchanged), with the two
 * branch names as material; a given range names none, since the pull request's branches may not be the ones merged.
 */
function withMergeNote(inner: AgentRunner, scope: MergeScope, pr: PrInfo): AgentRunner {
  const note = mergeNote(scope);
  const names = scope === 'given range' ? '' : `\n\n${mergeNoteBlock(pr.baseRef, pr.headRef)}`;
  return {
    run: <T>(req: AgentRequest<T>) => inner.run({ ...req, instructions: `${req.instructions}\n\n${note}`, material: `${req.material}${names}` }),
  };
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
  const findings: Finding[] = kept.map((k) => ({ ...k, fingerprint: fingerprint(k), bucket: 'also', rank: null, status: k.status ?? null }));
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
 * a stage error, since nothing was reviewed; otherwise null. A given range (explicit, or a re-review's push) is not the
 * range GitHub counts files over, so the check does not apply to it.
 */
function emptyDiff(files: FileDiff[], pr: PrInfo, givenRange: boolean): string | null {
  if (givenRange || files.length > 0 || pr.changedFiles <= 0) return null;
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

/**
 * When every changed file is in the trust or ignored tier, so no lens request is made, the note saying nothing was read
 * closely; otherwise null. An empty diff, and one where every file is ignored, have their own words (a stage error).
 */
function nothingReadNote(files: FileDiff[], tiers: FileFact[], what: 'pull request' | 'push'): string | null {
  if (files.length === 0 || notReviewed(files, tiers) !== null) return null;
  const tier = tierOf(tiers);
  if (!files.every((f) => tier(f.path) === 'trust' || tier(f.path) === 'ignored')) return null;
  return `Nothing in this ${what} was read closely: all ${files.length} changed files are of kinds Airlock trusts (tests, documents, generated files).`;
}

/** A re-review's note when the whole pull request was reviewed again, saying which and why. */
function everythingNote(plan: Extract<RereviewPlan, { kind: 'everything' }>, previous: ReviewDocument, pr: PrInfo): string {
  switch (plan.reason) {
    case 'rewritten':
      return `The branch was rewritten since the last review (its earlier head ${previous.pr.headSha.slice(0, 7)} is no longer part of it), so the whole pull request was reviewed again.`;
    case 'base-merged-in':
      return `A commit pushed since the last review merges the base branch ${pr.baseRef} in, so the whole pull request was reviewed again.`;
    case 'earlier-incomplete':
      return 'The last review did not finish, so everything was reviewed again.';
    case 'base-missing':
      return `The base commit of this pull request could not be found, so Airlock could not tell whether the push merges ${pr.baseRef} in, and everything was reviewed again.`;
  }
}
/** A re-review's note when the push was one merge of the base branch, of which only the changes made by hand were reviewed. */
const baseMergeNote = (pr: PrInfo): string =>
  `The push since the last review only merges the base branch ${pr.baseRef} in, so only what was changed by hand in that merge was reviewed.`;
const NO_WHOLE_DIFF_NOTE = 'Airlock could not work out the pull request\'s whole diff, so which lines GitHub shows was judged from the push alone.';
const EMPTY_PUSH_NOTE = 'The push changed no files.';
/** A push of only files Airlock ignores is not an unreviewed pull request: the earlier findings carry the verdict. */
const IGNORED_PUSH_NOTE = 'The push changed only files Airlock does not review.';

/** What became of the earlier review's findings: still open or moved (by code or by the fixed check), and fixed. */
interface Carried { open: Finding[]; fixed: Finding[] }

interface Settings { depth: Depth; models: ModelConfig; parallel: number; combine: 'never' | 'no-read-tier' }

interface Reviewed {
  range: ReviewRange; packs: Pack[]; tiers: FileFact[]; facts: Fact[]; map: ChangeMap; brief: Brief; questions: Question[];
  candidates: Candidate[]; dropped: Dropped[]; selection: SelectResult; limits: string[]; notes: string[];
  /** On a re-review, the findings fixed since the earlier review. */
  fixed: Finding[];
}

/** A carried finding as an item for selection: its status kept, its list place and fingerprint made again there. */
function asKept(f: Finding): KeptCandidate {
  const { fingerprint: _f, bucket: _b, rank: _r, ...item } = f;
  return item;
}

/** Every stage from packs to select, inside the workspace. */
async function reviewInWorkspace(
  req: ReviewRequest, deps: EngineDeps & { gate: UsageGate }, log: StageLog, settings: Settings, pr: PrInfo, ws: Workspace,
  files: FileDiff[], diffFacts: Fact[], chosen: { packs: Pack[]; errors: StageError[]; notes: string[]; ms: number },
  again: { previous: ReviewDocument | null; push: LensContext['push'] },
): Promise<Reviewed> {
  const { previous, push } = again;
  // What decides a line's place in the diff GitHub shows: the whole diff on a push re-review (the push's when it could not
  // be worked out); otherwise the review's own diff.
  const whole = push === undefined ? undefined : (push.whole ?? undefined);
  // A merge whose hand-made changes are reviewed is reviewed as any change, and every request is told what it is.
  const { merge } = ws;
  const { exec } = deps;
  const scope: MergeScope = previous !== null ? 'push' : req.explicit !== undefined ? 'given range' : 'pull request';
  const runner = merge?.kind === 'by-hand' ? withMergeNote(deps.runner, scope, pr) : deps.runner;
  // A re-review's push is a range Airlock chose, as an explicit one is: GitHub's file count is about the whole pull request.
  // So is a merge with nothing changed by hand, whose diff is left empty on purpose.
  const pushed = ws.range.kind === 'rereview';
  const givenRange = req.explicit !== undefined || pushed || merge?.kind === 'nothing-by-hand';
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
  // For an earlier finding: null when its file is gone, a throw when it is there but cannot be read (never "gone").
  const readEarlier = async (path: string): Promise<string | null> => {
    const text = await safeRead(ws.headDir, path);
    if (text === null && await presentAt(ws.headDir, path)) throw new Error(`${path} cannot be read`);
    return text;
  };
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
      baseIsMerge: merge?.kind === 'by-hand',
    });
    rec.error(...p.errors);
    return p;
  }, { extraMs: chosen.ms, rethrow: true })) ?? NO_PACKS; // only a kit that cannot be had rejects: no model is asked without it
  const { packs } = prepared;
  engineQuestions.push(...prepared.questions);
  limits.push(...prepared.limits);

  // A merge with nothing changed by hand, or one Airlock cannot review, runs no model stage: `sync`.
  const sync = merge !== undefined && merge.kind !== 'by-hand';
  await log.run('shape', async (rec) => {
    if (ws.shapeError !== undefined) throw new Error(ws.shapeError);
    // A merge that changes no files leaves nothing unreviewed.
    // Conflicts git settled without markers are never left unsaid, even when the diff is empty.
    if (merge?.kind === 'unsupported' && (files.length > 0 || merge.conflicted !== undefined)) {
      const message = files.length > 0 ? `${unreviewedMerge(files.length)} ${merge.reason}` : merge.reason;
      rec.error({ stage: 'shape', cohortId: null, message });
    }
    // What was decided for those conflicts is not in the diff of a merge reviewed by hand either: named, so it is incomplete.
    if (merge?.kind === 'by-hand' && merge.unshown.length > 0) {
      rec.error({ stage: 'shape', cohortId: null, message: settledSentence(merge.unshown) });
    }
  });
  // A merge, a re-review's pushed merge too, is a sync-merge range; `previous` says whether it is a re-review.
  const range: ReviewRange = merge !== undefined ? { ...ws.range, kind: 'sync-merge' } : ws.range;

  const gathered = (await log.run('facts', async (rec) => {
    const tiers = await rec.attempt(() => classifyFiles(files, packs), [] as FileFact[]);
    // A push of only ignored files leaves nothing of the pull request unreviewed that the earlier review did not see.
    const unreviewed = (pushed ? null : notReviewed(files, tiers)) ?? emptyDiff(files, pr, givenRange);
    if (unreviewed !== null) rec.error({ stage: 'facts', cohortId: null, message: unreviewed });
    for (const path of binarySourcePaths(files, packs)) rec.error({ stage: 'facts', cohortId: null, message: binarySourceSentence(path) });
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
    const nothingChanged = files.length === 0 && emptyDiff(files, pr, givenRange) === null;
    brief = merge?.kind === 'nothing-by-hand' ? cleanMergeBrief(scope, pr.baseRef)
      : nothingChanged ? EMPTY_SYNC_MERGE_BRIEF : files.length === 0 ? EMPTY_BRIEF : SYNC_MERGE_BRIEF;
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
    headDir: ws.headDir, baseDir: ws.baseDir, models, run, ...(push === undefined ? {} : { push }),
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
  // A carried finding keeps its id, so a new candidate never takes one of them.
  const usedIds = new Set<string>(previous?.findings.map((f) => f.id) ?? []);
  const candidates = withUniqueIds([...lensR.candidates, ...sweepR.candidates, ...seamsR.candidates], usedIds);
  const schemaDropped = [...lensR.dropped, ...sweepR.dropped, ...seamsR.dropped];

  // On a re-review every earlier finding is looked for at the head by code, in the anchor stage, even on a sync merge.
  // When that cannot be done, each stays open with no place (never fixed), and the stage error makes the review incomplete.
  const unplaced = (): { open: Finding[]; vanished: Finding[] } =>
    ({ open: (previous?.findings ?? []).map((f) => leftOpen({ ...f, cohortId: null })), vanished: [] });
  let earlier = { open: [] as Finding[], vanished: [] as Finding[] };
  let anchored: AnchoredCandidate[] = [];
  const anchorDropped: Dropped[] = [];
  if (sync && previous === null) log.skip('anchor', skipWhy);
  else {
    const r = await log.run('anchor', async (rec) => {
      const a = sync ? { anchored: [], dropped: [] } : await anchorCandidates(candidates, files, readHead, whole);
      const judge = push === undefined ? files : whole;
      const c = previous === null ? earlier : await rec.attempt(async () => {
        const out = await carryOver(previous, files, readEarlier, judge);
        rec.error(...out.errors);
        return out;
      }, unplaced());
      return { ...a, carried: c };
    });
    anchored = r?.anchored ?? [];
    anchorDropped.push(...(r?.dropped ?? []));
    earlier = r?.carried ?? (previous === null ? earlier : unplaced());
  }

  // A finding raised again is the earlier one: merged into it before the merge stage, so it is neither asked about nor
  // challenged again, and once more after it, for a keeper that took the carried fingerprint as an alias there.
  const carryDropped: Dropped[] = [];
  const intoCarried = (): void => {
    if (previous === null) return;
    const r = mergeIntoCarried(anchored, earlier.open);
    anchored = r.items;
    earlier = { ...earlier, open: r.carried };
    carryDropped.push(...r.dropped);
  };
  intoCarried();

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
  intoCarried();

  // The challenge stage also holds a re-review's fixed check, which runs at every depth: a vanished Block or Fix finding
  // gets one request; a vanished Ask or Note is fixed by code. When the check cannot run, nothing is marked fixed by it.
  const { vanished } = earlier;
  const notChecked = (): FixedCheckResult => ({
    fixed: vanished.filter((f) => !needsCheck(f)).map(fixedByCode), open: vanished.filter(needsCheck).map(leftOpen),
    errors: [], usage: [], limits: [],
  });
  const skipChallenge = sync || quick;
  let kept: KeptCandidate[];
  let checkedEarlier: FixedCheckResult;
  const challengeDropped: Dropped[] = [];
  /** An earlier finding the fixed check placed is carried too, so the same finding raised again is merged into it. */
  const intoPlaced = <T extends AnchoredCandidate>(items: T[], placed: FixedCheckResult): { items: T[]; checked: FixedCheckResult } => {
    const r = mergeIntoCarried(items, placed.open);
    carryDropped.push(...r.dropped);
    return { items: r.items, checked: { ...placed, open: r.carried } };
  };
  if (skipChallenge && !vanished.some(needsCheck)) {
    log.skip('challenge', skipWhy);
    kept = anchored.map((c) => ({ ...c, checked: QUICK_CHECKED }));
    checkedEarlier = notChecked();
  } else if (await limitedOut('challenge')) {
    const placed = intoPlaced(anchored.map((c) => ({ ...c, checked: skipChallenge ? QUICK_CHECKED : CHALLENGE_FAILED })), notChecked());
    kept = placed.items;
    checkedEarlier = placed.checked;
  } else {
    // In order: the fixed check, then the new items compared with what it placed, then the challenge of what is left. Each
    // part that fails is a stage error of its own and keeps what the other finished.
    const r = await log.run('challenge', async (rec) => {
      let fixedOut: FixedCheckResult;
      try {
        fixedOut = await confirmFixed(runner, ctx, vanished);
      } catch (err) {
        rec.error({ stage: 'challenge', cohortId: null, message: messageOf(err) });
        fixedOut = notChecked();
      }
      rec.usage(fixedOut.usage);
      rec.error(...fixedOut.errors);
      limits.push(...fixedOut.limits);
      const placed = intoPlaced(anchored, fixedOut);
      anchored = placed.items;
      let out: Awaited<ReturnType<typeof challenge>> | null = null;
      if (!skipChallenge) {
        try {
          out = await challenge(runner, ctx, anchored, readBoth);
          rec.usage(out.usage);
          rec.error(...out.errors);
          limits.push(...out.limits);
        } catch (err) {
          rec.error({ stage: 'challenge', cohortId: null, message: messageOf(err) });
        }
      }
      return { out, fixedOut: placed.checked };
    });
    kept = skipChallenge ? anchored.map((c) => ({ ...c, checked: QUICK_CHECKED }))
      : (r?.out?.kept ?? anchored.map((c) => ({ ...c, checked: CHALLENGE_FAILED })));
    challengeDropped.push(...withMergedCount(r?.out?.dropped ?? [], mergeDropped));
    checkedEarlier = r?.fixedOut ?? notChecked();
  }
  const carried: Carried = { open: [...earlier.open, ...checkedEarlier.open], fixed: checkedEarlier.fixed };

  if (depth === 'deep' && !sync && !(await limitedOut('lenses-deep'))) {
    const known = [...kept, ...[...schemaDropped, ...anchorDropped, ...carryDropped, ...mergeDropped, ...challengeDropped].map((d) => d.candidate)];
    // A deep-pass item that is an earlier finding raised again is merged into it, as in the first pass.
    const sameAsEarlier = previous === null ? undefined : (items: AnchoredCandidate[]): AnchoredCandidate[] => {
      const r = mergeIntoCarried(items, carried.open);
      carried.open = r.carried;
      carryDropped.push(...r.dropped);
      return r.items;
    };
    await log.run('lenses-deep', (rec) => deepPass(rec, {
      runner, ctx, seen: new Set(known.map(fingerprint)), uniqueIds: (c) => withUniqueIds(c, usedIds), readHead, readBoth,
      ...(sameAsEarlier === undefined ? {} : { sameAsEarlier }),
    }, { candidates, questions, schemaDropped, anchorDropped, challengeDropped, kept, limits }));
  }

  // On a re-review the earlier findings still open join the new ones before selection, so the top five and the verdict
  // are over everything still open; the fixed ones are in neither.
  const items: KeptCandidate[] = previous === null ? kept
    : [...carried.open.map(asKept), ...kept.map((k) => ({ ...k, status: 'new' as const }))];

  // Select always runs, so the document has a verdict; it is told every error so far. On a sync merge it asks no model,
  // and after the usage limit it is replaced by the fallback, which asks none either.
  const selected = ((await limitedOut('select')) ? undefined : await log.run('select', async (rec) => {
    const r = await select(runner, ctx, items, questions, [...log.errors], depth, sync);
    rec.usage(r.usage);
    rec.error(...r.errors);
    // Every earlier finding must say what became of it: shown, fixed, or merged into one that is shown.
    const dropped = [...schemaDropped, ...anchorDropped, ...carryDropped, ...mergeDropped, ...challengeDropped, ...r.dropped];
    const lost = previous === null ? [] : unaccounted(previous, r.findings, carried.fixed, dropped);
    if (lost.length === 0) return r;
    rec.error(...lost.map((f) => ({
      stage: 'select', cohortId: null,
      message: `The earlier finding ${f.id} ("${f.title}") is in neither the findings nor the fixed list, and was not merged into one.`,
    })));
    return { ...r, verdict: decideVerdict(pr, r.findings, [...log.errors], false, r.questions.length) };
  })) ?? fallbackSelection(pr, depth, packs, items, questions, log);
  const selection = previous === null ? selected : {
    ...selected,
    selfReviewText: selfReviewText(pr, depth, packs.map((p) => p.title), selected.verdict, rereviewText(previous, selected.findings, carried.fixed)),
  };

  limits.push(...selection.limits);
  const rereviewNotes = previous === null ? []
    : ws.plan?.kind === 'everything' ? [everythingNote(ws.plan, previous, pr)]
      : [
        ...(ws.plan?.kind === 'base-merge' ? [baseMergeNote(pr)] : []),
        ...(push?.whole === null ? [NO_WHOLE_DIFF_NOTE] : []),
        ...(files.length === 0 && merge?.kind !== 'nothing-by-hand' ? [EMPTY_PUSH_NOTE] : []),
        ...(pushed && notReviewed(files, tiers) !== null ? [IGNORED_PUSH_NOTE] : []),
      ];
  return {
    range, packs, tiers, facts, map, brief, questions: [...selection.questions, ...engineQuestions], candidates, selection,
    dropped: [...schemaDropped, ...anchorDropped, ...carryDropped, ...mergeDropped, ...challengeDropped, ...selection.dropped], limits,
    notes: [
      ...chosen.notes, ...rereviewNotes, ...(sync ? [] : [nothingReadNote(files, tiers, pushed ? 'push' : 'pull request')].filter((n) => n !== null)),
      ...mergeNotes, ...selection.notes,
    ],
    fixed: carried.fixed,
  };
}

/** The self-review text's re-review part: the earlier head, the findings with their status, and the fixed ones. */
const rereviewText = (previous: ReviewDocument, findings: Finding[], fixed: Finding[]): RereviewText =>
  ({ earlierHead: previous.pr.headSha, findings, fixed });

/**
 * Reviews one pull request: every stage in order, then the document is checked against the schema, saved and returned.
 * A stage that fails becomes a stage error and the verdict `incomplete`; only a pull request that cannot be fetched, a
 * workspace that cannot be prepared, or a pack's review kit that can be neither fetched nor found in the cache rejects
 * (the last before any model call). The workspace is always disposed.
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
  let intake: {
    pr: PrInfo; ws: Workspace; files: FileDiff[]; diffFacts: Fact[]; previous: ReviewDocument | null; push: LensContext['push'];
  };
  let reviewed: Reviewed;
  try {
    intake = (await log.run('intake', async (rec) => {
      // A re-review starts from a stored review of this pull request, and only when something was pushed since.
      const previous = req.since === undefined ? null : await earlierReview(req, req.since.reviewId);
      const live = await fetchPr(exec, req.repo, req.number, stageRulesOf(chosen.packs));
      if (previous !== null && live.headSha === previous.pr.headSha) throw new Error(NOTHING_PUSHED);
      // The title and description as they were when the pull request was reviewed, when given, replace today's everywhere.
      const fetched = req.prText ? { ...live, title: req.prText.title, body: req.prText.body } : live;
      const ws = await openWorkspace(exec, req, fetched, id, previous);
      opened = ws;
      // A given range's ids, not the commits reviewed: the merge git made by itself is only in the document's range.
      const pr = req.explicit ? { ...fetched, baseSha: req.explicit.baseSha, headSha: req.explicit.headSha } : fetched;
      // A merge with nothing changed by hand has nothing to review, whatever its range's diff holds.
      const noFiles = { files: [] as FileDiff[], facts: [] as Fact[] };
      const loaded = ws.merge?.kind === 'nothing-by-hand' ? noFiles : await rec.attempt(async () => recheckBinary(
        await loadDiff(exec, ws.gitDir, ws.range),
        (path, bytes) => safeRead(ws.headDir, path, { firstBytes: bytes }),
      ), noFiles);
      // On a push re-review (a push of one merge of the base too), the pull request's whole diff as well: it decides what
      // GitHub shows and what the pull request touched. Null when it cannot be worked out; the push's diff then stands in,
      // and the document says so.
      const pushed = ws.plan?.kind === 'push' || ws.plan?.kind === 'base-merge';
      const whole = !pushed ? undefined : ws.whole === undefined ? null : await loadDiff(exec, ws.gitDir, ws.whole)
        .then((d) => recheckBinary(d, (path, bytes) => safeRead(ws.headDir, path, { firstBytes: bytes })))
        .then((d) => d.files, () => null);
      // Told to the challenge only when its base worktree is the earlier head, not a merge git made by itself.
      const push = whole === undefined ? undefined : { whole, baseIsEarlierHead: ws.merge?.kind !== 'by-hand' };
      return { pr, ws, files: loaded.files, diffFacts: [...loaded.facts, ...linkFacts(loaded.files)], previous, push };
    }, { rethrow: true }))!;
    reviewed = await reviewInWorkspace(
      req, deps, log, settings, intake.pr, intake.ws, intake.files, intake.diffFacts, { ...chosen, ms: choiceMs },
      { previous: intake.previous, push: intake.push },
    );
  } finally {
    await (opened as Workspace | undefined)?.dispose().catch(() => undefined);
  }

  const { selection } = reviewed;
  const { previous } = intake;
  // `createdAt` is when the document is assembled, at the end; `startedAt` is when the review began.
  const draft = (): ReviewDocument => ({
    schemaVersion: 1, id, createdAt: given.now().toISOString(), startedAt, pr: intake.pr, range: reviewed.range, depth: settings.depth,
    packs: reviewed.packs.map((p) => ({ id: p.id, version: p.version, title: p.title })), models: settings.models,
    files: reviewed.tiers, facts: reviewed.facts, map: reviewed.map, brief: reviewed.brief, verdict: selection.verdict,
    findings: selection.findings, questions: reviewed.questions, dropped: reviewed.dropped, candidates: reviewed.candidates,
    whoseCall: selection.whoseCall, checksAfterMerge: selection.checksAfterMerge, selfReviewText: selection.selfReviewText,
    stageErrors: [...log.errors], timings: log.timings(), limits: reviewed.limits, notes: reviewed.notes,
    ...(previous === null ? {} : { previous: { reviewId: previous.id, headSha: previous.pr.headSha }, fixed: reviewed.fixed }),
  });
  // A draft that fails the schema is the engine's own fault, so it rejects rather than becoming a stage error.
  const engineFault: { error: Error | null } = { error: null };
  const checked = (doc: ReviewDocument): ReviewDocument => {
    const parsed = ReviewDocumentSchema.safeParse(doc);
    if (parsed.success) return parsed.data;
    engineFault.error = new Error(`Airlock built a review document that does not match its own schema: ${parsed.error.message}`);
    throw engineFault.error;
  };
  // The store stage's own timing is its time up to the write, since the saved document carries it. A stopped review
  // stores nothing: the signal is checked just before the save, and a stop during the save removes the file it wrote.
  let document = await log.run('store', async () => {
    const doc = checked(draft());
    if (signal?.aborted) throw new Error(REVIEW_STOPPED);
    const path = await saveReview(doc);
    if (signal?.aborted) {
      await rm(path, { force: true });
      throw new Error(REVIEW_STOPPED);
    }
    return doc;
  });
  if (engineFault.error) throw engineFault.error;
  if (document === undefined) {
    // Not saved: the review is returned, but never as a complete one, and its self-review text says so.
    const doc = draft();
    const verdict = decideVerdict(doc.pr, doc.findings, doc.stageErrors, false, selection.questions.length);
    const again = previous === null ? undefined : rereviewText(previous, doc.findings, reviewed.fixed);
    const text = selfReviewText(doc.pr, doc.depth, reviewed.packs.map((p) => p.title), verdict, again);
    document = checked({ ...doc, verdict, selfReviewText: text });
  }
  log.emit({ type: 'done', document });
  return document;
}
