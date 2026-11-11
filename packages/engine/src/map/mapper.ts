import { stat } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { CohortSchema } from '@airlock/shared';
import type { ChangeMap, Cohort, FileDiff, FileFact, Link, ModelConfig, Neighbour, PrInfo, StageErrorKind } from '@airlock/shared';
import { z } from 'zod';
import { asMaterial, fill, loadTemplate } from '../agent/prompt.js';
import type { AgentRequest, AgentRunner, AgentUsage } from '../agent/runner.js';
import { descriptionCutSentence } from '../lenses/context.js';
import { checkChangeMap, placeablePaths } from './check.js';

export interface MapInput {
  pr: PrInfo;
  files: FileDiff[];
  facts: FileFact[];
  links: Link[];
  neighbours: Neighbour[];
  headDir: string;
  model: string;
  effort: ModelConfig['effort'];
}

export interface MapResult {
  map: ChangeMap;
  usage: AgentUsage[];
  error: string | null;
  /** Why the map failed, when it did. */
  errorKind?: StageErrorKind;
  /** Plain sentences saying what the mapper was not shown because of a size limit. */
  limits: string[];
}

const MapperAnswerSchema = z.object({ cohorts: z.array(CohortSchema), standalone: z.array(z.string()) });
type MapperAnswer = z.infer<typeof MapperAnswerSchema>;

/**
 * Limits that keep the request small for a huge pull request. The file table is never cut; the links get what is left of
 * the material budget after the other blocks, up to their own limits.
 */
const MATERIAL_BUDGET = 56_000;
const MAX_LINK_LINES = 400;
const MAX_LINK_CHARS = 24_000;
const MAX_NEIGHBOUR_LINES = 60;
const MAX_NEIGHBOUR_CHARS = 8_000;
const MAX_DESCRIPTION_CHARS = 6_000;
const MAX_ERROR_CHARS = 300;

const RETRY_SENTENCE = 'Your previous answer could not be used. The problems are listed in the material block below. Fix them and return the whole map again.';
const PROBLEMS_LABEL = 'problems with your previous answer';

const FALLBACK_SUMMARY = 'Grouped by code links because the mapper did not return a valid map.';

/** Links whose two ends are both in `paths`. */
function linksBetween(links: Link[], paths: Set<string>): Link[] {
  return links.filter((l) => paths.has(l.from) && paths.has(l.to));
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const clip = (text: string): string => (text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text);
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Takes lines in order until either limit is reached, then adds one line saying how many were left out. */
function capLines(lines: string[], maxLines: number, maxChars: number, noun: string): string[] {
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (kept.length >= maxLines || chars + line.length + 1 > maxChars) break;
    kept.push(line);
    chars += line.length + 1;
  }
  const left = lines.length - kept.length;
  if (left > 0) kept.push(`(${left} more ${noun} left out)`);
  return kept;
}

function buildMaterial(input: MapInput, placeable: string[]): string {
  const tiers = new Map(input.facts.map((f) => [f.path, f.tier]));
  const changed = new Set(placeable);
  const byFile = new Map(input.files.map((f) => [f.path, f]));

  const body = input.pr.body.trim() === '' ? '(no description)' : input.pr.body;
  const description = body.length > MAX_DESCRIPTION_CHARS
    ? `${body.slice(0, MAX_DESCRIPTION_CHARS)}\n(description cut at ${MAX_DESCRIPTION_CHARS} characters)`
    : body;

  const fileLines = [...placeable].sort(byPath).map((p) => {
    const f = byFile.get(p)!;
    return `${p} | ${f.status} | ${tiers.get(p) ?? 'read'} | +${f.additions} -${f.deletions}`;
  });

  const ranked = [...input.links].sort((a, b) => {
    const rank = (l: Link): number => (changed.has(l.from) && changed.has(l.to) ? 0 : 1);
    return rank(a) - rank(b) || byPath(a.from, b.from) || byPath(a.to, b.to);
  });
  const linkLines = [...new Set(ranked.map((l) => oneLine(`${l.from} -> ${l.to} (${l.kind}: ${l.detail})`)))];

  const neighbourLines = [...input.neighbours]
    .sort((a, b) => byPath(a.path, b.path))
    .map((n) => oneLine(`${n.path} [${n.role}] for: ${n.forFiles.join(', ')} — ${n.why}`));

  const section = (lines: string[]): string => (lines.length === 0 ? '(none)' : lines.join('\n'));
  const prBlock = asMaterial('pull request', `Title: ${input.pr.title}\n\n${description}`);
  const filesBlock = asMaterial('changed files', section(fileLines));
  const neighboursBlock = asMaterial('neighbours', section(capLines(neighbourLines, MAX_NEIGHBOUR_LINES, MAX_NEIGHBOUR_CHARS, 'neighbours')));
  const linkChars = Math.min(MAX_LINK_CHARS, MATERIAL_BUDGET - prBlock.length - filesBlock.length - neighboursBlock.length);
  const linksBlock = asMaterial('links', section(capLines(linkLines, MAX_LINK_LINES, linkChars, 'links')));
  return [prBlock, filesBlock, linksBlock, neighboursBlock].join('\n\n');
}

/** True when `path` names a file inside `headDir`. */
async function existsAtHead(headDir: string, path: string): Promise<boolean> {
  if (path.trim() === '' || isAbsolute(path)) return false;
  const full = resolve(headDir, path);
  const rel = relative(resolve(headDir), full);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  try {
    return (await stat(full)).isFile();
  } catch {
    return false;
  }
}

