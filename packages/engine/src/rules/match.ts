import type { ChangeMap, FileDiff, FileFact } from '@airlock/shared';
import picomatch from 'picomatch';
import { cohortFiles, standaloneCohort, tierOf } from '../lenses/context.js';
import type { Pack, Rule } from '../packs/types.js';

/** A batch holds at most this many files. */
export const MAX_BATCH_FILES = 8;
/** A batch holds at most this many changed lines (additions plus deletions), except a single file over it. */
export const MAX_BATCH_LINES = 1_200;

export interface SweepBatch { cohortId: string; files: string[]; rules: Rule[] }

/** Every rule of every pack with a glob matching the path, in pack order then rule order. */
export function rulesForFile(path: string, packs: Pack[]): Rule[] {
  return packs.flatMap((p) => p.rules.filter((r) => r.paths.some((g) => picomatch(g, { dot: true })(path))));
}

const ruleKey = (rules: Rule[]): string => rules.map((r) => `${r.packId}\u0000${r.id}`).join('\u0001');

/**
 * The batches of the rule sweep. Only read and skim files that are not deleted or binary and have a matching rule are
 * considered. Within a cohort (the standalone group is cohort `standalone`) files with the same rules share a batch,
 * closed at MAX_BATCH_FILES files or when the next file would pass MAX_BATCH_LINES changed lines. Batches follow cohort
 * order, then the position of their first file in the cohort's layer order.
 */
export function planSweep(map: ChangeMap, tiers: FileFact[], files: FileDiff[], packs: Pack[]): SweepBatch[] {
  const tier = tierOf(tiers);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const batches: SweepBatch[] = [];
  for (const cohort of [...map.cohorts, standaloneCohort(map)]) {
    const groups = new Map<string, { rules: Rule[]; members: { path: string; lines: number }[] }>();
    const position = new Map<string, number>();
    cohortFiles(cohort).forEach((path, index) => {
      const diff = byPath.get(path);
      if (!diff || diff.binary || diff.status === 'deleted') return;
      if (tier(path) !== 'read' && tier(path) !== 'skim') return;
      const rules = rulesForFile(path, packs);
      if (rules.length === 0) return;
      const key = ruleKey(rules);
      const group = groups.get(key) ?? { rules, members: [] };
      group.members.push({ path, lines: diff.additions + diff.deletions });
      groups.set(key, group);
      position.set(path, index);
    });
    const cohortBatches: SweepBatch[] = [];
    for (const { rules, members } of groups.values()) {
      let current: string[] = [];
      let lines = 0;
      for (const m of members) {
        if (current.length > 0 && (current.length >= MAX_BATCH_FILES || lines + m.lines > MAX_BATCH_LINES)) {
          cohortBatches.push({ cohortId: cohort.id, files: current, rules });
          current = [];
          lines = 0;
        }
        current.push(m.path);
        lines += m.lines;
      }
      if (current.length > 0) cohortBatches.push({ cohortId: cohort.id, files: current, rules });
    }
    cohortBatches.sort((a, b) => position.get(a.files[0]!)! - position.get(b.files[0]!)!);
    batches.push(...cohortBatches);
  }
  return batches;
}
