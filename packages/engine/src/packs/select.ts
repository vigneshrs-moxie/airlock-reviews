import type { Pack } from './types.js';

/** The pack selected for every repository, under the ones named for it. */
const EVERY_REPO_PACK = 'generic';

/** True for the pack that is selected for every repository. */
export const appliesToEveryRepo = (pack: Pack): boolean => pack.id === EVERY_REPO_PACK;

export function selectPacks(all: Pack[], repo: string, override?: string[]): Pack[] {
  if (override) {
    return override.map((id) => {
      const pack = all.find((p) => p.id === id);
      if (!pack) throw new Error(`No pack with id "${id}"`);
      return pack;
    });
  }
  // GitHub treats repository names without regard to letter case, so selection does too.
  const wanted = repo.toLowerCase();
  const matched = all.filter((p) => !appliesToEveryRepo(p) && p.repos.some((r) => r.toLowerCase() === wanted));
  const generic = all.find(appliesToEveryRepo);
  return generic ? [...matched, generic] : matched;
}
