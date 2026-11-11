import type { Anchor, Candidate, Dropped, FileDiff, Place, Severity, StageError, Tier } from '@airlock/shared';
import { SeveritySchema } from '@airlock/shared';
import { posix } from 'node:path';
import { z } from 'zod';
import { asMaterial, loadTemplate } from '../agent/prompt.js';
import type { AgentRunner, AgentUsage } from '../agent/runner.js';
import { findQuote } from '../anchor/anchor.js';
import { budgetedDiff } from '../lenses/cohort-lens.js';
import {
  cohortOutline, factsBlock, instructionsFor, learnedDocuments, prBlock, sendRequest, standaloneCohort, standardDocuments,
  tierOf,
} from '../lenses/context.js';
import type { LensContext, StandardDocument } from '../lenses/context.js';
import { SEVERITY_RANK } from '../rules/sweep.js';

/** The challenge's diff budget, in lines of formatForPrompt output, shared by the finding's file and its connected files. */
export const CHALLENGE_DIFF_LINE_BUDGET = 600;

export type ChallengeOutcome = 'keep' | 'drop' | 'downgrade' | 'ask';

export const ChallengeOutputSchema = z.object({
  outcome: z.enum(['keep', 'drop', 'downgrade', 'ask']),
  ground: z.enum(['unreachable', 'pre-existing', 'guarded-elsewhere', 'documented-intent', 'smaller', 'none']),
  explanation: z.string(),
  refutation: z.object({ path: z.string(), quote: z.string(), where: z.enum(['head', 'base', 'standard']) }).nullable(),
  newSeverity: SeveritySchema.nullable(),
  checked: z.string(),
});
export type ChallengeOutput = z.infer<typeof ChallengeOutputSchema>;

/** A candidate that survived the challenge, with one or two sentences on what the challenger looked at. */
export type KeptCandidate = Candidate & { anchor: Anchor; checked: string };

export interface ChallengeResult {
  kept: KeptCandidate[];
  dropped: Dropped[];
  errors: StageError[];
  usage: AgentUsage[];
}

type Item = Candidate & { anchor: Anchor };
type Side = 'head' | 'base';
type ReadFile = (where: Side, path: string) => Promise<string | null>;
type Outcome = { kept: KeptCandidate } | { dropped: Dropped };

const NOT_CHALLENGED = 'not challenged';
const DID_NOT_COMPLETE = 'challenge did not complete';
const NOTHING_SAID = 'checked, no refutation found';
const UNCONFIRMED = ' The refutation it offered could not be confirmed in the code, so the finding stands.';

const isChallenged = (c: Item): boolean => c.severity === 'block' || c.severity === 'fix';
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const orNotGiven = (text: string): string => (text.trim() === '' ? '(not given)' : text);

/**
 * A repository-relative path safe to read: no backslash, `%`, `:` or NUL, not starting with `/`, and no empty or `..`
 * segment. Encoded and Windows-style paths are refused rather than decoded.
 */
const isSafePath = (path: string): boolean =>
  path.trim() !== '' && !path.startsWith('/') && !/[\\%:\0]/.test(path)
  && path.split('/').every((s) => s !== '' && s !== '..');

