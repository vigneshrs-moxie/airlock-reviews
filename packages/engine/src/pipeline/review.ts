import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ReviewDocumentSchema } from '@airlock/shared';
import type {
  Anchor, Brief, Candidate, ChangeMap, Depth, Dropped, Fact, FileDiff, FileFact, Finding, Link, ModelConfig, Neighbour, PrInfo,
  Question, ReviewDocument, ReviewEvent, ReviewRange, StageError,
} from '@airlock/shared';
import type { AgentRequest, AgentRunner } from '../agent/runner.js';
import { anchorCandidates } from '../anchor/anchor.js';
import { fingerprint } from '../anchor/fingerprint.js';
import { buildBrief } from '../brief/brief.js';
import { challenge, type KeptCandidate } from '../challenge/challenge.js';
import type { ReadFile } from '../challenge/proof.js';
import { loadDiff } from '../diff/parse.js';
import { runChecks } from '../facts/checks.js';
import { classifyFiles } from '../facts/classify.js';
import { fetchPr } from '../intake/pr.js';
import { prepareWorkspace, type Workspace } from '../intake/workspace.js';
import { runCohortLenses, runnableLenses } from '../lenses/cohort-lens.js';
import { emptyResult, type LensContext, type LensStageResult } from '../lenses/context.js';
import { runSeams } from '../lenses/seams.js';
import { findLinks } from '../map/links.js';
import { fallbackMap, buildChangeMap } from '../map/mapper.js';
import { findNeighbours } from '../map/neighbours.js';
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
  packsDir: string;
  remoteUrl?: string;
  parallel?: number;
  /** Read the team kit from this folder instead of GitHub (tests and the replay). */
  kitDir?: string;
  /** The kit's version when `kitDir` is given; `pinned` otherwise. */
  kitSha?: string;
}

export interface EngineDeps { exec: Exec; runner: AgentRunner; now: () => Date }

const DEFAULT_MODELS: ModelConfig = { main: 'claude-opus-5-5', challenger: 'claude-opus-5-5', sweep: 'claude-opus-5-5', effort: 'high' };
const DEFAULT_PARALLEL = 4;
const QUICK_CHECKED = 'not challenged (quick review)';
const CHALLENGE_FAILED = 'challenge did not complete';
const SYNC_MERGE_BRIEF: Brief = {
  whatItDoes: ['This branch only merges its target branch into itself, so only conflict resolutions need review.'], claims: [],
};
const EMPTY_BRIEF: Brief = { whatItDoes: [], claims: [] };
const EMPTY_MAP: ChangeMap = { cohorts: [], standalone: [], links: [] };
const NO_PACKS: PreparedPacks = { packs: [], missingHelpers: [], repoRules: [], questions: [], errors: [] };
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

/** Only the first lens that can run of each pack. */
function firstLensOnly(packs: Pack[]): Pack[] {
  const runnable = runnableLenses(packs);
  return packs.map((pack) => {
    const first = runnable.find((r) => r.pack === pack);
    return { ...pack, lenses: first ? [first.lens] : [] };
  });
}

