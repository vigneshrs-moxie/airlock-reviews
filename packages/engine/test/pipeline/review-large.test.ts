import { describe, expect, it } from 'vitest';
import type { AgentRequest } from '../../src/agent/runner.js';
import { CHALLENGE_DIFF_LINE_BUDGET } from '../../src/challenge/challenge.js';
import { DIFF_LINE_BUDGET } from '../../src/lenses/cohort-lens.js';
import { MAX_BATCH_FILES } from '../../src/rules/match.js';
import { SWEEP_DIFF_LINE_BUDGET } from '../../src/rules/sweep.js';
import { block, rawCandidate } from '../helpers/lens-context.js';
import { concurrencyProbe, useReviewHarness } from '../helpers/review-scenario.js';

const { scenario, review } = useReviewHarness();

describe('runReview on a large pull request', () => {
  it('a pull request of 300 small files completes and keeps every request under the caps', async () => {
    const head: Record<string, string> = {};
    for (let i = 0; i < 300; i++) {
      const n = String(i).padStart(3, '0');
      const lines = [`export const first${n} = ${i};`, `export const second${n} = ${i} + 1;`, `export function third${n}(): number {`];
      for (let k = 0; k < 12; k++) lines.push(`  const step${k} = ${k} * ${i};`);
      lines.push(`  return first${n} + second${n};`, '}');
      head[`bulk/${'abc'[i % 3]}/file${n}.ts`] = `${lines.join('\n')}\n`;
    }
    const s = await scenario({ 'README.md': 'base\n' }, head);
    const script = (req: AgentRequest<unknown>): unknown => {
      if (req.role === 'mapper') {
        const paths = block(req.material, 'changed files')!.split('\n').map((l) => l.split(' | ')[0]!);
        const cohorts = ['a', 'b', 'c'].map((d) => ({
          id: `k${d}`, title: `Bulk ${d}`, summary: '', neighbours: [], inferredLinks: [],
          layers: [{ id: `k${d}.l1`, title: 'Files', kind: 'other', files: paths.filter((p) => p.startsWith(`bulk/${d}/`)), dependsOn: [], note: '' }],
        }));
        return { cohorts, standalone: [] };
      }
      if (req.role === 'brief') return { whatItDoes: ['Adds many files.'], claims: [] };
      if (req.role === 'lens:core/correctness') {
        const first = /## File: (\S+)/.exec(block(req.material, 'diff')!)![1]!;
        const n = /file(\d{3})/.exec(first)![1]!;
        return { candidates: [rawCandidate({ path: first, quote: `export const first${n} = ${Number(n)};`, lineHint: 1 })], questions: [] };
      }
      if (req.role.startsWith('challenge:')) {
        return { outcome: 'keep', ground: 'none', explanation: '', refutation: null, newSeverity: null, checked: 'Looked.' };
      }
      if (req.role === 'select') return { top: [], also: [], sameAs: [], whoseCall: [], checksAfterMerge: [], splitSuggested: false };
      return { candidates: [], questions: [] };
    };
    let probe!: ReturnType<typeof concurrencyProbe>;
    const { doc, calls } = await review({ s, script, req: { parallel: 3 }, wrap: (r) => (probe = concurrencyProbe(r, 1)) });

    expect(doc.stageErrors).toEqual([]);
    expect(doc.files).toHaveLength(300);
    expect(doc.findings).toHaveLength(3);
    expect(doc.questions.map((q) => q.text)).toContain('300 changed names were not searched for callers because the pull request is very large.');
    expect(probe.max()).toBe(3);

    const lines = (text: string | null): number => (text ?? '').split('\n').length;
    const lenses = calls.filter((c) => c.role.startsWith('lens:'));
    const sweeps = calls.filter((c) => c.role.startsWith('sweep:'));
    const challenges = calls.filter((c) => c.role.startsWith('challenge:'));
    expect(lenses).toHaveLength(9);
    expect(sweeps.length).toBeGreaterThanOrEqual(Math.ceil(300 / MAX_BATCH_FILES));
    expect(challenges).toHaveLength(3);
    for (const c of lenses) expect(lines(block(c.material, 'diff'))).toBeLessThanOrEqual(DIFF_LINE_BUDGET);
    expect(lenses.some((c) => block(c.material, 'diff')!.includes('more changed lines not shown'))).toBe(true); // the cap was needed
    for (const c of sweeps) {
      const diff = block(c.material, 'diff')!;
      expect(lines(diff)).toBeLessThanOrEqual(SWEEP_DIFF_LINE_BUDGET);
      expect(diff.match(/^## File: /gm)!.length).toBeLessThanOrEqual(MAX_BATCH_FILES);
    }
    for (const c of challenges) expect(lines(block(c.material, 'diff'))).toBeLessThanOrEqual(CHALLENGE_DIFF_LINE_BUDGET);
  }, 90_000); // about 10 s alone and 15 s in the full suite on a quiet machine; the limit is generous because this Mac often runs other work

});
