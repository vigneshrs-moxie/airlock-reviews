import { copyFile, mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { candidate, ReviewDocumentSchema, type Candidate, type ReviewEvent } from '@airlock/shared';
import { type AgentRequest, withRetry } from '../../src/agent/runner.js';
import { fingerprint } from '../../src/anchor/fingerprint.js';
import { withUniqueIds } from '../../src/pipeline/review.js';
import { selfReviewText } from '../../src/select/select.js';
import { latestReview } from '../../src/store/store.js';
import { realExec, type Exec } from '../../src/util/exec.js';
import { block } from '../helpers/lens-context.js';
import {
  concurrencyProbe, DEEP_NEW, DEEP_SENTENCE, fakeGh, GHOST, GOOD, KIT_DIR, NOW, NUMBER, REPO, RULED, scenarioScript,
  STANDARD_STAGES, UNRULED, useReviewHarness,
} from '../helpers/review-scenario.js';

const SLOW = 20_000;

const { home, scenario, review } = useReviewHarness();

/** Hooks that make a stage throw, or change what it returns; by default each stage runs as it is. */
const hooks = vi.hoisted(() => ({
  anchor: null as null | ((cands: Candidate[]) => void),
  challenge: null as null | ((items: Candidate[]) => void),
  select: null as null | ((result: unknown) => unknown),
}));
vi.mock('../../src/anchor/anchor.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/anchor/anchor.js')>();
  return {
    ...m,
    anchorCandidates: async (...args: Parameters<typeof m.anchorCandidates>) => {
      hooks.anchor?.(args[0]);
      return m.anchorCandidates(...args);
    },
  };
});
vi.mock('../../src/challenge/challenge.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/challenge/challenge.js')>();
  return {
    ...m,
    challenge: async (...args: Parameters<typeof m.challenge>) => {
      hooks.challenge?.(args[2]);
      return m.challenge(...args);
    },
  };
});
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
afterEach(() => {
  hooks.anchor = null;
  hooks.challenge = null;
  hooks.select = null;
});
const fail = (message: string) => (): never => { throw new Error(message); };

const starts = (events: ReviewEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'stage' && e.status === 'start' ? [e.stage] : []));
const roles = (calls: AgentRequest<unknown>[]): string[] => calls.map((c) => c.role);
const everything = (calls: AgentRequest<unknown>[]): string => calls.map((c) => `${c.instructions}\n${c.material}`).join('\n');
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

const STALE_KIT_QUESTION = 'The team standard could not be refreshed; the copy from 2026-03-04 was used.';
/** Puts a copy of the kit dated 2026-03-04 in the cache, so a review without `kitDir` uses it and says it is stale. */
async function cacheStaleKit(): Promise<string> {
  const sha = 'f'.repeat(40);
  const cached = join(home(), 'kit', sha);
  await mkdir(cached, { recursive: true });
  for (const name of ['profile.md', 'orbit.md', 'calibration.md', 'SKILL.md']) await copyFile(join(KIT_DIR, name), join(cached, name));
  await utimes(cached, new Date('2026-03-04T12:00:00Z'), new Date('2026-03-04T12:00:00Z'));
  return sha;
}

