import type { Dropped, FileDiff, Finding, ReviewDocument } from '@airlock/shared';
import { anchorCandidates, findQuote } from '../anchor/anchor.js';
import { fingerprint } from '../anchor/fingerprint.js';
import { plainCandidate, type AnchoredCandidate } from '../merge/merge.js';

/** Each value once, in the order given, without `except`. */
const uniqueWithout = (values: string[], except: string): string[] => [...new Set(values)].filter((v) => v !== except);

/**
 * The finding with its fingerprint made from where it now is; a fingerprint it had before that differs is kept as an
 * alias, so a dismissal or a post made under the old one still recognises it.
 */
export function withPlace(f: Finding): Finding {
  const print = fingerprint(f);
  const aliases = uniqueWithout([...(f.aliases ?? []), f.fingerprint], print);
  const { aliases: _old, ...rest } = f;
  return { ...rest, fingerprint: print, ...(aliases.length > 0 ? { aliases } : {}) };
}

/**
 * The earlier review's findings at the new head, found by code. Each is looked for by its quote in its own file, or in
 * the file it was renamed to: the whole quote on its earlier lines of the same file is `still-open` with its earlier
 * place; found elsewhere by the anchoring the anchor stage uses, `moved` with that new anchor and comment line, its quote
 * the file's own lines; not found (or its file gone or unreadable), vanished, as it was. The earlier review's `fixed`
 * list is not carried. A carried finding names no group, since its group belongs to the earlier review's change map.
 */
export async function carryOver(
  prev: ReviewDocument, files: FileDiff[], read: (path: string) => Promise<string | null>,
): Promise<{ open: Finding[]; vanished: Finding[] }> {
  const cache = new Map<string, Promise<string | null>>();
  const readOnce = (path: string): Promise<string | null> => {
    let hit = cache.get(path);
    if (!hit) {
      hit = Promise.resolve().then(() => read(path)).catch(() => null);
      cache.set(path, hit);
    }
    return hit;
  };
  const renamedTo = new Map(files.flatMap((d) => (d.status === 'renamed' && d.oldPath !== null ? [[d.oldPath, d.path] as const] : [])));
  const deleted = new Set(files.filter((d) => d.status === 'deleted').map((d) => d.path));

  const open: Finding[] = [];
  const vanished: Finding[] = [];
  for (const earlier of prev.findings) {
    const f: Finding = { ...earlier, cohortId: null };
    const path = renamedTo.get(f.path) ?? f.path;
    const text = deleted.has(path) ? null : await readOnce(path);
    const { startLine, endLine } = f.anchor;
    const onSameLines = path === f.path && startLine !== null && endLine !== null
      && findQuote(text, f.quote).some((at) => at.startLine === startLine && at.endLine === endLine);
    if (onSameLines) {
      open.push({ ...f, status: 'still-open' });
      continue;
    }
    const hint = startLine ?? f.lineHint;
    const { anchored } = await anchorCandidates([{ ...f, path, lineHint: hint }], files, readOnce);
    const found = anchored[0];
    if (found === undefined) {
      vanished.push(f);
      continue;
    }
    open.push(withPlace({ ...found, lineHint: f.lineHint, status: 'moved' }));
  }
  return { open, vanished };
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * A finding raised again is the same finding: each new item whose fingerprint or one of its aliases equals the
 * fingerprint or an alias of a carried finding is dropped at stage `merge` with `mergedInto` that carried finding (the
 * first that matches), which gains the item's fingerprint and aliases as its own aliases. Items and carried findings keep
 * the order given; the inputs are not changed.
 */
export function mergeIntoCarried<T extends AnchoredCandidate>(
  items: T[], carried: Finding[],
): { items: T[]; carried: Finding[]; dropped: Dropped[] } {
  const out = carried.map((f) => ({ ...f }));
  const left: T[] = [];
  const dropped: Dropped[] = [];
  for (const item of items) {
    const prints = [fingerprint(item), ...(item.aliases ?? [])];
    const same = out.find((f) => prints.some((p) => p === f.fingerprint || (f.aliases ?? []).includes(p)));
    if (same === undefined) {
      left.push(item);
      continue;
    }
    same.aliases = uniqueWithout([...(same.aliases ?? []), ...prints], same.fingerprint);
    if (same.aliases.length === 0) delete same.aliases;
    dropped.push({
      candidate: plainCandidate(item), stage: 'merge', refutation: null, mergedInto: same.id,
      reason: `raised again: the same finding as "${oneLine(same.title)}" from the last review`,
    });
  }
  return { items: left, carried: out, dropped };
}
