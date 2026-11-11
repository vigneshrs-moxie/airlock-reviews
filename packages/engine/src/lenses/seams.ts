import type { Candidate } from '@airlock/shared';
import { asMaterial, fill, loadTemplate } from '../agent/prompt.js';
import type { AgentRunner } from '../agent/runner.js';
import {
  briefBlock, candidateLines, emptyResult, factsBlock, hasFilesToRead, instructionsFor, mapBlock, prBlock, readerOf,
  runLensCall, standaloneCohort, tierOf,
} from './context.js';
import type { LensContext, LensStageResult } from './context.js';

/**
 * One request that looks only at what crosses cohorts or concerns the whole pull request. It runs when there are at
 * least two cohorts, counting the standalone group when it has a read or skim file. No diff text is sent.
 */
export async function runSeams(runner: AgentRunner, ctx: LensContext, soFar: Candidate[]): Promise<LensStageResult> {
  const standalone = hasFilesToRead(standaloneCohort(ctx.map), tierOf(ctx.tiers)) ? 1 : 0;
  if (ctx.map.cohorts.length + standalone < 2) return emptyResult();

  const lines = candidateLines(soFar);
  const material = [
    prBlock(ctx.pr),
    briefBlock(ctx.brief),
    mapBlock(ctx.map),
    factsBlock(ctx.facts),
    asMaterial('candidates so far', lines.length === 0 ? '(none)' : lines.join('\n')),
  ].join('\n\n');

  return runLensCall(runner, ctx, {
    role: 'seams', name: 'airlock/seams', stage: 'seams', source: { pack: 'airlock', lens: 'seams', ruleId: null },
    cohortId: null, material,
    instructions: instructionsFor(fill(await loadTemplate('seams'), { reader: readerOf(ctx.pr) }), ctx.packs, ctx.missingHelpers),
  }, new Set(soFar.map((c) => c.id)));
}