describe('runReview', () => {
  it('runs the stages in order and returns a valid document', async () => {
    const { doc, events, calls, s } = await review();
    expect(starts(events)).toEqual(STANDARD_STAGES);
    expect(ReviewDocumentSchema.parse(doc)).toEqual(doc);
    expect(doc.id).toMatch(/^r_[0-9a-f]{10}$/);
    expect(doc.createdAt).toBe(NOW.toISOString());
    expect(doc.pr).toMatchObject({ repo: REPO, number: NUMBER, headSha: s.headSha, stage: 'pr2', author: 'alice', viewer: 'bob' });
    expect(doc.range).toEqual({ baseSha: s.baseSha, headSha: s.headSha, kind: 'full' });
    expect(doc.depth).toBe('standard');
    expect(doc.models).toEqual({ main: 'claude-opus-5-5', challenger: 'claude-opus-5-5', sweep: 'claude-opus-5-5', effort: 'high' });
    expect(doc.packs).toEqual([{ id: 'core', version: '1' }, { id: 'raj-standard', version: 'pinned' }]);
    expect(doc.stageErrors).toEqual([]);
    expect(doc.verdict.label).toBe('approve-after-fixes');
    expect(doc.findings.map((f) => f.title).sort()).toEqual([GOOD.title, RULED.title].sort());
    expect(doc.findings.find((f) => f.title === RULED.title)!.severity).toBe('fix'); // raised to the rule's floor
    expect(doc.whoseCall).toEqual(['Whether refunds may be negative is a product call.']);
    expect(doc.files).toContainEqual({ path: 'test/money.test.ts', tier: 'trust', reason: 'built-in: **/*.test.*' });
    expect(doc.facts).toContainEqual({ checkId: 'no-todo', path: 'src/money.ts', line: 2, message: 'Leaves a TODO in the code' });
    expect(doc.map.cohorts.map((c) => c.id)).toEqual(['k1', 'k2']);
    expect(doc.brief.whatItDoes).toEqual(['Adds refunds and a pause job.']);
    expect(events.at(-1)).toEqual({ type: 'done', document: doc });

    // the sibling glob found the existing job, and the mapper saw it
    expect(block(calls.find((c) => c.role === 'mapper')!.material, 'neighbours')).toContain('src/jobs/expire.ts [sibling]');
    // rule files come from the base worktree; helpers named by the kit that are gone are listed
    const lens = calls.find((c) => c.role.startsWith('lens:'))!;
    const rules = block(lens.material, 'repository rule file CLAUDE.md')!;
    expect(rules).toContain('BASE_RULES_MARKER');
    expect(rules).not.toContain('HEAD_RULES_MARKER');
    const helpers = lens.instructions.slice(lens.instructions.indexOf('# Helpers that no longer exist'));
    expect(helpers).toContain('`legacyDateHelper`');
    expect(helpers).not.toContain('`formatMoney`');
    // the saved copy is the returned document
    expect(await latestReview(REPO, NUMBER, s.headSha)).toEqual(doc);
  }, SLOW);

  it('emits the map and the brief before the lenses finish', async () => {
    const seenBeforeLens: string[][] = [];
    const events: ReviewEvent[] = [];
    const script = scenarioScript();
    await review({
      onEvent: (e) => events.push(e),
      script: (req) => {
        if (req.role.startsWith('lens:')) seenBeforeLens.push(events.flatMap((e) => (e.type === 'map' || e.type === 'brief' ? [e.type] : [])));
        return script(req);
      },
    });
    expect(seenBeforeLens.length).toBeGreaterThan(0);
    for (const seen of seenBeforeLens) expect(seen).toEqual(['map', 'brief']);
    const brief = events.find((e) => e.type === 'brief');
    expect(brief).toEqual({ type: 'brief', brief: { whatItDoes: ['Adds refunds and a pause job.'], claims: [] } });
  }, SLOW);

  it('quick depth makes requests only for the mapper, the brief, the first lens of each pack and select', async () => {
    const { doc, calls, events } = await review({ req: { depth: 'quick' } });
    expect(new Set(roles(calls))).toEqual(new Set(['mapper', 'brief', 'lens:core/correctness', 'lens:raj-standard/boundary', 'select']));
    expect(roles(calls).filter((r) => r.startsWith('lens:'))).toHaveLength(6); // three cohorts, two lenses
    expect(doc.findings.map((f) => f.checked)).toEqual(['not challenged (quick review)']);
    expect(doc.depth).toBe('quick');
    expect(starts(events)).toEqual(STANDARD_STAGES);
    const skipped = events.flatMap((e) => (e.type === 'stage' && e.status === 'done' && e.detail.startsWith('skipped') ? [e.stage] : []));
    expect(skipped).toEqual(['sweep', 'seams', 'challenge']);
  }, SLOW);

  it('never runs more than the parallel limit at once', async () => {
    let probe!: ReturnType<typeof concurrencyProbe>;
    await review({ req: { parallel: 2 }, wrap: (r) => (probe = concurrencyProbe(r)) });
    expect(probe.max()).toBe(2);
  }, SLOW);

  it('refuses a parallel limit below one before doing anything', async () => {
    const s = await scenario();
    await expect(review({ s, req: { parallel: 0 } })).rejects.toThrow(/parallel/);
    expect(await exists(join(home(), 'repos'))).toBe(false);
  }, SLOW);

  it('a lens that fails twice gives verdict incomplete and still lists the other findings', async () => {
    const { doc, calls } = await review({
      script: scenarioScript({ 'lens:core/naming': () => new Error('not JSON') }),
      wrap: (r) => withRetry(r, 1),
    });
    expect(roles(calls).filter((r) => r === 'lens:core/naming')).toHaveLength(6); // three cohorts, each tried twice
    expect(doc.verdict.label).toBe('incomplete');
    const lensErrors = doc.stageErrors.filter((e) => e.stage === 'lenses');
    expect(lensErrors.map((e) => e.cohortId)).toEqual(['k1', 'k2', 'standalone']);
    expect(lensErrors.every((e) => e.message.startsWith('core/naming: '))).toBe(true);
    expect(doc.findings.map((f) => f.title)).toContain(GOOD.title);
    expect(doc.findings.map((f) => f.title)).toContain(RULED.title);
  }, SLOW);

  it('a dropped candidate appears in dropped with its stage and reason; candidates and questions hold what the stages returned', async () => {
    const { doc } = await review();
    expect(doc.dropped.map((d) => [d.stage, d.candidate.title])).toEqual([
      ['schema', UNRULED.title],
      ['anchor', GHOST.title],
    ]);
    expect(doc.dropped[0]!.reason).toBe('names a rule that was not given: made-up');
    expect(doc.dropped[1]!.reason).toBe('quoted code is not in src/money.ts at the head commit');
    expect(doc.candidates.map((c) => c.title)).toEqual([GOOD.title, GHOST.title, RULED.title]);
    expect(new Set(doc.candidates.map((c) => c.id)).size).toBe(3);
    expect(doc.questions.map((q) => q.text)).toEqual(['Is rounding half up intended?', 'Does a refund need a ledger entry?']);
  }, SLOW);

  it('disposes the workspace even when a stage throws, and returns an incomplete document instead of rejecting', async () => {
    const { doc, events } = await review({
      script: scenarioScript({ mapper: () => { throw new Error('mapper exploded'); } }),
      onEvent: () => { throw new Error('a broken listener'); },
    });
    expect(doc.verdict.label).toBe('incomplete');
    expect(doc.stageErrors).toContainEqual({ stage: 'map', cohortId: null, message: 'mapper exploded' });
    expect(events).toContainEqual({ type: 'stage', stage: 'map', status: 'error', detail: 'mapper exploded' });
    // the review carried on with the link-based map
    expect(doc.findings.length).toBeGreaterThan(0);
    expect(await exists(join(home(), 'work', doc.id))).toBe(false);
    const worktrees = (await realExec('git', ['--git-dir', join(home(), 'repos', 'acme__app.git'), 'worktree', 'list'])).stdout;
    expect(worktrees.trim().split('\n')).toHaveLength(1);
  }, SLOW);

  it('held-out rules and dated standards never reach a request', async () => {
    const markers = ['HELD_RULE_MARKER', 'LOG_LATE_MARKER', 'CAL_LATE_MARKER'];
    const open = await review();
    for (const m of [...markers, 'LOG_EARLY_MARKER', 'CAL_EARLY_MARKER']) expect(everything(open.calls), m).toContain(m);

    const held = await review({ s: open.s, req: { holdout: { pr: NUMBER, reviewedAt: '2026-06-01T00:00:00Z' } } });
    const text = everything(held.calls);
    for (const m of markers) expect(text, m).not.toContain(m);
    expect(text).toContain('LOG_EARLY_MARKER');
    expect(text).toContain('CAL_EARLY_MARKER');
    expect(held.calls.some((c) => c.role.startsWith('sweep:'))).toBe(true);
  }, SLOW);

  it('saves the document and latestReview returns it for the same head', async () => {
    const s = await scenario();
    const { doc } = await review({ s, req: { explicit: { baseSha: s.baseSha, headSha: s.headSha } } });
    expect(doc.range).toEqual({ baseSha: s.baseSha, headSha: s.headSha, kind: 'explicit' });
    expect(await readdir(join(home(), 'reviews', 'acme__app', String(NUMBER)))).toEqual([`${s.headSha}-${doc.id}.json`]);
    expect(await latestReview(REPO, NUMBER, s.headSha)).toEqual(doc);
    expect(await latestReview(REPO, NUMBER, s.baseSha)).toBeNull();
  }, SLOW);

  it('returns the review as incomplete when it cannot be saved', async () => {
    await writeFile(join(home(), 'reviews'), 'a file where the folder should be');
    const { doc, events } = await review();
    expect(doc.stageErrors.map((e) => e.stage)).toEqual(['store']);
    expect(doc.verdict.label).toBe('incomplete');
    expect(doc.selfReviewText).toMatch(/The review did not finish\.$/);
    expect(doc.selfReviewText).toBe(selfReviewText(doc.pr, doc.depth, ['Core', 'Team standard'], doc.verdict));
    expect(doc.timings.map((t) => t.stage)).toEqual(STANDARD_STAGES);
    expect(events.find((e) => e.type === 'stage' && e.stage === 'store' && e.status !== 'start')).toMatchObject({ status: 'error' });
    expect(events.at(-1)).toEqual({ type: 'done', document: doc });
  }, SLOW);

  it('never reports a sync merge as reviewed: verdict incomplete, a shape error with the count, and the map event', async () => {
    const s = await scenario({ 'a.txt': 'root\n' }, {});
    // `feature` sits at the base; main moves on and feature merges it in, changing one more file in the merge itself
    await s.remote.git('checkout', 'main');
    await s.remote.write('b.txt', 'main moved on\n');
    await s.remote.commit('main advances');
    await s.remote.git('checkout', 'feature');
    await s.remote.git('merge', '--no-ff', '--no-commit', 'main');
    await s.remote.write('a.txt', 'changed inside the merge\n');
    await s.remote.git('add', 'a.txt');
    await s.remote.git('commit', '-m', 'Merge main into feature');
    const head = await s.remote.git('rev-parse', 'HEAD');
    const { doc, calls, events } = await review({ s, exec: fakeGh({ baseSha: s.baseSha, headSha: head }) });
    expect(doc.range.kind).toBe('sync-merge');
    expect(calls).toEqual([]);
    expect(doc.verdict.label).toBe('incomplete');
    expect(doc.stageErrors).toEqual([{
      stage: 'shape', cohortId: null,
      message: 'This pull request only merges another branch in. Airlock did not review it: 1 changed file was not looked at.',
    }]);
    expect(doc.brief.whatItDoes).toHaveLength(1);
    expect(doc.brief.whatItDoes[0]).toMatch(/only conflict resolutions need review/);
    expect(events).toContainEqual({ type: 'map', map: { cohorts: [], standalone: [], links: [] } });
    expect(events).toContainEqual({ type: 'brief', brief: doc.brief });
    expect(events.findIndex((e) => e.type === 'map')).toBeLessThan(events.findIndex((e) => e.type === 'brief'));
    const skipped = events.flatMap((e) => (e.type === 'stage' && e.status === 'done' && e.detail.startsWith('skipped') ? [e.stage] : []));
    expect(skipped).toEqual(['map', 'brief', 'lenses', 'sweep', 'seams', 'anchor', 'challenge']);
  }, SLOW);

  it('a kit that cannot be fetched gives a packs stage error and verdict incomplete', async () => {
    const { doc, calls } = await review({ req: { kitDir: undefined } });
    const packErrors = doc.stageErrors.filter((e) => e.stage === 'packs');
    expect(packErrors).toHaveLength(1);
    expect(packErrors[0]!.cohortId).toBeNull();
    expect(packErrors[0]!.message).toMatch(/review kit could not be fetched/);
    expect(doc.verdict.label).toBe('incomplete');
    expect(doc.packs.map((p) => p.id)).toEqual(['core']);
    expect(roles(calls).some((r) => r.startsWith('lens:raj-standard'))).toBe(false);
  }, SLOW);

  it('a stale kit adds a question with the date of the cached copy', async () => {
    const sha = await cacheStaleKit();
    const { doc, calls } = await review({ req: { kitDir: undefined } });
    expect(doc.questions.at(-1)).toEqual({
      text: STALE_KIT_QUESTION, cohortId: null, source: { pack: 'airlock', lens: null, ruleId: null },
    });
    expect(doc.packs).toContainEqual({ id: 'raj-standard', version: sha });
    expect(doc.stageErrors).toEqual([]);
    expect(everything(calls)).toContain('CAL_EARLY_MARKER');
  }, SLOW);

  it('the document holds the questions that survived selection plus the engine\'s own', async () => {
    await cacheStaleKit();
    const base = scenarioScript();
    const { doc, calls } = await review({
      req: { kitDir: undefined },
      script: scenarioScript({ select: (req) => ({ ...(base(req) as object), questionSameAs: [{ question: 2, sameAs: 'q1' }] }) }),
    });
    const shown = block(calls.find((c) => c.role === 'select')!.material, 'questions')!;
    expect(shown.split('\n')).toEqual(['q1 | Is rounding half up intended?', 'q2 | Does a refund need a ledger entry?']);
    expect(doc.questions.map((q) => q.text)).toEqual(['Is rounding half up intended?', STALE_KIT_QUESTION]);
    expect(doc.stageErrors).toEqual([]);
  }, SLOW);

  it('a clean review still has checks after merge', async () => {
    const nothing = (): unknown => ({ candidates: [], questions: [] });
    const check = 'Refund an order on the test environment as a manager; the receipt shows the refund as a negative amount.';
    const base = scenarioScript();
    const { doc, calls } = await review({
      script: scenarioScript({
        'lens:': nothing, 'sweep:': nothing, seams: nothing,
        select: (req) => ({ ...(base(req) as object), checksAfterMerge: [check] }),
      }),
    });
    expect(doc.findings).toEqual([]);
    expect(roles(calls).filter((r) => r === 'select')).toHaveLength(1);
    expect(doc.checksAfterMerge).toEqual([check]);
    expect(doc.whoseCall).toEqual(['Whether refunds may be negative is a product call.']);
    expect(doc.verdict.label).toBe('approve');
  }, SLOW);

  it('deep depth makes second-pass requests only for cohorts with more than one layer and discards a repeated fingerprint', async () => {
    const { doc, calls, events } = await review({ req: { depth: 'deep' } });
    const deep = calls.filter((c) => c.instructions.includes(DEEP_SENTENCE));
    expect(deep).toHaveLength(6); // two layers of Money, three lenses
    for (const c of deep) expect(block(c.material, 'cohort')!.split('\n')[0]).toMatch(/^Cohort: Money: (Rules|Callers)$/);
    expect(calls.filter((c) => !c.instructions.includes(DEEP_SENTENCE)).every((c) => !c.material.includes('Cohort: Money: '))).toBe(true);

    const goodPrint = fingerprint({ source: { pack: 'core', lens: 'correctness', ruleId: null }, path: GOOD.path as string, quote: GOOD.quote as string });
    expect(doc.candidates.filter((c) => fingerprint(c) === goodPrint)).toHaveLength(1);
    const added = doc.candidates.find((c) => c.title === DEEP_NEW.title)!;
    expect(added.cohortId).toBe('k1');
    expect(doc.findings.map((f) => f.title)).toContain(DEEP_NEW.title);
    expect(roles(calls)).toContain(`challenge:${added.id}`);
    expect(starts(events)).toEqual([...STANDARD_STAGES.slice(0, 11), 'lenses-deep', 'select', 'store']);
  }, SLOW);

  it('timings add up: one entry per stage, agent runs equal to the requests of that stage', async () => {
    const { doc, calls } = await review({ req: { depth: 'deep' } });
    expect(doc.timings.map((t) => t.stage)).toEqual([...STANDARD_STAGES.slice(0, 11), 'lenses-deep', 'select', 'store']);
    const isDeep = (c: AgentRequest<unknown>): boolean => c.instructions.includes(DEEP_SENTENCE);
    const deepIds = new Set(doc.candidates.filter((c) => c.title === DEEP_NEW.title).map((c) => c.id));
    const isDeepChallenge = (c: AgentRequest<unknown>): boolean => deepIds.has(c.role.replace('challenge:', ''));
    const count = (pick: (c: AgentRequest<unknown>) => boolean): number => calls.filter(pick).length;
    const expected: Record<string, number> = {
      intake: 0, packs: 0, shape: 0, facts: 0, anchor: 0, store: 0,
      map: count((c) => c.role === 'mapper'),
      brief: count((c) => c.role === 'brief'),
      lenses: count((c) => c.role.startsWith('lens:') && !isDeep(c)),
      sweep: count((c) => c.role.startsWith('sweep:')),
      seams: count((c) => c.role === 'seams'),
      challenge: count((c) => c.role.startsWith('challenge:') && !isDeepChallenge(c)),
      'lenses-deep': count((c) => isDeep(c) || (c.role.startsWith('challenge:') && isDeepChallenge(c))),
      select: count((c) => c.role === 'select'),
    };
    expect(expected['lenses-deep']).toBe(7);
    for (const t of doc.timings) {
      expect(t.agentRuns, t.stage).toBe(expected[t.stage]);
      expect(t.inputTokens, t.stage).toBe(10 * t.agentRuns);
      expect(t.outputTokens, t.stage).toBe(5 * t.agentRuns);
      expect(t.costUsd, t.stage).toBe(t.agentRuns === 0 ? 0 : null);
      expect(t.ms, t.stage).toBeGreaterThanOrEqual(0);
    }
    expect(doc.timings.reduce((n, t) => n + t.agentRuns, 0)).toBe(calls.length);
  }, SLOW);

  it('rejects with the reason when the pull request cannot be fetched, before touching the disk', async () => {
    const s = await scenario();
    const exec: Exec = async () => ({ stdout: '', stderr: 'HTTP 404: Not Found', code: 1 });
    await expect(review({ s, exec })).rejects.toThrow(/HTTP 404/);
    expect(await exists(join(home(), 'work'))).toBe(false);
  }, SLOW);

  it('clones from GitHub by default and says to run gh auth setup-git when the clone has no credentials', async () => {
    const s = await scenario();
    const exec = fakeGh({
      baseSha: s.baseSha, headSha: s.headSha,
      failClone: "Cloning into bare repository...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled",
    });
    await expect(review({ s, exec, req: { remoteUrl: undefined } })).rejects.toThrow(/gh auth setup-git/);
    expect(exec.calls.find((c) => c[0] === 'git' && c[1] === 'clone')).toContain('https://github.com/acme/app.git');
  }, SLOW);
});

