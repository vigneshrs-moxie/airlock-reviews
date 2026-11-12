import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { failure } from '../../src/agent/fake-runner.js';
import type { AgentRequest } from '../../src/agent/runner.js';
import { renderReview } from '../../src/render/terminal.js';
import { block, rawCandidate } from '../helpers/lens-context.js';
import { scenarioScript, useReviewHarness } from '../helpers/review-scenario.js';

const SIX_LENSES_DIR = fileURLToPath(new URL('../fixtures/pipeline/six-lenses/', import.meta.url));
const LENSES = ['boundary', 'numbers', 'scale', 'release', 'sibling', 'correctness'];
const none = { candidates: [], questions: [] };
const cohortLine = (req: AgentRequest<unknown>): string => block(req.material, 'cohort')?.split('\n')[0] ?? '';

/** Every lens raises the same un-rounded line of src/money.ts; the scale lens calls it a block. */
const sameLine = (req: AgentRequest<unknown>) => {
  if (cohortLine(req) !== 'Cohort: Money') return none;
  const lens = req.role.split('/')[1]!;
  return {
    candidates: [rawCandidate({
      severity: lens === 'scale' ? 'block' : 'fix', title: `${lens}: the total is not rounded`, path: 'src/money.ts',
      quote: 'return n.toFixed(2);', lineHint: 3,
    })],
    questions: [],
  };
};

/** Every member id of every cluster in a merge request, one set per cluster. */
const allOneSet = (req: AgentRequest<unknown>) => {
  const blocks = [...req.material.matchAll(/<material label="cluster (d\d+)">\n([\s\S]*?)\n<\/material>/g)];
  return {
    clusters: blocks.map(([, id, body]) => ({
      id, sets: [body!.split('\n').filter((l) => l.startsWith('- id: ')).map((l) => l.slice(6))], reason: 'They all say the total is not rounded.',
    })),
  };
};

