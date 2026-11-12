import { SEVERITY_WORD, type Dropped, type FileDiff, type Finding, type ReviewDocument, type Severity, type StageError } from '@airlock/shared';
import { anchorCandidates, findQuote } from '../anchor/anchor.js';
import { commentLine } from '../anchor/comment-line.js';
import { lineInDiff } from '../diff/parse.js';
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

/** A file that is at the head but cannot be read (too large, a link, not a regular file): `read` throws for it. */
const UNREADABLE = Symbol('unreadable');

/**
 * The earlier review's findings at the new head, found by code. Each is looked for by its quote in its own file, or in
 * the file it was renamed to: the whole quote on its earlier lines of the same file is `still-open` with its earlier
 * place, its connected places anchored again; found elsewhere by the anchoring the anchor stage uses, `moved` with that
 * new anchor and comment line, its quote the file's own lines; not found, or its file gone (`read` gives null, or the
 * diff deletes it), vanished, as it was. A file that is there but cannot be read (`read` throws) is never taken as gone:
 * the finding stays `still-open` with no place, and a stage error says why. The earlier review's `fixed` list is not
 * carried. A carried finding names no group, since its group belongs to the earlier review's change map.
 *
 * `judge` is the diff GitHub shows for the pull request (its whole diff on a push re-review): when given, a still-open
 * finding's status and comment line are judged again against it, and a moved one's come from it (see anchorCandidates).
 * Without it a still-open finding keeps its earlier anchor whole.
 */
export async function carryOver(
  prev: ReviewDocument, files: FileDiff[], read: (path: string) => Promise<string | null>, judge?: FileDiff[],
): Promise<{ open: Finding[]; vanished: Finding[]; errors: StageError[] }> {
  const cache = new Map<string, Promise<string | null | typeof UNREADABLE>>();
  const look = (path: string): Promise<string | null | typeof UNREADABLE> => {
    let hit = cache.get(path);
    if (!hit) {
      hit = Promise.resolve().then(() => read(path)).catch(() => UNREADABLE);
      cache.set(path, hit);
    }
    return hit;
  };
  const readOnce = async (path: string): Promise<string | null> => {
    const text = await look(path);
    return text === UNREADABLE ? null : text;
  };
  const renamedTo = new Map(files.flatMap((d) => (d.status === 'renamed' && d.oldPath !== null ? [[d.oldPath, d.path] as const] : [])));
  const deleted = new Set(files.filter((d) => d.status === 'deleted').map((d) => d.path));

  const open: Finding[] = [];
  const vanished: Finding[] = [];
  const errors: StageError[] = [];
  for (const earlier of prev.findings) {
    const f: Finding = { ...earlier, cohortId: null };
    const path = renamedTo.get(f.path) ?? f.path;
    const text = deleted.has(path) ? null : await look(path);
    if (text === UNREADABLE) {
      open.push({ ...f, status: 'still-open', anchor: { status: 'not-found', startLine: null, endLine: null, comment: null } });
      errors.push({ stage: 'anchor', cohortId: null, message: `${f.id}: the file ${path} could not be read at the head, so this earlier finding stays open.` });
      continue;
    }
    const { startLine, endLine } = f.anchor;
    const onSameLines = path === f.path && startLine !== null && endLine !== null
      && findQuote(text, f.quote).some((at) => at.startLine === startLine && at.endLine === endLine);
    if (onSameLines) {
      // Its own lines did not move; its connected places may have, so they are found again as a moved finding's are.
      const again = await anchorCandidates([f], files, readOnce, judge);
      open.push({
        ...f, status: 'still-open', connected: again.anchored[0]?.connected ?? f.connected,
        anchor: judge === undefined ? f.anchor : judged(judge.find((d) => d.path === path), startLine, endLine),
      });
      continue;
    }
    const hint = startLine ?? f.lineHint;
    const { anchored } = await anchorCandidates([{ ...f, path, lineHint: hint }], files, readOnce, judge);
    const found = anchored[0];
    if (found === undefined) {
      vanished.push(f);
      continue;
    }
    open.push(withPlace({ ...found, lineHint: f.lineHint, status: 'moved' }));
  }
  return { open, vanished, errors };
}

/** The anchor of lines that did not move, judged against the file's entry in the diff GitHub shows. */
function judged(file: FileDiff | undefined, startLine: number, endLine: number): Finding['anchor'] {
  const shown = file !== undefined && lineInDiff(file, startLine);
  return { status: shown ? 'in-diff' : 'outside-diff', startLine, endLine, comment: commentLine(file, startLine, endLine) };
}

/**
 * The earlier findings the document does not account for: neither among `findings` nor in `fixed`, nor dropped with a
 * `mergedInto` chain that ends at one of the findings. Each earlier finding must say what became of it.
 */
export function unaccounted(prev: ReviewDocument, findings: Finding[], fixed: Finding[], dropped: Dropped[]): Finding[] {
  const shown = new Set([...findings, ...fixed].map((f) => f.id));
  const into = new Map(dropped.flatMap((d) => (d.mergedInto ? [[d.candidate.id, d.mergedInto] as const] : [])));
  return prev.findings.filter((f) => {
    let id: string | undefined = f.id;
    for (let step = 0; id !== undefined && step <= into.size; step++) {
      if (shown.has(id)) return false;
      id = into.get(id);
    }
    return true;
  });
}

const SERIOUSNESS: Severity[] = ['note', 'ask', 'fix', 'block'];
const moreSerious = (a: Severity, than: Severity): boolean => SERIOUSNESS.indexOf(a) > SERIOUSNESS.indexOf(than);

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * A finding raised again is the same finding: each new item whose fingerprint or one of its aliases equals the
 * fingerprint or an alias of a carried finding is dropped at stage `merge` with `mergedInto` that carried finding (the
 * first that matches), which gains the item's fingerprint and aliases as its own aliases. The carried finding keeps its
 * own text and place, but takes the item's severity when that is more serious, and its `checked` then gains a sentence
 * saying so; a repeat that is as serious or less changes nothing else. Items and carried findings keep
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
    if (moreSerious(item.severity, same.severity)) {
      same.severity = item.severity;
      same.checked = `${same.checked} Raised again as ${SEVERITY_WORD[item.severity]} in this review.`;
    }
    dropped.push({
      candidate: plainCandidate(item), stage: 'merge', refutation: null, mergedInto: same.id,
      reason: `raised again: the same finding as "${oneLine(same.title)}" from the last review`,
    });
  }
  return { items: left, carried: out, dropped };
}
