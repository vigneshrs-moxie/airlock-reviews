import type { FileDiff, FileFact, Tier } from '@airlock/shared';
import picomatch from 'picomatch';
import type { Pack } from '../packs/types.js';

const BUILT_IN_IGNORE = [
  '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/*.snap', '**/*.min.js', '**/dist/**',
  '**/*.generated.*',
];
const BUILT_IN_TRUST = ['**/*.test.*', '**/*.spec.*', '**/*.dbtest.*', '**/__tests__/**'];

const matches = (glob: string, path: string): boolean => picomatch(glob, { dot: true })(path);

/** The reason for the first glob that matches: pack globs in pack order, then built-in ones. */
function firstMatch(path: string, packs: Pack[], pick: (p: Pack) => string[], builtIn: string[]): string | null {
  for (const pack of packs) {
    const glob = pick(pack).find((g) => matches(g, path));
    if (glob !== undefined) return `${pack.id}: ${glob}`;
  }
  const glob = builtIn.find((g) => matches(g, path));
  return glob !== undefined ? `built-in: ${glob}` : null;
}

function classify(file: FileDiff, packs: Pack[]): FileFact {
  const fact = (tier: Tier, reason: string): FileFact => ({ path: file.path, tier, reason });
  if (file.binary) return fact('ignored', 'binary file');
  const ignored = firstMatch(file.path, packs, (p) => p.tiers.ignore, BUILT_IN_IGNORE);
  if (ignored) return fact('ignored', ignored);
  const read = firstMatch(file.path, packs, (p) => p.tiers.read, []);
  if (read) return fact('read', read);
  const trust = firstMatch(file.path, packs, (p) => p.tiers.trust, BUILT_IN_TRUST);
  if (trust) return fact('trust', trust);
  return fact('skim', 'default');
}

export function classifyFiles(files: FileDiff[], packs: Pack[]): FileFact[] {
  return files.map((f) => classify(f, packs));
}
