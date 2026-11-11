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

/** The pack that the team's review kit is attached to. */
export const KIT_PACK_ID = 'raj-standard';
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
 * a selection that fails, is a stage error; the rest carry on. Makes no model call and no network call.
 */
export async function choosePacks(packsDir: string, repo: string, packIds?: string[]): Promise<{ packs: Pack[]; errors: StageError[] }> {
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
    return { packs: selectPacks(all, repo, packIds).map((p) => learnedFor(p, repo, errors)), errors };
  } catch (err) {
    errors.push(packsError(messageOf(err)));
    return { packs: [], errors };
  }
}

/** The stage rules of the first selected pack that has any. */
export function stageRulesOf(packs: Pack[]): StageRule[] {
  return packs.find((p) => p.stageRules.length > 0)?.stageRules ?? [];
}

export interface PackOptions {
  exec: Exec;
  kitDir?: string;
  kitSha?: string;
  holdout?: Holdout;
  baseDir: string;
  changedPaths: string[];
}

export interface PreparedPacks {
  packs: Pack[];
  missingHelpers: string[];
  repoRules: { path: string; text: string }[];
  questions: Question[];
  errors: StageError[];
  /** Plain sentences naming the repository rule files left out by the count or size limit. */
  limits: string[];
}

/** The kit from `kitDir` when given (no network), otherwise synced from GitHub with the cache as a fallback. */
async function getKit(exec: Exec, kitDir: string | undefined, kitSha: string | undefined): Promise<SyncedKit> {
  return kitDir !== undefined ? { sha: kitSha ?? 'pinned', dir: kitDir, stale: false } : syncKit(exec);
}

/**
 * Makes the selected packs ready for the review: attaches the team's kit to its pack, applies the hold-out to every pack,
 * finds the helpers the kit names that the base no longer has, and reads the repository's rule files from the base.
 * A kit that cannot be had drops its pack with a stage error; a stale kit adds a question. After this, only the returned
 * packs are used: nothing is read from the packs folder again.
 */
export async function preparePacks(selected: Pack[], opts: PackOptions): Promise<PreparedPacks> {
  const errors: StageError[] = [];
  const questions: Question[] = [];

  const withKit: Pack[] = [];
  for (const pack of selected) {
    if (pack.id !== KIT_PACK_ID) { withKit.push(pack); continue; }
    try {
      const kit = await getKit(opts.exec, opts.kitDir, opts.kitSha);
      withKit.push(await attachKit(pack, kit));
      if (kit.stale) {
        const day = (await stat(kit.dir)).mtime.toISOString().slice(0, 10);
        questions.push(question(`The team standard could not be refreshed; the copy from ${day} was used.`));
      }
    } catch (err) {
      errors.push(packsError(messageOf(err)));
    }
  }

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
    repoRules = loaded.rules;
    limits.push(...loaded.leftOut.map((l) => `repository rule file ${l.path} was not shown: ${l.reason}`));
  } catch (err) {
    errors.push(packsError(`The repository's rule files could not be read: ${messageOf(err)}`));
  }

  return { packs, missingHelpers: missing, repoRules, questions, errors, limits };
}
