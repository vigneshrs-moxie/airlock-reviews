import type { FileDiff } from '@airlock/shared';

/**
 * Where GitHub can hang a review comment on an anchored range. GitHub accepts a comment only on a line its diff shows, so
 * only the new side counts: the added and context lines of the file's hunks, by their new line numbers (a deleted line has
 * none, and a file that changed type is judged by its new side alone for that reason).
 *
 * `line` is the last line of the range that is such a line. `startLine` is the first line of the range when it differs from
 * `line` and every line from it to `line` lies in the same hunk; otherwise null. The result is null when no line of the
 * range qualifies, when the file is binary, deleted or has no hunks, or when the range is null.
 */
export function commentLine(
  file: FileDiff | undefined, startLine: number | null, endLine: number | null,
): { line: number; startLine: number | null } | null {
  if (file === undefined || file.binary || file.status === 'deleted' || startLine === null || endLine === null) return null;
  if (endLine < startLine) return null;
  const hunks = file.hunks.map((h) => new Set(h.lines.flatMap((l) => (l.newNo === null ? [] : [l.newNo]))));
  for (let line = endLine; line >= startLine; line--) {
    const hunk = hunks.find((h) => h.has(line));
    if (hunk === undefined) continue;
    if (line === startLine) return { line, startLine: null };
    for (let n = startLine; n < line; n++) if (!hunk.has(n)) return { line, startLine: null };
    return { line, startLine };
  }
  return null;
}
