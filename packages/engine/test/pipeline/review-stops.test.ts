import { readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewEvent, StageError } from '@airlock/shared';
import { createFakeRunner, failure } from '../../src/agent/fake-runner.js';
import { loadTemplate } from '../../src/agent/prompt.js';
import type { AgentRequest } from '../../src/agent/runner.js';
import { runReview } from '../../src/pipeline/review.js';
import { latestReview } from '../../src/store/store.js';
import { realExec, type Exec } from '../../src/util/exec.js';
import {
  fakeGh, KIT_DIR, NOW, NUMBER, PACKS_DIR, REPO, scenarioScript, useReviewHarness,
} from '../helpers/review-scenario.js';

const SLOW = 20_000;
const { home, scenario, review } = useReviewHarness();

/** Runs after saveReview has written the document and before it returns, so a test can stop the review mid-save. */
const storeHooks = vi.hoisted(() => ({ afterSave: undefined as (() => void) | undefined }));
vi.mock('../../src/store/store.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/store/store.js')>();
  return {
    ...m,
    saveReview: async (...args: Parameters<typeof m.saveReview>) => {
      const path = await m.saveReview(...args);
      storeHooks.afterSave?.();
      return path;
    },
  };
});
afterEach(() => { storeHooks.afterSave = undefined; });

const LIMIT = "Claude's usage limit was reached; it resets at 17:00";
const errorsOf = (errors: StageError[], stage: string): StageError[] => errors.filter((e) => e.stage === stage);

describe('a usage limit stops the review from asking for more', () => {
  it('after a usage limit in the lens stage, sweep, seams, challenge and select make no request and record why', async () => {
    // Loaded before the review so the lens stage queues its requests before the sweep does.
    await loadTemplate('lens');
    await loadTemplate('sweep');
    const script = scenarioScript({ 'lens:': () => failure(LIMIT, 'usage-limit') });
    const { doc, calls } = await review({ script, req: { parallel: 1 } });
    const roles = calls.map((c) => c.role);
    const firstLens = roles.findIndex((r) => r.startsWith('lens:'));
    expect(roles.slice(firstLens)).toEqual([roles[firstLens]]);
    for (const prefix of ['sweep:', 'seams', 'challenge:', 'select']) expect(roles.some((r) => r.startsWith(prefix))).toBe(false);
    expect(doc.verdict.label).toBe('incomplete');
    expect(errorsOf(doc.stageErrors, 'lenses').every((e) => e.kind === 'usage-limit')).toBe(true);
    expect(errorsOf(doc.stageErrors, 'sweep').length).toBeGreaterThan(0);
    expect(errorsOf(doc.stageErrors, 'sweep').every((e) => e.kind === 'usage-limit')).toBe(true);
    for (const stage of ['seams', 'challenge', 'select']) {
      expect(errorsOf(doc.stageErrors, stage)).toEqual([{
        stage, cohortId: null, kind: 'usage-limit', message: `${LIMIT}. This stage was not run.`,
      }]);
    }
  }, SLOW);

  it('copies the kind of each failed request into its stage error', async () => {
    const script = scenarioScript({
      mapper: () => failure('timed out after 900 s', 'timeout'),
      brief: () => failure('error_max_turns', 'turn-limit'),
      'lens:core/naming': () => failure('not the expected form', 'invalid-output'),
      seams: () => failure('Claude Code process exited with code 1', 'other'),
      select: () => failure('error_max_turns', 'turn-limit'),
    });
    const { doc } = await review({ script });
    const kindOf = (stage: string) => errorsOf(doc.stageErrors, stage).map((e) => e.kind);
    expect(kindOf('map')).toEqual(['timeout']);
    expect(kindOf('brief')).toEqual(['turn-limit']);
    expect(kindOf('lenses')).toEqual(expect.arrayContaining(['invalid-output']));
    expect(kindOf('seams')).toEqual(['other']);
    expect(kindOf('select')).toEqual(['turn-limit']);
  }, SLOW);
});

