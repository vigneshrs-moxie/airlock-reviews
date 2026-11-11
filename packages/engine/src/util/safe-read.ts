import { open, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** The largest file read on behalf of a model's claim. */
export const MAX_SAFE_READ_BYTES = 2 * 1024 * 1024;

/** Repository-relative: no leading `/`, no backslash, `%`, `:` or NUL, and no empty or `..` segment. */
const isRepoPath = (path: string): boolean =>
  path !== '' && !path.startsWith('/') && !/[\\%:\0]/.test(path) && path.split('/').every((s) => s !== '' && s !== '..' && s !== '.');

/**
 * Reads `relPath` under `rootDir`, or returns null. Every file read on behalf of a model's claim goes through here. The
 * path must be repository-relative; its real path must lie inside the real root and be spelled exactly as asked, letter
 * case included (so no symbolic link is followed and `SRC/a.ts` does not read `src/a.ts` on a case-insensitive disk);
 * and it must be a regular file of at most 2 MB. Never throws.
 */
export async function safeRead(rootDir: string, relPath: string): Promise<string | null> {
  try {
    if (typeof relPath !== 'string' || !isRepoPath(relPath)) return null;
    const root = await realpath(rootDir);
    const real = await realpath(join(root, relPath));
    if (relative(root, real).split(sep).join('/') !== relPath) return null;
    const file = await open(real, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_SAFE_READ_BYTES) return null;
      return await file.readFile('utf8');
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}
