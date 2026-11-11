import { z } from 'zod';

const text = z.string().trim().min(1);

export const SeveritySchema = z.enum(['block', 'fix', 'ask', 'note']);
export type Severity = z.infer<typeof SeveritySchema>;
export const TierSchema = z.enum(['read', 'skim', 'trust', 'ignored']);
export type Tier = z.infer<typeof TierSchema>;
export const DepthSchema = z.enum(['quick', 'standard', 'deep']);
export type Depth = z.infer<typeof DepthSchema>;
export const StageSchema = z.enum(['pr1', 'pr2', 'pr3', 'other']);
export type Stage = z.infer<typeof StageSchema>;

export const PrInfoSchema = z.object({
  repo: z.string(), number: z.number().int(), title: z.string(), body: z.string(), author: z.string(),
  viewer: z.string(), baseRef: z.string(), headRef: z.string(), baseSha: z.string(), headSha: z.string(),
  isFork: z.boolean(), additions: z.number().int(), deletions: z.number().int(),
  changedFiles: z.number().int(), url: z.string(), stage: StageSchema,
});
export type PrInfo = z.infer<typeof PrInfoSchema>;

export const ReviewRangeSchema = z.object({
  baseSha: z.string(), headSha: z.string(),
  kind: z.enum(['full', 'rereview', 'sync-merge', 'explicit']),
});
export type ReviewRange = z.infer<typeof ReviewRangeSchema>;

export const DiffLineSchema = z.object({
  kind: z.enum(['add', 'del', 'ctx']), oldNo: z.number().int().nullable(),
  newNo: z.number().int().nullable(), text: z.string(),
});
export type DiffLine = z.infer<typeof DiffLineSchema>;

export const HunkSchema = z.object({
  oldStart: z.number().int(), oldLines: z.number().int(), newStart: z.number().int(),
  newLines: z.number().int(), header: z.string(), lines: z.array(DiffLineSchema),
});
export type Hunk = z.infer<typeof HunkSchema>;

