import type { Depth, DismissReason, Finding, PrSummary, Severity } from '@airlock/shared';

export const CODE_QUOTE_LIMIT = 160;

const SEVERITY: Record<Severity, string> = { block: 'Block', fix: 'Fix', ask: 'Ask', note: 'Note' };
const REASON: Record<DismissReason, string> = { wrong: 'Wrong', intended: 'Intended', 'not-now': 'Not now' };
const DEPTH: Record<Depth, string> = { quick: 'Quick', standard: 'Standard', deep: 'Deep' };
const SIDE: Record<string, string> = {
  head: 'in the pull request', base: 'before the pull request', standard: "the team's corrections log", learned: 'a recorded decision',
};

export const severityWord = (severity: Severity): string => SEVERITY[severity];
export const dismissReasonWord = (reason: DismissReason): string => REASON[reason];
export const depthWord = (depth: Depth): string => DEPTH[depth];
export const proofSide = (role: string): string => (Object.hasOwn(SIDE, role) ? (SIDE[role] as string) : role);

/** A code quote cut to `CODE_QUOTE_LIMIT` characters, ending in `…` when cut. Counts code points. */
export function clipQuote(quote: string): string {
  const chars = [...quote];
  return chars.length <= CODE_QUOTE_LIMIT ? quote : `${chars.slice(0, CODE_QUOTE_LIMIT).join('')}…`;
}

/** A path with a line, or the path alone when there is no line. */
export const placeText = (path: string, line: number | null): string => (line === null ? path : `${path}:${line}`);

/** Where a finding is, by its anchor: the start line, or what is known when the line is not in the changed lines. */
export function locationText(finding: Finding): string {
  const { status, startLine } = finding.anchor;
  if (status === 'outside-diff') return `${finding.path}, outside the changed lines`;
  if (status === 'not-found') return finding.path;
  return placeText(finding.path, startLine);
}

/** The pack's title (its id when it has none here) and the lens or rule that raised the finding. */
export function fromText(finding: Finding, packs: readonly Pick<PrSummary['packs'][number], 'id' | 'title'>[]): string {
  const { pack, lens, ruleId } = finding.source;
  const title = packs.find((p) => p.id === pack)?.title ?? pack;
  const how = lens ?? ruleId;
  return how === null ? title : `${title} · ${how}`;
}
