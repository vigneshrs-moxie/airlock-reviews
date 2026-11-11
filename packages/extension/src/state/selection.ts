import type { Dismissal, Finding } from '@airlock/shared';

export interface DismissedFinding { finding: Finding; dismissal: Dismissal }

export interface FindingLists {
  /** The top list in rank order, without dismissed findings. */
  top: Finding[];
  /** Also found, in the document's order, without dismissed findings. */
  also: Finding[];
  /** Findings of this document that have a dismissal. */
  dismissed: DismissedFinding[];
  /** Top then also found: the order Previous and Next and the fix prompt follow. */
  order: Finding[];
}

/**
 * The dismissal that applies to a finding: one recorded under its fingerprint, else one under any of its aliases (the
 * fingerprints of duplicates merged into it). The one place this is decided.
 */
export function dismissalOf(finding: Pick<Finding, 'fingerprint' | 'aliases'>, dismissals: readonly Dismissal[]): Dismissal | undefined {
  const own = dismissals.find((d) => d.fingerprint === finding.fingerprint);
  if (own !== undefined || finding.aliases === undefined || finding.aliases.length === 0) return own;
  const aliases = new Set(finding.aliases);
  return dismissals.find((d) => aliases.has(d.fingerprint));
}

/** Splits a document's findings into what is shown and what is dismissed. A dismissal for a finding not in the document is ignored. */
export function listFindings(findings: readonly Finding[], dismissals: readonly Dismissal[]): FindingLists {
  const top: Finding[] = [];
  const also: Finding[] = [];
  const dismissed: DismissedFinding[] = [];
  for (const finding of findings) {
    const dismissal = dismissalOf(finding, dismissals);
    if (dismissal !== undefined) dismissed.push({ finding, dismissal });
    else if (finding.bucket === 'top') top.push(finding);
    else also.push(finding);
  }
  const rank = (f: Finding): number => f.rank ?? Number.POSITIVE_INFINITY;
  top.sort((a, b) => (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1));
  return { top, also, dismissed, order: [...top, ...also] };
}

/** A copy of the set with `id` added, or removed when it was there. */
export function toggled(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** The selected findings in list order; an id that is not in the list (dismissed since) is dropped. */
export function selectedInOrder(order: readonly Finding[], selected: ReadonlySet<string>): Finding[] {
  return order.filter((f) => selected.has(f.id));
}

export function neighbours(order: readonly Finding[], id: string): { previous: Finding | null; next: Finding | null } {
  const at = order.findIndex((f) => f.id === id);
  if (at === -1) return { previous: null, next: null };
  return { previous: order[at - 1] ?? null, next: order[at + 1] ?? null };
}