/** Prepares the workspace; a clone or fetch refused for lack of credentials says how to fix it. */
async function openWorkspace(exec: Exec, req: ReviewRequest, pr: PrInfo, reviewId: string): Promise<Workspace> {
  try {
    return await prepareWorkspace(exec, {
      repo: req.repo, remoteUrl: req.remoteUrl ?? `https://github.com/${req.repo}.git`, reviewId,
      ...(req.explicit ? { explicit: req.explicit } : { pr: { number: req.number, baseRef: pr.baseRef, headSha: pr.headSha } }),
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
    selfReviewText: selfReviewText(pr, depth, packs.map((p) => p.title), verdict), errors: [], usage: [],
  };
}

/** The stage error that keeps a sync merge from being reported as reviewed. */
const unreviewedMerge = (changed: number): string =>
  `This pull request only merges another branch in. Airlock did not review it: ${changed === 1 ? '1 changed file was' : `${changed} changed files were`} not looked at.`;

interface Settings { depth: Depth; models: ModelConfig; parallel: number }

interface Reviewed {
  range: ReviewRange; packs: Pack[]; tiers: FileFact[]; facts: Fact[]; map: ChangeMap; brief: Brief; questions: Question[];
  candidates: Candidate[]; dropped: Dropped[]; selection: SelectResult;
}

/** Every stage from packs to select, inside the workspace. */
async function reviewInWorkspace(
  req: ReviewRequest, deps: EngineDeps, log: StageLog, settings: Settings, pr: PrInfo, ws: Workspace, files: FileDiff[],
  chosen: { packs: Pack[]; errors: StageError[]; ms: number },
): Promise<Reviewed> {
  const { exec, runner } = deps;
  const { depth, models } = settings;
  const run = limiter(settings.parallel);
  const capped: AgentRunner = { run: <T>(r: AgentRequest<T>) => run(() => runner.run(r)) };
  const readHead = (path: string): Promise<string | null> => safeRead(ws.headDir, path);
  const readBoth: ReadFile = (where, path) => safeRead(where === 'head' ? ws.headDir : ws.baseDir, path);
  // The stages' questions go through selection, which merges repeats; the engine's own are added after it, unmerged.
  const questions: Question[] = [];
  const engineQuestions: Question[] = [];

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

  const sync = (await log.run('shape', async (rec) => {
    const merged = await isSyncMerge(exec, ws.headDir, ws.range, null);
    if (merged) rec.error({ stage: 'shape', cohortId: null, message: unreviewedMerge(files.length) });
    return merged;
  })) ?? false;
  const range: ReviewRange = sync ? { ...ws.range, kind: 'sync-merge' } : ws.range;

  const gathered = (await log.run('facts', async (rec) => {
    const tiers = await rec.attempt(() => classifyFiles(files, packs), [] as FileFact[]);
    const facts = await rec.attempt(() => runChecks(files, packs, readHead), [] as Fact[]);
    const found = await rec.attempt(() => findLinks(exec, ws.headDir, files, packs), { links: [] as Link[], skippedNames: 0 });
    const neighbours = await rec.attempt(() => findNeighbours(exec, ws.headDir, files, found.links, packs), [] as Neighbour[]);
    return { tiers, facts, links: found.links, neighbours, skippedNames: found.skippedNames };
  })) ?? { tiers: [], facts: [], links: [], neighbours: [], skippedNames: 0 };
  const { tiers, facts } = gathered;
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
    brief = SYNC_MERGE_BRIEF;
  } else {
    map = (await log.run('map', async (rec) => {
      const r = await buildChangeMap(capped, {
        pr, files, facts: tiers, links: gathered.links, neighbours: gathered.neighbours, headDir: ws.headDir,
        model: models.main, effort: models.effort,
      });
      rec.usage(r.usage);
      if (r.error !== null) rec.error({ stage: 'map', cohortId: null, message: r.error });
      return r.map;
    })) ?? fallbackMap(files, tiers, gathered.links);
    log.emit({ type: 'map', map });
    brief = (await log.run('brief', async (rec) => {
      const r = await buildBrief(capped, { pr, map, files, headDir: ws.headDir, baseDir: ws.baseDir, model: models.main, effort: models.effort });
      rec.usage(r.usage);
      if (r.error !== null) rec.error({ stage: 'brief', cohortId: null, message: r.error });
      return r.brief;
    })) ?? EMPTY_BRIEF;
  }
  log.emit({ type: 'brief', brief });

  const ctx: LensContext = {
    pr, map, files, tiers, facts, brief, packs, repoRules: prepared.repoRules, missingHelpers: prepared.missingHelpers,
    headDir: ws.headDir, baseDir: ws.baseDir, models, run,
  };
  const quick = depth === 'quick';
  let lensR = emptyResult();
  let sweepR = emptyResult();
  let seamsR = emptyResult();
  if (sync) {
    for (const stage of ['lenses', 'sweep', 'seams'] as const) log.skip(stage, skipWhy);
  } else {
    // Lenses and sweep run side by side; both go through the same parallel cap.
    [lensR, sweepR] = await Promise.all([
      lensStage(log, 'lenses', () => runCohortLenses(runner, quick ? { ...ctx, packs: firstLensOnly(packs) } : ctx)),
      quick ? (log.skip('sweep', skipWhy), emptyResult()) : lensStage(log, 'sweep', () => runSweep(runner, ctx)),
    ]);
    if (quick) log.skip('seams', skipWhy);
    else seamsR = await lensStage(log, 'seams', () => runSeams(runner, ctx, [...lensR.candidates, ...sweepR.candidates]));
  }
  questions.push(...lensR.questions, ...sweepR.questions, ...seamsR.questions);
  const usedIds = new Set<string>();
  const candidates = withUniqueIds([...lensR.candidates, ...sweepR.candidates, ...seamsR.candidates], usedIds);
  const schemaDropped = [...lensR.dropped, ...sweepR.dropped, ...seamsR.dropped];

  let anchored: (Candidate & { anchor: Anchor })[] = [];
  const anchorDropped: Dropped[] = [];
  if (sync) log.skip('anchor', skipWhy);
  else {
    const r = await log.run('anchor', () => anchorCandidates(candidates, files, readHead));
    anchored = r?.anchored ?? [];
    anchorDropped.push(...(r?.dropped ?? []));
  }

  let kept: KeptCandidate[];
  const challengeDropped: Dropped[] = [];
  if (sync || quick) {
    log.skip('challenge', skipWhy);
    kept = anchored.map((c) => ({ ...c, checked: QUICK_CHECKED }));
  } else {
    const r = await log.run('challenge', async (rec) => {
      const out = await challenge(runner, ctx, anchored, readBoth);
      rec.usage(out.usage);
      rec.error(...out.errors);
      return out;
    });
    kept = r?.kept ?? anchored.map((c) => ({ ...c, checked: CHALLENGE_FAILED }));
    challengeDropped.push(...(r?.dropped ?? []));
  }

  if (depth === 'deep' && !sync) {
    const known = [...kept, ...[...schemaDropped, ...anchorDropped, ...challengeDropped].map((d) => d.candidate)];
    await log.run('lenses-deep', (rec) => deepPass(rec, {
      runner, ctx, seen: new Set(known.map(fingerprint)), uniqueIds: (c) => withUniqueIds(c, usedIds), readHead, readBoth,
    }, { candidates, questions, schemaDropped, anchorDropped, challengeDropped, kept }));
  }

  // Select always runs, so the document has a verdict; it is told every error so far. On a sync merge it asks no model.
  const selection = (await log.run('select', async (rec) => {
    const r = await select(runner, ctx, kept, questions, [...log.errors], depth, sync);
    rec.usage(r.usage);
    rec.error(...r.errors);
    return r;
  })) ?? fallbackSelection(pr, depth, packs, kept, questions, log);

  return {
    range, packs, tiers, facts, map, brief, questions: [...selection.questions, ...engineQuestions], candidates, selection,
    dropped: [...schemaDropped, ...anchorDropped, ...challengeDropped, ...selection.dropped],
  };
}

/**
 * Reviews one pull request: every stage in order, then the document is checked against the schema, saved and returned.
 * A stage that fails becomes a stage error and the verdict `incomplete`; only a pull request that cannot be fetched or a
 * workspace that cannot be prepared rejects. The workspace is always disposed.
 */
export async function runReview(req: ReviewRequest, deps: EngineDeps, onEvent?: (e: ReviewEvent) => void): Promise<ReviewDocument> {
  const parallel = req.parallel ?? DEFAULT_PARALLEL;
  if (!Number.isInteger(parallel) || parallel < 1) throw new RangeError(`parallel must be a whole number of at least 1, got ${parallel}`);
  const given = Object.fromEntries(Object.entries(req.models ?? {}).filter(([, v]) => v !== undefined)) as Partial<ModelConfig>;
  const settings: Settings = { depth: req.depth ?? 'standard', models: { ...DEFAULT_MODELS, ...given }, parallel };
  const id = hexId('r_', 5);
  const createdAt = deps.now().toISOString();
  const log = createStageLog(onEvent);

  // Packs are chosen first because their stage rules are needed to fetch the pull request; the time counts under packs.
  const choiceStarted = performance.now();
  const chosen = await choosePacks(req.packsDir, req.repo, req.packIds);
  const choiceMs = performance.now() - choiceStarted;

  const intake = (await log.run('intake', async (rec) => {
    const fetched = await fetchPr(deps.exec, req.repo, req.number, stageRulesOf(chosen.packs));
    const ws = await openWorkspace(deps.exec, req, fetched, id);
    const pr = req.explicit ? { ...fetched, baseSha: ws.range.baseSha, headSha: ws.range.headSha } : fetched;
    const files = await rec.attempt(() => loadDiff(deps.exec, ws.headDir, ws.range), [] as FileDiff[]);
    return { pr, ws, files };
  }, { rethrow: true }))!;

  let reviewed: Reviewed;
  try {
    reviewed = await reviewInWorkspace(req, deps, log, settings, intake.pr, intake.ws, intake.files, { ...chosen, ms: choiceMs });
  } finally {
    await intake.ws.dispose().catch(() => undefined);
  }

  const { selection } = reviewed;
  const draft = (): ReviewDocument => ({
    schemaVersion: 1, id, createdAt, pr: intake.pr, range: reviewed.range, depth: settings.depth,
    packs: reviewed.packs.map((p) => ({ id: p.id, version: p.version })), models: settings.models,
    files: reviewed.tiers, facts: reviewed.facts, map: reviewed.map, brief: reviewed.brief, verdict: selection.verdict,
    findings: selection.findings, questions: reviewed.questions, dropped: reviewed.dropped, candidates: reviewed.candidates,
    whoseCall: selection.whoseCall, checksAfterMerge: selection.checksAfterMerge, selfReviewText: selection.selfReviewText,
    stageErrors: [...log.errors], timings: log.timings(),
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
