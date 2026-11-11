import type {
  Depth, Dropped, Finding, PrInfo, Question, StageError, Verdict, VerdictLabel,
} from '@airlock/shared';
import { z } from 'zod';
import { asMaterial, fill, loadTemplate } from '../agent/prompt.js';
import type { AgentRunner, AgentUsage } from '../agent/runner.js';
import { fingerprint } from '../anchor/fingerprint.js';
import type { KeptCandidate } from '../challenge/challenge.js';
import { briefBlock, instructionsFor, mapBlock, prBlock, readerOf, sendRequest } from '../lenses/context.js';
import type { LensContext } from '../lenses/context.js';
import { absorb, nearInFile, plainCandidate } from '../merge/merge.js';
import { SEVERITY_RANK } from '../rules/sweep.js';

/** The top list holds at most this many findings. */
export const MAX_TOP = 5;
/** `whoseCall` and `checksAfterMerge` keep at most this many lines each. */
const MAX_LINES = 5;
/**
 * An agent group listing more findings than this is ignored unless they all sit near each other in one file: across files
 * that large a group is more likely careless than a real duplicate.
 */
const MAX_GROUP = 4;
/** The longest title quoted in the verdict sentence, the closing `…` of a cut title included. */
const MAX_TITLE = 120;

export const SelectOutputSchema = z.object({
  top: z.array(z.string()),
  also: z.array(z.string()),
  sameAs: z.array(z.array(z.string())),
  /** `question` is a 1-based position in the questions shown; `sameAs` is `q<m>` or the id of a finding shown. */
  questionSameAs: z.array(z.object({ question: z.number(), sameAs: z.string() })),
  whoseCall: z.array(z.string()),
  checksAfterMerge: z.array(z.string()),
  splitSuggested: z.boolean(),
});
export type SelectOutput = z.infer<typeof SelectOutputSchema>;

