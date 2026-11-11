import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StageError } from '@airlock/shared';
import { createFakeRunner, failure } from '../../src/agent/fake-runner.js';
import { loadTemplate } from '../../src/agent/prompt.js';
import type { AgentRequest } from '../../src/agent/runner.js';
import { runReview } from '../../src/pipeline/review.js';
import { realExec, type Exec } from '../../src/util/exec.js';
import {
  fakeGh, KIT_DIR, NOW, NUMBER, PACKS_DIR, REPO, scenarioScript, useReviewHarness,
} from '../helpers/review-scenario.js';

const SLOW = 20_000;
const { home, scenario, review } = useReviewHarness();

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
