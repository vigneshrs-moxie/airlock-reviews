import type {
  Brief, Candidate, ChangeMap, Cohort, Dropped, Fact, FileDiff, FileFact, ModelConfig, PrInfo, Question, Source,
  StageError, Tier,
} from '@airlock/shared';
import { asMaterial, PROMPT_BOUNDARY } from '../agent/prompt.js';
import { UNKNOWN_USAGE } from '../agent/runner.js';
import type { AgentRequest, AgentResult, AgentRunner, AgentUsage } from '../agent/runner.js';
import type { Pack } from '../packs/types.js';
import { LensOutputSchema, acceptCandidates, acceptCombined, combinedOutputSchema } from './candidate.js';
import type { Accepted, CombinedOutput, LensOutput } from './candidate.js';

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
  /** One more sentence for every cohort lens request, added after the lens's own instructions (the deep pass uses it). */
  extraInstructions?: string;
  /**
   * When the lenses of a group go in one combined request: `all` for every group (quick depth), `no-read-tier` for a group
   * with no file in the read tier and for the standalone group; otherwise each lens has its own request.
   */
  combine?: 'all' | 'no-read-tier';
}

export interface LensStageResult {
  candidates: Candidate[];
  questions: Question[];
  dropped: Dropped[];
  errors: StageError[];
  usage: AgentUsage[];
  /** Plain sentences saying what a request was not shown because of a size limit. */
  limits: string[];
}

export const emptyResult = (): LensStageResult => ({ candidates: [], questions: [], dropped: [], errors: [], usage: [], limits: [] });

export const STANDALONE_ID = 'standalone';
/** Lenses cannot fetch the description with their tools, so it is cut late. */
export const MAX_DESCRIPTION_CHARS = 20_000;

// ---- What a model was not shown ----

/** How much of a diff a budget let through: changed lines shown and in all, and how many files were cut. */
export interface DiffCut { shown: number; total: number; files: number }

const count = (n: number): string => n.toLocaleString('en-US');

/** `<stage>: <title>: <n> of <m> changed lines were shown (<k> files cut)`. */
export const diffCutSentence = (stage: string, title: string, cut: DiffCut): string =>
  `${stage}: ${oneLine(title)}: ${count(cut.shown)} of ${count(cut.total)} changed lines were shown (${cut.files === 1 ? '1 file' : `${count(cut.files)} files`} cut)`;

/** `<who>: the description was cut at <max> of <n> characters`, or null when it was not cut. */
export const descriptionCutSentence = (who: string, body: string, max: number): string | null =>
  (body.length > max ? `${who}: the description was cut at ${count(max)} of ${count(body.length)} characters` : null);

/** The lines joined, or `(none)` for a block with nothing in it. */
export const orNone = (lines: string[]): string => (lines.length === 0 ? '(none)' : lines.join('\n'));
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

/**
 * A named piece of the instructions' standard: one pack standard, or one list of learned entries. `dated` is true for a
 * standard kept as dated entries (the corrections log).
 */
export interface StandardDocument {
  name: string;
  text: string;
  dated: boolean;
}

/** Every standard of every pack, named `<pack title>: <standard name>`. */
export function standardDocuments(packs: Pack[]): StandardDocument[] {
  return packs.flatMap((p) => p.standards.map((s) => ({ name: `${p.title}: ${s.name}`, text: s.text.trim(), dated: s.dated })));
}

/** The heading each kind of learned entry is listed under. */
export const learnedListName = (kind: 'wrong' | 'intended'): string =>
  kind === 'wrong' ? 'Things flagged before that were wrong' : 'Product facts to respect';

/** Learned entries of every pack as two lists, one entry per line; each list is left out when empty. */
export function learnedDocuments(packs: Pack[]): StandardDocument[] {
  const list = (kind: 'wrong' | 'intended'): StandardDocument[] => {
    const lines = packs.flatMap((p) => p.learned.filter((e) => e.kind === kind).map((e) => `- ${oneLine(e.text)}`));
    return lines.length === 0 ? [] : [{ name: learnedListName(kind), text: lines.join('\n'), dated: false }];
  };
  return [...list('wrong'), ...list('intended')];
}

