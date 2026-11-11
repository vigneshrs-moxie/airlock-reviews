import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeRunner } from '@airlock/engine';
import type { ReviewRequest } from '@airlock/engine';
import type { ReviewDocument } from '@airlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import type { ReplayCliOverrides } from '../src/cli.js';
import type { ReplayDeps } from '../src/index.js';
import { doc, finding, problem, replayCase } from './fixtures.js';

const KIT = { dir: '/kit/here', sha: 'c'.repeat(40) };

const CASES = [
  replayCase({ id: 'pr1', pr: 1, known: [problem({ id: 'K1' })] }),
  replayCase({ id: 'pr2', pr: 2, known: [problem({ id: 'K2' })] }),
  replayCase({ id: 'pr3', pr: 3, kind: 'negative', known: [] }),
];

const judgeAnswer = () => ({
  matches: ['K1', 'K2'].map((knownId) => ({ knownId, itemId: 'f1', partial: false, reason: 'Same cause.' })),
});

function reviewFor(req: ReviewRequest): ReviewDocument {
  const base = doc();
  return doc({ pr: { ...base.pr, repo: req.repo, number: req.number }, findings: [finding('f1', 'top', { severity: 'note' })] });
}

interface Harness {
  overrides: ReplayCliOverrides;
  requests: ReviewRequest[];
  homes: (string | undefined)[];
  runner: ReturnType<typeof createFakeRunner>;
}

function harness(over: { review?: (req: ReviewRequest) => ReviewDocument; deps?: Partial<ReplayDeps>; kit?: ReplayCliOverrides['kit'] | null } = {}): Harness {
  const requests: ReviewRequest[] = [];
  const homes: (string | undefined)[] = [];
  const runner = createFakeRunner(judgeAnswer);
  const deps: ReplayDeps = {
    exec: async () => ({ stdout: '', stderr: 'no network in tests', code: 1 }),
    runner,
    now: () => new Date('2026-11-10T09:30:05.000Z'),
    review: async (req) => {
      requests.push(req);
      homes.push(process.env.AIRLOCK_HOME);
      return (over.review ?? reviewFor)(req);
    },
    ...over.deps,
  };
  const overrides: ReplayCliOverrides = { deps, packsDir: '/packs/here', cases: CASES };
  if (over.kit !== null) overrides.kit = over.kit ?? KIT;
  return { overrides, requests, homes, runner };
}

function io(): { out: string[]; err: string[]; io: { out: (t: string) => void; err: (t: string) => void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t) => out.push(t), err: (t) => err.push(t) } };
}

let work: string;
let savedHome: string | undefined;
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'airlock-replay-cli-'));
  savedHome = process.env.AIRLOCK_HOME;
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/** Runs `fn`, then puts AIRLOCK_HOME back as it was. */
async function keepingEnv<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    if (savedHome === undefined) delete process.env.AIRLOCK_HOME;
    else process.env.AIRLOCK_HOME = savedHome;
  }
}

const RUN_ID = '20261110-093005-claude-opus-5-5-standard';

