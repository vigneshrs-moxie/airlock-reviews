import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { asMaterial } from '@airlock/engine';
import type { AgentResult, AgentRunner } from '@airlock/engine';
import type { Candidate, ReviewDocument } from '@airlock/shared';
import { z } from 'zod';
import type { KnownProblem, ReplayCase } from './dataset.js';

/** Where the item that matches a known problem ended up in the review. */
export type MatchWhere = 'top' | 'also' | 'dropped' | 'candidate' | 'question' | 'none';

/** The judge's answer for one known problem. */
export interface Match {
  knownId: string;
  where: MatchWhere;
  itemId: string | null;
  /** True when the item describes one of two defects in a compound summary. */
  partial: boolean;
  reason: string;
}

const answerSchema = z.object({
  matches: z.array(z.object({
    knownId: z.string(),
    itemId: z.string().nullable(),
    partial: z.boolean(),
    reason: z.string(),
  })),
});

/** packages/replay/prompts/, from both src/ and a built dist/. */
const PROMPTS_DIR = new URL('../prompts/', import.meta.url);
let template: string | undefined;

async function loadJudgeTemplate(): Promise<string> {
  if (template !== undefined) return template;
  try {
    template = await readFile(new URL('judge.md', PROMPTS_DIR), 'utf8');
  } catch (err) {
    throw new Error(`The judge prompt could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
  return template;
}

/** Makes a value safe for one `|`-separated line of material: line breaks become spaces. */
const oneLine = (text: string): string => text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim();

interface Item { id: string; kind: string; severity: string; path: string; title: string; happens: string }

const fromCandidate = (c: Candidate, kind: string): Item =>
  ({ id: c.id, kind, severity: c.severity, path: c.path, title: c.title, happens: c.happens });

/** Every item the review produced, in the order the judge sees them. */
function listItems(doc: ReviewDocument): Item[] {
  const items: Item[] = [
    ...doc.findings.map((f) => fromCandidate(f, f.bucket)),
    ...doc.dropped.map((d) => fromCandidate(d.candidate, `dropped (${d.stage})`)),
  ];
  const listed = new Set(items.map((i) => i.id));
  for (const c of doc.candidates) if (!listed.has(c.id)) items.push(fromCandidate(c, 'candidate'));
  doc.questions.forEach((q, i) => items.push({ id: `q${i + 1}`, kind: 'question', severity: '-', path: '-', title: '-', happens: q.text }));
  return items;
}

/** Where an item id lives, checked in order: top, also found, dropped, raw candidates, questions. */
function locateItem(doc: ReviewDocument, itemId: string): Exclude<MatchWhere, 'none'> | null {
  if (doc.findings.some((f) => f.bucket === 'top' && f.id === itemId)) return 'top';
  if (doc.findings.some((f) => f.bucket === 'also' && f.id === itemId)) return 'also';
  if (doc.dropped.some((d) => d.candidate.id === itemId)) return 'dropped';
  if (doc.candidates.some((c) => c.id === itemId)) return 'candidate';
  const q = /^q([1-9]\d*)$/.exec(itemId);
  if (q && Number(q[1]) <= doc.questions.length) return 'question';
  return null;
}

const knownLine = (k: KnownProblem): string =>
  oneLine(`${k.id} | ${k.path ?? '-'}:${k.line ?? '-'} | summary: ${k.summary} | reviewer's words: ${k.comment}`);

const itemLine = (i: Item): string =>
  oneLine(`${i.id} | ${i.kind} | ${i.severity} | ${i.path} | ${i.title} | happens: ${i.happens}`);

function material(c: ReplayCase, doc: ReviewDocument): string {
  const items = listItems(doc);
  return [
    asMaterial('Known problems', c.known.map(knownLine).join('\n')),
    asMaterial("The tool's items", items.length > 0 ? items.map(itemLine).join('\n') : '(no items)'),
  ].join('\n\n');
}

/**
 * Asks the judge which item of `doc`, if any, describes each known problem of `c`.
 * Returns one match per known problem in the case's order. Throws when the request fails.
 */
export async function judgeCase(
  runner: AgentRunner, c: ReplayCase, doc: ReviewDocument, model: string, cwd: string = tmpdir(),
): Promise<Match[]> {
  if (c.known.length === 0) return [];
  const instructions = await loadJudgeTemplate();
  let result: AgentResult<z.infer<typeof answerSchema>>;
  try {
    result = await runner.run({ role: 'judge', instructions, material: material(c, doc), schema: answerSchema, cwd, model, effort: 'high' });
  } catch (err) {
    throw new Error(`The judge failed on case ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!result.ok) throw new Error(`The judge failed on case ${c.id}: ${result.error}`);

  const answers = new Map<string, z.infer<typeof answerSchema>['matches'][number]>();
  for (const a of result.output.matches) if (!answers.has(a.knownId)) answers.set(a.knownId, a);

  return c.known.map((k): Match => {
    const a = answers.get(k.id);
    if (!a) return { knownId: k.id, where: 'none', itemId: null, partial: false, reason: 'The judge gave no answer for this problem.' };
    if (a.itemId === null) return { knownId: k.id, where: 'none', itemId: null, partial: false, reason: a.reason };
    const where = locateItem(doc, a.itemId);
    if (where === null) {
      return { knownId: k.id, where: 'none', itemId: null, partial: false,
        reason: `The judge named "${a.itemId}", which is not one of the listed items. Its reason: ${a.reason}` };
    }
    return { knownId: k.id, where, itemId: a.itemId, partial: a.partial, reason: a.reason };
  });
}
