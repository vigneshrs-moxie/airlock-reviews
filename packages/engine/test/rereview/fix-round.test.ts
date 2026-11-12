import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewDocument } from '@airlock/shared';
import type { AgentRequest } from '../../src/agent/runner.js';
import { PUSH_BASE_SIDE } from '../../src/challenge/challenge.js';
import { fingerprint } from '../../src/anchor/fingerprint.js';
import { renderReview } from '../../src/render/terminal.js';
import { mergeNote } from '../../src/shape/merge-range.js';
import { saveReview } from '../../src/store/store.js';
import { commitFiles } from '../helpers/change-repo.js';
import { block, rawCandidate } from '../helpers/lens-context.js';
import {
  BASE_FILES, fakeGh, GOOD, HEAD_FILES, RULED, scenarioScript, useReviewHarness, type Scenario,
} from '../helpers/review-scenario.js';

const SLOW = 30_000;
const { scenario, review } = useReviewHarness();

/** Hooks that make a stage throw, or change what it returns; by default each runs as it is. */
const hooks = vi.hoisted(() => ({
  select: null as null | ((result: { findings: { id: string }[] }) => unknown),
  confirmFixed: null as null | (() => void),
  challenge: null as null | (() => void),
}));
vi.mock('../../src/select/select.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/select/select.js')>();
  return {
    ...m,
    select: async (...args: Parameters<typeof m.select>) => {
      const result = await m.select(...args);
      return hooks.select ? hooks.select(result) : result;
    },
  };
});
vi.mock('../../src/rereview/fixed.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/rereview/fixed.js')>();
  return {
    ...m,
    confirmFixed: async (...args: Parameters<typeof m.confirmFixed>) => {
      hooks.confirmFixed?.();
      return m.confirmFixed(...args);
    },
  };
});
vi.mock('../../src/challenge/challenge.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/challenge/challenge.js')>();
  return {
    ...m,
    challenge: async (...args: Parameters<typeof m.challenge>) => {
      hooks.challenge?.();
      return m.challenge(...args);
    },
  };
});
afterEach(() => {
  hooks.select = null;
  hooks.confirmFixed = null;
  hooks.challenge = null;
});

const none = { candidates: [], questions: [] };
const DEEP_SENTENCE = 'This is a second, closer pass over one layer: read every non-test file in it in full.';
const ROUND_TS = 'export function round(n: number): string {\n  return n.toFixed(2);\n}\n';
const ON_PAUSE = rawCandidate({ severity: 'fix', title: 'A pause is not audited', path: 'src/jobs/pause.ts', quote: 'export function pauseJob(): void { audit(); }', lineHint: 1 });

interface Answers {
  paths: string[];
  correctness?: Record<string, unknown>[];
  map?: unknown;
  deep?: Record<string, unknown>[];
  fixedCheck?: (req: AgentRequest<unknown>) => unknown;
}
function script(a: Answers) {
  return scenarioScript({
    mapper: () => a.map ?? { cohorts: [], standalone: a.paths },
    'lens:core/correctness': (req) => (req.instructions.includes(DEEP_SENTENCE)
      ? (block(req.material, 'diff')?.includes('src/money.ts') ? { candidates: a.deep ?? [], questions: [] } : none)
      : { candidates: a.correctness ?? [], questions: [] }),
    'lens:core/naming': () => none,
    'sweep:': () => none,
    seams: () => none,
    merge: () => ({ clusters: [] }),
    'challenge:fixed:': a.fixedCheck ?? (() => { throw new Error('no fixed check was expected'); }),
  });
}

async function first(): Promise<{ s: Scenario; doc: ReviewDocument }> {
  const s = await scenario();
  return { s, doc: (await review({ s })).doc };
}
const again = (s: Scenario, since: string, head: string, a: Answers, depth?: 'deep' | 'quick') => review({
  s, req: { since: { reviewId: since }, ...(depth ? { depth } : {}) }, exec: fakeGh({ baseSha: s.baseSha, headSha: head }), script: script(a),
});

