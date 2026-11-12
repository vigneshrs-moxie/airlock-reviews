import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewRange } from '@airlock/shared';
import { PROMPT_BOUNDARY } from '../../src/agent/prompt.js';
import { renderReview } from '../../src/render/terminal.js';
import { isSyncMerge } from '../../src/shape/detect.js';
import { mergeNote, mergeNoteBlock, mergeRange } from '../../src/shape/merge-range.js';
import { realExec, type Exec } from '../../src/util/exec.js';
import { commitFiles, diffOf } from '../helpers/change-repo.js';
import { block } from '../helpers/lens-context.js';
import { fakeGh, GOOD, RULED, scenarioScript, useReviewHarness } from '../helpers/review-scenario.js';
import { makeTempRepo, type TempRepo } from '../helpers/temp-repo.js';

const SLOW = 30_000;
const none = { candidates: [], questions: [] };

describe('mergeRange', () => {
  const repos: TempRepo[] = [];
  afterEach(async () => {
    for (const r of repos.splice(0)) await rm(r.dir, { recursive: true, force: true });
  });

  async function repo(): Promise<TempRepo> {
    const r = await makeTempRepo();
    repos.push(r);
    return r;
  }

  const range = (baseSha: string, headSha: string): ReviewRange => ({ baseSha, headSha, kind: 'full' });
  const gitDir = (r: TempRepo): string => join(r.dir, '.git');

  /** main at root; then feature and main change the same line of a.txt differently, and main also adds c.txt. */
  async function twoSides(r: TempRepo): Promise<{ feature: string; main: string }> {
    await commitFiles(r, { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'b one\nb two\n' }, 'root');
    await r.git('checkout', '-b', 'feature');
    const feature = await commitFiles(r, { 'a.txt': 'one\nfeature two\nthree\n' }, 'feature');
    await r.git('checkout', 'main');
    const main = await commitFiles(r, { 'a.txt': 'one\nmain two\nthree\n', 'c.txt': 'from main\n' }, 'main');
    return { feature, main };
  }

  /** A commit that already joins both tips, so the range from it to a merge of the same tips holds only that merge. */
  async function joinedBoth(r: TempRepo, feature: string, main: string): Promise<string> {
    await r.git('checkout', '-b', 'joined', main);
    await r.git('merge', '--no-ff', '-s', 'ours', '-m', 'join', feature);
    return r.git('rev-parse', 'HEAD');
  }

  /** Merges main into feature, writes `files` by hand (conflicts resolved, other changes), and commits the merge. */
  async function mergeByHand(r: TempRepo, files: Record<string, string>): Promise<string> {
    await r.git('checkout', 'feature');
    await r.git('merge', '--no-ff', '--no-commit', 'main').catch(() => undefined); // a conflict exits 1
    for (const [path, text] of Object.entries(files)) await r.write(path, text);
    await r.git('add', '--all');
    await r.git('commit', '--no-edit', '-m', 'Merge main into feature');
    return r.git('rev-parse', 'HEAD');
  }

  it('a clean merge with nothing changed by hand is nothing-by-hand', async () => {
    const r = await repo();
    await commitFiles(r, { 'a.txt': 'root\n' }, 'root');
    await r.git('checkout', '-b', 'feature');
    await r.git('checkout', 'main');
    const main = await commitFiles(r, { 'b.txt': 'main moved on\n' }, 'main');
    const merge = await mergeByHand(r, {});
    expect(await mergeRange(realExec, gitDir(r), range(main, merge))).toEqual({ kind: 'nothing-by-hand' });
  });

  it('a conflict resolved by hand gives a range whose diff is only the resolution', async () => {
    const r = await repo();
    const { feature, main } = await twoSides(r);
    const joined = await joinedBoth(r, feature, main);
    const merge = await mergeByHand(r, { 'a.txt': 'one\nfeature and main two\nthree\n' });
    const got = await mergeRange(realExec, gitDir(r), range(joined, merge));
    expect(got).toEqual({ kind: 'by-hand', baseSha: expect.stringMatching(/^[0-9a-f]{40}$/), headSha: merge, files: 1, unshown: [] });
    if (got.kind !== 'by-hand') return;
    // The mechanical merge sits on the first parent, and holds the conflict as git left it.
    expect(await r.git('rev-list', '--parents', '-n', '1', got.baseSha)).toBe(`${got.baseSha} ${feature}`);
    expect(await r.git('show', `${got.baseSha}:a.txt`)).toMatch(/^<<<<<<< .*\nfeature two\n=======\nmain two\n>>>>>>> /m);
    const files = await diffOf(r, got.baseSha, merge);
    expect(files.map((f) => f.path)).toEqual(['a.txt']);
    const lines = files[0]!.hunks.flatMap((h) => h.lines);
    expect(lines.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['feature and main two']);
    expect(lines.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual([
      expect.stringMatching(/^<<<<<<< /), 'feature two', '=======', 'main two', expect.stringMatching(/^>>>>>>> /),
    ]);
  });

  it('runs no merge driver from the person\'s own git configuration, and still gives the merge\'s tree and conflicts', async () => {
    const r = await repo();
    const { feature, main } = await twoSides(r);
    const joined = await joinedBoth(r, feature, main);
    const merge = await mergeByHand(r, { 'a.txt': 'one\nfeature and main two\nthree\n' });
    const dir = await mkdtemp(join(tmpdir(), 'airlock-driver-'));
    try {
      // The person's global configuration names an attributes file that sends .txt files to a driver leaving a marker.
      await writeFile(join(dir, 'attrs'), '*.txt merge=probe\n');
      const config = async (name: string): Promise<string> => {
        const path = join(dir, `${name}.gitconfig`);
        await writeFile(path, `[core]\n\tattributesFile = ${join(dir, 'attrs')}\n[merge "probe"]\n\tdriver = touch ${join(dir, name)}; false\n`);
        return path;
      };
      const asThePerson = (path: string): Exec => (cmd, args, opts) => realExec(cmd, args, { ...opts, env: { GIT_CONFIG_GLOBAL: path, ...opts?.env } });
      // The driver is real: a merge-tree run as the person runs it.
      await asThePerson(await config('sanity'))('git', ['--git-dir', gitDir(r), 'merge-tree', '--write-tree', feature, main]);
      expect(await stat(join(dir, 'sanity')).then(() => true, () => false)).toBe(true);

      const got = await mergeRange(asThePerson(await config('probe')), gitDir(r), range(joined, merge));
      expect(await stat(join(dir, 'probe')).then(() => true, () => false)).toBe(false);
      expect(got).toEqual({ kind: 'by-hand', baseSha: expect.stringMatching(/^[0-9a-f]{40}$/), headSha: merge, files: 1, unshown: [] });
      if (got.kind !== 'by-hand') return;
      expect(await r.git('show', `${got.baseSha}:a.txt`)).toMatch(/^<<<<<<< .*\nfeature two\n=======\nmain two\n>>>>>>> /m);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a line changed by hand in a file without conflict is in the range, and what git merged by itself is not', async () => {
    const r = await repo();
    const { feature, main } = await twoSides(r);
    const joined = await joinedBoth(r, feature, main);
    const merge = await mergeByHand(r, { 'a.txt': 'one\nmain two\nthree\n', 'b.txt': 'b one\nb two by hand\n' });
    const got = await mergeRange(realExec, gitDir(r), range(joined, merge));
    expect(got).toMatchObject({ kind: 'by-hand', headSha: merge, files: 2 });
    if (got.kind !== 'by-hand') return;
    const files = await diffOf(r, got.baseSha, merge);
    expect(files.map((f) => f.path)).toEqual(['a.txt', 'b.txt']);
    const b = files[1]!.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== 'ctx').map((l) => `${l.kind} ${l.text}`);
    expect(b).toEqual(['del b two', 'add b two by hand']);
  });

  it('the mechanical commit has the same id on a second run and no ref points at it', async () => {
    const r = await repo();
    const { feature, main } = await twoSides(r);
    const joined = await joinedBoth(r, feature, main);
    const merge = await mergeByHand(r, { 'a.txt': 'one\nresolved\nthree\n' });
    const refsBefore = await r.git('for-each-ref', '--format=%(refname) %(objectname)');
    const first = await mergeRange(realExec, gitDir(r), range(joined, merge));
    const second = await mergeRange(realExec, gitDir(r), range(joined, merge));
    expect(first.kind).toBe('by-hand');
    expect(second).toEqual(first);
    if (first.kind !== 'by-hand') return;
    expect(await r.git('for-each-ref', '--contains', first.baseSha)).toBe('');
    expect(await r.git('for-each-ref', '--format=%(refname) %(objectname)')).toBe(refsBefore);
    expect(await r.git('rev-parse', 'HEAD')).toBe(merge);
    expect(await r.git('status', '--porcelain')).toBe('');
    // The fixed author and dates, not the person's own.
    expect(await r.git('log', '-1', '--format=%an <%ae> %at | %cn <%ce> %ct', first.baseSha))
      .toBe('Airlock <airlock@localhost> 946684800 | Airlock <airlock@localhost> 946684800');
  });

  it('gives a reason for several merges and for an octopus merge, and refuses an id that is not a full commit id', async () => {
    const r = await repo();
    await commitFiles(r, { 'a.txt': 'root\n' }, 'root');
    const root = await r.git('rev-parse', 'HEAD');
    await r.git('checkout', '-b', 'feature');
    await r.git('checkout', 'main');
    const x = await commitFiles(r, { 'b.txt': 'x\n' }, 'x');
    await r.git('checkout', '-b', 'side', root);
    const y = await commitFiles(r, { 'c.txt': 'y\n' }, 'y');
    await r.git('checkout', 'feature');
    await r.git('merge', '--no-ff', '-m', 'octopus', x, y);
    const octopus = await r.git('rev-parse', 'HEAD');
    await r.git('checkout', '-b', 'joined', x);
    await r.git('merge', '--no-ff', '-m', 'join', y);
    const joined = await r.git('rev-parse', 'HEAD');
    expect(await mergeRange(realExec, gitDir(r), range(joined, octopus))).toEqual({
      kind: 'unsupported', reason: 'Its merge commit joins 3 branches, and Airlock reviews what was changed by hand only in a merge of two.',
    });

    // feature merges z in after the octopus; from a commit holding x, y and z, the range is those two merges.
    await r.git('checkout', 'main');
    const z = await commitFiles(r, { 'd.txt': 'z\n' }, 'z');
    await r.git('checkout', 'feature');
    await r.git('merge', '--no-ff', '-m', 'again', 'main');
    const twice = await r.git('rev-parse', 'HEAD');
    await r.git('checkout', 'joined');
    await r.git('merge', '--no-ff', '-m', 'join z', z);
    const joinedAll = await r.git('rev-parse', 'HEAD');
    expect(await mergeRange(realExec, gitDir(r), range(joinedAll, twice))).toEqual({
      kind: 'unsupported', reason: 'It has 2 merge commits, and Airlock reviews what was changed by hand only in a single merge.',
    });

    const calls: string[][] = [];
    const exec = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { stdout: '', stderr: '', code: 0 }; };
    await expect(mergeRange(exec, '/nowhere', range('--output=x', 'a'.repeat(40)))).rejects.toThrow(/not a full commit id/);
    await expect(mergeRange(exec, '/nowhere', range('a'.repeat(40), 'abc1234'))).rejects.toThrow(/not a full commit id/);
    expect(calls).toEqual([]);
  });

  /**
   * main at root; then feature changes f, b.bin and (with `marker`) a.txt, while main deletes f, changes b.bin and (with
   * `marker`) the same line of a.txt. Returns both tips.
   */
  async function settledSides(r: TempRepo, marker: boolean): Promise<{ feature: string; main: string }> {
    await commitFiles(r, { 'a.txt': 'one\ntwo\nthree\n', f: 'a\n', 'b.bin': 'x\0root' }, 'root');
    await r.git('checkout', '-b', 'feature');
    const feature = await commitFiles(r, { f: 'a feature\n', 'b.bin': 'x\0feat', ...(marker ? { 'a.txt': 'one\nfeature two\nthree\n' } : {}) }, 'feature');
    await r.git('checkout', 'main');
    const main = await commitFiles(r, { f: null, 'b.bin': 'x\0main', ...(marker ? { 'a.txt': 'one\nmain two\nthree\n' } : {}) }, 'main');
    return { feature, main };
  }

  const SETTLED = 'Git reported conflicts in this merge that it settled without markers (a file one side deleted and the other changed, or a binary file):';

  it('a merge whose conflicts git settled without markers, kept as git left them, is never nothing-by-hand', async () => {
    const r = await repo();
    const { feature, main } = await settledSides(r, false);
    const joined = await joinedBoth(r, feature, main);
    const merge = await mergeByHand(r, {});
    // The measured premise: the merge as committed has exactly the tree git made by itself.
    expect(await r.git('rev-parse', `${merge}^{tree}`)).toBe((await r.git('merge-tree', '--write-tree', feature, main).catch((e: { stdout: string }) => e.stdout)).split('\n')[0]);
    expect(await mergeRange(realExec, gitDir(r), range(joined, merge))).toEqual({
      kind: 'unsupported', conflicted: ['b.bin', 'f'],
      reason: `${SETTLED} b.bin, f. Airlock cannot show what was decided for them.`,
    });
  });

  it('a marker conflict resolved by hand and a kept modify/delete: by-hand, with the kept path named as not shown', async () => {
    const r = await repo();
    const { feature, main } = await settledSides(r, true);
    const joined = await joinedBoth(r, feature, main);
    const merge = await mergeByHand(r, { 'a.txt': 'one\nboth two\nthree\n' });
    expect(await mergeRange(realExec, gitDir(r), range(joined, merge))).toEqual({
      kind: 'by-hand', baseSha: expect.stringMatching(/^[0-9a-f]{40}$/), headSha: merge, files: 1, unshown: ['b.bin', 'f'],
    });
  });

  it('cuts the list of conflicted paths at ten', async () => {
    const r = await repo();
    const names = Array.from({ length: 12 }, (_, i) => `p${String(i + 1).padStart(2, '0')}.txt`);
    await commitFiles(r, Object.fromEntries(names.map((n) => [n, 'root\n'])), 'root');
    await r.git('checkout', '-b', 'feature');
    const feature = await commitFiles(r, Object.fromEntries(names.map((n) => [n, 'feature\n'])), 'feature');
    await r.git('checkout', 'main');
    const main = await commitFiles(r, Object.fromEntries(names.map((n) => [n, null])), 'main');
    const joined = await joinedBoth(r, feature, main);
    const merge = await mergeByHand(r, {});
    const got = await mergeRange(realExec, gitDir(r), range(joined, merge));
    expect(got).toMatchObject({
      kind: 'unsupported', reason: `${SETTLED} ${names.slice(0, 10).join(', ')} and 2 more. Airlock cannot show what was decided for them.`,
    });
  });

  it('a merge-tree answer that is not a tree id is an error, never no conflicts', async () => {
    const r = await repo();
    await commitFiles(r, { 'a.txt': 'root\n' }, 'root');
    await r.git('checkout', '-b', 'feature');
    await r.git('checkout', 'main');
    const main = await commitFiles(r, { 'b.txt': 'main moved on\n' }, 'main');
    const merge = await mergeByHand(r, {});
    const answering = (answer: (args: string[]) => { stdout: string; stderr: string; code: number } | null): Exec =>
      async (cmd, args, opts) => (args.includes('merge-tree') ? answer(args) : null) ?? realExec(cmd, args, opts);
    // A bad argument exits 1, as conflicts do, with no tree.
    await expect(mergeRange(answering(() => ({ stdout: '', stderr: 'fatal: not something we can merge', code: 1 })), gitDir(r), range(main, merge)))
      .rejects.toThrow(/git merge-tree .*not something we can merge/);
    // A full id that is not a tree (here the merge commit itself) is not an answer either.
    await expect(mergeRange(answering(() => ({ stdout: `${merge}\0`, stderr: '', code: 0 })), gitDir(r), range(main, merge)))
      .rejects.toThrow(/git merge-tree/);
  });

  it('names the mirror with --git-dir, so safe.bareRepository=explicit cannot break the detection or the merge', async () => {
    const r = await repo();
    const { feature, main } = await twoSides(r);
    const joined = await joinedBoth(r, feature, main);
    const merge = await mergeByHand(r, { 'a.txt': 'one\nresolved\nthree\n' });
    const mirror = `${r.dir}-mirror.git`;
    await realExec('git', ['clone', '-q', '--bare', r.dir, mirror]);
    const strictEnv = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.bareRepository', GIT_CONFIG_VALUE_0: 'explicit' };
    try {
      // The setting is in force: git run inside the bare mirror without --git-dir is refused.
      expect((await realExec('git', ['rev-list', '-n', '1', merge], { cwd: mirror, env: strictEnv })).code).not.toBe(0);
      const strict: Exec = (cmd, args, opts) => realExec(cmd, args, { ...opts, env: { ...opts?.env, ...strictEnv } });
      expect(await isSyncMerge(strict, mirror, range(joined, merge), null)).toBe(true);
      expect(await mergeRange(strict, mirror, range(joined, merge))).toMatchObject({ kind: 'by-hand', headSha: merge, files: 1 });
    } finally {
      await rm(mirror, { recursive: true, force: true });
    }
  });
});

