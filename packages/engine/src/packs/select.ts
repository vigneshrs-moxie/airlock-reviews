import type { Pack } from './types.js';

export function selectPacks(all: Pack[], repo: string, override?: string[]): Pack[] {
  if (override) {
    return override.map((id) => {
      const pack = all.find((p) => p.id === id);
      if (!pack) throw new Error(`No pack with id "${id}"`);
      return pack;
    });
  }
  const matched = all.filter((p) => p.id !== 'generic' && p.repos.includes(repo));
  const generic = all.find((p) => p.id === 'generic');
  return generic ? [...matched, generic] : matched;
}
