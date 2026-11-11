import type { Candidate, ChangeMap, Cohort, Dropped, Question, StageError } from '@airlock/shared';
import type { AgentRunner } from '../agent/runner.js';
import { anchorCandidates } from '../anchor/anchor.js';
import { fingerprint } from '../anchor/fingerprint.js';
import { challenge, type KeptCandidate } from '../challenge/challenge.js';
import type { ReadFile } from '../challenge/proof.js';
import { runCohortLenses } from '../lenses/cohort-lens.js';
import type { LensContext } from '../lenses/context.js';
import type { StageRecorder } from './stages.js';

/** The sentence added to every lens request of the deep pass. */
export const DEEP_SENTENCE = 'This is a second, closer pass over one layer: read every non-test file in it in full.';

/** For the deep pass: each layer of a cohort with more than one layer as its own cohort, keyed back to the cohort. */
function layerMap(map: ChangeMap): { map: ChangeMap; cohortOf: Map<string, string> } {
  const cohortOf = new Map<string, string>();
  const cohorts: Cohort[] = map.cohorts.filter((c) => c.layers.length > 1).flatMap((c) => c.layers.map((l) => {
    const id = `${c.id}/${l.id}`;
    cohortOf.set(id, c.id);
    return { ...c, id, title: `${c.title}: ${l.title}`, layers: [{ ...l, dependsOn: [] }] };
  }));
  return { map: { cohorts, standalone: [], links: map.links }, cohortOf };
}

/** The review's own lists; the deep pass adds to them as it goes, so what it found before a failure is kept. */
export interface DeepSink {
  candidates: Candidate[];
  questions: Question[];
  schemaDropped: Dropped[];
  anchorDropped: Dropped[];
  challengeDropped: Dropped[];
  kept: KeptCandidate[];
  limits: string[];
}

export interface DeepInput {
  runner: AgentRunner;
  ctx: LensContext;
  /** Fingerprints of every item already kept or dropped; the pass adds the ones it accepts. */
  seen: Set<string>;
  /** Gives fresh ids to candidates whose id is already used in this review. */
  uniqueIds: (candidates: Candidate[]) => Candidate[];
  readHead: (path: string) => Promise<string | null>;
  readBoth: ReadFile;
}

/**
 * The deep pass: the cohort lenses again over each layer of every cohort with more than one layer, told to read the
 * layer's files in full. A candidate whose fingerprint was seen before, in the review or earlier in this pass, is
 * discarded; the rest are added to the review's candidates, then anchored and challenged. Everything it adds names the
 * original cohort, and every error it records is named `lenses-deep`.
 */
export async function deepPass(rec: StageRecorder, input: DeepInput, sink: DeepSink): Promise<void> {
  const { runner, ctx, seen } = input;
  const { map, cohortOf } = layerMap(ctx.map);
  const back = <T extends { cohortId: string | null }>(x: T): T =>
    ({ ...x, cohortId: x.cohortId === null ? null : (cohortOf.get(x.cohortId) ?? x.cohortId) });
  const named = (errors: StageError[]): StageError[] => errors.map((e) => ({ ...e, stage: 'lenses-deep' }));

  const lensed = await runCohortLenses(runner, { ...ctx, map, extraInstructions: DEEP_SENTENCE });
  rec.usage(lensed.usage);
  rec.error(...named(lensed.errors));
  sink.limits.push(...lensed.limits.map((l) => l.replace(/^lenses: /, 'lenses-deep: ')));
  sink.questions.push(...lensed.questions.map(back));
  sink.schemaDropped.push(...lensed.dropped.map((d) => ({ ...d, candidate: back(d.candidate) })));
  const fresh = lensed.candidates.filter((c) => {
    const print = fingerprint(c);
    if (seen.has(print)) return false;
    seen.add(print);
    return true;
  });
  const candidates = input.uniqueIds(fresh.map(back));
  sink.candidates.push(...candidates);

  const anchored = await anchorCandidates(candidates, ctx.files, input.readHead);
  sink.anchorDropped.push(...anchored.dropped);
  const challenged = await challenge(runner, ctx, anchored.anchored, input.readBoth);
  rec.usage(challenged.usage);
  rec.error(...named(challenged.errors));
  sink.limits.push(...challenged.limits.map((l) => l.replace(/^challenge: /, 'lenses-deep challenge: ')));
  sink.challengeDropped.push(...challenged.dropped);
  sink.kept.push(...challenged.kept);
}
