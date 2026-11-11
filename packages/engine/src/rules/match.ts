import type { ChangeMap, FileDiff, FileFact } from '@airlock/shared';
import picomatch from 'picomatch';
import { SYMLINK_MODE } from '../diff/parse.js';
import { cohortFiles, standaloneCohort, tierOf } from '../lenses/context.js';
import type { Pack, Rule } from '../packs/types.js';

/** A batch holds at most this many files. */
export const MAX_BATCH_FILES = 8;
/** A batch carries at most this many rules: the union of the rules that match its files. */
export const MAX_BATCH_RULES = 25;
/** A batch holds at most this many changed lines (additions plus deletions), except a single file over it. */
export const MAX_BATCH_LINES = 1_200;

export interface SweepBatch {
  cohortId: string;
  files: string[];
  /** Every rule that matches at least one of the files, in pack order then rule order. */
  rules: Rule[];
  /** For each file, the ids of the rules it is checked against: those that match it, and only those. */
  rulesOf: Record<string, string[]>;
}

/** Every rule of every pack with a glob matching the path, in pack order then rule order. */
export function rulesForFile(path: string, packs: Pack[]): Rule[] {
  return packs.flatMap((p) => p.rules.filter((r) => ruleApplies(r, path)));
}

/** True when one of the rule's globs matches the path. */
export function ruleApplies(rule: Rule, path: string): boolean {
  return rule.paths.some((g) => picomatch(g, { dot: true })(path));
}

const ruleKey = (r: Rule): string => `${r.packId}\u0000${r.id}`;

interface Entry { path: string; rules: Rule[]; lines: number }

/** A file whose own rules are more than MAX_BATCH_RULES, as entries of at most that many rules each. */
const byRuleCap = (e: Entry): Entry[] => {
  const parts: Entry[] = [];
  for (let i = 0; i < e.rules.length; i += MAX_BATCH_RULES) parts.push({ ...e, rules: e.rules.slice(i, i + MAX_BATCH_RULES) });
  return parts;
};

/**
 * The batches of the rule sweep. Only read and skim files that are not deleted, binary or links and have a matching rule are
 * considered. Each cohort (the standalone group is cohort `standalone`) is cut greedily, in its layer order, into
 * batches of at most MAX_BATCH_FILES files, MAX_BATCH_RULES rules (the union of the rules matching its files) and
 * MAX_BATCH_LINES changed lines (a single file over that limit gets a batch of its own). A file that matches more than
 * MAX_BATCH_RULES rules is checked in several batches, each with part of its rules. Every file is listed with the ids of
 * the rules that match it, so each matching file-and-rule pair is sent exactly once, and no rule is sent for a file it
 * does not match. Batches follow cohort order, then layer order.
 */
export function planSweep(map: ChangeMap, tiers: FileFact[], files: FileDiff[], packs: Pack[]): SweepBatch[] {
  const tier = tierOf(tiers);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const batches: SweepBatch[] = [];
  for (const cohort of [...map.cohorts, standaloneCohort(map)]) {
    const entries = cohortFiles(cohort).flatMap((path): Entry[] => {
      const diff = byPath.get(path);
      // A symbolic link holds a path, not code, so no rule is checked against it.
      if (!diff || diff.binary || diff.status === 'deleted' || diff.mode === SYMLINK_MODE) return [];
      if (tier(path) !== 'read' && tier(path) !== 'skim') return [];
      const rules = rulesForFile(path, packs);
      return rules.length === 0 ? [] : byRuleCap({ path, rules, lines: diff.additions + diff.deletions });
    });
    let current: Entry[] = [];
    let union = new Map<string, Rule>();
    let lines = 0;
    const close = (): void => {
      if (current.length === 0) return;
      const rulesOf: Record<string, string[]> = {};
      for (const e of current) rulesOf[e.path] = e.rules.map((r) => r.id);
      const order = new Map(packs.flatMap((p) => p.rules).map((r, i) => [ruleKey(r), i]));
      const rules = [...union.values()].sort((a, b) => order.get(ruleKey(a))! - order.get(ruleKey(b))!);
      batches.push({ cohortId: cohort.id, files: current.map((e) => e.path), rules, rulesOf });
      current = [];
      union = new Map();
      lines = 0;
    };
    for (const e of entries) {
      const added = e.rules.filter((r) => !union.has(ruleKey(r))).length;
      const full = current.length >= MAX_BATCH_FILES || union.size + added > MAX_BATCH_RULES || lines + e.lines > MAX_BATCH_LINES
        || current.some((c) => c.path === e.path);
      if (current.length > 0 && full) close();
      current.push(e);
      for (const r of e.rules) union.set(ruleKey(r), r);
      lines += e.lines;
    }
    close();
  }
  return batches;
}
