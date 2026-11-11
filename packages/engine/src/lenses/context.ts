import type {
  Brief, Candidate, ChangeMap, Cohort, Dropped, Fact, FileDiff, FileFact, ModelConfig, PrInfo, Question, Source,
  StageError, Tier,
} from '@airlock/shared';
import { asMaterial } from '../agent/prompt.js';
import type { AgentRequest, AgentResult, AgentRunner, AgentUsage } from '../agent/runner.js';
import type { Pack } from '../packs/types.js';
import { LensOutputSchema, acceptCandidates } from './candidate.js';
import type { LensOutput } from './candidate.js';

/** What the lens stages need. `tiers` holds the read, skim, trust or ignored tier of each changed file. */
export interface LensContext {
  pr: PrInfo;
  map: ChangeMap;
  files: FileDiff[];
  tiers: FileFact[];
  facts: Fact[];
  brief: Brief;
  packs: Pack[];
  repoRules: { path: string; text: string }[];
  missingHelpers: string[];
  headDir: string;
  baseDir: string;
  models: ModelConfig;
  run: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface LensStageResult {
  candidates: Candidate[];
  questions: Question[];
  dropped: Dropped[];
  errors: StageError[];
  usage: AgentUsage[];
}

export const emptyResult = (): LensStageResult => ({ candidates: [], questions: [], dropped: [], errors: [], usage: [] });

export const STANDALONE_ID = 'standalone';
/** Lenses cannot fetch the description with their tools, so it is cut late. */
const MAX_DESCRIPTION_CHARS = 20_000;

const orNone = (lines: string[]): string => (lines.length === 0 ? '(none)' : lines.join('\n'));
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A file with no recorded tier is read, so nothing is skipped by accident. */
export function tierOf(tiers: FileFact[]): (path: string) => Tier {
  const byPath = new Map(tiers.map((t) => [t.path, t.tier]));
  return (path) => byPath.get(path) ?? 'read';
}

/** The standalone files as one cohort with a single layer. */
export function standaloneCohort(map: ChangeMap): Cohort {
  return {
    id: STANDALONE_ID, title: 'Standalone changes', summary: 'Changes with no clear relationship to the other cohorts.',
    layers: [{ id: `${STANDALONE_ID}.l1`, title: 'Standalone files', kind: 'other', files: [...map.standalone], dependsOn: [], note: '' }],
    neighbours: [], inferredLinks: [],
  };
}

/** Every file of a cohort once, in layer order. */
export function cohortFiles(cohort: Cohort): string[] {
  return [...new Set(cohort.layers.flatMap((l) => l.files))];
}

export const hasFilesToRead = (cohort: Cohort, tier: (path: string) => Tier): boolean =>
  cohortFiles(cohort).some((p) => tier(p) === 'read' || tier(p) === 'skim');

/** The cohorts the lenses review: map cohorts and then the standalone group, each only when it has a read or skim file. */
export function reviewedCohorts(ctx: LensContext): Cohort[] {
  const tier = tierOf(ctx.tiers);
  return [...ctx.map.cohorts, standaloneCohort(ctx.map)].filter((c) => hasFilesToRead(c, tier));
}

// ---- Instructions: the reviewer's own standard ----

/** Who reads the findings: the author on their own pull request, otherwise a reviewer who passes them on. */
export function readerOf(pr: PrInfo): string {
  return pr.author === pr.viewer
    ? 'The reader is the author, who will fix what you find before a senior reviewer sees the pull request.'
    : 'The reader is a reviewer deciding whether to ask the author for changes, who will pass on what you find in their own words.';
}

/** Every standard of every pack, each under a heading naming the pack and the standard. */
function standardsText(packs: Pack[]): string {
  const parts = packs.flatMap((p) => p.standards.map((s) => `## ${p.title}: ${s.name}\n\n${s.text.trim()}`));
  return parts.length === 0 ? '' : `# The team's standards\n\n${parts.join('\n\n')}`;
}

/** Learned entries of every pack as two lists; each list is left out when empty. */
function learnedText(packs: Pack[]): string {
  const list = (kind: 'wrong' | 'intended'): string[] =>
    packs.flatMap((p) => p.learned.filter((e) => e.kind === kind).map((e) => `- ${oneLine(e.text)}`));
  const parts: string[] = [];
  const wrong = list('wrong');
  const intended = list('intended');
  if (wrong.length > 0) parts.push(`## Things flagged before that were wrong\n\n${wrong.join('\n')}`);
  if (intended.length > 0) parts.push(`## Product facts to respect\n\n${intended.join('\n')}`);
  return parts.length === 0 ? '' : `# Learned from earlier reviews\n\n${parts.join('\n\n')}`;
}

function helpersText(missing: string[]): string {
  if (missing.length === 0) return '';
  return [
    '# Helpers that no longer exist',
    '',
    'The standards name these helpers, but they are not in the repository any more. Do not ask the author to use them.',
    '',
    ...missing.map((h) => `- \`${h}\``),
  ].join('\n');
}

/** The template, then the standards, the learned entries and (when given) the missing helpers. */
export function instructionsFor(template: string, packs: Pack[], missingHelpers: string[] | null): string {
  return [template.trimEnd(), standardsText(packs), learnedText(packs), missingHelpers ? helpersText(missingHelpers) : '']
    .filter((s) => s !== '')
    .join('\n\n');
}

// ---- Material: content under review ----

export function prBlock(pr: PrInfo): string {
  const body = pr.body.trim() === '' ? '(no description)' : pr.body;
  const description = body.length > MAX_DESCRIPTION_CHARS
    ? `${body.slice(0, MAX_DESCRIPTION_CHARS)}\n(description cut at ${MAX_DESCRIPTION_CHARS} characters)`
    : body;
  return asMaterial('pull request', `Title: ${pr.title}\n\n${description}`);
}

export function briefBlock(brief: Brief): string {
  const lines = ['What it does:', ...(brief.whatItDoes.length === 0 ? ['(not known)'] : brief.whatItDoes.map((l) => `- ${l}`))];
  lines.push('', 'Claims in the description:');
  if (brief.claims.length === 0) lines.push('(none)');
  for (const c of brief.claims) lines.push(`- [${c.verdict}] ${oneLine(c.text)} — ${oneLine(c.evidence)}`);
  return asMaterial('brief', lines.join('\n'));
}

/** A cohort's title, summary and layers in order, each with its kind, dependencies, note and files. */
export function cohortOutline(cohort: Cohort, tier?: (path: string) => Tier): string[] {
  const lines = [`Cohort: ${cohort.title}`];
  if (cohort.summary.trim() !== '') lines.push(`  ${oneLine(cohort.summary)}`);
  for (const l of cohort.layers) {
    const deps = l.dependsOn.length > 0 ? `, depends on ${l.dependsOn.join(', ')}` : '';
    lines.push(`  Layer ${l.id} (${l.kind}): ${oneLine(l.title)}${deps}`);
    if (l.note.trim() !== '') lines.push(`    Note: ${oneLine(l.note)}`);
    for (const f of l.files) lines.push(tier ? `    ${f} [${tier(f)}]` : `    ${f}`);
  }
  return lines;
}

/** Every cohort of the map with its layers and files, then the standalone files. */
export function mapBlock(map: ChangeMap): string {
  const lines = map.cohorts.flatMap((c) => cohortOutline(c));
  if (map.standalone.length > 0) lines.push('Standalone files:', ...map.standalone.map((f) => `  ${f}`));
  return asMaterial('change map', orNone(lines));
}

/** One line per fact: `path:line check: message`, or `path check: message` when there is no line. */
export function factsBlock(facts: Fact[]): string {
  const lines = facts.map((f) => `${f.path}${f.line === null ? '' : `:${f.line}`} ${f.checkId}: ${oneLine(f.message)}`);
  return asMaterial('facts', orNone(lines));
}

/** One line per candidate: `severity | title | path`. */
export function candidateLines(candidates: Candidate[]): string[] {
  return candidates.map((c) => `${c.severity} | ${oneLine(c.title)} | ${c.path}`);
}

// ---- Running one request ----

export interface LensCall {
  role: string;
  /** `<pack id>/<lens id>`, used in error messages. */
  name: string;
  stage: 'lenses' | 'seams';
  source: Source;
  cohortId: string | null;
  instructions: string;
  material: string;
}

/** Sends one request through the parallel cap. A runner that throws becomes a failed result, so one request never stops the others. */
export async function sendRequest<T>(runner: AgentRunner, ctx: LensContext, req: AgentRequest<T>): Promise<AgentResult<T>> {
  try {
    return await ctx.run(() => runner.run(req));
  } catch (err) {
    const usage: AgentUsage = { ms: 0, inputTokens: 0, outputTokens: 0, costUsd: null, turns: 0 };
    return { ok: false, error: err instanceof Error ? err.message : String(err), usage };
  }
}

/** Sends one request through the parallel cap and turns its answer into candidates, questions and dropped extras. */
export async function runLensCall(runner: AgentRunner, ctx: LensContext, call: LensCall, taken: Set<string>): Promise<LensStageResult> {
  const result = await sendRequest<LensOutput>(runner, ctx, {
    role: call.role,
    instructions: call.instructions,
    material: call.material,
    schema: LensOutputSchema,
    cwd: ctx.headDir,
    extraDirs: [ctx.baseDir],
    model: ctx.models.main,
    effort: ctx.models.effort,
  });
  const out = emptyResult();
  out.usage.push(result.usage);
  if (!result.ok) {
    out.errors.push({ stage: call.stage, cohortId: call.cohortId, message: `${call.name}: ${result.error}` });
    return out;
  }
  const accepted = acceptCandidates(result.output.candidates, call.source, call.cohortId, taken);
  out.candidates.push(...accepted.candidates);
  out.dropped.push(...accepted.dropped);
  for (const q of result.output.questions) {
    if (q.trim() !== '') out.questions.push({ text: q.trim(), cohortId: call.cohortId, source: call.source });
  }
  out.questions.push(...accepted.questions);
  return out;
}

/** Joins results in the order given. */
export function mergeResults(results: LensStageResult[]): LensStageResult {
  const out = emptyResult();
  for (const r of results) {
    out.candidates.push(...r.candidates);
    out.questions.push(...r.questions);
    out.dropped.push(...r.dropped);
    out.errors.push(...r.errors);
    out.usage.push(...r.usage);
  }
  return out;
}
