import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** One problem the senior reviewer raised on a past pull request. */
export interface KnownProblem {
  id: string;
  path: string | null;
  line: number | null;
  /** One neutral sentence: the underlying problem as cause plus consequence. */
  summary: string;
  /** The reviewer's own words. */
  comment: string;
  reviewerSeverity: 'change' | 'question' | 'note';
  /** True when seeing the problem needs a second file besides `path`. */
  crossFile: boolean;
  /**
   * False for a pure question with no underlying code defect. Absent means true;
   * `loadCases` always fills it in.
   */
  defect?: boolean;
}

/** One past pull request, pinned to the commits the reviewer saw. */
export interface ReplayCase {
  id: string;
  repo: string;
  pr: number;
  title: string;
  /** The pull request's title as it stood at `reviewedAt`, from descriptions.json. */
  titleAtReview: string;
  /** The pull request's description as it stood at `reviewedAt`, from descriptions.json. */
  bodyAtReview: string;
  kind: 'positive' | 'secondary' | 'negative';
  reviewedAt: string;
  baseSha: string;
  headSha: string;
  lines: number | null;
  known: KnownProblem[];
}

const sha = z.string().regex(/^[0-9a-f]{40}$/, 'expected a 40-character hex SHA');

const knownProblemSchema = z.strictObject({
  id: z.string().min(1),
  path: z.string().min(1).nullable(),
  line: z.int().positive().nullable(),
  summary: z.string().min(1),
  comment: z.string().min(1),
  reviewerSeverity: z.enum(['change', 'question', 'note']),
  crossFile: z.boolean(),
  defect: z.boolean().default(true),
});

const replayCaseSchema = z.strictObject({
  id: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected owner/name'),
  pr: z.int().positive(),
  title: z.string().min(1),
  kind: z.enum(['positive', 'secondary', 'negative']),
  reviewedAt: z.iso.datetime(),
  baseSha: sha,
  headSha: sha,
  lines: z.int().nonnegative().nullable(),
  known: z.array(knownProblemSchema),
});

const descriptionsSchema = z.record(z.string(), z.object({
  title: z.string().min(1),
  body: z.string(),
  editedAfterReview: z.int().nonnegative(),
  renamedAfterReview: z.int().nonnegative(),
}));
type Descriptions = z.infer<typeof descriptionsSchema>;

const BUNDLED = fileURLToPath(new URL('../dataset/cases.json', import.meta.url));
const CAPTURE = 'node packages/replay/scripts/capture-descriptions.mjs';

/** descriptions.json beside `casesFile`; an empty record when there is none, so each case then reports itself missing. */
async function loadDescriptions(casesFile: string): Promise<Descriptions> {
  const file = join(dirname(casesFile), 'descriptions.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const parsed = descriptionsSchema.safeParse(parseJson(file, text));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${file}: field ${issue?.path.join('.') || '(record)'}: ${issue?.message ?? 'invalid'}. Run ${CAPTURE} to write it again.`);
  }
  return parsed.data;
}

/**
 * Reads and validates the replay cases from `file`, or the bundled dataset, with each case's title and description at
 * review time from descriptions.json in the same folder. A case with no description there is an error.
 */
export async function loadCases(file: string = BUNDLED): Promise<ReplayCase[]> {
  const raw = parseJson(file, await readFile(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`${file}: expected an array of replay cases`);
  const descriptions = await loadDescriptions(file);
  const cases = raw.map((record: unknown, index): ReplayCase => {
    const parsed = replayCaseSchema.safeParse(record);
    if (parsed.success) {
      const d = Object.hasOwn(descriptions, parsed.data.id) ? descriptions[parsed.data.id] : undefined;
      if (d === undefined) {
        throw new Error(
          `${file}: replay case ${parsed.data.id} has no entry in descriptions.json, so its description at review time is not known. ` +
            `Run ${CAPTURE} to record it.`,
        );
      }
      return { ...parsed.data, titleAtReview: d.title, bodyAtReview: d.body };
    }
    const id = caseId(record) ?? `#${index}`;
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || '(record)';
    throw new Error(`${file}: replay case ${id}: field ${field}: ${issue?.message ?? 'invalid'}`);
  });
  const duplicateCase = firstDuplicate(cases.map((c) => c.id));
  if (duplicateCase) throw new Error(`${file}: duplicate replay case id ${duplicateCase}`);
  const duplicateProblem = firstDuplicate(cases.flatMap((c) => c.known.map((k) => k.id)));
  if (duplicateProblem) throw new Error(`${file}: duplicate known-problem id ${duplicateProblem}`);
  return cases;
}

function parseJson(file: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function firstDuplicate(ids: string[]): string | undefined {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return undefined;
}

function caseId(record: unknown): string | undefined {
  if (typeof record !== 'object' || record === null || !('id' in record)) return undefined;
  return typeof record.id === 'string' ? record.id : undefined;
}

/**
 * Selects cases by `all`, `positive`, `negative`, `small` (positive cases of at
 * most 2,000 changed lines) or a comma-separated list of ids. Keeps dataset order.
 */
export function pickCases(all: ReplayCase[], sel: string): ReplayCase[] {
  switch (sel.trim()) {
    case 'all':
      return [...all];
    case 'positive':
    case 'negative':
      return all.filter((c) => c.kind === sel.trim());
    case 'small':
      return all.filter((c) => c.kind === 'positive' && c.lines !== null && c.lines <= 2000);
  }
  const wanted = new Set(sel.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
  const known = new Set(all.map((c) => c.id));
  const unknown = [...wanted].filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`Unknown replay case id: ${unknown.join(', ')}`);
  if (wanted.size === 0) throw new Error(`No replay cases selected by "${sel}"`);
  return all.filter((c) => wanted.has(c.id));
}