/** `read` with each side and path asked for once; a read that fails counts as a missing file. */
function readOnce(read: ReadFile): ReadFile {
  const cache = new Map<string, Promise<string | null>>();
  return (where, path) => {
    const key = `${where}\0${path}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = Promise.resolve().then(() => read(where, path)).catch(() => null);
      cache.set(key, hit);
    }
    return hit;
  };
}

// ---- Material ----

function whereText(c: Item): string {
  const { status, startLine, endLine } = c.anchor;
  const lines = startLine === null ? ''
    : endLine === null || endLine === startLine ? `, line ${startLine}` : `, lines ${startLine}-${endLine}`;
  return `${c.path}${lines}${status === 'outside-diff' ? ', outside the diff' : ''}`;
}

const indented = (text: string): string[] => text.split('\n').map((l) => `    ${l}`);

function findingBlock(c: Item): string {
  const connected = c.connected.length === 0 ? ['(none)'] : c.connected.flatMap((p) => [
    `- ${p.path}${p.line === null ? '' : `:${p.line}`} (${oneLine(p.role)})`,
    ...(p.quote.trim() === '' ? [] : indented(p.quote)),
  ]);
  return asMaterial('finding', [
    `Severity: ${c.severity}`,
    `Title: ${c.title}`,
    `Where: ${whereText(c)}`,
    'Quoted code:',
    ...indented(c.quote),
    `What happens: ${c.happens}`,
    `Why: ${c.why}`,
    `Suggested change: ${orNotGiven(c.suggestedChange)}`,
    'Connected places:',
    ...connected,
    `Would be wrong if: ${orNotGiven(c.wouldBeWrongIf)}`,
  ].join('\n'));
}

/** The finding, the pull request, the finding's cohort, the diff and facts of its files, then the repository's rule files. */
function challengeMaterial(ctx: LensContext, c: Item, tier: (path: string) => Tier): string {
  const paths = new Set([c.path, ...c.connected.map((p) => p.path)]);
  const byPath = new Map(ctx.files.map((f) => [f.path, f]));
  const diffs = [...paths].flatMap((p) => byPath.get(p) ?? []);
  const cohort = c.cohortId === null ? undefined
    : [...ctx.map.cohorts, standaloneCohort(ctx.map)].find((k) => k.id === c.cohortId);
  return [
    findingBlock(c),
    prBlock(ctx.pr),
    ...(cohort ? [asMaterial('cohort', cohortOutline(cohort, tier).join('\n'))] : []),
    asMaterial('diff', diffs.length === 0 ? '(none)' : budgetedDiff(diffs, CHALLENGE_DIFF_LINE_BUDGET)),
    factsBlock(ctx.facts.filter((f) => paths.has(f.path))),
    ...ctx.repoRules.map((r) => asMaterial(`repository rule file ${r.path}`, r.text)),
  ].join('\n\n');
}

// ---- The answer ----

/** A quote proves nothing unless one of its lines, without whitespace, has this many characters and a letter or digit. */
const MIN_PROOF_CHARS = 12;
const squash = (text: string): string => text.replace(/\s+/g, '');
const hasSubstance = (quote: string): boolean =>
  quote.split('\n').map(squash).some((l) => l.length >= MIN_PROOF_CHARS && /[\p{L}\p{N}]/u.test(l));

/** A quote from the standards proves intent only when it is a whole sentence: this long without whitespace, with this many words. */
const MIN_SENTENCE_CHARS = 40;
const MIN_SENTENCE_WORDS = 4;
const isWholeSentence = (quote: string): boolean =>
  squash(quote).length >= MIN_SENTENCE_CHARS
  && quote.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length >= MIN_SENTENCE_WORDS;

/** Text that ends a sentence, with a full stop added when it has none. */
const asSentence = (text: string): string => (/[.!?]["')\]]*$/.test(text) ? text : `${text}.`);

type Lines = { startLine: number; endLine: number };
const overlaps = (found: Lines, own: Anchor): boolean =>
  own.startLine !== null && found.startLine <= (own.endLine ?? own.startLine) && own.startLine <= found.endLine;

/** A leading list marker such as `- `, `* ` or `1. `; it is not part of the sentence after it. */
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
/** Whole sentences and list entries, each without whitespace. They end at a line break or at `.`, `!` or `?` before whitespace. */
const sentencesOf = (text: string): string[] =>
  text.split(/\r?\n/)
    .flatMap((line) => line.replace(LIST_MARKER, '').split(/(?<=[.!?])\s+/))
    .map(squash)
    .filter((s) => s !== '');
/** True when `needle` appears as consecutive items of `hay`. */
const hasRun = (hay: string[], needle: string[]): boolean =>
  needle.length > 0 && hay.some((_, i) => needle.every((n, k) => hay[i + k] === n));

const isAddedLine = (file: FileDiff, line: number): boolean =>
  file.hunks.some((h) => h.lines.some((l) => l.kind === 'add' && l.newNo === line));

/** What a refutation is checked against: files on either side, the diff, and the standards the challenger was given. */
interface Evidence {
  read: ReadFile;
  files: Map<string, FileDiff>;
  documents: StandardDocument[];
}
type Refutation = NonNullable<ChallengeOutput['refutation']>;
type Proof = { place: Place } | { place: null; ownCode: boolean };
const NO_PROOF: Proof = { place: null, ownCode: false };
const OWN_CODE: Proof = { place: null, ownCode: true };

/** Grounds 1 and 3: code on the head, other than the finding's own lines, quoted in full. */
async function proveOnHead(item: Item, ref: Refutation, { read }: Evidence): Promise<Proof> {
  if (ref.where !== 'head' || !isSafePath(ref.path) || !hasSubstance(ref.quote)) return NO_PROOF;
  const path = posix.normalize(ref.path);
  const found = findQuote(await read('head', path), ref.quote);
  if (found.length === 0) return NO_PROOF;
  if (path === item.path && found.some((f) => overlaps(f, item.anchor))) return OWN_CODE;
  return { place: { path, line: found[0]!.startLine, role: 'head', quote: ref.quote } };
}

/**
 * Ground 2: the base version of the finding's own file (or of its old path, when renamed) holds the finding's own quote,
 * and the finding's first line is not one this pull request added. The record cites the finding's quote on the base.
 */
async function provePreExisting(item: Item, ref: Refutation, { read, files }: Evidence): Promise<Proof> {
  if (ref.where !== 'base' || !isSafePath(ref.path)) return NO_PROOF;
  const file = files.get(item.path);
  const path = posix.normalize(ref.path);
  const own = file?.status === 'renamed' && file.oldPath ? [item.path, file.oldPath] : [item.path];
  const line = item.anchor.startLine;
  if (!own.includes(path) || line === null || (file !== undefined && isAddedLine(file, line))) return NO_PROOF;
  const found = findQuote(await read('base', path), item.quote);
  if (found.length === 0) return NO_PROOF;
  const nearest = found.reduce((a, b) => (Math.abs(b.startLine - line) < Math.abs(a.startLine - line) ? b : a));
  return { place: { path, line: nearest.startLine, role: 'base', quote: item.quote } };
}

/** Ground 4: one or more whole consecutive sentences or entries of one standard or learned list the challenger was given. */
function proveIntent(ref: Refutation, { documents }: Evidence): Proof {
  if (ref.where !== 'standard' || !isWholeSentence(ref.quote)) return NO_PROOF;
  const quoted = sentencesOf(ref.quote);
  const doc = documents.find((d) => hasRun(sentencesOf(d.text), quoted));
  return doc ? { place: { path: doc.name, line: null, role: 'standard', quote: ref.quote } } : NO_PROOF;
}

/** The place a drop's refutation proves, if it does; each ground is tied to the side and place that can prove it. */
async function proveDrop(item: Item, answer: ChallengeOutput, evidence: Evidence): Promise<Proof> {
  const ref = answer.refutation;
  if (ref === null) return NO_PROOF;
  switch (answer.ground) {
    case 'unreachable':
    case 'guarded-elsewhere':
      return proveOnHead(item, ref, evidence);
    case 'pre-existing':
      return provePreExisting(item, ref, evidence);
    case 'documented-intent':
      return proveIntent(ref, evidence);
    default:
      return NO_PROOF;
  }
}

const lowered = (current: Severity, proposed: Severity | null): Severity =>
  proposed !== null && SEVERITY_RANK[proposed] < SEVERITY_RANK[current] ? proposed : current;

/**
 * Applies the answer. A drop is honoured only on grounds 1 to 4 with a proved refutation; a drop on the ground
 * `smaller` is a downgrade. A downgrade only lowers, and an ask becomes ask.
 */
async function applyAnswer(item: Item, answer: ChallengeOutput, evidence: Evidence): Promise<Outcome> {
  const checked = answer.checked.trim() === '' ? NOTHING_SAID : answer.checked.trim();
  const downgraded: Outcome = { kept: { ...item, severity: lowered(item.severity, answer.newSeverity), checked } };
  switch (answer.outcome) {
    case 'drop': {
      if (answer.ground === 'smaller') return downgraded;
      const proof = await proveDrop(item, answer, evidence);
      if (proof.place === null) {
        // On the finding's own lines the challenger reads the code differently; the reader should see its argument.
        const explanation = answer.explanation.trim();
        const said = proof.ownCode && explanation !== '' ? `${asSentence(checked)} ${explanation}` : checked;
        return { kept: { ...item, checked: `${asSentence(said)}${UNCONFIRMED}` } };
      }
      const { anchor: _anchor, ...candidate } = item;
      const reason = `${answer.ground}: ${answer.explanation.trim()}`;
      return { dropped: { candidate, stage: 'challenge', reason, refutation: proof.place } };
    }
    case 'downgrade':
      return downgraded;
    case 'ask':
      return { kept: { ...item, severity: 'ask', checked } };
    case 'keep':
      return { kept: { ...item, checked } };
  }
}

/**
 * The challenge stage: one request per block or fix candidate tries to refute it. A candidate is removed only when the
 * whole quote the challenger offers as proof is found where it says (see proveDrop). Ask and note candidates pass
 * through unchallenged. A request that fails, or an item that throws, keeps its candidate and becomes a stage error; the
 * others carry on. `kept` and `dropped` keep the input order.
 * `read` returns a file's text on one side, or null; it is called only to confirm refutations, once per side and path.
 */
export async function challenge(
  runner: AgentRunner,
  ctx: LensContext,
  items: Item[],
  read: ReadFile,
): Promise<ChallengeResult> {
  const out: ChallengeResult = { kept: [], dropped: [], errors: [], usage: [] };
  if (!items.some(isChallenged)) {
    out.kept = items.map((item) => ({ ...item, checked: NOT_CHALLENGED }));
    return out;
  }

  const instructions = instructionsFor(await loadTemplate('challenge'), ctx.packs, null);
  const evidence: Evidence = {
    read: readOnce(read),
    files: new Map(ctx.files.map((f) => [f.path, f])),
    documents: [...standardDocuments(ctx.packs), ...learnedDocuments(ctx.packs)],
  };
  const tier = tierOf(ctx.tiers);
  type ItemResult = Outcome & { usage?: AgentUsage; error?: StageError };
  const failed = (item: Item, message: string, usage: AgentUsage | undefined): ItemResult => ({
    kept: { ...item, checked: DID_NOT_COMPLETE }, ...(usage ? { usage } : {}),
    error: { stage: 'challenge', cohortId: item.cohortId, message: `${item.id}: ${message}` },
  });
  const results = await Promise.all(items.map(async (item): Promise<ItemResult> => {
    if (!isChallenged(item)) return { kept: { ...item, checked: NOT_CHALLENGED } };
    let usage: AgentUsage | undefined;
    try {
      const result = await sendRequest<ChallengeOutput>(runner, ctx, {
        role: `challenge:${item.id}`,
        instructions,
        material: challengeMaterial(ctx, item, tier),
        schema: ChallengeOutputSchema,
        cwd: ctx.headDir,
        extraDirs: [ctx.baseDir],
        model: ctx.models.challenger,
        effort: ctx.models.effort,
      });
      usage = result.usage;
      if (!result.ok) return failed(item, result.error, usage);
      return { ...(await applyAnswer(item, result.output, evidence)), usage };
    } catch (err) {
      return failed(item, err instanceof Error ? err.message : String(err), usage);
    }
  }));

  for (const r of results) {
    if ('kept' in r) out.kept.push(r.kept);
    else out.dropped.push(r.dropped);
    if (r.error) out.errors.push(r.error);
    if (r.usage) out.usage.push(r.usage);
  }
  return out;
}
