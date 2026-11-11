import type { ChangeMap } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import { createFakeRunner } from '../../src/agent/fake-runner.js';
import { runCohortLenses } from '../../src/lenses/cohort-lens.js';
import { applyHoldout } from '../../src/packs/holdout.js';
import {
  block, cohort, ctx, diff, labels, layer, lens, pack, pr, rawCandidate, tier, twoCohorts,
} from '../helpers/lens-context.js';

const empty = () => ({ candidates: [], questions: [] });
const diffLines = (material: string): string[] => block(material, 'diff')!.split('\n');

describe('runCohortLenses', () => {
  it('makes one request per cohort per lens', async () => {
    const runner = createFakeRunner(empty);
    const packs = [pack('core', [lens('boundary'), lens('money')]), pack('extra', [lens('jobs')])];
    const r = await runCohortLenses(runner, ctx({ packs }));
    expect(runner.calls.map((c) => c.role)).toEqual([
      'lens:core/boundary', 'lens:core/money', 'lens:extra/jobs',
      'lens:core/boundary', 'lens:core/money', 'lens:extra/jobs',
    ]);
    expect(runner.calls.map((c) => block(c.material, 'cohort')!.split('\n')[0])).toEqual([
      ...Array(3).fill('Cohort: Pausing a plan'), ...Array(3).fill('Cohort: Invoice totals'),
    ]);
    expect(r.usage).toHaveLength(6);
    expect(r.errors).toEqual([]);
  });

  it('sends each request with its directories, model and effort, through the parallel cap', async () => {
    const runner = createFakeRunner(empty);
    let wrapped = 0;
    await runCohortLenses(runner, ctx({ run: (fn) => { wrapped++; return fn(); } }));
    expect(wrapped).toBe(2);
    expect(runner.calls[0]).toMatchObject({
      role: 'lens:core/boundary', cwd: '/tmp/head', extraDirs: ['/tmp/base'], model: 'claude-opus-5-5', effort: 'high',
    });
  });

  it('skips a cohort made only of test files', async () => {
    const map: ChangeMap = {
      ...twoCohorts,
      cohorts: [...twoCohorts.cohorts, cohort('k3', 'Only tests', [layer('k3.l1', 'tests', ['test/a.test.ts', 'test/b.test.ts'])])],
    };
    const files = [...ctx().files, diff('test/a.test.ts'), diff('test/b.test.ts')];
    const tiers = [...ctx().tiers, tier('test/a.test.ts', 'trust'), tier('test/b.test.ts', 'ignored')];
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ map, files, tiers }));
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls.some((c) => c.material.includes('Only tests'))).toBe(false);
  });

  it('reviews the standalone group as a cohort when it has files to read', async () => {
    const map: ChangeMap = { ...twoCohorts, standalone: ['README.md', 'test/x.test.ts'] };
    const files = [...ctx().files, diff('README.md'), diff('test/x.test.ts')];
    const tiers = [...ctx().tiers, tier('README.md', 'skim'), tier('test/x.test.ts', 'trust')];
    const runner = createFakeRunner((req) => (req.material.includes('Standalone changes')
      ? { candidates: [rawCandidate({ path: 'README.md' })], questions: ['Is the link right?'] } : empty()));
    const r = await runCohortLenses(runner, ctx({ map, files, tiers }));
    expect(runner.calls).toHaveLength(3);
    const standalone = runner.calls[2]!.material;
    expect(block(standalone, 'cohort')).toMatch(/^Cohort: Standalone changes/);
    expect(block(standalone, 'diff')).toContain('## File: README.md');
    expect(block(standalone, 'trusted files')).toContain('test/x.test.ts');
    expect(r.candidates.map((c) => c.cohortId)).toEqual(['standalone']);
    expect(r.questions).toEqual([{ text: 'Is the link right?', cohortId: 'standalone', source: { pack: 'core', lens: 'boundary', ruleId: null } }]);
  });

  it('skips the standalone group when all of its files are trusted or ignored', async () => {
    const map: ChangeMap = { ...twoCohorts, standalone: ['test/x.test.ts'] };
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ map, files: [...ctx().files, diff('test/x.test.ts')], tiers: [...ctx().tiers, tier('test/x.test.ts', 'trust')] }));
    expect(runner.calls).toHaveLength(2);
  });

  it('a request contains the cohort layers in order and the neighbour roles', async () => {
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx());
    const material = runner.calls[0]!.material;
    const outline = block(material, 'cohort')!;
    expect(outline).toContain('Summary of Pausing a plan.');
    const at = (s: string) => outline.indexOf(s);
    expect(at('Layer k1.l1 (data)')).toBeGreaterThan(-1);
    expect(at('Layer k1.l1 (data)')).toBeLessThan(at('Layer k1.l2 (writes)'));
    expect(at('Layer k1.l2 (writes)')).toBeLessThan(at('Layer k1.l3 (tests)'));
    expect(outline).toMatch(/Layer k1\.l2 \(writes\)[^\n]*depends on k1\.l1/);
    expect(outline).toContain('The 60-day limit is set here.');
    expect(outline).toContain('src/pause.ts');
    const neighbours = block(material, 'neighbours')!;
    expect(neighbours).toContain('src/jobs/expire.ts [sibling] for: src/pause.ts — The existing job to match.');
    expect(neighbours).toContain('src/charge.ts [caller]');
    expect(block(runner.calls[1]!.material, 'neighbours')).toBe('(none)');
  });

  it('orders the material: pull request, brief, cohort, diff, trusted files, neighbours, facts, rule files', async () => {
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ repoRules: [{ path: 'CLAUDE.md', text: 'Use the money helper.' }, { path: 'src/AGENTS.md', text: 'No raw SQL.' }] }));
    expect(labels(runner.calls[0]!.material)).toEqual([
      'pull request', 'brief', 'cohort', 'diff', 'trusted files', 'neighbours', 'facts',
      'repository rule file CLAUDE.md', 'repository rule file src/AGENTS.md',
    ]);
    const briefText = block(runner.calls[0]!.material, 'brief')!;
    expect(briefText).toContain('Members can pause their plan from the account page.');
    expect(briefText).toContain('[not-supported] Pauses are limited to 60 days');
  });

  it('a request lists trust files by path and never includes their diff', async () => {
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx());
    const material = runner.calls[0]!.material;
    expect(block(material, 'trusted files')).toBe('test/pause.test.ts');
    expect(material).not.toContain('test/pause.test.ts line');
    expect(material).not.toContain('## File: test/pause.test.ts');
    expect(block(material, 'diff')).toContain('src/pause.ts line 3');
    expect(block(material, 'diff')!.indexOf('## File: db/0042.sql')).toBeLessThan(block(material, 'diff')!.indexOf('## File: src/pause.ts'));
  });

  it('caps the diff text at 1,500 lines and says how many lines were left out', async () => {
    const map: ChangeMap = { cohorts: [cohort('k1', 'Big', [layer('k1.l1', 'other', ['src/big.ts'])])], standalone: [], links: [] };
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ map, files: [diff('src/big.ts', 3_000)], tiers: [tier('src/big.ts')] }));
    const lines = diffLines(runner.calls[0]!.material);
    expect(lines).toHaveLength(1_500);
    expect(lines.at(-1)).toBe('… 1503 more changed lines not shown; read the file');
  });

  it('the diff budget cuts the largest file first and keeps the smallest whole', async () => {
    const map: ChangeMap = {
      cohorts: [cohort('k1', 'Mixed', [layer('k1.l1', 'data', ['src/small.ts']), layer('k1.l2', 'writes', ['src/big.ts', 'src/mid.ts'])])],
      standalone: [], links: [],
    };
    const files = [diff('src/big.ts', 2_000), diff('src/mid.ts', 600), diff('src/small.ts', 50)];
    const tiers = [tier('src/big.ts'), tier('src/mid.ts', 'skim'), tier('src/small.ts')];
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ map, files, tiers }));
    const text = block(runner.calls[0]!.material, 'diff')!;
    expect(text.split('\n')).toHaveLength(1_500);
    expect(text.indexOf('## File: src/small.ts')).toBeLessThan(text.indexOf('## File: src/big.ts'));
    expect(text.indexOf('## File: src/big.ts')).toBeLessThan(text.indexOf('## File: src/mid.ts'));
    expect(text).toContain('src/small.ts line 50');
    expect(text).toContain('src/mid.ts line 600');
    expect(text).toContain('src/big.ts line 843');
    expect(text).not.toContain('src/big.ts line 844');
    expect(text).toContain('… 1157 more changed lines not shown; read the file');
    expect(text.match(/more changed lines not shown/g)).toHaveLength(1);
  });

  it('cuts many large files to the same allowance and never below 40 lines when the budget allows', async () => {
    const paths = Array.from({ length: 30 }, (_, i) => `src/f${String(i).padStart(2, '0')}.ts`);
    const map: ChangeMap = { cohorts: [cohort('k1', 'Many', [layer('k1.l1', 'other', paths)])], standalone: [], links: [] };
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ map, files: paths.map((p) => diff(p, 100)), tiers: paths.map((p) => tier(p)) }));
    const text = block(runner.calls[0]!.material, 'diff')!;
    expect(text.split('\n').length).toBeLessThanOrEqual(1_500);
    for (const p of paths) expect(text).toContain(`${p} line 40`);
  });

  it('lists deleted and binary files with their marker on one line', async () => {
    const map: ChangeMap = { cohorts: [cohort('k1', 'Assets', [layer('k1.l1', 'other', ['src/gone.ts', 'img/logo.png', 'src/a.ts'])])], standalone: [], links: [] };
    const files = [diff('src/gone.ts', 0, { status: 'deleted', hunks: [{ ...diff('x', 5).hunks[0]!, lines: [{ kind: 'del', oldNo: 1, newNo: null, text: 'old code' }] }] }),
      diff('img/logo.png', 0, { binary: true }), diff('src/a.ts', 2)];
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ map, files, tiers: files.map((f) => tier(f.path)) }));
    expect(diffLines(runner.calls[0]!.material)).toEqual([
      '## File: src/gone.ts (deleted)',
      '## File: img/logo.png (binary, not shown)',
      '## File: src/a.ts', '@@ -0,0 +1,2 @@', '    1 + src/a.ts line 1', '    2 + src/a.ts line 2',
    ]);
  });

  it('held-out standards are absent from the request', async () => {
    const full = pack('core', [lens('boundary')], {
      standards: [{ name: 'Conventions', dated: true, text: 'Intro.\n\n2026-10-01 · Old rule kept\n\n2026-11-05 · HELD_OUT_RULE from the pull request\n' }],
      learned: [
        { date: '2026-10-02', repo: 'acme/web', kind: 'wrong', text: 'Old wrong entry' },
        { date: '2026-11-06', repo: 'acme/web', kind: 'wrong', text: 'HELD_OUT_LEARNED entry' },
      ],
    });
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ packs: [applyHoldout(full, { pr: 1, reviewedAt: '2026-11-01' })] }));
    const { instructions, material } = runner.calls[0]!;
    expect(instructions).toContain('Old rule kept');
    expect(instructions).toContain('Old wrong entry');
    expect(instructions + material).not.toContain('HELD_OUT_RULE');
    expect(instructions + material).not.toContain('HELD_OUT_LEARNED');
  });

  it('puts the standards and learned entries in the instructions and not in the material', async () => {
    const packs = [
      pack('core', [lens('boundary', { instructions: 'LENS_TEXT follow the money.' })], {
        standards: [{ name: 'Conventions', dated: false, text: 'STANDARD_CORE text' }],
        learned: [
          { date: '2026-10-02', repo: 'acme/web', kind: 'wrong', text: 'LEARNED_WRONG entry' },
          { date: '2026-10-03', repo: 'acme/web', kind: 'intended', text: 'LEARNED_FACT entry' },
        ],
      }),
      pack('generic', [], { standards: [{ name: 'Basics', dated: false, text: 'STANDARD_GENERIC text' }] }),
    ];
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ packs, missingHelpers: ['formatMoneyCents'] }));
    const { instructions, material } = runner.calls[0]!;
    for (const marker of ['STANDARD_CORE', 'STANDARD_GENERIC', 'LEARNED_WRONG', 'LEARNED_FACT', 'LENS_TEXT', 'formatMoneyCents']) {
      expect(instructions).toContain(marker);
      expect(material).not.toContain(marker);
    }
    expect(instructions).toContain('Lens boundary');
    expect(instructions).toMatch(/^#+ .*Pack core.*Conventions/m);
    expect(instructions).toMatch(/^#+ .*Pack generic.*Basics/m);
    expect(instructions).toMatch(/Things flagged before that were wrong\n+- LEARNED_WRONG entry/);
    expect(instructions).toMatch(/Product facts to respect\n+- LEARNED_FACT entry/);
  });

  it('leaves out the learned lists and the helper list when they are empty', async () => {
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx());
    const { instructions } = runner.calls[0]!;
    expect(instructions).not.toContain('Things flagged before that were wrong');
    expect(instructions).not.toContain('Product facts to respect');
    expect(instructions).not.toMatch(/^#+ Helpers that no longer exist/m);
  });

  it('puts the pull request description and the repository rule files in the material and not in the instructions', async () => {
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ repoRules: [{ path: 'CLAUDE.md', text: 'REPO_RULE_MARKER always use cents' }] }));
    const { instructions, material } = runner.calls[0]!;
    expect(block(material, 'pull request')).toContain('PR_BODY_MARKER');
    expect(block(material, 'repository rule file CLAUDE.md')).toBe('REPO_RULE_MARKER always use cents');
    expect(instructions).not.toContain('PR_BODY_MARKER');
    expect(instructions).not.toContain('REPO_RULE_MARKER');
  });

  it('passes the facts for the cohort files only', async () => {
    const facts = [
      { checkId: 'no-raw-sql', path: 'src/pause.ts', line: 4, message: 'Raw SQL in an action' },
      { checkId: 'no-console', path: 'src/totals.ts', line: null, message: 'console.log left in' },
    ];
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ facts }));
    expect(block(runner.calls[0]!.material, 'facts')).toBe('src/pause.ts:4 no-raw-sql: Raw SQL in an action');
    expect(block(runner.calls[1]!.material, 'facts')).toBe('src/totals.ts no-console: console.log left in');
  });

  it('runs an onlyWhenAlone lens when its pack is the only one with lenses', async () => {
    const packs = [pack('generic', [lens('combined', { onlyWhenAlone: true }), lens('basic')]), pack('empty', [])];
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ packs }));
    expect(runner.calls.map((c) => c.role)).toEqual([
      'lens:generic/combined', 'lens:generic/basic', 'lens:generic/combined', 'lens:generic/basic',
    ]);
  });

  it('skips an onlyWhenAlone lens when another pack has lenses', async () => {
    const packs = [pack('core', [lens('boundary')]), pack('generic', [lens('combined', { onlyWhenAlone: true }), lens('basic')])];
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ packs }));
    expect(runner.calls.map((c) => c.role)).toEqual([
      'lens:core/boundary', 'lens:generic/basic', 'lens:core/boundary', 'lens:generic/basic',
    ]);
  });

  it('a failed lens becomes a stage error naming the cohort and the lens', async () => {
    const packs = [pack('core', [lens('boundary'), lens('money')])];
    const runner = createFakeRunner((req) => (req.role === 'lens:core/money' && req.material.includes('Invoice totals')
      ? new Error('model timed out') : { candidates: [rawCandidate()], questions: [] }));
    const r = await runCohortLenses(runner, ctx({ packs }));
    expect(r.errors).toEqual([{ stage: 'lenses', cohortId: 'k2', message: 'core/money: model timed out' }]);
    expect(r.candidates).toHaveLength(3);
    expect(r.usage).toHaveLength(4);
  });

  it('labels candidates with their pack, lens and cohort and gives every one a unique id', async () => {
    const packs = [pack('core', [lens('boundary'), lens('money')])];
    const runner = createFakeRunner(() => ({ candidates: Array.from({ length: 5 }, (_, i) => rawCandidate({ title: `F${i}` })), questions: [] }));
    const r = await runCohortLenses(runner, ctx({ packs }));
    expect(r.candidates).toHaveLength(20);
    expect(new Set(r.candidates.map((c) => c.id)).size).toBe(20);
    expect(r.candidates[0]).toMatchObject({ cohortId: 'k1', source: { pack: 'core', lens: 'boundary', ruleId: null } });
    expect(r.candidates[19]).toMatchObject({ cohortId: 'k2', source: { pack: 'core', lens: 'money', ruleId: null } });
  });

  it('collects questions, invalid candidates as questions and dropped extras', async () => {
    const runner = createFakeRunner((req) => (req.material.includes('Pausing a plan')
      ? { candidates: [...Array.from({ length: 7 }, (_, i) => rawCandidate({ title: `F${i}` })), { title: 'No quote here' }], questions: ['  ', 'Is 60 days right?'] }
      : empty()));
    const r = await runCohortLenses(runner, ctx());
    expect(r.candidates).toHaveLength(6);
    expect(r.dropped.map((d) => d.candidate.title)).toEqual(['F6']);
    expect(r.questions.map((q) => q.text)).toEqual(['Is 60 days right?', 'No quote here']);
    expect(r.questions.every((q) => q.cohortId === 'k1')).toBe(true);
  });

  it('calls onDone once per request', async () => {
    const packs = [pack('core', [lens('boundary')]), pack('extra', [lens('jobs')])];
    const runner = createFakeRunner((req) => (req.role === 'lens:extra/jobs' ? new Error('no') : empty()));
    const done: string[] = [];
    await runCohortLenses(runner, ctx({ packs }), (cohortId, lensId) => done.push(`${cohortId} ${lensId}`));
    expect(done.sort()).toEqual(['k1 core/boundary', 'k1 extra/jobs', 'k2 core/boundary', 'k2 extra/jobs']);
  });

  it('finishes the stage when onDone throws', async () => {
    const runner = createFakeRunner(() => ({ candidates: [rawCandidate()], questions: [] }));
    let calls = 0;
    const r = await runCohortLenses(runner, ctx(), () => { calls++; throw new Error('listener broke'); });
    expect(calls).toBe(2);
    expect(r.candidates).toHaveLength(2);
    expect(r.errors).toEqual([]);
  });

  it('names the author as the reader on their own pull request', async () => {
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ pr: { ...pr, author: 'alice', viewer: 'alice' } }));
    const { instructions } = runner.calls[0]!;
    expect(instructions).toContain('The reader is the author, who will fix what you find before a senior reviewer sees the pull request.');
    expect(instructions).not.toContain('deciding whether to ask the author for changes');
    expect(instructions).toMatch(/Write so the reader can act/);
  });

  it('names a reviewer as the reader on someone else\'s pull request', async () => {
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ pr: { ...pr, author: 'alice', viewer: 'bob' } }));
    const { instructions } = runner.calls[0]!;
    expect(instructions).toContain('The reader is a reviewer deciding whether to ask the author for changes, who will pass on what you find in their own words.');
    expect(instructions).not.toContain('before a senior reviewer sees');
  });

  it('cuts a long description at 20,000 characters and says so', async () => {
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ pr: { ...pr, body: 'a'.repeat(20_500) } }));
    const text = block(runner.calls[0]!.material, 'pull request')!;
    expect(text).toContain('a'.repeat(20_000));
    expect(text).not.toContain('a'.repeat(20_001));
    expect(text).toContain('(description cut at 20000 characters)');
  });

  it('keeps every file title and its not-shown line when there are too many files for the budget', async () => {
    const paths = Array.from({ length: 800 }, (_, i) => `src/f${String(i).padStart(3, '0')}.ts`);
    const map: ChangeMap = { cohorts: [cohort('k1', 'Huge', [layer('k1.l1', 'other', paths)])], standalone: [], links: [] };
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx({ map, files: paths.map((p) => diff(p, 10)), tiers: paths.map((p) => tier(p)) }));
    const lines = diffLines(runner.calls[0]!.material);
    expect(lines).toHaveLength(1_600);
    paths.forEach((p, i) => {
      expect(lines[2 * i]).toBe(`## File: ${p}`);
      expect(lines[2 * i + 1]).toBe('… 10 more changed lines not shown; read the file');
    });
  });

  it('makes no request when there is nothing to read', async () => {
    const runner = createFakeRunner(empty);
    const r = await runCohortLenses(runner, ctx({ map: { cohorts: [], standalone: [], links: [] } }));
    expect(runner.calls).toEqual([]);
    expect(r).toEqual({ candidates: [], questions: [], dropped: [], errors: [], usage: [], limits: [] });
  });

  it('tells the reviewer how to work and what to return', async () => {
    const runner = createFakeRunner(empty);
    await runCohortLenses(runner, ctx());
    const { instructions } = runner.calls[0]!;
    expect(instructions).toMatch(/one connected change/);
    expect(instructions).toMatch(/at most 6/);
    expect(instructions).toMatch(/wouldBeWrongIf/);
    expect(instructions).toMatch(/base branch/);
    expect(instructions).not.toMatch(/\{\{/);
  });

  it('appends the extra sentence right after the lens instructions when one is given, and nothing otherwise', async () => {
    const extra = 'This is a second, closer pass over one layer: read every non-test file in it in full.';
    const plain = createFakeRunner(empty);
    await runCohortLenses(plain, ctx());
    const withExtra = createFakeRunner(empty);
    await runCohortLenses(withExtra, ctx({ extraInstructions: extra }));
    expect(plain.calls[0]!.instructions).not.toContain(extra);
    for (const call of withExtra.calls) {
      expect(call.instructions).toContain(`Instructions for the boundary lens.\n\n${extra}`);
    }
    expect(withExtra.calls.map((c) => c.material)).toEqual(plain.calls.map((c) => c.material));
  });

  it('says once per cohort how much of its diff the lenses were shown when the budget cut it', async () => {
    const runner = createFakeRunner(empty);
    const files = [diff('db/0042.sql'), diff('src/pause.ts', 2000), diff('test/pause.test.ts'), diff('src/totals.ts')];
    const r = await runCohortLenses(runner, ctx({ files, packs: [pack('core', [lens('a'), lens('b')])] }));
    const shown = diffLines(runner.calls[0]!.material).filter((l) => /^\s*\d* [+-] /.test(l)).length;
    expect(shown).toBeLessThan(2003);
    expect(r.limits).toEqual([`lenses: Pausing a plan: ${shown.toLocaleString('en-US')} of 2,003 changed lines were shown (1 file cut)`]);
  });

  it('records no limit when every diff fits', async () => {
    const r = await runCohortLenses(createFakeRunner(empty), ctx());
    expect(r.limits).toEqual([]);
  });
});
