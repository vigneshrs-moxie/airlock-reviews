import type { ChangeMap, FileDiff, FileFact } from '@airlock/shared';

/** Paths of the changed files whose tier is not `ignored`, in diff order. A file with no fact counts as not ignored. */
export function placeablePaths(files: FileDiff[], facts: FileFact[]): string[] {
  const ignored = new Set(facts.filter((f) => f.tier === 'ignored').map((f) => f.path));
  return files.map((f) => f.path).filter((p) => !ignored.has(p));
}

/**
 * Problems with a change map, as short sentences that name the file or id; empty when the map is valid.
 * Every non-ignored changed file must be placed exactly once across the layers and standalone, and nothing else may be placed.
 * Cohort ids are non-empty and unique, each cohort has a title and at least one layer, layer ids are unique within their
 * cohort, and every dependsOn names a layer of the same cohort.
 */
export function checkChangeMap(map: ChangeMap, files: FileDiff[], facts: FileFact[]): string[] {
  const problems: string[] = [];
  const cohortIds = new Set<string>();
  const places = new Map<string, string[]>();
  const place = (path: string, where: string): void => {
    const list = places.get(path);
    if (list) list.push(where);
    else places.set(path, [where]);
  };

  for (const cohort of map.cohorts) {
    if (cohort.id.trim() === '') problems.push('a cohort has an empty id');
    else if (cohort.id === 'standalone') problems.push('cohort id "standalone" is reserved for the standalone group');
    else if (cohortIds.has(cohort.id)) problems.push(`cohort id "${cohort.id}" is used more than once`);
    cohortIds.add(cohort.id);
    if (cohort.title.trim() === '') problems.push(`cohort ${cohort.id} has no title`);
    if (cohort.layers.length === 0) problems.push(`cohort ${cohort.id} has no layers`);

    const layerIds = new Set<string>();
    for (const layer of cohort.layers) {
      if (layerIds.has(layer.id)) problems.push(`cohort ${cohort.id} has the layer id "${layer.id}" more than once`);
      layerIds.add(layer.id);
      for (const path of layer.files) place(path, `cohort ${cohort.id} layer ${layer.id}`);
    }
    for (const layer of cohort.layers) {
      for (const dep of layer.dependsOn) {
        if (!layerIds.has(dep)) {
          problems.push(`layer ${layer.id} in cohort ${cohort.id} depends on "${dep}", which is not a layer of cohort ${cohort.id}`);
        }
      }
    }
  }
  for (const path of map.standalone) place(path, 'standalone');

  const inDiff = new Set(files.map((f) => f.path));
  const required = new Set(placeablePaths(files, facts));
  const paths = [...new Set([...required, ...places.keys()])].sort();
  for (const path of paths) {
    const where = places.get(path) ?? [];
    if (!inDiff.has(path)) problems.push(`${path} is not a changed file`);
    else if (where.length > 1) problems.push(`${path} is placed ${where.length === 2 ? 'twice' : `${where.length} times`} (${where.join(', ')})`);
    else if (where.length === 0 && required.has(path)) problems.push(`${path} is not placed in any cohort or in standalone`);
  }
  return problems;
}
