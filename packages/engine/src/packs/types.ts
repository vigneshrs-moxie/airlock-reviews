import type { Severity } from '@airlock/shared';
import type { StageRule } from '../intake/pr.js';

export interface Rule {
  id: string; title: string; paths: string[]; severityFloor: Severity; sourcePrs: number[];
  origin: string; body: string; packId: string;
}
/** `onlyWhenAlone`: the lens runs only when no other selected pack has a lens. */
export interface LensDef { id: string; title: string; instructions: string; onlyWhenAlone?: boolean }
export interface CheckDef {
  id: string; kind: 'added-line-matches' | 'file-pair' | 'new-file-requires' | 'file-touched';
  paths: string[]; pattern?: string; exceptPaths?: string[];
  requires?: { path: string; pattern?: string }[]; message: string;
}
export interface LinkRule {
  id: string; from: string; capture: string; transform: 'none' | 'camel' | 'pascal';
  searchIn: string[]; detail: string;
}
/**
 * `repo` is empty or `-` for a line written by hand for no repository. `where` (`<file>:<line>`) is set when the entry
 * was read from a file.
 */
export interface LearnedEntry { date: string; repo: string; kind: 'wrong' | 'intended'; text: string; where?: string }
/**
 * A review kit a pack attaches, named in its manifest under `kit:`: the files are downloaded from `repo` at review time
 * (reads only) and attached as the pack's standards, in this order, each named by its file name. `ref` is the branch, tag
 * or commit to read (default `main`). `datedStandards` lists which of `files` are dated standards.
 */
export interface KitRef { repo: string; ref?: string; files: string[]; datedStandards?: string[] }
export interface Pack {
  id: string; title: string; version: string; dir: string; repos: string[]; appRoot: string | null;
  stageRules: StageRule[]; tiers: { read: string[]; trust: string[]; ignore: string[] };
  siblings: { id: string; glob: string }[]; linkRules: LinkRule[]; checks: CheckDef[];
  standards: { name: string; text: string; dated: boolean }[]; lenses: LensDef[]; rules: Rule[];
  learned: LearnedEntry[];
  /** One `<pack id>/learned/<file>:<line>` for each learned line that could not be read and was left out; none when absent. */
  learnedProblems?: string[];
  /** The review kit attached to this pack when the review is prepared; none when absent. */
  kit?: KitRef;
}
export interface Holdout { pr: number; reviewedAt: string }