export const FileDiffSchema = z.object({
  path: z.string(), oldPath: z.string().nullable(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']), binary: z.boolean(),
  additions: z.number().int(), deletions: z.number().int(), hunks: z.array(HunkSchema),
  /** The file's git mode on the head (the base for a deleted file), such as `100644` or `120000` for a symbolic link. */
  mode: z.string().nullable().optional(),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;

export const FileFactSchema = z.object({ path: z.string(), tier: TierSchema, reason: z.string() });
export type FileFact = z.infer<typeof FileFactSchema>;

export const FactSchema = z.object({
  checkId: z.string(), path: z.string(), line: z.number().int().nullable(), message: z.string(),
});
export type Fact = z.infer<typeof FactSchema>;

export const LinkSchema = z.object({
  from: z.string(), to: z.string(), kind: z.enum(['imports', 'uses', 'convention', 'tests']),
  detail: z.string(), line: z.number().int().nullable(),
});
export type Link = z.infer<typeof LinkSchema>;

export const NeighbourSchema = z.object({
  path: z.string(), role: z.enum(['caller', 'callee', 'sibling']),
  forFiles: z.array(z.string()), why: z.string(),
});
export type Neighbour = z.infer<typeof NeighbourSchema>;

export const LayerKindSchema = z.enum(['data', 'rules', 'writes', 'reads', 'screens', 'jobs', 'tests', 'config', 'other']);
export type LayerKind = z.infer<typeof LayerKindSchema>;

export const LayerSchema = z.object({
  id: z.string(), title: z.string(), kind: LayerKindSchema, files: z.array(z.string()),
  dependsOn: z.array(z.string()), note: z.string(),
});
export type Layer = z.infer<typeof LayerSchema>;

export const CohortSchema = z.object({
  id: z.string(), title: z.string(), summary: z.string(), layers: z.array(LayerSchema),
  neighbours: z.array(NeighbourSchema), inferredLinks: z.array(z.string()),
});
export type Cohort = z.infer<typeof CohortSchema>;

export const ChangeMapSchema = z.object({
  cohorts: z.array(CohortSchema), standalone: z.array(z.string()), links: z.array(LinkSchema),
});
export type ChangeMap = z.infer<typeof ChangeMapSchema>;

export const ClaimSchema = z.object({
  text: z.string(), verdict: z.enum(['verified', 'not-supported', 'unclear']), evidence: z.string(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const BriefSchema = z.object({ whatItDoes: z.array(z.string()), claims: z.array(ClaimSchema) });
export type Brief = z.infer<typeof BriefSchema>;

export const PlaceSchema = z.object({
  path: z.string(), line: z.number().int().nullable(), role: z.string(), quote: z.string(),
});
export type Place = z.infer<typeof PlaceSchema>;

export const SourceSchema = z.object({
  pack: z.string(), lens: z.string().nullable(), ruleId: z.string().nullable(),
});
export type Source = z.infer<typeof SourceSchema>;

export const CandidateSchema = z.object({
  id: z.string(), source: SourceSchema, cohortId: z.string().nullable(), severity: SeveritySchema,
  title: text, path: text, quote: text, lineHint: z.number().int().nullable(),
  happens: text, why: text, suggestedChange: z.string(), connected: z.array(PlaceSchema),
  wouldBeWrongIf: z.string(), confidence: z.enum(['high', 'medium', 'low']),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const AnchorSchema = z.object({
  status: z.enum(['in-diff', 'outside-diff', 'not-found']),
  startLine: z.number().int().nullable(), endLine: z.number().int().nullable(),
});
export type Anchor = z.infer<typeof AnchorSchema>;

export const FindingSchema = CandidateSchema.extend({
  anchor: AnchorSchema, fingerprint: z.string(), checked: z.string(),
  bucket: z.enum(['top', 'also']), rank: z.number().int().nullable(),
  status: z.enum(['new', 'still-open', 'fixed', 'moved']).nullable(),
  /** The lenses and rules whose duplicates were merged into this finding. */
  alsoRaisedBy: z.array(SourceSchema).optional(),
  /** The fingerprints of those duplicates, so a dismissal or a re-review can recognise the finding under any of them. */
  aliases: z.array(z.string()).optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const DroppedSchema = z.object({
  candidate: CandidateSchema, stage: z.enum(['schema', 'anchor', 'merge', 'challenge', 'select']),
  reason: z.string(), refutation: PlaceSchema.nullable(),
  /** For a duplicate merged into another finding: the id of the finding that was kept. */
  mergedInto: z.string().nullable().optional(),
});
export type Dropped = z.infer<typeof DroppedSchema>;

export const QuestionSchema = z.object({
  text: z.string(), cohortId: z.string().nullable(), source: SourceSchema,
});
export type Question = z.infer<typeof QuestionSchema>;

export const VerdictLabelSchema = z.enum([
  'not-ready', 'ready-for-pr2', 'split-first', 'request-changes', 'approve-after-fixes', 'approve', 'incomplete',
]);
export type VerdictLabel = z.infer<typeof VerdictLabelSchema>;

export const VerdictSchema = z.object({
  label: VerdictLabelSchema, sentence: z.string(),
  counts: z.object({ block: z.number().int(), fix: z.number().int(), ask: z.number().int(), note: z.number().int() }),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const StageErrorKindSchema = z.enum(['invalid-output', 'turn-limit', 'usage-limit', 'timeout', 'other']);
export type StageErrorKind = z.infer<typeof StageErrorKindSchema>;

export const StageErrorSchema = z.object({
  stage: z.string(), cohortId: z.string().nullable(), message: z.string(),
  /** Why the stage failed, when the engine can tell. A usage limit or a timeout is worth running again; a bad answer is not. */
  kind: StageErrorKindSchema.optional(),
});
export type StageError = z.infer<typeof StageErrorSchema>;

export const StageTimingSchema = z.object({
  stage: z.string(), ms: z.number(), agentRuns: z.number().int(), inputTokens: z.number().int(),
  outputTokens: z.number().int(), costUsd: z.number().nullable(),
  /** When the stage started and finished (ISO times). Stages can overlap, so elapsed time is not the sum of `ms`. */
  startedAt: z.string().optional(), finishedAt: z.string().optional(),
  /** Model turns used by the stage's requests. */
  turns: z.number().int().optional(),
});
export type StageTiming = z.infer<typeof StageTimingSchema>;

export const PackRefSchema = z.object({ id: z.string(), version: z.string() });
export type PackRef = z.infer<typeof PackRefSchema>;

export const ModelConfigSchema = z.object({
  main: z.string(), challenger: z.string(), sweep: z.string(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const ReviewDocumentSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), createdAt: z.string(), pr: PrInfoSchema,
  range: ReviewRangeSchema, depth: DepthSchema, packs: z.array(PackRefSchema), models: ModelConfigSchema,
  files: z.array(FileFactSchema), facts: z.array(FactSchema), map: ChangeMapSchema, brief: BriefSchema,
  verdict: VerdictSchema, findings: z.array(FindingSchema), questions: z.array(QuestionSchema),
  dropped: z.array(DroppedSchema), candidates: z.array(CandidateSchema), whoseCall: z.array(z.string()),
  checksAfterMerge: z.array(z.string()), selfReviewText: z.string(), stageErrors: z.array(StageErrorSchema),
  timings: z.array(StageTimingSchema),
  /** Plain sentences saying what a model was not shown because of a size limit (a diff cut short, rule files left out). */
  limits: z.array(z.string()).optional(),
  /** Plain sentences about what the engine did that a reader may want to know (a group it did not merge, a merged question). */
  notes: z.array(z.string()).optional(),
  /** When the review started (ISO time). `createdAt` is when the document was assembled, at the end of the review. */
  startedAt: z.string().optional(),
});
export type ReviewDocument = z.infer<typeof ReviewDocumentSchema>;
