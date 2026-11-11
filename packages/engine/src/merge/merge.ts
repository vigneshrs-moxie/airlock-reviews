import type { Anchor, Candidate, Dropped, Place, Source, StageError, StageErrorKind } from '@airlock/shared';
import { z } from 'zod';
import { asMaterial, loadTemplate } from '../agent/prompt.js';
import type { AgentRunner, AgentUsage } from '../agent/runner.js';
import { fingerprint } from '../anchor/fingerprint.js';
import { instructionsFor, sendRequest } from '../lenses/context.js';
import type { LensContext } from '../lenses/context.js';
import { SEVERITY_RANK } from '../rules/sweep.js';

/** A cluster holds at most this many candidates; a larger connected set is cut into runs in line order. */
export const MAX_CLUSTER = 12;
/** Two ranges in one file are near when the gap between them is at most this many lines. */
const NEAR_LINES = 2;

/**
 * An anchored candidate. After a merge the keeper also lists the lenses and rules whose duplicates it absorbed, and their
 * fingerprints, so a later dismissal or re-review can recognise it under any of them.
 */
export type AnchoredCandidate = Candidate & { anchor: Anchor; alsoRaisedBy?: Source[]; aliases?: string[] };

export interface Cluster { id: string; members: AnchoredCandidate[] }

export const MergeOutputSchema = z.object({
  clusters: z.array(z.object({ id: z.string(), sets: z.array(z.array(z.string())), reason: z.string() })),
});
export type MergeOutput = z.infer<typeof MergeOutputSchema>;

export interface MergeResult {
  /** The candidates left: every keeper and every candidate not merged, in the order given. */
  items: AnchoredCandidate[];
  /** One entry per merged duplicate, at stage `merge`, naming its keeper in `mergedInto`. */
  dropped: Dropped[];
  errors: StageError[];
  usage: AgentUsage[];
}

const squash = (text: string): string => text.replace(/\s+/g, '');
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const CONFIDENCE_RANK: Record<Candidate['confidence'], number> = { low: 0, medium: 1, high: 2 };

/** The candidate's own place, as a key: its file and its quote without whitespace. */
const placeKey = (path: string, quote: string): string => `${path}\0${squash(quote)}`;

/** Two anchored ranges in one file that overlap or lie within NEAR_LINES lines of each other. */
export function nearInFile(a: AnchoredCandidate, b: AnchoredCandidate): boolean {
  const [as, ae, bs, be] = [a.anchor.startLine, a.anchor.endLine ?? a.anchor.startLine, b.anchor.startLine, b.anchor.endLine ?? b.anchor.startLine];
  if (a.path !== b.path || as === null || bs === null || ae === null || be === null) return false;
  return bs - ae <= NEAR_LINES && as - be <= NEAR_LINES;
}

/** One candidate's primary place is one of the other's connected places: same file, same quote ignoring whitespace. */
function pointsAt(a: AnchoredCandidate, b: AnchoredCandidate): boolean {
  const own = placeKey(a.path, a.quote);
  return b.connected.some((p) => placeKey(p.path, p.quote) === own);
}

const anchoredLine = (c: AnchoredCandidate): boolean => c.anchor.startLine !== null;

/** Line order: by file, then first line, then the order given. */
function inLineOrder(items: readonly AnchoredCandidate[], members: number[]): number[] {
  return [...members].sort((x, y) => {
    const a = items[x]!;
    const b = items[y]!;
    return (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.anchor.startLine! - b.anchor.startLine! || x - y;
  });
}

/** `members` cut into the fewest runs of at most MAX_CLUSTER, as even in size as possible. */
function runsOf(members: number[]): number[][] {
  const count = Math.ceil(members.length / MAX_CLUSTER);
  const runs: number[][] = [];
  let at = 0;
  for (let k = 0; k < count; k++) {
    const size = Math.floor(members.length / count) + (k < members.length % count ? 1 : 0);
    runs.push(members.slice(at, at + size));
    at += size;
  }
  return runs;
}

/**
 * The clusters code proposes; it never merges anything itself. Two anchored candidates are linked when they are in the
 * same file and their lines overlap or lie within two lines of each other, or when one's own place is a connected place
 * of the other. A cluster is a connected set of two or more; a larger one than MAX_CLUSTER is cut into runs in line
 * order. A candidate with no anchored line joins none. Clusters are named `d1`, `d2`, … in the order of their first
 * member in the list given, and list their members in line order.
 */
export function proposeClusters(items: readonly AnchoredCandidate[]): Cluster[] {
  const parent = items.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i]!;
    return i;
  };
  const placed = items.flatMap((c, i) => (anchoredLine(c) ? [i] : []));
  for (const [k, i] of placed.entries()) {
    for (const j of placed.slice(k + 1)) {
      const [a, b] = [items[i]!, items[j]!];
      if (nearInFile(a, b) || pointsAt(a, b) || pointsAt(b, a)) {
        const [ri, rj] = [root(i), root(j)];
        if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
      }
    }
  }
  const sets = new Map<number, number[]>();
  for (const i of placed) {
    const r = root(i);
    sets.set(r, [...(sets.get(r) ?? []), i]);
  }
  const clusters: Cluster[] = [];
  for (const members of [...sets.values()].filter((m) => m.length > 1).sort((a, b) => a[0]! - b[0]!)) {
    for (const run of runsOf(inLineOrder(items, members))) {
      clusters.push({ id: `d${clusters.length + 1}`, members: run.map((i) => items[i]!) });
    }
  }
  return clusters;
}

