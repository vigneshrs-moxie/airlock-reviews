import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { asMaterial } from '@airlock/engine';
import type { AgentResult, AgentRunner } from '@airlock/engine';
import type { Candidate, Dropped, ReviewDocument } from '@airlock/shared';
import { z } from 'zod';
import type { KnownProblem, ReplayCase } from './dataset.js';

/** Where the item that matches a known problem ended up in the review. */
export type MatchWhere = 'top' | 'also' | 'dropped' | 'candidate' | 'question' | 'none';

/** Another item the judge said describes the same problem, besides the one chosen. */
export interface OtherMatch {
  itemId: string;
  where: Exclude<MatchWhere, 'none'>;
  partial: boolean;
}

/** For one known problem: the best-placed item the judge said describes it, and the others it named. */
export interface Match {
  knownId: string;
  where: MatchWhere;
  /** For a duplicate merged into another finding, the finding it was merged into. */
  itemId: string | null;
  /** True when the item describes one of two defects in a compound summary. */
  partial: boolean;
  reason: string;
  /** The other items the judge named, best placed first. Absent in matches saved before the judge named every item. */
  others?: OtherMatch[];
}

const answerSchema = z.object({
  matches: z.array(z.object({
    knownId: z.string(),
    items: z.array(z.object({ itemId: z.string(), partial: z.boolean(), reason: z.string() })),
    reason: z.string(),
  })),
});
type Answer = z.infer<typeof answerSchema>['matches'][number];

/** The judge could not answer because Claude's usage limit was reached: the run stops rather than carry on failing. */
export class UsageLimitError extends Error {}

/** True for an error text that says Claude's usage limit was reached, for failures that carry no kind. */
export const mentionsUsageLimit = (text: string): boolean => /usage limit/i.test(text);

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

/**
 * Makes free text safe as one field of a `|`-separated line of material: line breaks become
 * spaces, and backslashes and pipes are escaped, so only the separators are bare pipes.
 */
const field = (text: string): string =>
  text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim().replaceAll('\\', '\\\\').replaceAll('|', '\\|');

/** What the judge sees of one item: its kind in neutral words, never where it ended up. */
interface Item { id: string; kind: 'finding' | 'question'; path: string; title: string; happens: string }

const fromCandidate = (c: Candidate): Item =>
  ({ id: c.id, kind: 'finding', path: field(c.path), title: field(c.title), happens: c.happens });

/** A stable shuffle key for an item: a rerun of the same case gives the same order, another case another. */
const shuffleKey = (caseId: string, itemId: string): string => createHash('sha256').update(`${caseId}\n${itemId}`).digest('hex');

/**
 * Every item the review produced (findings, dropped candidates, raw candidates and questions), each id once, in one
 * list shuffled with a seed from the case id, so neither the order nor a label tells the judge where an item ended up.
 */
function listItems(caseId: string, doc: ReviewDocument): Item[] {
  const items = [...doc.findings, ...doc.dropped.map((d) => d.candidate), ...doc.candidates].map(fromCandidate);
  doc.questions.forEach((q, i) => items.push({ id: `q${i + 1}`, kind: 'question', path: '-', title: '-', happens: q.text }));
  const seen = new Set<string>();
  const unique = items.filter((i) => !seen.has(i.id) && seen.add(i.id));
  const keys = new Map(unique.map((i) => [i.id, shuffleKey(caseId, i.id)]));
  return unique.sort((a, b) => (keys.get(a.id)! < keys.get(b.id)! ? -1 : keys.get(a.id)! > keys.get(b.id)! ? 1 : 0));
}

/** Placements from best to worst. */
const PLACEMENT: Exclude<MatchWhere, 'none'>[] = ['top', 'also', 'question', 'dropped', 'candidate'];

/** The best place an item id lives: top, also found, question, dropped, raw candidate; null when it is nowhere. */
function locateItem(doc: ReviewDocument, itemId: string): Exclude<MatchWhere, 'none'> | null {
  if (doc.findings.some((f) => f.bucket === 'top' && f.id === itemId)) return 'top';
  if (doc.findings.some((f) => f.bucket === 'also' && f.id === itemId)) return 'also';
  const q = /^q([1-9]\d*)$/.exec(itemId);
  if (q && Number(q[1]) <= doc.questions.length) return 'question';
  if (doc.dropped.some((d) => d.candidate.id === itemId)) return 'dropped';
  if (doc.candidates.some((c) => c.id === itemId)) return 'candidate';
  return null;
}

/**
 * The id of the finding a dropped duplicate was merged into, or null when it was not merged. `mergedInto` says so when
 * the document has it; an older document says so only in a selection drop's reason, "same problem as <id>".
 */
function keeperOf(entry: Dropped): string | null {
  if (entry.mergedInto !== undefined) return entry.mergedInto;
  if (entry.stage !== 'select') return null;
  return /^same problem as (\S+)$/.exec(entry.reason.trim())?.[1] ?? null;
}

/**
 * Where an item counts: its own best place, or for a dropped duplicate the place of the finding it was merged into,
 * followed through any chain of merges. A loop, or a keeper that cannot be found, ends at the last dropped entry.
 */
