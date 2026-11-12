import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { minimalDocument } from '@airlock/shared';
import type { PrInfo, ReviewDocument } from '@airlock/shared';
import { prepareWorkspace } from '../../src/intake/workspace.js';
import { realExec, type Exec } from '../../src/util/exec.js';
import { commitFiles } from '../helpers/change-repo.js';
import { makeTempRepo, type TempRepo } from '../helpers/temp-repo.js';

let home = '';
let savedHome: string | undefined;
const repos: TempRepo[] = [];
beforeEach(async () => {
  savedHome = process.env.AIRLOCK_HOME;
  home = await mkdtemp(join(tmpdir(), 'airlock-plan-home-'));
  process.env.AIRLOCK_HOME = home;
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env.AIRLOCK_HOME;
  else process.env.AIRLOCK_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
  for (const r of repos.splice(0)) await rm(r.dir, { recursive: true, force: true });
});

describe('the re-review plan in the workspace', () => {
  it('fetches the recorded base of a merged pull request before planning, so the plan does not fail', async () => {
    const r = await makeTempRepo();
    repos.push(r);
    const base = await commitFiles(r, { 'a.ts': 'one\n' }, 'base');
    await r.git('checkout', '-b', 'side');
    await commitFiles(r, { 'side.ts': 'side\n' }, 'side');
    await r.git('checkout', 'main');
    await r.git('checkout', '-b', 'feature');
    const earlier = await commitFiles(r, { 'a.ts': 'two\n' }, 'first');
    await r.git('merge', '--no-ff', '--no-edit', 'side');
    const head = await r.git('rev-parse', 'HEAD');

    // The mirror lacks GitHub's recorded base until Airlock fetches it by its id.
    let fetchedBase = false;
    const calls: string[] = [];
    const exec: Exec = async (cmd, args, opts) => {
      const line = args.join(' ');
      calls.push(line);
      if (line.endsWith(`fetch origin ${base}`)) { fetchedBase = true; return { stdout: '', stderr: '', code: 0 }; }
      if (!fetchedBase && line.includes('rev-parse') && line.includes(base)) return { stdout: '', stderr: '', code: 1 };
      if (!fetchedBase && line.includes('--is-ancestor') && line.includes(base)) return { stdout: '', stderr: `fatal: Not a valid commit name ${base}`, code: 128 };
      return realExec(cmd, args, opts);
    };
    const doc = minimalDocument();
    const previous: ReviewDocument = { ...doc, id: 'r_0123456789', pr: { ...doc.pr, headSha: earlier } };
    const pr: PrInfo = { ...doc.pr, baseRef: 'main', baseSha: base, headSha: head, merged: true };
    const ws = await prepareWorkspace(exec, {
      repo: 'acme/app', remoteUrl: r.dir, reviewId: 'r_00000000a1',
      pr: { number: 1, baseRef: 'main', headSha: head, baseSha: base, merged: true }, rereview: { previous, pr },
    });
    try {
      expect(ws.plan).toEqual({ kind: 'push', baseSha: earlier, headSha: head });
      expect(calls.findIndex((c) => c.endsWith(`fetch origin ${base}`)))
        .toBeLessThan(calls.findIndex((c) => c.includes('--is-ancestor')));
    } finally {
      await ws.dispose();
    }
  });
});