export interface SelectResult {
  findings: Finding[];
  dropped: Dropped[];
  /** The questions that survived selection, in the order given. */
  questions: Question[];
  verdict: Verdict;
  whoseCall: string[];
  checksAfterMerge: string[];
  selfReviewText: string;
  /** Groups the model named that were not merged, and the questions that were merged, in words for the document. */
  notes: string[];
  errors: StageError[];
  usage: AgentUsage[];
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
/** The positions `at` in `items`, higher severity first, then by position. */
const bySeverity = (items: KeptCandidate[], at: number[]): number[] =>
  [...at].sort((a, b) => SEVERITY_RANK[items[b]!.severity] - SEVERITY_RANK[items[a]!.severity] || a - b);

// ---- Merging duplicates ----

/** Two items share a file when they have the same path, or one's path is the path of one of the other's connected places. */
const shareFile = (a: KeptCandidate, b: KeptCandidate): boolean =>
  a.path === b.path || a.connected.some((p) => p.path === b.path) || b.connected.some((p) => p.path === a.path);

/** True when the items are all in one file and their anchored lines join up, each near another (see nearInFile). */
function nearInOneFile(items: KeptCandidate[]): boolean {
  if (items.length === 0 || items.some((i) => i.path !== items[0]!.path || i.anchor.startLine === null)) return false;
  const reached = new Set([0]);
  const todo = [0];
  while (todo.length > 0) {
    const i = todo.pop()!;
    items.forEach((other, j) => {
      if (!reached.has(j) && nearInFile(items[i]!, other)) { reached.add(j); todo.push(j); }
    });
  }
  return reached.size === items.length;
}

const titles = (items: KeptCandidate[]): string => items.map((i) => `"${oneLine(i.title)}"`).join(', ');
const ignoredNote = (members: KeptCandidate[], because: string): string =>
  `Selection named ${members.length} findings as one problem; they were not merged because ${because}: ${titles(members)}`;
/** Why a group larger than MAX_GROUP was not merged. */
const TOO_MANY = 'more than four are merged at once only when they all sit near each other in one file';

/**
 * Merges items that are the same underlying problem: always those with the identical fingerprint, and the items of an
 * agent group when every pair of items it would end up joining, including those of sets it joins, shares a file, and the
 * group holds at most MAX_GROUP items or all of them sit near each other in one file. Otherwise the group is ignored and
 * a note says why. Lines alone never merge two items.
 * Each merged set keeps its most serious item (the first on a tie) with the connected places, sources and fingerprints
 * of all of them, and records the others as dropped at stage `select` with `mergedInto` naming the kept item. Survivors
 * and dropped items keep the input order. Inputs are not changed.
 */
export function mergeDuplicates(
  items: readonly KeptCandidate[],
  groups: readonly (readonly string[])[] = [],
): { merged: KeptCandidate[]; dropped: Dropped[]; notes: string[] } {
  const parent = items.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i]!;
    return i;
  };
  const join = (a: number, b: number): void => {
    const [ra, rb] = [root(a), root(b)];
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const firstWithPrint = new Map<string, number>();
  items.forEach((item, i) => {
    const print = fingerprint(item);
    const first = firstWithPrint.get(print);
    if (first === undefined) firstWithPrint.set(print, i);
    else join(first, i);
  });

  const indexOf = new Map<string, number>();
  items.forEach((item, i) => {
    if (!indexOf.has(item.id)) indexOf.set(item.id, i);
  });
  const allShare = (set: number[]): boolean =>
    set.every((a, k) => set.slice(k + 1).every((b) => shareFile(items[a]!, items[b]!)));
  const notes: string[] = [];
  for (const group of groups) {
    const members = [...new Set(group.flatMap((id) => indexOf.get(id) ?? []))];
    if (members.length < 2) continue;
    const named = members.map((m) => items[m]!);
    if (members.length > MAX_GROUP && !nearInOneFile(named)) {
      notes.push(ignoredNote(named, TOO_MANY));
      continue;
    }
    // The test covers everything the group would end up with, so two groups cannot chain unrelated files together.
    const roots = new Set(members.map(root));
    if (!allShare(items.flatMap((_, i) => (roots.has(root(i)) ? [i] : [])))) {
      notes.push(ignoredNote(named, 'they do not all share a file'));
      continue;
    }
    for (const m of members.slice(1)) join(members[0]!, m);
  }

  const sets = new Map<number, number[]>();
  items.forEach((_, i) => {
    const r = root(i);
    const set = sets.get(r);
    if (set) set.push(i);
    else sets.set(r, [i]);
  });
  const keeperOf = new Map<number, number>();
  for (const [r, members] of sets) {
    keeperOf.set(r, members.reduce((best, i) => (SEVERITY_RANK[items[i]!.severity] > SEVERITY_RANK[items[best]!.severity] ? i : best)));
  }

  const merged: KeptCandidate[] = [];
  const dropped: Dropped[] = [];
  items.forEach((item, i) => {
    const r = root(i);
    const keeper = keeperOf.get(r)!;
    if (keeper !== i) {
      const into = items[keeper]!.id;
      dropped.push({ candidate: plainCandidate(item), stage: 'select', reason: `same problem as ${into}`, refutation: null, mergedInto: into });
      return;
    }
    const others = sets.get(r)!.filter((m) => m !== i).map((m) => items[m]!);
    merged.push(others.length === 0 ? { ...item } : absorb(item, others));
  });
  return { merged, dropped, notes };
}

// ---- The request ----

/** A free-text field on one line of a `|`-separated row. */
const field = (text: string): string => oneLine(text).replaceAll('|', '\\|');

function findingLine(c: KeptCandidate): string {
  const origin = c.source.ruleId ?? c.source.lens ?? '-';
  return [
    c.id, c.severity, `${field(c.source.pack)}/${field(origin)}`, `${field(c.path)}:${c.anchor.startLine ?? '-'}`,
    field(c.title), `happens: ${field(c.happens)}`, `why: ${field(c.why)}`,
  ].join(' | ');
}