describe('fix round 1', () => {
  it('a new finding the same as an earlier one the fixed check moved is merged into it, not challenged', async () => {
    const { s, doc: earlier } = await first();
    const good = earlier.findings.find((f) => f.title === GOOD.title)!;
    // The faulty line leaves src/money.ts for a new file, src/round.ts, where the lens raises it again.
    const head = await commitFiles(s.remote, {
      'src/money.ts': 'export function formatMoney(n: number): string {\n  return round(n);\n}\n', 'src/round.ts': ROUND_TS,
    }, 'move the rounding');
    const again2 = rawCandidate({ ...GOOD, severity: 'block', path: 'src/round.ts', lineHint: 2 });
    const { doc, calls } = await again(s, earlier.id, head, {
      paths: ['src/money.ts', 'src/round.ts'], correctness: [again2],
      fixedCheck: () => ({ outcome: 'still-open', evidence: { path: 'src/round.ts', quote: 'return n.toFixed(2);' }, explanation: 'It moved.', checked: 'Read both.' }),
    });
    const atRound = doc.findings.filter((f) => f.path === 'src/round.ts');
    expect(atRound.map((f) => [f.id, f.status])).toEqual([[good.id, 'moved']]);
    // Raised again as a Block where the earlier review had a Fix: the earlier finding takes the more serious word.
    expect(good.severity).toBe('fix');
    expect(atRound[0]).toMatchObject({ severity: 'block', title: good.title });
    expect(atRound[0]!.checked.endsWith(' Raised again as Block in this review.')).toBe(true);
    expect(doc.dropped.filter((d) => d.mergedInto === good.id).map((d) => [d.stage, d.candidate.path])).toEqual([['merge', 'src/round.ts']]);
    // The re-raised one never reached the challenge: only the fixed check asked about it.
    expect(calls.filter((c) => c.role.startsWith('challenge:') && !c.role.startsWith('challenge:fixed:'))).toEqual([]);
    expect(doc.stageErrors).toEqual([]);
  }, SLOW);

  it('a new finding under the alias of a vanished earlier finding is that finding moved: not fixed, not new, and no request spent', async () => {
    const { s, doc: earlier } = await first();
    const ruled = earlier.findings.find((f) => f.title === RULED.title)!;
    // In the last review RULED (here a Fix) absorbed a duplicate in pause.ts, whose fingerprint it carries as an alias.
    const dupPrint = fingerprint({ source: { pack: 'core', lens: 'correctness', ruleId: null }, path: ON_PAUSE.path as string, quote: ON_PAUSE.quote as string });
    const stored: ReviewDocument = {
      ...earlier, id: 'r_ffffffffff',
      findings: earlier.findings.map((f) => (f.id === ruled.id ? { ...f, severity: 'fix' as const, aliases: [dupPrint] } : f)),
    };
    await saveReview(stored);
    // The push removes RULED's own lines (the refund) and writes the pause line, where the lens raises the duplicate again.
    const head = await commitFiles(s.remote, {
      'src/billing.ts': BASE_FILES['src/billing.ts']!, 'src/jobs/pause.ts': 'export function pauseJob(): void { audit(); }\n',
    }, 'push');
    const { doc, calls } = await again(s, stored.id, head, { paths: ['src/billing.ts', 'src/jobs/pause.ts'], correctness: [ON_PAUSE] });
    expect(doc.stageErrors).toEqual([]);
    expect(doc.fixed).toEqual([]);
    const moved = doc.findings.find((f) => f.id === ruled.id)!;
    expect(moved).toMatchObject({ status: 'moved', title: RULED.title, severity: 'fix', path: 'src/jobs/pause.ts', anchor: { status: 'in-diff', startLine: 1 } });
    expect([moved.fingerprint, ...(moved.aliases ?? [])]).toEqual(expect.arrayContaining([ruled.fingerprint, dupPrint]));
    expect(doc.findings.filter((f) => f.status === 'new')).toEqual([]);
    expect(doc.dropped.filter((d) => d.mergedInto === ruled.id).map((d) => [d.stage, d.candidate.title])).toEqual([['merge', ON_PAUSE.title]]);
    // Neither the fixed check nor the challenge was asked about it.
    expect(calls.filter((c) => c.role.startsWith('challenge:'))).toEqual([]);
  }, SLOW);

  it('an earlier finding lost by selection is a stage error', async () => {
    const { s, doc: earlier } = await first();
    const good = earlier.findings.find((f) => f.title === GOOD.title)!;
    const head = await commitFiles(s.remote, { 'src/jobs/pause.ts': 'export function pauseJob(): void { audit(); }\n' }, 'push');
    hooks.select = (result) => ({ ...result, findings: result.findings.filter((f) => f.id !== good.id) });
    const { doc } = await again(s, earlier.id, head, { paths: ['src/jobs/pause.ts'] });
    expect(doc.verdict.label).toBe('incomplete');
    expect(doc.stageErrors).toEqual([{
      stage: 'select', cohortId: null,
      message: `The earlier finding ${good.id} ("${GOOD.title}") is in neither the findings nor the fixed list, and was not merged into one.`,
    }]);
  }, SLOW);

  it('a deep-pass finding the same as a carried one is merged into it at stage merge', async () => {
    const { s, doc: earlier } = await first();
    const good = earlier.findings.find((f) => f.title === GOOD.title)!;
    const head = await commitFiles(s.remote, {
      'src/money.ts': `// money helpers\n${HEAD_FILES['src/money.ts']}`, 'src/jobs/pause.ts': 'export function pauseJob(): void { audit(); }\n',
    }, 'push');
    const map = {
      cohorts: [{
        id: 'k1', title: 'Money and jobs', summary: 'Both.', neighbours: [], inferredLinks: [],
        layers: [
          { id: 'l1', title: 'Rules', kind: 'rules', files: ['src/money.ts'], dependsOn: [], note: '' },
          { id: 'l2', title: 'Jobs', kind: 'jobs', files: ['src/jobs/pause.ts'], dependsOn: [], note: '' },
        ],
      }],
      standalone: [],
    };
    const { doc, calls } = await again(s, earlier.id, head, { paths: [], map, deep: [{ ...GOOD, severity: 'block' }] }, 'deep');
    expect(calls.some((c) => c.role.startsWith('lens:') && c.instructions.includes(DEEP_SENTENCE))).toBe(true);
    expect(doc.findings.filter((f) => f.path === 'src/money.ts').map((f) => [f.id, f.status])).toEqual([[good.id, 'moved']]);
    expect(doc.dropped.filter((d) => d.mergedInto === good.id).map((d) => d.stage)).toEqual(['merge']);
    expect(doc.findings.find((f) => f.id === good.id)).toMatchObject({ severity: 'block' });
    expect(doc.findings.find((f) => f.id === good.id)!.checked.endsWith(' Raised again as Block in this review.')).toBe(true);
    expect(calls.filter((c) => c.role.startsWith('challenge:'))).toEqual([]);
  }, SLOW);

  it('a fixed check that throws does not discard the challenge, and the reverse', async () => {
    const { s, doc: earlier } = await first();
    const head = await commitFiles(s.remote, {
      'src/money.ts': 'export function formatMoney(n: number): string {\n  return round(n);\n}\n',
      'src/jobs/pause.ts': 'export function pauseJob(): void { audit(); }\n',
    }, 'push');
    const answers: Answers = {
      paths: ['src/jobs/pause.ts', 'src/money.ts'], correctness: [ON_PAUSE],
      fixedCheck: () => ({ outcome: 'still-open', evidence: null, explanation: '', checked: '' }),
    };
    hooks.confirmFixed = () => { throw new Error('the fixed check broke'); };
    const one = (await again(s, earlier.id, head, answers)).doc;
    expect(one.findings.find((f) => f.title === ON_PAUSE.title)!.checked).toBe('Read the callers.');
    expect(one.findings.find((f) => f.title === GOOD.title)).toMatchObject({ status: 'still-open', anchor: { status: 'not-found' } });
    expect(one.stageErrors.map((e) => e.message)).toEqual(['the fixed check broke']);

    hooks.confirmFixed = null;
    hooks.challenge = () => { throw new Error('the challenge broke'); };
    const two = (await again(s, earlier.id, head, answers)).doc;
    expect(two.findings.find((f) => f.title === ON_PAUSE.title)!.checked).toBe('challenge did not complete');
    // The fixed check ran: its answer (no evidence) leaves the finding open, saying why, and is no stage error.
    expect(two.findings.find((f) => f.title === GOOD.title)).toMatchObject({
      status: 'still-open', anchor: { status: 'not-found' }, checked: expect.stringMatching(/^Airlock could not confirm this was fixed: /),
    });
    expect(two.stageErrors.map((e) => e.message)).toEqual(['the challenge broke']);
  }, SLOW);

  it('a deep-pass finding under the alias of a vanished earlier finding is that finding moved, not fixed and new', async () => {
    const { s, doc: earlier } = await first();
    const ruled = earlier.findings.find((f) => f.title === RULED.title)!;
    // In the last review RULED, a Note, absorbed a duplicate D in money.ts, whose fingerprint it carries as an alias. As a
    // Note that vanishes, it is fixed by code, with no request.
    const D = rawCandidate({ severity: 'note', title: 'formatMoney takes any number', path: 'src/money.ts', quote: 'export function formatMoney(n: number): string {', lineHint: 1 });
    const dPrint = fingerprint({ source: { pack: 'core', lens: 'correctness', ruleId: null }, path: D.path as string, quote: D.quote as string });
    const stored: ReviewDocument = {
      ...earlier, id: 'r_5555555555',
      findings: earlier.findings.map((f) => (f.id === ruled.id ? { ...f, severity: 'note' as const, aliases: [dPrint] } : f)),
    };
    await saveReview(stored);
    // The push removes RULED's own lines (the refund) and touches money.ts; the first-pass lenses raise nothing.
    const head = await commitFiles(s.remote, {
      'src/billing.ts': BASE_FILES['src/billing.ts']!, 'src/money.ts': `// money helpers\n${HEAD_FILES['src/money.ts']}`,
    }, 'push');
    const map = {
      cohorts: [{
        id: 'k1', title: 'Money and billing', summary: 'Both.', neighbours: [], inferredLinks: [],
        layers: [
          { id: 'l1', title: 'Rules', kind: 'rules', files: ['src/money.ts'], dependsOn: [], note: '' },
          { id: 'l2', title: 'Billing', kind: 'writes', files: ['src/billing.ts'], dependsOn: [], note: '' },
        ],
      }],
      standalone: [],
    };
    // The deep pass raises D again in money.ts.
    const { doc, calls } = await again(s, stored.id, head, { paths: [], map, deep: [D] }, 'deep');
    expect(calls.some((c) => c.role.startsWith('lens:') && c.instructions.includes(DEEP_SENTENCE))).toBe(true);
    expect(doc.stageErrors).toEqual([]);
    expect(doc.fixed).toEqual([]);
    const moved = doc.findings.find((f) => f.id === ruled.id)!;
    expect(moved).toMatchObject({ status: 'moved', title: RULED.title, path: 'src/money.ts', anchor: { startLine: 2 } });
    expect([moved.fingerprint, ...(moved.aliases ?? [])]).toEqual(expect.arrayContaining([ruled.fingerprint, dPrint]));
    expect(moved.checked).toBe(ruled.checked);
    expect(doc.findings.filter((f) => f.status === 'new')).toEqual([]);
    expect(doc.dropped.filter((d) => d.mergedInto === ruled.id).map((d) => [d.stage, d.candidate.title])).toEqual([['merge', D.title]]);
  }, SLOW);

  it('an earlier finding whose file is now too large to read stays open with a stage error', async () => {
    const { s, doc: earlier } = await first();
    const huge = `${HEAD_FILES['src/money.ts']}// ${'x'.repeat(2 * 1024 * 1024 + 10)}\n`;
    const head = await commitFiles(s.remote, { 'src/money.ts': huge }, 'push');
    const { doc } = await again(s, earlier.id, head, { paths: ['src/money.ts'] });
    expect(doc.findings.find((f) => f.title === GOOD.title)).toMatchObject({ status: 'still-open', anchor: { status: 'not-found' } });
    expect(doc.fixed).toEqual([]);
    expect(doc.stageErrors.map((e) => [e.stage, e.message])).toContainEqual(
      ['anchor', `${earlier.findings.find((f) => f.title === GOOD.title)!.id}: the file src/money.ts could not be read at the head, so this earlier finding stays open.`],
    );
    expect(doc.verdict.label).toBe('incomplete');
  }, SLOW);

  describe('a push\'s own words', () => {
    it('a push of only files Airlock ignores gets a note, no stage error, and the verdict of the earlier findings', async () => {
      const { s, doc: earlier } = await first();
      const head = await commitFiles(s.remote, { 'package-lock.json': '{}\n' }, 'lock');
      const { doc } = await again(s, earlier.id, head, { paths: [] });
      expect(doc.stageErrors).toEqual([]);
      expect(doc.notes).toContain('The push changed only files Airlock does not review.');
      expect(doc.verdict.label).not.toBe('incomplete');
      expect(doc.findings.map((f) => f.status)).toEqual(expect.arrayContaining(['still-open']));
    }, SLOW);

    it('a push of only trusted files says nothing in this push was read closely', async () => {
      const { s, doc: earlier } = await first();
      const head = await commitFiles(s.remote, { 'test/money.test.ts': "import { formatMoney } from '../src/money';\n// more\n" }, 'tests');
      const { doc } = await again(s, earlier.id, head, { paths: ['test/money.test.ts'] });
      expect(doc.notes).toContain('Nothing in this push was read closely: all 1 changed files are of kinds Airlock trusts (tests, documents, generated files).');
    }, SLOW);

    it('a push with no files says so', async () => {
      const { s, doc: earlier } = await first();
      await s.remote.git('commit', '--allow-empty', '-m', 'empty');
      const head = await s.remote.git('rev-parse', 'HEAD');
      const { doc } = await again(s, earlier.id, head, { paths: [] });
      expect(doc.notes).toContain('The push changed no files.');
    }, SLOW);
  });

  it('a push of one merge of the base is a sync-merge range with previous, its challenge told only the merge\'s base side', async () => {
    const { s, doc: earlier } = await first();
    expect(earlier.findings.map((f) => f.title).sort()).toEqual([GOOD.title, RULED.title].sort());
    await s.remote.git('checkout', 'main');
    await commitFiles(s.remote, {
      'src/money.ts': 'export function formatMoney(n: number, digits = 2): string {\n  return n.toFixed(2);\n}\n', 'README.md': 'main moved on\n',
    }, 'main advances');
    await s.remote.git('checkout', 'feature');
    await s.remote.git('merge', '--no-commit', 'main').catch(() => undefined);
    await s.remote.write('src/money.ts', [
      'export function formatMoney(n: number, digits = 2): string {', '  // TODO round half up',
      "  if (digits > 4) throw new Error('too many digits');", '  return n.toFixed(2);', '}', '',
    ].join('\n'));
    await s.remote.git('add', '--all');
    await s.remote.git('commit', '--no-edit', '-m', 'Merge main into feature');
    const head = await s.remote.git('rev-parse', 'HEAD');
    const byHand = rawCandidate({
      severity: 'fix', title: 'Too many digits throws', path: 'src/money.ts', quote: "if (digits > 4) throw new Error('too many digits');", lineHint: 3,
    });
    const { doc, calls } = await again(s, earlier.id, head, { paths: ['src/money.ts'], correctness: [byHand] });
    expect(doc.stageErrors).toEqual([]);
    expect(doc.range.kind).toBe('sync-merge');
    expect(doc.previous).toEqual({ reviewId: earlier.id, headSha: s.headSha, covered: 'merge' });
    const challenges = calls.filter((c) => c.role.startsWith('challenge:'));
    expect(challenges.length).toBeGreaterThan(0);
    for (const c of challenges) {
      expect(c.instructions).toContain(mergeNote('push'));
      expect(c.instructions).not.toContain(PUSH_BASE_SIDE);
    }
    expect(renderReview(doc).split('\n')[2]).toBe(`Review of the merge pushed since ${s.headSha.slice(0, 7)}: only what was changed by hand was reviewed.`);
    // The whole-diff rule still holds: the new finding sits on a line the pull request's whole diff shows.
    expect(doc.findings.find((f) => f.title === byHand.title)!.anchor).toMatchObject({ status: 'in-diff', comment: { line: 3, startLine: null } });
  }, SLOW);
});
