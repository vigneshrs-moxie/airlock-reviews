import { readFile } from 'node:fs/promises';
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
}

/** One past pull request, pinned to the commits the reviewer saw. */
export interface ReplayCase {
  id: string;
  repo: string;
  pr: number;
  title: string;
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

const BUNDLED = fileURLToPath(new URL('../dataset/cases.json', import.meta.url));

/** Reads and validates the replay cases from `file`, or the bundled dataset. */
export async function loadCases(file: string = BUNDLED): Promise<ReplayCase[]> {
  const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`${file}: expected an array of replay cases`);
  return raw.map((record: unknown, index) => {
    const parsed = replayCaseSchema.safeParse(record);
    if (parsed.success) return parsed.data;
    const id = caseId(record) ?? `#${index}`;
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || '(record)';
    throw new Error(`${file}: replay case ${id}: field ${field}: ${issue?.message ?? 'invalid'}`);
  });
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