/** The items by file, then line (an item with no line last in its file), then the order given. */
function byPlace(items: KeptCandidate[]): KeptCandidate[] {
  const line = (c: KeptCandidate): number => c.anchor.startLine ?? Number.POSITIVE_INFINITY;
  return items.map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.path < b.c.path ? -1 : a.c.path > b.c.path ? 1 : 0) || line(a.c) - line(b.c) || a.i - b.i)
    .map(({ c }) => c);
}

/** The questions are numbered `q1`, `q2`, … so the model can name them in `questionSameAs`. */
function selectMaterial(ctx: LensContext, items: KeptCandidate[], questions: Question[]): string {
  const orNone = (lines: string[]): string => (lines.length === 0 ? '(none)' : lines.join('\n'));
  return [
    prBlock(ctx.pr),
    briefBlock(ctx.brief),
    mapBlock(ctx.map),
    asMaterial('findings', orNone(byPlace(items).map(findingLine))),
    asMaterial('questions', orNone(questions.map((q, i) => `q${i + 1} | ${field(q.text)}`))),
  ].join('\n\n');
}

// ---- Merging questions ----

/** The questions with only the first of each text, comparing without letter case and with every run of whitespace as one space. */
export function sameTextOnce(questions: readonly Question[]): Question[] {
  const seen = new Set<string>();
  return questions.filter((q) => {
    const key = oneLine(q.text).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `q<m>` names the question at position m of the list the model was given. */
const QUESTION_REF = /^q([1-9]\d*)$/;

/** What a merged question went into: another question that stays, or a finding shown to the model. */
export type QuestionTarget = { question: Question } | { findingId: string };

/**
 * The questions left once the model's `questionSameAs` entries are applied, in the order given, and each question that
 * went with what it went into. An entry counts only when its `question` is a position in the list and its `sameAs` is
 * another question of the list (`q<m>`) or the id of a finding shown to the model; anything else is ignored and the
 * question stays. Every finding shown survives selection, in the result or as the survivor of a merge, so an entry that
 * names one always applies. Chains are followed: a question goes when what it names goes on to a finding or to a
 * question that stays, and it is merged into that finding (the first a question of the chain names) or else that
 * question (the lowest that stays). In a cycle the lowest position stays.
 */
function mergeQuestions(
  questions: readonly Question[],
  entries: readonly { question: number; sameAs: string }[],
  findingIds: ReadonlySet<string>,
): { kept: Question[]; merged: { question: Question; into: QuestionTarget }[] } {
  const n = questions.length;
  const next: number[][] = questions.map(() => []);
  const namesFinding: (string | null)[] = questions.map(() => null);
  for (const { question, sameAs } of entries) {
    if (!Number.isInteger(question) || question < 1 || question > n) continue;
    const from = question - 1;
    const ref = QUESTION_REF.exec(sameAs);
    if (ref) {
      const to = Number(ref[1]) - 1;
      if (to < n && to !== from) next[from]!.push(to);
    } else if (findingIds.has(sameAs)) {
      namesFinding[from] ??= sameAs;
    }
  }
  // Every question reachable from each one through one entry or more.
  const reach = questions.map((_, start) => {
    const seen = new Set<number>();
    const todo = [...next[start]!];
    while (todo.length > 0) {
      const i = todo.pop()!;
      if (seen.has(i)) continue;
      seen.add(i);
      todo.push(...next[i]!);
    }
    return seen;
  });
  // A question stays when it leads to no finding, everything it leads to leads back to it, and it is the lowest of those.
  const stays = questions.map((_, i) => namesFinding[i] === null
    && [...reach[i]!].every((j) => j >= i && namesFinding[j] === null && reach[j]!.has(i)));
  const merged: { question: Question; into: QuestionTarget }[] = [];
  questions.forEach((q, i) => {
    if (stays[i]) return;
    const chain = [i, ...[...reach[i]!].sort((a, b) => a - b)];
    const finding = chain.map((j) => namesFinding[j]).find((id) => id !== null);
    const kept = chain.find((j) => j !== i && stays[j]);
    if (finding !== undefined && finding !== null) merged.push({ question: q, into: { findingId: finding } });
    else if (kept !== undefined) merged.push({ question: q, into: { question: questions[kept]! } });
  });
  return { kept: questions.filter((_, i) => stays[i]), merged };
}

// ---- Ranking ----

/**
 * The top list: the agent's `top` ids in order (unknown and repeated ids ignored), or, when none is usable, the most
 * serious items. Then the blocks left out, in input order, are added while there is room, then take the places of the
 * last items that are not blocks, which go under also found. Also found: blocks that still do not fit, the displaced
 * items, the agent's `also` ids in order, then the rest by severity and order given.
 * Items are placed by position, so each is placed exactly once even if two share an id; an id names its first item.
 */
function rank(items: KeptCandidate[], answer: SelectOutput | null): { top: KeptCandidate[]; also: KeptCandidate[] } {
  const all = items.map((_, i) => i);
  const indexOf = new Map<string, number>();
  all.forEach((i) => {
    if (!indexOf.has(items[i]!.id)) indexOf.set(items[i]!.id, i);
  });
  const isBlock = (i: number): boolean => items[i]!.severity === 'block';
  const placed = new Set<number>();
  const place = (list: number[], ...add: number[]): void => {
    list.push(...add);
    for (const i of add) placed.add(i);
  };
  const byId = (ids: string[]): number[] => ids.flatMap((id) => indexOf.get(id) ?? []);

  const top: number[] = [];
  for (const i of byId(answer?.top ?? [])) if (!placed.has(i) && top.length < MAX_TOP) place(top, i);
  if (top.length === 0) place(top, ...bySeverity(items, all).slice(0, MAX_TOP));

  const leftOut = all.filter((i) => isBlock(i) && !placed.has(i));
  const room = MAX_TOP - top.length;
  place(top, ...leftOut.slice(0, room));
  const waiting = leftOut.slice(room);
  const nonBlocks = top.flatMap((i, at) => (isBlock(i) ? [] : [at]));
  const vacated = nonBlocks.slice(Math.max(0, nonBlocks.length - waiting.length));
  const displaced = vacated.map((at) => top[at]!);
  vacated.forEach((at, k) => {
    top[at] = waiting[k]!;
    placed.add(waiting[k]!);
  });

  const also: number[] = [];
  place(also, ...waiting.slice(vacated.length), ...displaced);
  for (const i of byId(answer?.also ?? [])) if (!placed.has(i)) place(also, i);
  place(also, ...bySeverity(items, all.filter((i) => !placed.has(i))));
  return { top: top.map((i) => items[i]!), also: also.map((i) => items[i]!) };
}

const toFinding = (item: KeptCandidate, bucket: Finding['bucket'], rank: number | null): Finding =>
  ({ ...item, fingerprint: fingerprint(item), bucket, rank, status: null });

/** Trimmed, without empty lines, at most MAX_LINES. */
const cleanLines = (lines: string[]): string[] => lines.map((l) => l.trim()).filter((l) => l !== '').slice(0, MAX_LINES);

// ---- The verdict ----

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/** Text that ends a sentence, with a full stop added when it has none. */
const asSentence = (text: string): string => (/[.!?]["')\]]*$/.test(text) ? text : `${text}.`);

type Counts = Verdict['counts'];

function countOf(findings: Finding[]): Counts {
  const counts: Counts = { block: 0, fix: 0, ask: 0, note: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

function labelOf(pr: PrInfo, counts: Counts, failed: boolean, splitSuggested: boolean): VerdictLabel {
  if (failed) return 'incomplete';
  if (pr.author === pr.viewer) {
    if (splitSuggested) return 'split-first';
    return counts.block + counts.fix > 0 ? 'not-ready' : 'ready-for-pr2';
  }
  if (counts.block > 0) return 'request-changes';
  return counts.fix > 0 ? 'approve-after-fixes' : 'approve';
}

/** The title of the first block or fix: the top list by rank, then also found in the order given. */
function firstToFix(findings: Finding[]): string {
  const order = (f: Finding): number => (f.bucket === 'top' ? (f.rank ?? MAX_TOP) : Number.POSITIVE_INFINITY);
  const ranked = findings.map((f, i) => ({ f, i })).sort((a, b) => order(a.f) - order(b.f) || a.i - b.i).map(({ f }) => f);
  const first = ranked.find((f) => f.severity === 'block' || f.severity === 'fix');
  return first ? quotedTitle(first.title) : '';
}

/** Trailing `:`, `;`, `,`, `…` or `...`, with any spaces before them. */
const TRAILING = /(?:\s*(?:[:;,…]|\.\.\.))+$/;

/**
 * A title to end the verdict sentence: on one line, without trailing punctuation that cannot end a sentence, with a full
 * stop. A title longer than MAX_TITLE is cut at a word boundary and ends with `…` instead.
 */
function quotedTitle(title: string): string {
  const text = oneLine(title).replace(TRAILING, '');
  if (text.length <= MAX_TITLE) return asSentence(text);
  let cut = text.slice(0, MAX_TITLE - 1);
  if (text[MAX_TITLE - 1] !== ' ') {
    const space = cut.lastIndexOf(' ');
    if (space > 0) cut = cut.slice(0, space);
  }
  return `${cut.replace(TRAILING, '').trimEnd()}…`;
}

/**
 * The verdict in words. Any stage error makes it `incomplete`. On the viewer's own pull request: `split-first` when a
 * split is suggested, `not-ready` with any block or fix, else `ready-for-pr2`. On someone else's: `request-changes` with
 * any block, `approve-after-fixes` with any fix, else `approve`. `counts` cover the top list and also found; the sentence
 * of a ready or approve verdict also counts the questions that survived selection (`questionCount`) with the `ask` findings.
 */
export function decideVerdict(
  pr: PrInfo, findings: Finding[], stageErrors: StageError[], splitSuggested: boolean, questionCount: number,
): Verdict {
  const counts = countOf(findings);
  const label = labelOf(pr, counts, stageErrors.length > 0, splitSuggested);
  const toFix = counts.block + counts.fix;
  let sentence: string;
  switch (label) {
    case 'incomplete': {
      const stages = [...new Set(stageErrors.map((e) => e.stage))].join(', ');
      sentence = `The review did not finish (${stages}). What was found is listed below, but this is not a complete review.`;
      break;
    }
    case 'split-first':
      sentence = 'This pull request is too large or mixed to review well in one go. Split it, then review the parts.';
      break;
    case 'not-ready':
    case 'request-changes':
      sentence = `${plural(toFix, 'thing', 'things')} to fix before this merges. The first: ${firstToFix(findings)}`;
      break;
    case 'approve-after-fixes':
      sentence = `${plural(toFix, 'thing', 'things')} to fix, none of them blocking. The first: ${firstToFix(findings)}`;
      break;
    case 'ready-for-pr2':
    case 'approve': {
      const toSettle = counts.ask + questionCount;
      sentence = toSettle > 0
        ? `Nothing that needs fixing was found. ${plural(toSettle, 'question', 'questions')} to settle.`
        : 'Nothing that needs fixing was found.';
      break;
    }
  }
  return { label, sentence, counts };
}

/** The self-review text's sentence, in place of "No findings.", for a review that did not finish. */
export const INCOMPLETE_TEXT = 'Airlock could not finish reviewing this pull request.';

export function selfReviewText(pr: PrInfo, depth: Depth, packTitles: string[], verdict: Verdict): string {
  const { counts } = verdict;
  const total = counts.block + counts.fix + counts.ask + counts.note;
  const words: [number, string, string][] = [
    [counts.block, 'block', 'blocks'], [counts.fix, 'fix', 'fixes'], [counts.ask, 'question', 'questions'], [counts.note, 'note', 'notes'],
  ];
  const tally = words.filter(([n]) => n > 0).map(([n, one, many]) => plural(n, one, many)).join(', ');
  const incomplete = verdict.label === 'incomplete';
  const parts = [`Reviewed with Airlock at ${pr.headSha.slice(0, 7)} (${[depth, ...packTitles].join(', ')}).`];
  // A review that did not finish never says "No findings.": nothing found is not the same as nothing there.
  if (total > 0) parts.push(`${plural(total, 'finding', 'findings')}: ${tally}.`);
  else parts.push(incomplete ? INCOMPLETE_TEXT : 'No findings.');
  if (pr.stage === 'pr1') parts.push('No checks ran at PR #1.');
  if (incomplete && total > 0) parts.push('The review did not finish.');
  return parts.join(' ');
}

// ---- The stage ----

/**
 * The selection stage. One request asks the model to choose and order the findings, to say which questions are the same
 * as another question or a finding, and to write whose call it is and what to check after merge; it is made even when
 * nothing was kept. Code then merges duplicates, keeps at most MAX_TOP in the top list with every block in it where room
 * allows, puts every other survivor under also found, and removes the questions the model named as the same. Questions
 * with the same text are reduced to the first before anything else. When the request fails the findings are ranked by
 * severity, no question is merged and a stage error is added. Nothing is removed here except confirmed duplicates.
 * `skipModel` is set on a sync merge, where the model stages did not run: then no request is made when nothing was kept
 * and there are no questions.
 */
export async function select(
  runner: AgentRunner,
  ctx: LensContext,
  kept: KeptCandidate[],
  questions: Question[],
  stageErrors: StageError[],
  depth: Depth = 'standard',
  skipModel = false,
): Promise<SelectResult> {
  const errors: StageError[] = [];
  const usage: AgentUsage[] = [];
  // Items with identical fingerprints are always merged, and questions with the same text, so the model sees each once.
  const distinct = mergeDuplicates(kept);
  const shown = sameTextOnce(questions);
  let answer: SelectOutput | null = null;

  if (!(skipModel && distinct.merged.length === 0 && shown.length === 0)) {
    const template = await loadTemplate('select');
    const result = await sendRequest<SelectOutput>(runner, ctx, {
      role: 'select',
      instructions: instructionsFor(fill(template, { reader: readerOf(ctx.pr) }), ctx.packs, ctx.missingHelpers),
      material: selectMaterial(ctx, distinct.merged, shown),
      schema: SelectOutputSchema,
      cwd: ctx.headDir,
      extraDirs: [ctx.baseDir],
      model: ctx.models.main,
      effort: ctx.models.effort,
    });
    usage.push(result.usage);
    if (result.ok) answer = result.output;
    else errors.push({ stage: 'select', cohortId: null, message: result.error, kind: result.kind });
  }

  const { merged, dropped, notes } = answer ? mergeDuplicates(kept, answer.sameAs) : distinct;
  const { top, also } = rank(merged, answer);
  const findings = [...top.map((item, i) => toFinding(item, 'top', i + 1)), ...also.map((item) => toFinding(item, 'also', null))];
  const titleOf = new Map(distinct.merged.map((k) => [k.id, k.title]));
  const asked = answer ? mergeQuestions(shown, answer.questionSameAs, new Set(titleOf.keys())) : { kept: shown, merged: [] };
  const survivors = asked.kept;
  for (const { question, into } of asked.merged) {
    const target = 'findingId' in into ? `the finding "${oneLine(titleOf.get(into.findingId)!)}"` : `the question "${oneLine(into.question.text)}"`;
    notes.push(`A question was merged into ${target}: "${oneLine(question.text)}"`);
  }
  const verdict = decideVerdict(ctx.pr, findings, [...stageErrors, ...errors], answer?.splitSuggested ?? false, survivors.length);
  return {
    findings,
    dropped,
    questions: survivors,
    verdict,
    whoseCall: cleanLines(answer?.whoseCall ?? []),
    checksAfterMerge: cleanLines(answer?.checksAfterMerge ?? []),
    selfReviewText: selfReviewText(ctx.pr, depth, ctx.packs.map((p) => p.title), verdict),
    notes,
    errors,
    usage,
  };
}