describe('airlock-replay', () => {
  it('requires --cases and returns 2 without it', async () => {
    const h = harness();
    const t = io();
    const code = await keepingEnv(() => main(['run', '--out', work], t.io, h.overrides));
    expect(code).toBe(2);
    expect(t.err.join('\n')).toContain('--cases');
    expect(h.requests).toHaveLength(0);

    const unknown = io();
    expect(await keepingEnv(() => main(['run', '--cases', 'pr1', '--colour', 'red'], unknown.io, h.overrides))).toBe(2);
    const badParallel = io();
    expect(await keepingEnv(() => main(['run', '--cases', 'pr1', '--parallel', '4'], badParallel.io, h.overrides))).toBe(2);
    expect(badParallel.err.join('\n')).toContain('--parallel');
    const badCase = io();
    expect(await keepingEnv(() => main(['run', '--cases', 'pr99', '--out', work], badCase.io, h.overrides))).toBe(2);
    expect(badCase.err.join('\n')).toContain('pr99');
    expect(h.requests).toHaveLength(0);
  });

  it('sets AIRLOCK_HOME under the output folder before the first review', async () => {
    const h = harness();
    const t = io();
    process.env.AIRLOCK_HOME = join(work, 'the-persons-real-home');
    try {
      const code = await main(['run', '--cases', 'pr1', '--out', work], t.io, h.overrides);
      expect(code).toBe(0);
      expect(h.homes).toEqual([join(work, 'home')]);
      expect(t.err.join('\n')).toContain(join(work, 'home'));

      // The kit is fetched after the variable is set: syncKit's first command sees it.
      const seen: (string | undefined)[] = [];
      const fetching = harness({ kit: null, deps: { exec: async () => { seen.push(process.env.AIRLOCK_HOME); return { stdout: '', stderr: 'offline', code: 1 }; } } });
      process.env.AIRLOCK_HOME = join(work, 'the-persons-real-home');
      expect(await main(['run', '--cases', 'pr1', '--out', join(work, 'second')], io().io, fetching.overrides)).toBe(1);
      expect(seen[0]).toBe(join(work, 'second', 'home'));
    } finally {
      if (savedHome === undefined) delete process.env.AIRLOCK_HOME;
      else process.env.AIRLOCK_HOME = savedHome;
    }
  });

  it('passes the selection to pickCases and the defaults to the run', async () => {
    const h = harness();
    const t = io();
    const code = await keepingEnv(() => main(['run', '--cases', 'pr1,pr3', '--out', work], t.io, h.overrides));
    expect(code).toBe(0);
    expect(h.requests.map((r) => r.number)).toEqual([1, 3]);
    for (const req of h.requests) {
      expect(req).toMatchObject({
        depth: 'standard', packsDir: '/packs/here', kitDir: KIT.dir, kitSha: KIT.sha,
        models: { main: 'claude-opus-5-5', challenger: 'claude-opus-5-5', sweep: 'claude-opus-5-5' },
      });
    }
    expect(h.runner.calls.map((r) => r.model)).toEqual(['claude-opus-5-5']);
    const runDir = join(work, RUN_ID);
    expect(JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'))).toMatchObject({
      runId: RUN_ID, model: 'claude-opus-5-5', depth: 'standard', judgeModel: 'claude-opus-5-5', kitSha: KIT.sha, caseIds: ['pr1', 'pr3'],
    });
    expect(t.out).toEqual([
      join(runDir, 'report.md'),
      'Half of the known problems in the top list: yes',
      'Clean pull requests stay clean: yes',
    ]);
    expect(t.err).toContain('pr1: start');
    expect(t.err).toContain('pr1: 1/1 in the top list, 1 shown, verdict approve');
    expect(t.err).toContain('pr3: 0/0 in the top list, 1 shown, verdict approve');

    // The options reach the run too.
    const other = harness();
    const u = io();
    const code2 = await keepingEnv(() => main([
      'run', '--cases', 'positive', '--out', work, '--model', 'claude-fable-5-2', '--depth', 'quick', '--run', 'mine',
      '--judge-model', 'claude-haiku-5-5', '--parallel', '2',
    ], u.io, other.overrides));
    expect(code2).toBe(0);
    // With --parallel 2 the two reviews start in either order.
    expect(other.requests.map((r) => [r.number, r.depth, r.models?.main]).sort()).toEqual([[1, 'quick', 'claude-fable-5-2'], [2, 'quick', 'claude-fable-5-2']]);
    expect(other.runner.calls.map((r) => r.model)).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5']);
    expect(u.out[0]).toBe(join(work, 'mine', 'report.md'));
    expect(u.out[2]).toBe('Clean pull requests stay clean: not tested');
  });

  it('returns 1 when the kit cannot be fetched', async () => {
    const h = harness({ kit: null });
    const t = io();
    const code = await keepingEnv(() => main(['run', '--cases', 'pr1', '--out', work], t.io, h.overrides));
    expect(code).toBe(1);
    expect(t.err.join('\n')).toMatch(/kit/);
    expect(t.err.join('\n')).toContain('a replay without the team standard would not measure the real configuration');
    expect(h.requests).toHaveLength(0);
  });

  it('report rewrites the report from a run folder without any model call', async () => {
    const h = harness({ review: (req) => { if (req.number === 2) throw new Error('no such commit'); return reviewFor(req); } });
    expect(await keepingEnv(() => main(['run', '--cases', 'all', '--out', work], io().io, h.overrides))).toBe(0);
    const runDir = join(work, RUN_ID);
    const before = await readFile(join(runDir, 'report.md'), 'utf8');
    const summaryBefore = await readFile(join(runDir, 'summary.json'), 'utf8');
    await rm(join(runDir, 'report.md'));
    await rm(join(runDir, 'summary.json'));

    const again = harness({ review: () => { throw new Error('must not review'); } });
    const t = io();
    const code = await keepingEnv(() => main(['report', runDir], t.io, again.overrides));
    expect(code).toBe(0);
    expect(t.out).toEqual([join(runDir, 'report.md')]);
    expect(await readFile(join(runDir, 'report.md'), 'utf8')).toBe(before);
    expect(await readFile(join(runDir, 'summary.json'), 'utf8')).toBe(summaryBefore);
    expect(again.requests).toHaveLength(0);
    expect(again.runner.calls).toHaveLength(0);

    const missing = io();
    expect(await keepingEnv(() => main(['report', join(work, 'nothing-here')], missing.io, again.overrides))).toBe(1);
    expect(await keepingEnv(() => main(['report'], io().io, again.overrides))).toBe(2);
  });

  it('returns 0 and says so when a case failed', async () => {
    const h = harness({ review: (req) => { if (req.number === 2) throw new Error('no such commit'); return reviewFor(req); } });
    const t = io();
    const code = await keepingEnv(() => main(['run', '--cases', 'pr1,pr2', '--out', work], t.io, h.overrides));
    expect(code).toBe(0);
    const err = t.err.join('\n');
    expect(err).toContain('pr2: failed');
    expect(err).toContain('no such commit');
    expect(err).toMatch(/1 case did not finish: pr2/);
    expect(t.out[0]).toBe(join(work, RUN_ID, 'report.md'));
    expect(t.out[1]).toBe('Half of the known problems in the top list: yes');
    expect((await stat(join(work, RUN_ID, 'report.md'))).isFile()).toBe(true);
  });

  it('prints text from outside without terminal control characters, each message on one line', async () => {
    const h = harness({ review: (req) => { if (req.number === 2) throw new Error('bad\u001b[2K\rthing\nsecond line'); return reviewFor(req); } });
    const t = io();
    const out = join(work, 'odd\u001b[31m\rfolder');
    expect(await keepingEnv(() => main(['run', '--cases', 'pr1,pr2', '--out', out], t.io, h.overrides))).toBe(0);
    for (const line of [...t.err, ...t.out]) {
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
    expect(t.err.some((l) => l.startsWith('pr2: failed: ') && l.includes('bad') && l.includes('thing second line'))).toBe(true);
    // The carriage return becomes a space and the escape character is removed.
    expect(t.out[0]).toBe(join(work, 'odd[31m folder', RUN_ID, 'report.md'));
  });
});
