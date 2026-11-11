// Words for a place, shared by the screens and the panel's state (which does not import from screens/).

/** A path with a line, or the path alone when there is no line. */
export const placeText = (path: string, line: number | null): string => (line === null ? path : `${path}:${line}`);

/** A path cut to `max` characters (code points), ending in `…` when cut. */
export function clippedPath(path: string, max = 80): string {
  const chars = [...path];
  return chars.length <= max ? path : `${chars.slice(0, max).join('')}…`;
}
