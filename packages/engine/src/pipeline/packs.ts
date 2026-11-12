import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isRepo, type Question, type Source, type StageError } from '@airlock/shared';
import type { StageRule } from '../intake/pr.js';
import { missingHelpers, namedHelpers } from '../packs/helpers-check.js';
import { applyHoldout } from '../packs/holdout.js';
import { attachKit, syncKit, type SyncedKit } from '../packs/kit-sync.js';
import { loadPack } from '../packs/load.js';
import { loadRepoRules } from '../packs/repo-rules.js';
import { appliesToEveryRepo, selectPacks } from '../packs/select.js';
import type { Holdout, Pack } from '../packs/types.js';
import type { Exec } from '../util/exec.js';
import { messageOf } from './stages.js';

/** The source of questions the engine itself asks. */
export const ENGINE_SOURCE: Source = { pack: 'airlock', lens: null, ruleId: null };

const packsError = (message: string): StageError => ({ stage: 'packs', cohortId: null, message });
const question = (text: string): Question => ({ text, cohortId: null, source: ENGINE_SOURCE });

/** A learned line written by hand for no repository: its repository field is empty or `-`. */
const forNoRepo = (field: string): boolean => field.trim() === '' || field.trim() === '-';

/**
 * A pack selected for every repository keeps only the learned lines saved on this repository (letter case ignored) and
 * the lines with no repository recorded (written by hand, the field empty or `-`); a line saved on another repository is
 * not given to this review. A line whose field is none of these is given to no review and reported. A named pack's
 * lines apply to every repository the pack is selected for, so they are left alone.
 */
function learnedFor(pack: Pack, repo: string, errors: StageError[]): Pack {
  if (!appliesToEveryRepo(pack)) return pack;
  const here = repo.toLowerCase();
  const learned = pack.learned.filter((e) => {
    if (forNoRepo(e.repo)) return true;
    if (isRepo(e.repo)) return e.repo.toLowerCase() === here;
    errors.push(packsError(
      `${e.where ?? pack.dir}: the repository "${e.repo}" is not a repository name, "-" or empty, so this line is left out of every review.`));
    return false;
  });
  return { ...pack, learned };
}

/**
 * Loads every folder directly under `packsDir` that has a `pack.yaml` and selects the packs for the repository (or the
 * ones named in `packIds`), each with only the learned lines that apply to the repository. A pack that does not load, or
 * a selection that fails, is a stage error; the rest carry on. A learned line that cannot be read is left out and named
 * in `notes` (one sentence each), not an error. Makes no model call and no network call.
 */
