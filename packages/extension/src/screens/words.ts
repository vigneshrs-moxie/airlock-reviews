import { SEVERITY_WORD, type Depth, type DismissReason, type Dropped, type Finding, type PrSummary, type Severity, type Source } from '@airlock/shared';
import { placeText } from '../place-text';

export const CODE_QUOTE_LIMIT = 160;

const REASON: Record<DismissReason, string> = { wrong: 'Wrong', intended: 'Intended', 'not-now': 'Not now' };
const DEPTH: Record<Depth, string> = { quick: 'Quick', standard: 'Standard', deep: 'Deep' };
const SIDE: Record<string, string> = {
  head: 'in the pull request', base: 'before the pull request', standard: "the team's corrections log", learned: 'a recorded decision',
};

export const severityWord = (severity: Severity): string => SEVERITY_WORD[severity];
export const dismissReasonWord = (reason: DismissReason): string => REASON[reason];
export const depthWord = (depth: Depth): string => DEPTH[depth];
export const proofSide = (role: string): string => (Object.hasOwn(SIDE, role) ? (SIDE[role] as string) : role);

/** A code quote cut to `CODE_QUOTE_LIMIT` characters, ending in `…` when cut. Counts code points. */
export function clipQuote(quote: string): string {
  const chars = [...quote];
  return chars.length <= CODE_QUOTE_LIMIT ? quote : `${chars.slice(0, CODE_QUOTE_LIMIT).join('')}…`;
}

export { placeText } from '../place-text';

/** Where a finding is, by its anchor: the start line, or what is known when the line is not in the changed lines. */
export function locationText(finding: Finding): string {
  const { status, startLine } = finding.anchor;
  if (status === 'outside-diff') return `${finding.path}, outside the changed lines`;
  if (status === 'not-found') return finding.path;
  return placeText(finding.path, startLine);
}

type PackTitles = readonly Pick<PrSummary['packs'][number], 'id' | 'title'>[];

/** The pack's title (its id when it has none here) and the lens or rule. */
export function sourceText({ pack, lens, ruleId }: Source, packs: PackTitles): string {
  const title = packs.find((p) => p.id === pack)?.title ?? pack;
  const how = lens ?? ruleId;
  return how === null ? title : `${title} · ${how}`;
}

/** The pack and the lens or rule that raised the finding. */
export const fromText = (finding: Finding, packs: PackTitles): string => sourceText(finding.source, packs);

const WHERE: Record<string, string> = {
  schema: 'when checking its format',
  anchor: 'when finding its line',
  challenge: 'in the challenge',
  select: 'when ranking',
  lenses: 'while reading the code',
  'lenses-deep': 'in the closer second pass',
  sweep: 'in the rule sweep',
  seams: 'when checking how the parts fit',
  map: 'when grouping the changes',
  brief: 'when working out what the pull request does',
  intake: 'when getting the pull request',
  packs: 'when loading the rule packs',
  shape: 'when checking the kind of pull request',
  facts: 'when sorting the files',
  store: 'when saving the review',
};

/** Where something was dropped or failed, in words; a stage not listed is shown as written. */
export const stageWhere = (stage: string): string => (Object.hasOwn(WHERE, stage) ? (WHERE[stage] as string) : stage);

/** How a candidate was dropped, in words: a duplicate merged into another finding is dropped "as a duplicate". */
export const droppedHow = (stage: Dropped['stage']): string => (stage === 'merge' ? 'as a duplicate' : stageWhere(stage));