function placeOf(doc: ReviewDocument, itemId: string): { where: Exclude<MatchWhere, 'none'>; itemId: string } | null {
  const seen = new Set<string>();
  let id = itemId;
  for (;;) {
    const where = locateItem(doc, id);
    if (where !== 'dropped') return where === null ? null : { where, itemId: id };
    seen.add(id);
    const entry = doc.dropped.find((d) => d.candidate.id === id)!;
    const keeper = keeperOf(entry);
    if (keeper === null || seen.has(keeper) || locateItem(doc, keeper) === null) return { where, itemId: id };
    id = keeper;
  }
}

/**
 * The match for one known problem from the items the judge named: the best placed (top, also found, question, dropped,
 * raw candidate), a full match before a partial one at the same place; the rest, each place once, as `others`.
 */
function choose(doc: ReviewDocument, knownId: string, a: Answer): Match {
  const placed = a.items.flatMap((item, order) => {
    const place = placeOf(doc, item.itemId);
    return place === null ? [] : [{ ...place, named: item.itemId, partial: item.partial, reason: item.reason, order }];
  });
  if (placed.length === 0) {
    const invented = a.items.map((i) => `"${i.itemId}"`);
    const reason = invented.length === 0 ? a.reason
      : `The judge named ${invented.join(', ')}, which ${invented.length === 1 ? 'is' : 'are'} not one of the listed items. Its reason: ${a.reason}`;
    return { knownId, where: 'none', itemId: null, partial: false, reason, others: [] };
  }
  placed.sort((x, y) => PLACEMENT.indexOf(x.where) - PLACEMENT.indexOf(y.where) || Number(x.partial) - Number(y.partial) || x.order - y.order);
  const [best, ...rest] = placed;
  const listed = new Set([best!.itemId]);
  const others = rest.filter((o) => !listed.has(o.itemId) && listed.add(o.itemId)).map((o) => ({ itemId: o.itemId, where: o.where, partial: o.partial }));
  const followed = best!.named === best!.itemId ? '' : ` (The judge named ${best!.named}, a duplicate merged into ${best!.itemId}.)`;
  return { knownId, where: best!.where, itemId: best!.itemId, partial: best!.partial, reason: `${best!.reason}${followed}`, others };
}

const knownLine = (k: KnownProblem): string =>
  `${k.id} | ${k.path === null ? '-' : field(k.path)}:${k.line ?? '-'} | summary: ${field(k.summary)} | reviewer's words: ${field(k.comment)}`;

const itemLine = (i: Item): string =>
  `${i.id} | ${i.kind} | ${i.path} | ${i.title} | happens: ${field(i.happens)}`;

function material(c: ReplayCase, doc: ReviewDocument): string {
  const items = listItems(c.id, doc);
  return [
    asMaterial('Known problems', c.known.map(knownLine).join('\n')),
    asMaterial("The tool's items", items.length > 0 ? items.map(itemLine).join('\n') : '(no items)'),
  ].join('\n\n');
}

/** What judgeCase rejects with when its signal was aborted before the request was sent. */
export const JUDGE_STOPPED = 'The judge was stopped.';

/**
 * Asks the judge which items of `doc` describe each known problem of `c`, without telling it where any item ended up,
 * and chooses the best placed of them. Returns one match per known problem in the case's order. Throws when the
 * request fails; with a UsageLimitError when Claude's usage limit was reached. The request carries `signal`, and none
 * is sent once it is aborted.
 */
export async function judgeCase(
  runner: AgentRunner, c: ReplayCase, doc: ReviewDocument, model: string, cwd: string = tmpdir(), signal?: AbortSignal,
): Promise<Match[]> {
  if (c.known.length === 0) return [];
  if (signal?.aborted) throw new Error(JUDGE_STOPPED);
  const instructions = await loadJudgeTemplate();
  let result: AgentResult<z.infer<typeof answerSchema>>;
  const failed = (error: string, usageLimit: boolean): Error => {
    const message = `The judge failed on case ${c.id}: ${error}`;
    return usageLimit || mentionsUsageLimit(error) ? new UsageLimitError(message) : new Error(message);
  };
  try {
    result = await runner.run({
      role: 'judge', instructions, material: material(c, doc), schema: answerSchema, cwd, model, effort: 'high', ...(signal ? { signal } : {}),
    });
  } catch (err) {
    throw failed(err instanceof Error ? err.message : String(err), false);
  }
  // A runner that can tell why a request failed marks a usage limit with `kind`; older runners only say so in words.
  if (!result.ok) throw failed(result.error, 'kind' in result && result.kind === 'usage-limit');

  const answers = new Map<string, Answer>();
  for (const a of result.output.matches) if (!answers.has(a.knownId)) answers.set(a.knownId, a);

  return c.known.map((k): Match => {
    const a = answers.get(k.id);
    if (!a) return { knownId: k.id, where: 'none', itemId: null, partial: false, reason: 'The judge gave no answer for this problem.', others: [] };
    return choose(doc, k.id, a);
  });
}