export async function choosePacks(packsDir: string, repo: string, packIds?: string[]): Promise<{ packs: Pack[]; errors: StageError[]; notes: string[] }> {
  const errors: StageError[] = [];
  const all: Pack[] = [];
  let names: string[] = [];
  try {
    names = (await readdir(packsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch (err) {
    errors.push(packsError(`The packs folder could not be read: ${messageOf(err)}`));
  }
  for (const name of names) {
    const dir = join(packsDir, name);
    if (!(await stat(join(dir, 'pack.yaml')).then((s) => s.isFile(), () => false))) continue;
    try {
      all.push(await loadPack(dir));
    } catch (err) {
      errors.push(packsError(messageOf(err)));
    }
  }
  try {
    const packs = selectPacks(all, repo, packIds).map((p) => learnedFor(p, repo, errors));
    const notes = packs.flatMap((p) => p.learnedProblems ?? []).map((where) => `A learned line could not be read and was left out: ${where}.`);
    return { packs, errors, notes };
  } catch (err) {
    errors.push(packsError(messageOf(err)));
    return { packs: [], errors, notes: [] };
  }
}

/** The stage rules of the first selected pack that has any. */
export function stageRulesOf(packs: Pack[]): StageRule[] {
  return packs.find((p) => p.stageRules.length > 0)?.stageRules ?? [];
}

export interface PackOptions {
  exec: Exec;
  /** Stands in for the download of the first selected pack's kit that has one (the replay pins it); others are synced. */
  kitDir?: string;
  /** The version of the kit in `kitDir`; `pinned` otherwise. */
  kitSha?: string;
  holdout?: Holdout;
  baseDir: string;
  changedPaths: string[];
  /** The base worktree is a merge git made by itself, so a rule file there may hold conflict markers. */
  baseIsMerge?: boolean;
}

/** A conflict as git leaves it in a file: a `<<<<<<<` line and, later, a `>>>>>>>` line. */
const CONFLICT_MARKERS = /^<{7}(?: |$)[\s\S]*^>{7}(?: |$)/m;

export interface PreparedPacks {
  packs: Pack[];
  missingHelpers: string[];
  repoRules: { path: string; text: string }[];
  questions: Question[];
  errors: StageError[];
  /** Plain sentences naming the repository rule files left out by the count or size limit. */
  limits: string[];
}

/**
 * Makes the selected packs ready for the review: attaches to each pack whose manifest names a kit that kit's files, applies
 * the hold-out to every pack, finds the helpers a kit's orbit.md names that the base no longer has, and reads the
 * repository's rule files from the base. A stale kit adds a question naming it. A kit that cannot be had, with no copy in
 * the cache, rejects with a sentence naming it (one per kit), so the review stops before any model call. After this, only
 * the returned packs are used: nothing is read from the packs folder again.
 */
export async function preparePacks(selected: Pack[], opts: PackOptions): Promise<PreparedPacks> {
  const errors: StageError[] = [];
  const questions: Question[] = [];

  const withKit: Pack[] = [];
  const unavailable: string[] = [];
  let pinnedUsed = false;
  for (const pack of selected) {
    if (pack.kit === undefined) { withKit.push(pack); continue; }
    const pinnedDir = pinnedUsed ? undefined : opts.kitDir;
    if (pinnedDir !== undefined) pinnedUsed = true;
    try {
      const kit: SyncedKit = pinnedDir !== undefined
        ? { sha: opts.kitSha ?? 'pinned', dir: pinnedDir, stale: false }
        : await syncKit(opts.exec, pack.kit);
      withKit.push(await attachKit(pack, kit));
      if (kit.stale) {
        const day = (await stat(kit.dir)).mtime.toISOString().slice(0, 10);
        questions.push(question(`The review kit ${pack.kit.repo} could not be refreshed; the copy from ${day} was used.`));
      }
    } catch (err) {
      unavailable.push(messageOf(err));
    }
  }
  if (unavailable.length > 0) throw new Error(unavailable.join(' '));

  const { holdout } = opts;
  const packs = holdout ? withKit.map((p) => applyHoldout(p, holdout)) : withKit;

  const names = [...new Set(packs.flatMap((p) => p.standards.filter((s) => s.name === 'orbit.md').flatMap((s) => namedHelpers(s.text))))];
  let missing: string[] = [];
  if (names.length > 0) {
    try {
      missing = await missingHelpers(opts.exec, opts.baseDir, names);
    } catch (err) {
      errors.push(packsError(messageOf(err)));
    }
  }

  let repoRules: PreparedPacks['repoRules'] = [];
  const limits: string[] = [];
  try {
    const loaded = await loadRepoRules(opts.baseDir, opts.changedPaths, opts.exec);
    // Both sides of a conflict are not rules anyone wrote: such a file is left out and named.
    const conflicted = opts.baseIsMerge === true ? loaded.rules.filter((r) => CONFLICT_MARKERS.test(r.text)) : [];
    repoRules = loaded.rules.filter((r) => !conflicted.includes(r));
    limits.push(...conflicted.map((r) => `${r.path} has merge conflict markers on the base side and was not used as rules.`));
    limits.push(...loaded.leftOut.map((l) => `repository rule file ${l.path} was not shown: ${l.reason}`));
  } catch (err) {
    errors.push(packsError(`The repository's rule files could not be read: ${messageOf(err)}`));
  }

  return { packs, missingHelpers: missing, repoRules, questions, errors, limits };
}
