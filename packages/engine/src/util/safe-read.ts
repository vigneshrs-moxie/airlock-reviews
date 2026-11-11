import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** The largest file read on behalf of a model's claim. */
export const MAX_SAFE_READ_BYTES = 2 * 1024 * 1024;

/** Repository-relative: no leading `/`, no backslash, `%`, `:` or NUL, no empty, `.` or `..` segment, and not under `.git`. */
const isRepoPath = (path: string): boolean => {
  const segments = path.split('/');
  return path !== '' && !path.startsWith('/') && !/[\\%:\0]/.test(path)
    && segments.every((s) => s !== '' && s !== '..' && s !== '.') && segments[0]!.toLowerCase() !== '.git';
};

/**
 * Reads `relPath` under `rootDir`, or returns null. Every file read on behalf of a model's claim goes through here. The
 * path must be repository-relative and not under `.git`; its real path must lie inside the real root and be spelled
 * exactly as asked, letter case included (so no symbolic link is followed and `SRC/a.ts` does not read `src/a.ts` on a
 * case-insensitive disk); and it must be a regular file of at most 2 MB. The file is opened without following a final link, so a link put in
 * its place after the check is refused rather than read. With `firstBytes`, only that many bytes from the start are read
 * and the size limit does not apply (to look at the start of a file of any size). Never throws.
 */
export async function safeRead(rootDir: string, relPath: string, opts: { firstBytes?: number } = {}): Promise<string | null> {
  try {
    if (typeof relPath !== 'string' || !isRepoPath(relPath)) return null;
    const root = await realpath(rootDir);
    const real = await realpath(join(root, relPath));
    if (relative(root, real).split(sep).join('/') !== relPath) return null;
    const file = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile()) return null;
      if (opts.firstBytes !== undefined) {
        const buffer = Buffer.alloc(Math.max(0, Math.min(opts.firstBytes, info.size)));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
      }
      if (info.size > MAX_SAFE_READ_BYTES) return null;
      return await file.readFile('utf8');
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}