// ---- The request ----

const indented = (text: string): string[] => text.split('\n').map((l) => `      ${l}`);

function lines(c: AnchoredCandidate): string {
  const { startLine, endLine } = c.anchor;
  return endLine === null || endLine === startLine ? `${startLine}` : `${startLine}-${endLine}`;
}

/** One material block per cluster: each member's id, who raised it, title, what happens, why, the change, place and quote. */
function clusterBlock(cluster: Cluster): string {
  const members = cluster.members.flatMap((c) => [
    `- id: ${c.id}`,
    `  raised by: ${c.source.pack}/${c.source.ruleId ?? c.source.lens ?? '-'}`,
    `  title: ${oneLine(c.title)}`,
    `  what happens: ${oneLine(c.happens)}`,
    `  why: ${oneLine(c.why)}`,
    `  suggested change: ${oneLine(c.suggestedChange) || '(not given)'}`,
    `  place: ${c.path}:${lines(c)}`,
    '  quote:',
    ...indented(c.quote),
  ]);
  return asMaterial(`cluster ${cluster.id}`, members.join('\n'));
}

/** Why an answer for this cluster cannot be used, or null when its sets are a partition of exactly the cluster's ids. */
function unusable(cluster: Cluster, sets: string[][]): string | null {
  const ids = new Set(cluster.members.map((m) => m.id));
  const seen = new Set<string>();
  if (sets.length === 0 || sets.some((s) => s.length === 0)) return 'an empty set';
  for (const id of sets.flat()) {
    if (!ids.has(id)) return `${id} is not in the cluster`;
    if (seen.has(id)) return `${id} is named twice`;
    seen.add(id);
  }
  return seen.size === ids.size ? null : 'a finding is left out';
}

interface Accepted { cluster: Cluster; sets: string[][]; reason: string }

/** The clusters whose answer is a usable partition, and the clusters left without one. */
function readAnswer(clusters: Cluster[], answer: MergeOutput): { accepted: Accepted[]; missing: Cluster[] } {
  const accepted: Accepted[] = [];
  const missing: Cluster[] = [];
  for (const cluster of clusters) {
    const entries = answer.clusters.filter((e) => e.id.trim() === cluster.id);
    const entry = entries.length === 1 ? entries[0]! : null;
    if (entry === null || unusable(cluster, entry.sets) !== null) missing.push(cluster);
    else accepted.push({ cluster, sets: entry.sets, reason: oneLine(entry.reason) });
  }
  return { accepted, missing };
}

const named = (clusters: Cluster[]): string => clusters.map((c) => `${c.id} (${c.members.map((m) => m.id).join(', ')})`).join(', ');
const clustersWord = (clusters: Cluster[]): string => (clusters.length === 1 ? 'cluster' : 'clusters');

// ---- Merging ----

/** The most serious member: by severity, then confidence, then the earliest in the list. */
function keeperOf(members: AnchoredCandidate[], position: Map<string, number>): AnchoredCandidate {
  return members.reduce((best, c) => {
    const bySeverity = SEVERITY_RANK[c.severity] - SEVERITY_RANK[best.severity];
    const byConfidence = CONFIDENCE_RANK[c.confidence] - CONFIDENCE_RANK[best.confidence];
    const earlier = position.get(c.id)! < position.get(best.id)!;
    return bySeverity > 0 || (bySeverity === 0 && (byConfidence > 0 || (byConfidence === 0 && earlier))) ? c : best;
  });
}

const sourceKey = (s: Source): string => `${s.pack}\0${s.lens ?? ''}\0${s.ruleId ?? ''}`;