describe('runReview merge stage', () => {
  const h = useReviewHarness();

  it('the six-lenses-one-line case ends as one finding with five dropped entries pointing at it, and only it is challenged', async () => {
    const { doc, calls } = await h.review({ req: { packsDir: SIX_LENSES_DIR }, script: scenarioScript({ 'lens:': sameLine, merge: allOneSet }) });
    expect(calls.filter((c) => c.role === 'merge')).toHaveLength(1);
    expect(doc.findings).toHaveLength(1);
    const keeper = doc.findings[0]!;
    expect(keeper.source.lens).toBe('scale');
    expect(keeper.severity).toBe('block');
    expect(keeper.alsoRaisedBy!.map((s) => s.lens)).toEqual(['boundary', 'numbers', 'release', 'sibling', 'correctness']);
    expect(keeper.aliases).toHaveLength(5);
    const merged = doc.dropped.filter((d) => d.stage === 'merge');
    expect(merged).toHaveLength(5);
    expect(merged.every((d) => d.mergedInto === keeper.id)).toBe(true);
    expect(calls.filter((c) => c.role.startsWith('challenge:')).map((c) => c.role)).toEqual([`challenge:${keeper.id}`]);
    expect(doc.timings.map((t) => t.stage).slice(9, 12)).toEqual(['anchor', 'merge', 'challenge']);
    expect(doc.stageErrors).toEqual([]);
  });

  it('a keeper the challenge drops says how many merged duplicates went with it', async () => {
    const { doc } = await h.review({
      req: { packsDir: SIX_LENSES_DIR },
      script: scenarioScript({
        'lens:': sameLine, merge: allOneSet,
        'challenge:': () => ({
          outcome: 'drop', ground: 'guarded-elsewhere', explanation: 'bill rounds first.', newSeverity: null, checked: 'Read billing.',
          refutation: { path: 'src/billing.ts', quote: 'export function bill(total: number): string {', where: 'head' },
        }),
      }),
    });
    expect(doc.findings).toHaveLength(0);
    const keeperDrop = doc.dropped.filter((d) => d.stage === 'challenge');
    expect(keeperDrop).toHaveLength(1);
    expect(keeperDrop[0]!.reason).toMatch(/ \(5 merged duplicates went with it\)$/);
  });

  it('keeps every candidate when the model says they are different problems', async () => {
    const apart = (req: AgentRequest<unknown>) => ({
      clusters: allOneSet(req).clusters.map((c) => ({ ...c, sets: c.sets[0]!.map((id) => [id]), reason: 'Different faults.' })),
    });
    const { doc } = await h.review({ req: { packsDir: SIX_LENSES_DIR }, script: scenarioScript({ 'lens:': sameLine, merge: apart, select: () => ({
      top: [], also: [], sameAs: [], questionSameAs: [], whoseCall: [], checksAfterMerge: [], splitSuggested: false,
    }) }) });
    expect(doc.findings).toHaveLength(6);
    expect(doc.dropped.filter((d) => d.stage === 'merge')).toEqual([]);
  });

  describe('a merge Airlock could not confirm', () => {
    const NOTE = /^Airlock could not confirm whether 6 findings at the same place are the same problem \("boundary: the total is not rounded", .* and 1 more\), so they are listed separately\.$/;

    it.each([
      ['an answer unusable twice', () => ({ clusters: [{ id: 'd1', sets: [['nobody']], reason: 'x' }] })],
      ['a turn limit', () => failure('error_max_turns', 'turn-limit')],
      ['a timeout', () => failure('timed out after 300 s', 'timeout')],
    ])('after %s, keeps every finding, adds a note and no stage error, and the review is not incomplete', async (_name, answer) => {
      const { doc } = await h.review({ req: { packsDir: SIX_LENSES_DIR }, script: scenarioScript({ 'lens:': sameLine, merge: answer }) });
      expect(doc.stageErrors).toEqual([]);
      expect(doc.verdict.label).not.toBe('incomplete');
      expect(doc.findings).toHaveLength(6);
      expect(doc.notes).toEqual([expect.stringMatching(NOTE)]);
      expect(doc.timings.map((t) => t.stage)).toContain('merge');
      expect(doc.timings.find((t) => t.stage === 'merge')!.agentRuns).toBeGreaterThan(0);
      expect(renderReview(doc)).toMatch(/\nNotes\n\n- Airlock could not confirm whether 6 findings/);
    });

    it('a usage limit stays a stage error of that kind and the review is incomplete', async () => {
      const { doc } = await h.review({
        req: { packsDir: SIX_LENSES_DIR },
        script: scenarioScript({ 'lens:': sameLine, merge: () => failure("Claude's usage limit was reached", 'usage-limit') }),
      });
      expect(doc.stageErrors.filter((e) => e.stage === 'merge')).toEqual([expect.objectContaining({ kind: 'usage-limit' })]);
      expect(doc.verdict.label).toBe('incomplete');
      expect(doc.notes ?? []).not.toContainEqual(expect.stringMatching(/could not confirm/));
    });
  });

  describe('a keeper challenged as pre-existing', () => {
    const PAY = "import { formatMoney } from './money';\n\nexport function pay(n: number): string {\n  return formatMoney(n);\n}\n";
    const ROUNDING = rawCandidate({ severity: 'block', title: 'formatMoney rounds half down', path: 'src/money.ts', quote: 'return n.toFixed(2);', lineHint: 2 });
    /** The challenger says pre-existing, quoting the finding's own line on the base. */
    const preExisting = (req: AgentRequest<unknown>) => {
      const finding = block(req.material, 'finding') ?? req.material;
      const [path, quote] = /^Where: src\/pay\.ts/m.test(finding) ? ['src/pay.ts', 'return formatMoney(n);'] : ['src/money.ts', 'return n.toFixed(2);'];
      return {
        outcome: 'drop', ground: 'pre-existing', explanation: 'This code was already there.', refutation: { path, quote, where: 'base' },
        newSeverity: null, checked: 'Read the base.',
      };
    };

    it('keeps a duplicate on a line this pull request added, as a second place of the keeper', async () => {
      const onAdded = rawCandidate({
        severity: 'fix', title: 'The new pay screen shows a wrongly rounded amount', path: 'src/pay.ts', quote: 'return formatMoney(n);', lineHint: 4,
        connected: [{ path: 'src/money.ts', quote: 'return n.toFixed(2);', role: 'the rounding is done here' }],
      });
      const lens = (req: AgentRequest<unknown>) => (req.role === 'lens:core/correctness' ? { candidates: [ROUNDING], questions: [] }
        : req.role === 'lens:raj-standard/boundary' ? { candidates: [onAdded], questions: [] } : none);
      const s = await h.scenario(undefined, { 'src/pay.ts': PAY });
      const { doc, calls } = await h.review({ s, script: scenarioScript({ 'lens:': lens, 'sweep:': () => none, merge: allOneSet, 'challenge:': preExisting }) });
      expect(calls.filter((c) => c.role === 'merge')).toHaveLength(1);
      expect(doc.dropped.filter((d) => d.stage === 'merge').map((d) => d.candidate.title)).toEqual(['The new pay screen shows a wrongly rounded amount']);
      expect(doc.findings.map((f) => [f.title, f.path])).toEqual([['formatMoney rounds half down', 'src/money.ts']]);
      expect(doc.findings[0]!.connected).toContainEqual({ path: 'src/pay.ts', line: 4, role: 'also raised here', quote: '  return formatMoney(n);' });
      expect(['approve', 'ready-for-pr2']).not.toContain(doc.verdict.label);
    });

    it('still drops a keeper whose merged duplicates are all on unchanged lines', async () => {
      const header = rawCandidate({
        severity: 'fix', title: 'formatMoney takes any number', path: 'src/money.ts', quote: 'export function formatMoney(n: number): string {', lineHint: 1,
      });
      const lens = (req: AgentRequest<unknown>) => (req.role === 'lens:core/correctness' ? { candidates: [ROUNDING], questions: [] }
        : req.role === 'lens:raj-standard/boundary' ? { candidates: [header], questions: [] } : none);
      const s = await h.scenario(undefined, { 'src/pay.ts': PAY });
      const { doc } = await h.review({ s, script: scenarioScript({ 'lens:': lens, 'sweep:': () => none, merge: allOneSet, 'challenge:': preExisting }) });
      expect(doc.findings).toEqual([]);
      const dropped = doc.dropped.find((d) => d.stage === 'challenge')!;
      expect(dropped.candidate.title).toBe('formatMoney rounds half down');
      expect(dropped.candidate.connected).toContainEqual({
        path: 'src/money.ts', line: 1, role: 'also raised here', quote: 'export function formatMoney(n: number): string {',
      });
      expect(dropped.reason).toMatch(/ \(1 merged duplicate went with it\)$/);
    });
  });

  it('makes no merge request at quick depth', async () => {
    const quick = await h.review({ req: { packsDir: SIX_LENSES_DIR, depth: 'quick' }, script: scenarioScript({ 'lens:': sameLine, merge: allOneSet }) });
    expect(quick.calls.filter((c) => c.role === 'merge')).toHaveLength(0);
    expect(quick.events).toContainEqual({ type: 'stage', stage: 'merge', status: 'done', detail: 'skipped: quick depth' });
  });

  it('makes no merge request when no two candidates are near each other', async () => {
    const standard = await h.review();
    expect(standard.calls.filter((c) => c.role === 'merge')).toHaveLength(0);
    expect(standard.doc.timings.map((t) => t.stage)).toContain('merge');
  });
});