const section = (title: string, docs: StandardDocument[]): string =>
  docs.length === 0 ? '' : `# ${title}\n\n${docs.map((d) => `## ${d.name}\n\n${d.text}`).join('\n\n')}`;

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

/**
 * The standards, the learned entries and the missing helpers first, then the boundary line, then the stage's template.
 * Everything before the boundary is the same for every stage of a review that is given the same packs and helpers, so it
 * is cached across its requests; nothing from the pull request may go there.
 */
export function instructionsFor(template: string, packs: Pack[], missingHelpers: string[]): string {
  return [
    section("The team's standards", standardDocuments(packs)),
    section('Learned from earlier reviews', learnedDocuments(packs)),
    helpersText(missingHelpers),
    PROMPT_BOUNDARY,
    template.trim(),
  ]
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

/** The change map block lists at most this many files; the rest are counted on its last line. */
export const MAX_MAP_FILES = 200;

const mapFileCount = (map: ChangeMap): number =>
  map.cohorts.reduce((n, c) => n + c.layers.reduce((m, l) => m + l.files.length, 0), 0) + map.standalone.length;

/**
 * Every cohort of the map with its layers and files, then the standalone files. After MAX_MAP_FILES files the rest are
 * left out (the cohort and layer lines stay) and the last line says `… and <n> more`.
 */
export function mapBlock(map: ChangeMap): string {
  let room = MAX_MAP_FILES;
  const files = (paths: string[]): string[] => {
    const shown = paths.slice(0, Math.max(0, room));
    room -= shown.length;
    return shown;
  };
  const lines = map.cohorts.flatMap((c) => cohortOutline({ ...c, layers: c.layers.map((l) => ({ ...l, files: files(l.files) })) }));
  const standalone = files(map.standalone);
  if (map.standalone.length > 0) lines.push('Standalone files:', ...standalone.map((f) => `  ${f}`));
  const left = mapFileCount(map) - MAX_MAP_FILES;
  if (left > 0) lines.push(`… and ${left} more`);
  return asMaterial('change map', orNone(lines));
}

/** `<stage>: the change map listed <max> of <n> files`, or null when mapBlock listed every file. */
export function mapCutSentence(stage: string, map: ChangeMap): string | null {
  const total = mapFileCount(map);
  return total > MAX_MAP_FILES ? `${stage}: the change map listed ${count(MAX_MAP_FILES)} of ${count(total)} files` : null;
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
  /** For a combined request: each lens it carries, by the id candidates name it with (`<pack>/<lens>`). */
  lenses?: ReadonlyMap<string, Source>;
}

/** Sends one request through the parallel cap. A runner that throws becomes a failed result, so one request never stops the others. */
export async function sendRequest<T>(runner: AgentRunner, ctx: LensContext, req: AgentRequest<T>): Promise<AgentResult<T>> {
  try {
    return await ctx.run(() => runner.run(req));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), kind: 'other', usage: { ...UNKNOWN_USAGE } };
  }
}

/** Sends one request through the parallel cap and turns its answer into candidates, questions and dropped extras. */
export async function runLensCall(runner: AgentRunner, ctx: LensContext, call: LensCall, taken: Set<string>): Promise<LensStageResult> {
  const result = await sendRequest<LensOutput | CombinedOutput>(runner, ctx, {
    role: call.role,
    instructions: call.instructions,
    material: call.material,
    schema: call.lenses === undefined ? LensOutputSchema : combinedOutputSchema([...call.lenses.keys()]),
    cwd: ctx.headDir,
    extraDirs: [ctx.baseDir],
    model: ctx.models.main,
    effort: ctx.models.effort,
  });
  const out = emptyResult();
  out.usage.push(result.usage);
  if (!result.ok) {
    out.errors.push({ stage: call.stage, cohortId: call.cohortId, message: `${call.name}: ${result.error}`, kind: result.kind });
    return out;
  }
  const accepted: Accepted = call.lenses === undefined
    ? acceptCandidates(result.output.candidates, call.source, call.cohortId, taken)
    : acceptCombined(result.output.candidates, call.lenses, call.cohortId, taken);
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
    out.limits.push(...r.limits);
  }
  return out;
}
