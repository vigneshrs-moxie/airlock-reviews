import type { FileDiff, FileFact, Tier } from '@airlock/shared';
import picomatch from 'picomatch';
import type { Pack } from '../packs/types.js';

/** Each built-in ignore glob with what it ignores, in words, for the reason shown under "Not reviewed". */
const BUILT_IN_IGNORE_WORDS: Record<string, string> = {
  '**/package-lock.json': 'lock file', '**/pnpm-lock.yaml': 'lock file', '**/yarn.lock': 'lock file', '**/*.snap': 'test snapshot',
  '**/*.min.js': 'minified file', '**/dist/**': 'build output', '**/*.generated.*': 'generated file',
};
const BUILT_IN_IGNORE = Object.keys(BUILT_IN_IGNORE_WORDS);
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

/**
 * A symbolic link is classified by its path like any other file, so a pull request cannot take a source file out of the
 * lenses by turning it into a link; the lenses see its diff and the fact saying where it points.
 */
function classify(file: FileDiff, packs: Pack[]): FileFact {
  const fact = (tier: Tier, reason: string): FileFact => ({ path: file.path, tier, reason });
  if (file.binary) return fact('ignored', 'binary file');
  const ignored = firstMatch(file.path, packs, (p) => p.tiers.ignore, BUILT_IN_IGNORE);
  if (ignored) {
    const words = ignored.startsWith('built-in: ') ? BUILT_IN_IGNORE_WORDS[ignored.slice('built-in: '.length)] : undefined;
    return fact('ignored', words === undefined ? ignored : `${words} (${ignored})`);
  }
  const read = firstMatch(file.path, packs, (p) => p.tiers.read, []);
  if (read) return fact('read', read);
  const trust = firstMatch(file.path, packs, (p) => p.tiers.trust, BUILT_IN_TRUST);
  if (trust) return fact('trust', trust);
  return fact('skim', 'default');
}

export function classifyFiles(files: FileDiff[], packs: Pack[]): FileFact[] {
  return files.map((f) => classify(f, packs));
}

/**
 * Extensions of files that are binary by nature: images, fonts, archives, media, PDF and compiled objects. A file git
 * calls binary with one of these is passed over quietly; any other is suspect (see binarySourcePaths).
 */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tif', 'tiff', 'avif', 'heic', 'heif', 'psd',
  // fonts
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  // archives
  'zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar', 'jar', 'war',
  // media
  'mp3', 'mp4', 'm4a', 'm4v', 'wav', 'ogg', 'oga', 'flac', 'aac', 'mov', 'avi', 'webm', 'mkv',
  // documents
  'pdf',
  // compiled objects
  'o', 'obj', 'a', 'lib', 'so', 'dylib', 'dll', 'exe', 'class', 'pyc', 'wasm', 'node',
]);

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};

/**
 * The binary files (by git's verdict or the NUL check) that look like source code: their path would put them in the read
 * or skim tier and their extension is not in BINARY_EXTENSIONS. Such a file is not reviewed, so it must not pass in silence.
 */
export function binarySourcePaths(files: FileDiff[], packs: Pack[]): string[] {
  return files.filter((f) => {
    if (!f.binary || BINARY_EXTENSIONS.has(extensionOf(f.path))) return false;
    const { tier } = classify({ ...f, binary: false }, packs);
    return tier === 'read' || tier === 'skim';
  }).map((f) => f.path);
}

/** The stage error for a binary file that looks like source code. */
export const binarySourceSentence = (path: string): string =>
  `${path} looks like source code but is a binary file to git, so it was not reviewed.`;