describe('runReview when a stage throws', () => {
  it('a throw inside anchor gives an incomplete document naming anchor, keeping the candidates', async () => {
    hooks.anchor = fail('anchor exploded');
    const { doc } = await review();
    expect(doc.verdict.label).toBe('incomplete');
    expect(doc.stageErrors).toEqual([{ stage: 'anchor', cohortId: null, message: 'anchor exploded' }]);
    expect(doc.candidates.map((c) => c.title)).toEqual([GOOD.title, GHOST.title, RULED.title]);
    expect(doc.findings).toEqual([]);
  }, SLOW);

  it('a throw inside challenge gives an incomplete document naming challenge, with the anchored findings marked unchecked', async () => {
    hooks.challenge = fail('challenge exploded');
    const { doc } = await review();
    expect(doc.verdict.label).toBe('incomplete');
    expect(doc.stageErrors).toEqual([{ stage: 'challenge', cohortId: null, message: 'challenge exploded' }]);
    expect(doc.findings.map((f) => f.title).sort()).toEqual([GOOD.title, RULED.title].sort());
    expect(doc.findings.every((f) => f.checked === 'challenge did not complete')).toBe(true);
  }, SLOW);

  it('a throw inside select gives an incomplete document naming select, with every kept finding and a self-review', async () => {
    hooks.select = fail('select exploded');
    const { doc } = await review();
    expect(doc.verdict.label).toBe('incomplete');
    expect(doc.stageErrors).toEqual([{ stage: 'select', cohortId: null, message: 'select exploded' }]);
    expect(doc.findings.map((f) => f.title).sort()).toEqual([GOOD.title, RULED.title].sort());
    expect(doc.findings.every((f) => f.bucket === 'also')).toBe(true);
    expect(doc.selfReviewText).toBe(selfReviewText(doc.pr, doc.depth, ['Core', 'Team standard'], doc.verdict));
    expect(doc.selfReviewText).toMatch(/^Reviewed with Airlock at .* The review did not finish\.$/);
  }, SLOW);

  it('rejects with a message of its own when it builds a document that does not match the schema', async () => {
    hooks.select = (result) => ({ ...(result as object), verdict: { label: 'not-a-label', sentence: '', counts: { block: 0, fix: 0, ask: 0, note: 0 } } });
    await expect(review()).rejects.toThrow(/^Airlock built a review document that does not match its own schema: /);
  }, SLOW);
});