/** Removes neighbours that are changed files or that do not exist at the head. These repairs are never problems. */
async function repairNeighbours(answer: MapperAnswer, diffPaths: Set<string>, headDir: string): Promise<MapperAnswer> {
  const cohorts = await Promise.all(answer.cohorts.map(async (c) => {
    const keep = await Promise.all(c.neighbours.map(async (n) => !diffPaths.has(n.path) && existsAtHead(headDir, n.path)));
    return { ...c, neighbours: c.neighbours.filter((_, i) => keep[i]) };
  }));
  return { ...answer, cohorts };
}

/** The longest directory that contains every path, or '' when they share none. */
function commonDirectory(paths: string[]): string {
  const dirs = paths.map((p) => posix.dirname(p).split('/').filter((s) => s !== '.' && s !== ''));
  const first = dirs[0] ?? [];
  let n = 0;
  while (n < first.length && dirs.every((d) => d[n] === first[n])) n++;
  return first.slice(0, n).join('/');
}

/** Groups the non-ignored changed files by the links between them: each connected group of two or more files is a cohort, the rest go to standalone. */
export function fallbackMap(files: FileDiff[], facts: FileFact[], links: Link[]): ChangeMap {
  const placeable = [...new Set(placeablePaths(files, facts))].sort(byPath);
  const changed = new Set(placeable);
  const mapLinks = linksBetween(links, changed);

  const parent = new Map(placeable.map((p) => [p, p]));
  const find = (p: string): string => {
    let root = p;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(p, root);
    return root;
  };
  for (const l of mapLinks) parent.set(find(l.from), find(l.to));

  const groups = new Map<string, string[]>();
  for (const p of placeable) {
    const root = find(p);
    const group = groups.get(root);
    if (group) group.push(p);
    else groups.set(root, [p]);
  }

  const components = [...groups.values()].filter((g) => g.length >= 2).sort((a, b) => byPath(a[0]!, b[0]!));
  const cohorts: Cohort[] = components.map((paths, i) => ({
    id: `k${i + 1}`,
    title: `Connected changes under ${commonDirectory(paths) || 'the repository root'}`,
    summary: FALLBACK_SUMMARY,
    layers: [{ id: 'l1', title: 'Changed files', kind: 'other', files: paths, dependsOn: [], note: '' }],
    neighbours: [],
    inferredLinks: [],
  }));
  const standalone = [...groups.values()].filter((g) => g.length === 1).map((g) => g[0]!).sort(byPath);
  return { cohorts, standalone, links: mapLinks };
}

/**
 * Asks the mapper agent to group the changed files into cohorts and layers, checks the answer, and retries once with the
 * problems when the check fails. When a request fails, or the second answer also fails the check, returns the link-based
 * fallback and records why in `error` and `errorKind`.
 */
export async function buildChangeMap(runner: AgentRunner, input: MapInput): Promise<MapResult> {
  const placeable = [...new Set(placeablePaths(input.files, input.facts))];
  const changed = new Set(placeable);
  const diffPaths = new Set(input.files.map((f) => f.path));
  const mapLinks = linksBetween(input.links, changed);

  if (placeable.length === 0) return { map: { cohorts: [], standalone: [], links: [] }, usage: [], error: null, limits: [] };

  if (placeable.length === 1) {
    const path = placeable[0]!;
    const cohort: Cohort = {
      id: 'k1', title: posix.basename(path), summary: '',
      layers: [{ id: 'l1', title: 'Changed file', kind: 'other', files: [path], dependsOn: [], note: '' }],
      neighbours: input.neighbours.filter((n) => !diffPaths.has(n.path)),
      inferredLinks: [],
    };
    return { map: { cohorts: [cohort], standalone: [], links: mapLinks }, usage: [], error: null, limits: [] };
  }

  const instructions = fill(await loadTemplate('mapper'), {}).trimEnd();
  const request: AgentRequest<MapperAnswer> = {
    role: 'mapper',
    instructions,
    material: buildMaterial(input, placeable),
    schema: MapperAnswerSchema,
    cwd: input.headDir,
    model: input.model,
    effort: input.effort,
  };

  const usage: AgentUsage[] = [];
  const limits = [descriptionCutSentence('mapper', input.pr.body, MAX_DESCRIPTION_CHARS)].flatMap((l) => l ?? []);
  const fallback = (error: string, errorKind: StageErrorKind): MapResult =>
    ({ map: fallbackMap(input.files, input.facts, input.links), usage, error, errorKind, limits });
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    // The problems quote file names from the pull request and ids the model wrote, so they go in as material, never
    // instructions. The retry is this stage's own, so the runner must not retry it again.
    const req: AgentRequest<MapperAnswer> = attempt === 1 ? request : {
      ...request,
      material: `${request.material}\n\n${RETRY_SENTENCE}\n\n${asMaterial(PROBLEMS_LABEL, problems.map((p) => `- ${p}`).join('\n'))}`,
      noRetry: true,
    };
    const result = await runner.run(req);
    usage.push(result.usage);
    if (!result.ok) {
      // A failed request is not retried here: an unusable answer is the runner's to retry (withRetry), and a turn limit,
      // usage limit or timeout would only fail again.
      return fallback(`mapper failed${attempt === 1 ? '' : ' twice'}: ${clip(oneLine(result.error))}`, result.kind);
    }
    const answer = await repairNeighbours(result.output, diffPaths, input.headDir);
    const map: ChangeMap = { ...answer, links: mapLinks };
    problems = checkChangeMap(map, input.files, input.facts);
    if (problems.length === 0) return { map, usage, error: null, limits };
  }

  const extra = problems.length - 1;
  const more = extra > 0 ? ` (and ${extra} more problem${extra === 1 ? '' : 's'})` : '';
  return fallback(`mapper failed twice: ${clip(problems[0] ?? 'no reason given')}${more}`, 'invalid-output');
}
