import type { Holdout, Pack } from './types.js';

const ENTRY_START = /^(\d{4}-\d{2}-\d{2}) ·/;

const day = (iso: string): string => iso.slice(0, 10);

type EntryLine = { line: string; entry: { index: number; date: string } | null };

/**
 * Each line of a dated standard with the entry it belongs to, or null outside any entry. An entry runs from a line that
 * starts `YYYY-MM-DD ·` to the next entry start or blank line.
 */
function entryLines(text: string): EntryLine[] {
  const out: EntryLine[] = [];
  let entry: EntryLine['entry'] = null;
  let index = -1;
  for (const line of text.split('\n')) {
    const start = ENTRY_START.exec(line);
    if (start) entry = { index: ++index, date: start[1]! };
    else if (line.trim() === '') entry = null;
    out.push({ line, entry });
  }
  return out;
}

/** The entries of a dated standard, each with its date and its text without the `YYYY-MM-DD ·` start. */
export function datedEntries(text: string): { date: string; body: string }[] {
  const entries: { date: string; lines: string[] }[] = [];
  for (const { line, entry } of entryLines(text)) {
    if (entry === null) continue;
    if (entries.length === entry.index) entries.push({ date: entry.date, lines: [line.replace(ENTRY_START, '').trim()] });
    else entries[entry.index]!.lines.push(line);
  }
  return entries.map((e) => ({ date: e.date, body: e.lines.join('\n') }));
}

function dropDatedEntries(text: string, reviewedAt: string): string {
  return entryLines(text)
    .filter(({ entry }) => entry === null || day(entry.date) < reviewedAt)
    .map(({ line }) => line)
    .join('\n');
}

export function applyHoldout(pack: Pack, h: Holdout): Pack {
  const cutoff = day(h.reviewedAt);
  return {
    ...pack,
    rules: pack.rules.filter((r) => !r.sourcePrs.includes(h.pr)),
    standards: pack.standards.map((s) => (s.dated ? { ...s, text: dropDatedEntries(s.text, cutoff) } : s)),
    learned: pack.learned.filter((l) => day(l.date) < cutoff),
  };
}
