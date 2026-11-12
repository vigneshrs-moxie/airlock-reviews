import { describe, expect, it } from 'vitest';
import type { Anchor } from '@airlock/shared';
import { createFakeRunner } from '../../src/agent/fake-runner.js';
import { loadTemplate, PROMPT_BOUNDARY, splitInstructions } from '../../src/agent/prompt.js';
import type { AgentRequest } from '../../src/agent/runner.js';
import { challenge } from '../../src/challenge/challenge.js';
import { runCohortLenses } from '../../src/lenses/cohort-lens.js';
import { instructionsFor } from '../../src/lenses/context.js';
import { runSeams } from '../../src/lenses/seams.js';
import { mergeSameProblems, type AnchoredCandidate } from '../../src/merge/merge.js';
import { select } from '../../src/select/select.js';
import { candidate } from '@airlock/shared';
import { ctx, lens, pack } from '../helpers/lens-context.js';

const packs = [pack('core', [lens('boundary'), lens('money')], {
  standards: [{ name: 'Money', text: 'STANDARD_MARKER use cents.', dated: false }],
  learned: [{ date: '2026-10-01', repo: 'acme/app', kind: 'wrong', text: 'LEARNED_MARKER pauses are fine.' }],
})];
const reviewCtx = () => ctx({ packs, missingHelpers: ['oldHelper'] });
const anchor: Anchor = { status: 'in-diff', startLine: 2, endLine: 2 };
const item = (id: string): AnchoredCandidate => ({ ...candidate(), id, path: 'src/pause.ts', anchor });
const count = (text: string, part: string): number => text.split(part).length - 1;

/** Every request one review's stages make with the same packs: two lenses, seams, merge, challenge and select. */
async function requests(): Promise<AgentRequest<unknown>[]> {
  const runner = createFakeRunner((req) => {
    if (req.role.startsWith('lens:') || req.role === 'seams') return { candidates: [], questions: [] };
    if (req.role === 'merge') return { clusters: [{ id: 'd1', sets: [['a'], ['b']], reason: 'Different.' }] };
    if (req.role.startsWith('challenge:')) return { outcome: 'keep', ground: 'none', explanation: '', refutation: null, newSeverity: null, checked: 'x' };
    return { top: [], also: [], sameAs: [], questionSameAs: [], whoseCall: [], checksAfterMerge: [], splitSuggested: false };
  });
  const c = reviewCtx();
  await runCohortLenses(runner, c);
  await runSeams(runner, c, []);
  await mergeSameProblems(runner, c, [item('a'), item('b')]);
  await challenge(runner, c, [item('a')], async () => null);
  await select(runner, c, [{ ...item('a'), checked: 'x' }], [], []);
  return runner.calls;
}

describe('instructions put what does not change first', () => {
  it('builds the standards, the learned entries and the missing helpers, then the boundary, then the template', () => {
    const text = instructionsFor('TEMPLATE_MARKER do this.', packs, ['oldHelper']);
    expect(count(text, PROMPT_BOUNDARY)).toBe(1);
    const { standing, stage } = splitInstructions(text);
    expect(standing).toContain('STANDARD_MARKER');
    expect(standing).toContain('LEARNED_MARKER');
    expect(standing).toContain('`oldHelper`');
    expect(standing).not.toContain('TEMPLATE_MARKER');
    expect(stage).toBe('TEMPLATE_MARKER do this.');
  });

  it('gives every stage of one review, and every lens, a byte-identical first part with nothing from the pull request in it', async () => {
    const calls = await requests();
    expect(calls.map((c) => c.role.split(':')[0])).toEqual(['lens', 'lens', 'lens', 'lens', 'seams', 'merge', 'challenge', 'select']);
    const parts = calls.map((c) => splitInstructions(c.instructions));
    for (const c of calls) expect(count(c.instructions, PROMPT_BOUNDARY)).toBe(1);
    expect(new Set(parts.map((p) => p.standing)).size).toBe(1);
    expect(parts[0]!.stage).not.toBe(parts[1]!.stage); // two lenses differ only after the boundary
    const first = parts[0]!.standing;
    expect(first).toContain('STANDARD_MARKER');
    for (const fromPr of ['PR_BODY_MARKER', 'Let members pause a plan', 'src/pause.ts', 'Pausing a plan', 'Finding']) {
      expect(first).not.toContain(fromPr);
    }
  });

  it('no template says the standards come after it', async () => {
    for (const name of ['lens', 'lens-combined', 'seams', 'sweep', 'merge', 'challenge', 'select', 'summary']) {
      const text = await loadTemplate(name);
      expect(text, name).not.toMatch(/After these instructions come the team's standards/);
      expect(text, name).not.toMatch(/After these instructions come[^.]*what earlier reviews taught/);
    }
  });

  it('a request with no boundary has no first part of its own', () => {
    expect(splitInstructions('Map the files.')).toEqual({ standing: '', stage: 'Map the files.' });
  });
});