describe('runReview deep pass', () => {
  it('keeps the second pass candidates in the document when its challenge throws, and names lenses-deep', async () => {
    hooks.challenge = (items) => { if (items.some((i) => i.title === DEEP_NEW.title)) throw new Error('deep challenge exploded'); };
    const { doc } = await review({ req: { depth: 'deep' } });
    expect(doc.candidates.map((c) => c.title)).toContain(DEEP_NEW.title);
    expect(doc.verdict.label).toBe('incomplete');
    expect(doc.stageErrors).toEqual([{ stage: 'lenses-deep', cohortId: null, message: 'deep challenge exploded' }]);
  }, SLOW);

  it('keeps one item when two layers of the second pass report the same fingerprint', async () => {
    const base = scenarioScript();
    const script = (req: AgentRequest<unknown>): unknown =>
      (req.role === 'lens:core/correctness' && req.instructions.includes(DEEP_SENTENCE) ? { candidates: [DEEP_NEW], questions: [] } : base(req));
    const { doc, calls } = await review({ req: { depth: 'deep' }, script });
    expect(calls.filter((c) => c.instructions.includes(DEEP_SENTENCE) && c.role === 'lens:core/correctness')).toHaveLength(2);
    expect(doc.candidates.filter((c) => c.title === DEEP_NEW.title)).toHaveLength(1);
    expect(doc.findings.filter((f) => f.title === DEEP_NEW.title)).toHaveLength(1);
  }, SLOW);

  it('names every error of the second pass lenses-deep, those of its challenge included', async () => {
    const { doc } = await review({
      req: { depth: 'deep' },
      script: scenarioScript({
        'challenge:': (req) => (req.material.includes(`Title: ${DEEP_NEW.title}`) ? new Error('deep challenger said nothing')
          : { outcome: 'keep', ground: 'none', explanation: '', refutation: null, newSeverity: null, checked: 'Read the callers.' }),
      }),
    });
    const errors = doc.stageErrors;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.stage).toBe('lenses-deep');
    expect(errors[0]!.message).toMatch(/deep challenger said nothing/);
    expect(doc.findings.find((f) => f.title === DEEP_NEW.title)!.checked).toBe('challenge did not complete');
  }, SLOW);
});