describe('one signal stops a review', () => {
  it('passes the signal to every request and command, and an aborted review disposes its workspace and says it was stopped', async () => {
    const s = await scenario();
    const ac = new AbortController();
    const gh = fakeGh({ baseSha: s.baseSha, headSha: s.headSha });
    const signals: (AbortSignal | undefined)[] = [];
    const exec: Exec = (cmd, args, opts) => {
      signals.push(opts?.signal);
      return gh(cmd, args, opts);
    };
    const fake = createFakeRunner(scenarioScript({
      'lens:': (req: AgentRequest<unknown>) => {
        ac.abort();
        return req.signal === ac.signal ? { candidates: [], questions: [] } : new Error('no signal on the request');
      },
    }));
    const stopped = runReview(
      { repo: REPO, number: NUMBER, packsDir: PACKS_DIR, kitDir: KIT_DIR, remoteUrl: s.remote.dir },
      { exec, runner: fake, now: () => NOW, signal: ac.signal },
    );
    await expect(stopped).rejects.toThrow('The review was stopped.');
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls.every((c) => c.signal === ac.signal)).toBe(true);
    expect(signals.filter((sig) => sig !== ac.signal)).toEqual([undefined]); // only the cleanup after the stop runs without it
    expect(await readdir(join(home(), 'work'))).toEqual([]);
    const mirror = join(home(), 'repos', 'acme__app.git');
    const worktrees = await realExec('git', ['--git-dir', mirror, 'worktree', 'list']);
    expect(worktrees.stdout.trim().split('\n')).toHaveLength(1);
    expect(await readdir(join(home(), 'reviews')).catch(() => [])).toEqual([]);
  }, SLOW);

  it('rejects at once, touching nothing, when the signal is already aborted', async () => {
    const s = await scenario();
    const ac = new AbortController();
    ac.abort();
    const fake = createFakeRunner(scenarioScript());
    await expect(runReview(
      { repo: REPO, number: NUMBER, packsDir: PACKS_DIR, kitDir: KIT_DIR, remoteUrl: s.remote.dir },
      { exec: fakeGh({ baseSha: s.baseSha, headSha: s.headSha }), runner: fake, now: () => NOW, signal: ac.signal },
    )).rejects.toThrow('The review was stopped.');
    expect(fake.calls).toEqual([]);
  }, SLOW);
});

describe('a stopped review stores nothing', () => {
  /** Every stored review document under AIRLOCK_HOME. */
  const storedDocuments = async (): Promise<string[]> =>
    (await readdir(join(home(), 'reviews'), { recursive: true }).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));

  const start = async (ac: AbortController, onEvent?: (e: ReviewEvent) => void) => {
    const s = await scenario();
    return runReview(
      { repo: REPO, number: NUMBER, packsDir: PACKS_DIR, kitDir: KIT_DIR, remoteUrl: s.remote.dir },
      { exec: fakeGh({ baseSha: s.baseSha, headSha: s.headSha }), runner: createFakeRunner(scenarioScript()), now: () => NOW, signal: ac.signal },
      onEvent,
    );
  };

  it('a signal aborted just before the store stage leaves no stored document', async () => {
    const ac = new AbortController();
    const stopped = start(ac, (e) => { if (e.type === 'stage' && e.stage === 'select' && e.status !== 'start') ac.abort(); });
    await expect(stopped).rejects.toThrow('The review was stopped.');
    expect(await storedDocuments()).toEqual([]);
    expect(await latestReview(REPO, NUMBER)).toBeNull();
  }, SLOW);

  it('an abort that fires during the save removes the document that save wrote', async () => {
    const ac = new AbortController();
    let onDisk: string[] = [];
    storeHooks.afterSave = () => {
      onDisk = readdirSync(join(home(), 'reviews'), { recursive: true, encoding: 'utf8' }).filter((n) => n.endsWith('.json'));
      ac.abort();
    };
    await expect(start(ac)).rejects.toThrow('The review was stopped.');
    expect(onDisk).toHaveLength(1);
    expect(await storedDocuments()).toEqual([]);
    expect(await latestReview(REPO, NUMBER)).toBeNull();
  }, SLOW);

  it('a review that completes keeps its document when the signal is aborted afterwards', async () => {
    const ac = new AbortController();
    const doc = await start(ac);
    ac.abort();
    expect(await storedDocuments()).toHaveLength(1);
    expect((await latestReview(REPO, NUMBER))?.id).toBe(doc.id);
  }, SLOW);
});

describe('time is reported as it passed', () => {
  it('stamps the start and the end of the review and of each stage, and keeps the turns', async () => {
    const s = await scenario();
    let tick = 0;
    const start = Date.parse('2026-11-11T09:00:00.000Z');
    const now = (): Date => new Date(start + 1000 * tick++);
    const fake = createFakeRunner(scenarioScript());
    const doc = await runReview(
      { repo: REPO, number: NUMBER, packsDir: PACKS_DIR, kitDir: KIT_DIR, remoteUrl: s.remote.dir },
      { exec: fakeGh({ baseSha: s.baseSha, headSha: s.headSha }), runner: fake, now },
    );
    expect(doc.startedAt).toBe(new Date(start).toISOString());
    expect(Date.parse(doc.createdAt)).toBeGreaterThan(Date.parse(doc.startedAt!));
    for (const t of doc.timings) {
      expect(t.startedAt, t.stage).toBeDefined();
      expect(Date.parse(t.finishedAt!), t.stage).toBeGreaterThanOrEqual(Date.parse(t.startedAt!));
      expect(Date.parse(t.startedAt!), t.stage).toBeGreaterThanOrEqual(Date.parse(doc.startedAt!));
      expect(t.turns, t.stage).toBe(t.agentRuns); // the fake runner reports one turn per request
    }
    const lenses = doc.timings.find((t) => t.stage === 'lenses')!;
    const sweep = doc.timings.find((t) => t.stage === 'sweep')!;
    expect(Date.parse(sweep.startedAt!)).toBeLessThan(Date.parse(lenses.finishedAt!)); // they overlap
  }, SLOW);
});
