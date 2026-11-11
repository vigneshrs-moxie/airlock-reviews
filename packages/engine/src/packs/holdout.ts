import type { Holdout, Pack } from './types.js';

const ENTRY_START = /^(\d{4}-\d{2}-\d{2}) ·/;

const day = (iso: string): string => iso.slice(0, 10);

function dropDatedEntries(text: string, reviewedAt: string): string {
  const out: string[] = [];
  let dropping = false;
  for (const line of text.split('\n')) {
    const start = ENTRY_START.exec(line);
    if (start) dropping = day(start[1]!) >= reviewedAt;
    else if (line.trim() === '') dropping = false;
    if (!dropping) out.push(line);
  }
  return out.join('\n');
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