describe('runReview of a pull request that only merges its base in', () => {
  const { scenario, review, home } = useReviewHarness();

  /** A remote whose feature branch sits at the base; main moves on, and feature merges it with `byHand` written into the merge. */
  async function mergedIn(byHand: Record<string, string>, base: Record<string, string> = { 'src/a.ts': 'export const a = 1;\n' }) {
    const s = await scenario(base, {});
    await s.remote.git('checkout', 'main');
    await commitFiles(s.remote, { 'README.md': 'main moved on\n' }, 'main advances');
    await s.remote.git('checkout', 'feature');
    await s.remote.git('merge', '--no-ff', '--no-commit', 'main');
    for (const [path, text] of Object.entries(byHand)) await s.remote.write(path, text);
    await s.remote.git('add', '--all');
    await s.remote.git('commit', '--no-edit', '-m', 'Merge main into feature');
    return { s, head: await s.remote.git('rev-parse', 'HEAD') };
  }

  it('a clean merge with nothing changed by hand reviews nothing and is not incomplete', async () => {
    const { s, head } = await mergedIn({});
    const { doc, calls, events } = await review({ s, exec: fakeGh({ baseSha: s.baseSha, headSha: head }) });
    expect(calls).toEqual([]);
    expect(doc.range.kind).toBe('sync-merge');
    expect(doc.mergeReview).toBe('nothing-by-hand');
    expect(doc.range.headSha).toBe(head);
    expect(doc.files).toEqual([]);
    expect(doc.stageErrors).toEqual([]);
    expect(doc.brief.whatItDoes).toEqual([
      'This pull request only merges main into the branch. Git merged it without conflicts and nothing was changed by hand.',
    ]);
    // The clean verdict for a reviewer who is not the author.
    expect(doc.verdict.label).toBe('approve');
    expect(doc.findings).toEqual([]);
    const skipped = events.flatMap((e) => (e.type === 'stage' && e.status === 'done' && e.detail.startsWith('skipped') ? [e.stage] : []));
    expect(skipped).toEqual(['map', 'brief', 'lenses', 'sweep', 'seams', 'anchor', 'merge', 'challenge']);
  }, SLOW);

  it('the shape sentence reaches the brief and every lens request, with branch names only as material', async () => {
    const { s, head } = await mergedIn({ 'src/a.ts': 'export const a = 2;\n' });
    const script = scenarioScript({ mapper: () => ({ cohorts: [], standalone: ['src/a.ts'] }), seams: () => none });
    const { doc, calls } = await review({ s, exec: fakeGh({ baseSha: s.baseSha, headSha: head }), script });
    expect(doc.stageErrors).toEqual([]);
    expect(doc.range).toEqual({ baseSha: expect.stringMatching(/^[0-9a-f]{40}$/), headSha: head, kind: 'sync-merge' });
    expect(doc.range.baseSha).not.toBe(s.baseSha);
    expect(doc.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(doc.verdict.label).not.toBe('incomplete');
    expect(doc.mergeReview).toBe('by-hand');

    const roles = calls.map((c) => c.role);
    expect(roles).toContain('brief');
    expect(roles.filter((r) => r.startsWith('lens:')).length).toBeGreaterThan(0);
    // The sentence is fixed text: neither branch name is in it.
    const MERGE_NOTE = mergeNote('pull request');
    expect(MERGE_NOTE).not.toMatch(/\bmain\b|\bfeature\b/);
    const names = mergeNoteBlock('main', 'feature');
    expect(block(names, 'merge')).toBe('Merged in: main\nInto: feature');
    for (const c of calls) {
      expect(c.instructions.split(MERGE_NOTE)).toHaveLength(2);
      expect(c.instructions.endsWith(MERGE_NOTE)).toBe(true);
      if (c.instructions.includes(PROMPT_BOUNDARY)) expect(c.instructions.indexOf(PROMPT_BOUNDARY)).toBeLessThan(c.instructions.indexOf(MERGE_NOTE));
      expect(c.material.split(names)).toHaveLength(2);
      expect(c.instructions).not.toContain('Merged in: main');
    }
  }, SLOW);

  it('two merges in the range, and an octopus merge, stay incomplete with the reason', async () => {
    const UNREVIEWED = 'This pull request only merges another branch in. Airlock did not review it: 1 changed file was not looked at.';
    const twice = await mergedIn({ 'src/a.ts': 'export const a = 2;\n' });
    await twice.s.remote.git('checkout', 'main');
    await commitFiles(twice.s.remote, { 'NOTES.md': 'main moved on again\n' }, 'main advances again');
    await twice.s.remote.git('checkout', 'feature');
    await twice.s.remote.git('merge', '--no-ff', '-m', 'Merge main into feature again', 'main');
    const head = await twice.s.remote.git('rev-parse', 'HEAD');
    const two = await review({ s: twice.s, exec: fakeGh({ baseSha: twice.s.baseSha, headSha: head }) });
    expect(two.calls).toEqual([]);
    expect(two.doc.range.kind).toBe('sync-merge');
    expect(two.doc.mergeReview).toBe('not-reviewed');
    expect(two.doc.verdict.label).toBe('incomplete');
    expect(two.doc.stageErrors).toEqual([{
      stage: 'shape', cohortId: null,
      message: `${UNREVIEWED} It has 2 merge commits, and Airlock reviews what was changed by hand only in a single merge.`,
    }]);

    // In the same remote (the mirror is per repository): main gains x and, through a merge, y; a branch from main's earlier
    // tip joins it, x and y in one octopus merge with a change by hand. The range is given, from main's new tip.
    const { s } = twice;
    await s.remote.git('checkout', 'main');
    const before = await s.remote.git('rev-parse', 'HEAD');
    const x = await commitFiles(s.remote, { 'x.md': 'x\n' }, 'x');
    await s.remote.git('checkout', '-b', 'side', before);
    const y = await commitFiles(s.remote, { 'y.md': 'y\n' }, 'y');
    await s.remote.git('checkout', 'main');
    await s.remote.git('merge', '--no-ff', '-m', 'Merge side', 'side');
    const mainTip = await s.remote.git('rev-parse', 'HEAD');
    await s.remote.git('checkout', '-b', 'octopus', before);
    await s.remote.git('merge', '--no-ff', '--no-commit', x, y);
    await s.remote.write('src/a.ts', 'export const a = 3;\n');
    await s.remote.git('add', '--all');
    await s.remote.git('commit', '--no-edit', '-m', 'Octopus');
    const octopus = await s.remote.git('rev-parse', 'HEAD');
    const octo = await review({ s, req: { explicit: { baseSha: mainTip, headSha: octopus } }, exec: fakeGh({ baseSha: mainTip, headSha: octopus }) });
    expect(octo.calls).toEqual([]);
    expect(octo.doc.mergeReview).toBe('not-reviewed');
    expect(octo.doc.verdict.label).toBe('incomplete');
    expect(octo.doc.stageErrors).toEqual([{
      stage: 'shape', cohortId: null,
      message: `${UNREVIEWED} Its merge commit joins 3 branches, and Airlock reviews what was changed by hand only in a merge of two.`,
    }]);
  }, SLOW);

  it('a re-review whose push is one merge of the base reviews its resolutions and carries the earlier findings', async () => {
    const first = await review();
    const { s } = first;
    expect(first.doc.findings.map((f) => f.title).sort()).toEqual([GOOD.title, RULED.title].sort());
    // main changes the line next to the one feature added, so the merge conflicts and is resolved by hand.
    await s.remote.git('checkout', 'main');
    await commitFiles(s.remote, {
      'src/money.ts': 'export function formatMoney(n: number, digits = 2): string {\n  return n.toFixed(2);\n}\n',
      'README.md': 'main moved on\n',
    }, 'main advances');
    await s.remote.git('checkout', 'feature');
    await s.remote.git('merge', '--no-commit', 'main').catch(() => undefined);
    expect(await s.remote.git('diff', '--name-only', '--diff-filter=U')).toBe('src/money.ts');
    await s.remote.write('src/money.ts', 'export function formatMoney(n: number, digits = 2): string {\n  // TODO round half up\n  return n.toFixed(2);\n}\n');
    await s.remote.git('add', '--all');
    await s.remote.git('commit', '--no-edit', '-m', 'Merge main into feature');
    const head = await s.remote.git('rev-parse', 'HEAD');

    const script = scenarioScript({
      mapper: () => ({ cohorts: [], standalone: ['src/money.ts'] }),
      'lens:': () => none, 'sweep:': () => none, seams: () => none,
      'challenge:fixed:': () => { throw new Error('no fixed check was expected'); },
    });
    const { doc, calls } = await review({ s, req: { since: { reviewId: first.doc.id } }, exec: fakeGh({ baseSha: s.baseSha, headSha: head }), script });
    expect(doc.stageErrors).toEqual([]);
    expect(doc.range).toEqual({ baseSha: expect.stringMatching(/^[0-9a-f]{40}$/), headSha: head, kind: 'sync-merge' });
    expect(doc.mergeReview).toBe('by-hand');
    // The mechanical merge was made in Airlock's own mirror, on the earlier head, and never in the remote.
    const mirror = join(home(), 'repos', 'acme__app.git');
    const parents = await realExec('git', ['--git-dir', mirror, 'rev-list', '--parents', '-n', '1', doc.range.baseSha]);
    expect(parents.stdout.trim()).toBe(`${doc.range.baseSha} ${s.headSha}`);
    expect((await realExec('git', ['cat-file', '-e', doc.range.baseSha], { cwd: s.remote.dir })).code).not.toBe(0);
    expect(doc.files.map((f) => f.path)).toEqual(['src/money.ts']);
    expect(doc.previous).toEqual({ reviewId: first.doc.id, headSha: s.headSha, covered: 'merge' });
    expect(doc.notes).toContain('The push since the last review only merges the base branch main in, so only what was changed by hand in that merge was reviewed.');
    expect(Object.fromEntries(doc.findings.map((f) => [f.title, f.status]))).toEqual({
      [GOOD.title as string]: 'still-open', [RULED.title as string]: 'still-open',
    });
    expect(doc.fixed).toEqual([]);
    const lensCalls = calls.filter((c) => c.role.startsWith('lens:'));
    expect(lensCalls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.instructions.endsWith(mergeNote('push'))).toBe(true);
    expect(mergeNote('push')).toMatch(/the merge pushed since the last review/);
  }, SLOW);

  const SETTLED = 'Git reported conflicts in this merge that it settled without markers (a file one side deleted and the other changed, or a binary file):';
  
  /**
   * A remote whose `feature` and `main` change `featureFiles` and `mainFiles` from `base`; a `joined` branch already holds
   * both tips, and feature merges main with `resolved` written by hand. The given range joined..merge holds only the merge.
   */
  async function joinedMerge(
    base: Record<string, string>, featureFiles: Record<string, string | null>, mainFiles: Record<string, string | null>,
    resolved: Record<string, string>,
  ) {
    const s = await scenario(base, {});
    const feature = await commitFiles(s.remote, featureFiles, 'feature');
    await s.remote.git('checkout', 'main');
    await commitFiles(s.remote, mainFiles, 'main');
    await s.remote.git('checkout', '-b', 'joined');
    await s.remote.git('merge', '--no-ff', '-s', 'ours', '-m', 'join', feature);
    const joined = await s.remote.git('rev-parse', 'HEAD');
    await s.remote.git('checkout', 'feature');
    await s.remote.git('merge', '--no-ff', '--no-commit', 'main').catch(() => undefined);
    for (const [path, text] of Object.entries(resolved)) await s.remote.write(path, text);
    await s.remote.git('add', '--all');
    await s.remote.git('commit', '--no-edit', '-m', 'Merge main into feature');
    return { s, joined, merge: await s.remote.git('rev-parse', 'HEAD') };
  }
  const SETTLED_BASE = { 'src/a.ts': 'export const a = 1;\n', 'src/f.ts': 'export const f = 1;\n', 'img.png': 'x\0root' };
  const given = (joined: string, merge: string) => ({ explicit: { baseSha: joined, headSha: merge } });

  it('conflicts git settled without markers, kept as git left them, are incomplete with both paths named and no request', async () => {
    const { s, joined, merge } = await joinedMerge(
      SETTLED_BASE, { 'src/f.ts': 'export const f = 2;\n', 'img.png': 'x\0feat' }, { 'src/f.ts': null, 'img.png': 'x\0main' }, {},
    );
    const { doc, calls } = await review({ s, req: given(joined, merge), exec: fakeGh({ baseSha: joined, headSha: merge }) });
    expect(calls).toEqual([]);
    // Every conflict settled without markers: a merge Airlock could not review.
    expect(doc.mergeReview).toBe('not-reviewed');
    expect(doc.verdict.label).toBe('incomplete');
    expect(doc.stageErrors).toEqual([{
      stage: 'shape', cohortId: null,
      message: 'This pull request only merges another branch in. Airlock did not review it: 2 changed files were not looked at. '
        + `${SETTLED} img.png, src/f.ts. Airlock cannot show what was decided for them.`,
    }]);
    expect(doc.brief.whatItDoes.join(' ')).not.toMatch(/without conflicts/);
  }, SLOW);

  it('a marker conflict resolved by hand is reviewed and a kept modify/delete is named; a given range names no branch', async () => {
    const { s, joined, merge } = await joinedMerge(
      SETTLED_BASE,
      { 'src/a.ts': 'export const a = 2;\n', 'src/f.ts': 'export const f = 2;\n', 'img.png': 'x\0feat' },
      { 'src/a.ts': 'export const a = 3;\n', 'src/f.ts': null, 'img.png': 'x\0main' },
      { 'src/a.ts': 'export const a = 4;\n' },
    );
    const script = scenarioScript({ mapper: () => ({ cohorts: [], standalone: ['src/a.ts'] }), seams: () => none });
    const { doc, calls } = await review({ s, req: given(joined, merge), exec: fakeGh({ baseSha: joined, headSha: merge }), script });
    expect(doc.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(calls.filter((c) => c.role.startsWith('lens:')).length).toBeGreaterThan(0);
    expect(doc.stageErrors).toEqual([{
      stage: 'shape', cohortId: null, message: `${SETTLED} img.png, src/f.ts. Airlock cannot show what was decided for them.`,
    }]);
    expect(doc.verdict.label).toBe('incomplete');
    // A given range: the sentence names no branch and there is no branch block; the pull request keeps the given base.
    expect(mergeNote('given range')).toMatch(/the two sides of the merge/);
    for (const c of calls) {
      expect(c.instructions.endsWith(mergeNote('given range'))).toBe(true);
      expect(c.material).not.toContain('<material label="merge"');
    }
    expect(doc.pr.baseSha).toBe(joined);
    expect(doc.pr.headSha).toBe(merge);
    expect(doc.range.baseSha).not.toBe(joined);
  }, SLOW);

  it('a given range of a merge named by a shortened id is refused with a sentence that a full id is needed', async () => {
    const { s, head } = await mergedIn({ 'src/a.ts': 'export const a = 2;\n' });
    const mainTip = await s.remote.git('rev-parse', 'main');
    const short = mainTip.slice(0, 12);
    const { doc, calls } = await review({ s, req: given(short, head), exec: fakeGh({ baseSha: mainTip, headSha: head }) });
    expect(calls).toEqual([]);
    expect(doc.verdict.label).toBe('incomplete');
    expect(doc.stageErrors).toEqual([{
      stage: 'shape', cohortId: null,
      message: 'This pull request only merges another branch in. Airlock did not review it: 1 changed file was not looked at. '
        + `The given range names the commit "${short}" by a shortened id, and a full commit id (40 or 64 hexadecimal characters) is needed to review what was changed by hand in a merge.`,
    }]);
  }, SLOW);

  it('a re-review whose push is a clean merge of the base says "This push"', async () => {
    const first = await review();
    const { s } = first;
    await s.remote.git('checkout', 'main');
    await commitFiles(s.remote, { 'README.md': 'main moved on\n' }, 'main advances');
    await s.remote.git('checkout', 'feature');
    await s.remote.git('merge', '--no-ff', '--no-edit', 'main');
    const head = await s.remote.git('rev-parse', 'HEAD');
    const script = scenarioScript({ 'challenge:fixed:': () => { throw new Error('no fixed check was expected'); } });
    const { doc } = await review({ s, req: { since: { reviewId: first.doc.id } }, exec: fakeGh({ baseSha: s.baseSha, headSha: head }), script });
    expect(doc.brief.whatItDoes).toEqual([
      'This push only merges main into the branch. Git merged it without conflicts and nothing was changed by hand.',
    ]);
    expect(doc.stageErrors).toEqual([]);
    expect(doc.mergeReview).toBe('nothing-by-hand');
    expect(doc.previous).toEqual({ reviewId: first.doc.id, headSha: s.headSha, covered: 'merge' });
    // Nothing was changed by hand, so no note says that what was changed by hand was reviewed.
    expect(doc.notes ?? []).not.toContainEqual(expect.stringMatching(/by hand/));
    expect(renderReview(doc).split('\n')[2])
      .toBe('The push only merged another branch in; git merged it without conflicts and nothing was changed by hand.');
  }, SLOW);

  it('a re-review whose push is a merge of the base Airlock could not review says it only merges the base, never that it was reviewed', async () => {
    const first = await review();
    const { s } = first;
    // main deletes the file the pull request changed; the merge keeps the pull request's file as git left it, with no markers.
    await s.remote.git('checkout', 'main');
    await commitFiles(s.remote, { 'src/money.ts': null, 'README.md': 'main moved on\n' }, 'main deletes money.ts');
    await s.remote.git('checkout', 'feature');
    await s.remote.git('merge', '--no-commit', 'main').catch(() => undefined);
    await s.remote.git('add', '--all');
    await s.remote.git('commit', '--no-edit', '-m', 'Merge main into feature');
    const head = await s.remote.git('rev-parse', 'HEAD');
    const script = scenarioScript({ 'challenge:fixed:': () => { throw new Error('no fixed check was expected'); } });
    const { doc } = await review({ s, req: { since: { reviewId: first.doc.id } }, exec: fakeGh({ baseSha: s.baseSha, headSha: head }), script });
    expect(doc.mergeReview).toBe('not-reviewed');
    expect(doc.previous).toEqual({ reviewId: first.doc.id, headSha: s.headSha, covered: 'merge' });
    expect(doc.stageErrors.map((e) => e.stage)).toContain('shape');
    expect(doc.notes).toContain('The push since the last review only merges the base branch main in.');
    expect(doc.notes ?? []).not.toContainEqual(expect.stringMatching(/by hand/));
    // No line of its own under the header: the stage error says what happened.
    expect(renderReview(doc).split('\n')[2]).toBe('');
  }, SLOW);

  it('a pull request that is only a merge, reviewed again in full, tells every request the pull request\'s scope, not the push\'s', async () => {
    const { s, head: merged } = await mergedIn({ 'src/a.ts': 'export const a = 2;\n' });
    const script = scenarioScript({ mapper: () => ({ cohorts: [], standalone: ['src/a.ts'] }), seams: () => none });
    const first = await review({ s, exec: fakeGh({ baseSha: s.baseSha, headSha: merged }), script });
    expect(first.doc.mergeReview).toBe('by-hand');
    // The branch is rewritten: the merge is made again with another change by hand.
    await s.remote.git('reset', '--hard', s.baseSha);
    await s.remote.git('merge', '--no-ff', '--no-commit', 'main');
    await s.remote.write('src/a.ts', 'export const a = 3;\n');
    await s.remote.git('add', '--all');
    await s.remote.git('commit', '--no-edit', '-m', 'Merge main into feature again');
    const head = await s.remote.git('rev-parse', 'HEAD');
    const { doc, calls } = await review({
      s, req: { since: { reviewId: first.doc.id } }, exec: fakeGh({ baseSha: s.baseSha, headSha: head }), script,
    });
    expect(doc.range.kind).toBe('sync-merge');
    expect(doc.mergeReview).toBe('by-hand');
    expect(doc.notes).toContainEqual(expect.stringMatching(/the whole pull request was reviewed again\.$/));
    expect(doc.previous).toEqual({ reviewId: first.doc.id, headSha: merged, covered: 'everything' });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.instructions.endsWith(mergeNote('pull request'))).toBe(true);
    // No merge line: reviewed again in full, and the note under Notes says why.
    expect(renderReview(doc).split('\n')[2]).toBe(`Reviewed again in full since ${merged.slice(0, 7)}`);
  }, SLOW);

  it('a rule file with conflict markers on the base side is not used as rules, and the limits say so', async () => {
    const { s, joined, merge } = await joinedMerge(
      { 'src/a.ts': 'export const a = 1;\n', 'CLAUDE.md': 'Rules RULES_ROOT\n' },
      { 'src/a.ts': 'export const a = 2;\n', 'CLAUDE.md': 'Rules RULES_FEATURE\n' },
      { 'CLAUDE.md': 'Rules RULES_MAIN\n' },
      { 'CLAUDE.md': 'Rules RULES_BOTH\n' },
    );
    const script = scenarioScript({ mapper: () => ({ cohorts: [], standalone: ['src/a.ts', 'CLAUDE.md'] }), seams: () => none });
    const { doc, calls } = await review({ s, req: given(joined, merge), exec: fakeGh({ baseSha: joined, headSha: merge }), script });
    expect(doc.range.kind).toBe('sync-merge');
    expect(doc.limits).toContain('CLAUDE.md has merge conflict markers on the base side and was not used as rules.');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.material).not.toContain('<material label="repository rule file CLAUDE.md"');
  }, SLOW);
});