/** Each value once, in the order given, leaving out the ones in `except`. */
function uniqueBy<T>(values: T[], key: (v: T) => string, except: Set<string> = new Set()): T[] {
  const seen = new Set(except);
  return values.filter((v) => {
    const k = key(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The candidate without what the pipeline added to it, as a Dropped entry holds it. */
export function plainCandidate(c: Candidate & Partial<{ anchor: Anchor; checked: string; alsoRaisedBy: Source[]; aliases: string[] }>): Candidate {
  const { anchor: _a, checked: _c, alsoRaisedBy: _s, aliases: _p, ...candidate } = c;
  return candidate;
}

/**
 * The keeper with its duplicates folded in: their connected places (each place once, never its own place), the sources
 * that also raised it and their fingerprints (each once, never its own). A list stays absent when it would be empty.
 */
export function absorb<T extends AnchoredCandidate>(keeper: T, others: AnchoredCandidate[]): T {
  const connected = uniqueBy<Place>([...keeper.connected, ...others.flatMap((o) => o.connected)],
    (p) => placeKey(p.path, p.quote), new Set([placeKey(keeper.path, keeper.quote)]));
  const sources = uniqueBy([...(keeper.alsoRaisedBy ?? []), ...others.flatMap((o) => [o.source, ...(o.alsoRaisedBy ?? [])])],
    sourceKey, new Set([sourceKey(keeper.source)]));
  const own = fingerprint(keeper);
  const aliases = uniqueBy([...(keeper.aliases ?? []), ...others.flatMap((o) => [fingerprint(o), ...(o.aliases ?? [])])],
    (a) => a, new Set([own]));
  return {
    ...keeper, connected,
    ...(sources.length > 0 ? { alsoRaisedBy: sources } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
  };
}

function applyMerges(items: AnchoredCandidate[], accepted: Accepted[]): { items: AnchoredCandidate[]; dropped: Dropped[] } {
  const position = new Map(items.map((c, i) => [c.id, i]));
  const byId = new Map(items.map((c) => [c.id, c]));
  const replaced = new Map<string, AnchoredCandidate>();
  const dropped: Dropped[] = [];
  for (const { sets, reason } of accepted) {
    for (const set of sets.filter((s) => s.length > 1)) {
      const members = set.map((id) => byId.get(id)!);
      const keeper = keeperOf(members, position);
      const others = members.filter((m) => m !== keeper).sort((a, b) => position.get(a.id)! - position.get(b.id)!);
      replaced.set(keeper.id, absorb(keeper, others));
      for (const o of others) {
        dropped.push({
          candidate: plainCandidate(o), stage: 'merge', refutation: null, mergedInto: keeper.id,
          reason: `the same problem as "${oneLine(keeper.title)}": ${reason === '' ? 'no reason was given' : reason}`,
        });
      }
    }
  }
  const gone = new Set(dropped.map((d) => d.candidate.id));
  return {
    items: items.filter((c) => !gone.has(c.id)).map((c) => replaced.get(c.id) ?? c),
    dropped: dropped.sort((a, b) => position.get(a.candidate.id)! - position.get(b.candidate.id)!),
  };
}

/**
 * The challenge's Dropped entries, each keeper that had duplicates merged into it saying so: its reason gains
 * ` (<n> merged duplicates went with it)`.
 */
export function withMergedCount(challengeDropped: Dropped[], mergeDropped: Dropped[]): Dropped[] {
  return challengeDropped.map((d) => {
    const n = mergeDropped.filter((m) => m.mergedInto === d.candidate.id).length;
    if (n === 0) return d;
    return { ...d, reason: `${d.reason} (${n === 1 ? '1 merged duplicate' : `${n} merged duplicates`} went with it)` };
  });
}

// ---- The stage ----

/**
 * The merge stage. Code proposes clusters of candidates at the same place (proposeClusters); one request asks the model
 * to split each cluster into sets of the same problem; a set is merged only when the model's answer for its cluster is a
 * partition of exactly that cluster. Same place alone never merges two candidates. Clusters without a usable answer are
 * asked about once more, on their own; if that fails too they stay unmerged and a stage error names them. A request that
 * fails for any reason other than an unusable answer is not repeated. With no cluster no request is made.
 */
export async function mergeSameProblems(runner: AgentRunner, ctx: LensContext, items: AnchoredCandidate[]): Promise<MergeResult> {
  const out: MergeResult = { items, dropped: [], errors: [], usage: [] };
  const clusters = proposeClusters(items);
  if (clusters.length === 0) return out;

  const instructions = instructionsFor(await loadTemplate('merge'), ctx.packs, ctx.missingHelpers);
  const ask = (asked: Cluster[]) => sendRequest<MergeOutput>(runner, ctx, {
    role: 'merge',
    instructions,
    material: asked.map(clusterBlock).join('\n\n'),
    schema: MergeOutputSchema,
    cwd: ctx.headDir,
    extraDirs: [ctx.baseDir],
    model: ctx.models.main,
    effort: 'low',
  });

  const accepted: Accepted[] = [];
  let missing = clusters;
  for (let attempt = 0; attempt < 2 && missing.length > 0; attempt++) {
    const result = await ask(missing);
    out.usage.push(result.usage);
    if (!result.ok) {
      if (result.kind === 'invalid-output') continue;
      const kind: StageErrorKind = result.kind;
      const verb = missing.length === 1 ? 'was' : 'were';
      out.errors.push({ stage: 'merge', cohortId: null, kind, message: `${result.error}; ${clustersWord(missing)} ${named(missing)} ${verb} not merged` });
      missing = [];
      break;
    }
    const read = readAnswer(missing, result.output);
    accepted.push(...read.accepted);
    missing = read.missing;
  }
  if (missing.length > 0) {
    const tail = missing.length === 1 ? 'so it was not merged' : 'so they were not merged';
    out.errors.push({
      stage: 'merge', cohortId: null, kind: 'invalid-output', message: `no usable answer for ${clustersWord(missing)} ${named(missing)}, ${tail}`,
    });
  }
  const merged = applyMerges(items, accepted);
  return { ...out, items: merged.items, dropped: merged.dropped };
}
