/** Each stage the engine reports, in the prototype's words. A stage not listed here is shown by its own name. */
export const STAGE_WORDS = {
  intake: 'Reading the pull request',
  packs: 'Choosing the packs for this pull request',
  shape: 'Checking for a sync merge, a stack or a re-review',
  facts: 'Sorting the files and running the code checks',
  map: 'Mapping the change',
  brief: 'Working out what the pull request does',
  lenses: 'Looking through each lens',
  sweep: 'Checking each file against the pack rules',
  seams: 'Checking where the groups meet',
  anchor: 'Finding the lines for each finding',
  challenge: 'Challenging every finding',
  'lenses-deep': 'Taking a second, deeper look',
  select: 'Ranking and picking the top five',
  summary: 'Writing the short version of each finding',
  store: 'Saving the review',
} as const satisfies Record<string, string>;

export function stageWords(stage: string): string {
  return Object.hasOwn(STAGE_WORDS, stage) ? STAGE_WORDS[stage as keyof typeof STAGE_WORDS] : stage;
}