describe('runReview models', () => {
  it('ignores a model left undefined and keeps the default', async () => {
    const { doc, calls } = await review({ req: { depth: 'quick', models: { main: undefined, effort: 'low' } } });
    expect(doc.models).toEqual({ main: 'claude-opus-5-5', challenger: 'claude-opus-5-5', sweep: 'claude-opus-5-5', effort: 'low' });
    expect(calls.every((c) => c.model === 'claude-opus-5-5' && c.effort === 'low')).toBe(true);
  }, SLOW);
});

describe('withUniqueIds', () => {
  it('gives a fresh id to a candidate whose id repeats an earlier one or one already used', () => {
    const a = { ...candidate(), id: 'c_00000001' };
    const b = { ...candidate(), id: 'c_00000002' };
    const used = new Set(['c_00000003']);
    const out = withUniqueIds([a, b, { ...a, title: 'Again' }, { ...b, id: 'c_00000003' }], used);
    expect(out.slice(0, 2)).toEqual([a, b]);
    expect(out[2]!.title).toBe('Again');
    expect(out[2]!.id).toMatch(/^c_[0-9a-f]{8}$/);
    expect(out[3]!.id).toMatch(/^c_[0-9a-f]{8}$/);
    expect(new Set([...out.map((c) => c.id), 'c_00000003']).size).toBe(5);
    expect(used.size).toBe(5);
    expect(a.id).toBe('c_00000001'); // inputs are not changed
  });
});
