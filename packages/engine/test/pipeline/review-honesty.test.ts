import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeRunner } from '../../src/agent/fake-runner.js';
import { withRetry, type AgentRequest } from '../../src/agent/runner.js';
import { runReview } from '../../src/pipeline/review.js';
import { renderReview } from '../../src/render/terminal.js';
import type { Exec } from '../../src/util/exec.js';
import { block, rawCandidate } from '../helpers/lens-context.js';
import {
  BASE_FILES, fakeGh, HEAD_FILES, KIT_DIR, NOW, PACKS_DIR, scenarioScript, useReviewHarness,
} from '../helpers/review-scenario.js';

const SLOW = 20_000;
const { scenario, review } = useReviewHarness();

const AUTH_BASE = 'export function canEdit(user: string): boolean {\n  return check(user);\n}\n';
const AUTH_HEAD = 'export function canEdit(user: string): boolean {\n  return true;\n}\n';
const PAY = 'export function pay(n: number): number {\n  return n;\n}\n';

const ALWAYS_TRUE = rawCandidate({
  severity: 'block', title: 'canEdit lets everyone edit', path: 'src/auth.ts', quote: 'return true;', lineHint: 2,
});

/** The mapper places the two source files in one cohort and anything else alone; the correctness lens flags `return true;`. */
function attributesScript() {
  return scenarioScript({
    mapper: (req: AgentRequest<unknown>) => {
      const paths = block(req.material, 'changed files')!.split('\n').map((l) => l.split(' | ')[0]!);
      const src = paths.filter((p) => p.startsWith('src/'));
      return {
        cohorts: [{
          id: 'k1', title: 'Access', summary: 'Who may edit.', neighbours: [], inferredLinks: [],
          layers: [{ id: 'l1', title: 'Rules', kind: 'rules', files: src, dependsOn: [], note: '' }],
        }],
        standalone: paths.filter((p) => !p.startsWith('src/')),
      };
    },
    'lens:': (req: AgentRequest<unknown>) => (req.role === 'lens:core/correctness' && block(req.material, 'diff')?.includes('return true;')
      ? { candidates: [ALWAYS_TRUE], questions: [] }
      : { candidates: [], questions: [] }),
  });
}

describe('a pull request cannot hide its own files', () => {
  for (const attributes of ['* -diff\n', '*.ts -diff\n']) {
    it(`a .gitattributes of "${attributes.trim()}" in the pull request does not hide the changed files`, async () => {
      const s = await scenario({ 'src/auth.ts': AUTH_BASE }, { 'src/auth.ts': AUTH_HEAD, 'src/pay.ts': PAY, '.gitattributes': attributes });
      const { doc, calls } = await review({ s, script: attributesScript() });
      const roles = calls.map((c) => c.role);
      expect(roles).toContain('mapper');
      expect(roles.filter((r) => r.startsWith('lens:')).length).toBeGreaterThan(0);
      const placed = [...doc.map.cohorts.flatMap((c) => c.layers.flatMap((l) => l.files)), ...doc.map.standalone];
      expect(placed).toEqual(expect.arrayContaining(['src/auth.ts', 'src/pay.ts']));
      expect(doc.files.filter((f) => f.tier === 'ignored')).toEqual([]);
      expect(['approve', 'ready-for-pr2']).not.toContain(doc.verdict.label);
      expect(doc.findings.map((f) => f.title)).toContain('canEdit lets everyone edit');
    }, SLOW);
  }

  it('a pull request that changes only a lock file and an image is incomplete and says what was not reviewed', async () => {
    const s = await scenario({ 'README.md': 'hello\n' }, {
      'package-lock.json': '{ "lockfileVersion": 3 }\n', 'img/logo.png': 'PNG\u0000\u0001\u0002 not text',
    });
    const { doc } = await review({ s });
    expect(doc.verdict.label).toBe('incomplete');
    expect(doc.stageErrors).toContainEqual({
      stage: 'facts', cohortId: null, message: '2 changed files were not reviewed: img/logo.png, package-lock.json',
    });
    expect(doc.selfReviewText).toContain('Airlock could not finish reviewing this pull request.');
    expect(doc.selfReviewText).not.toContain('No findings.');
    const out = renderReview(doc);
    expect(out).toContain('\nNot reviewed\n\n- img/logo.png: binary file\n- package-lock.json: lock file (built-in: **/package-lock.json)\n');
  }, SLOW);
});

describe('a file git calls binary', () => {
  const STOPPED = 'src/auth.ts looks like source code but is a binary file to git, so it was not reviewed.';

  it('makes the review incomplete when its path looks like source code', async () => {
    const s = await scenario(
      { 'src/auth.ts': AUTH_BASE, 'src/pay.ts': 'export const fee = 1;\n' },
      { 'src/auth.ts': `// build \u0000 note\n${AUTH_HEAD}`, 'src/pay.ts': 'export const fee = 2;\n' },
    );
    const { doc } = await review({ s, exec: fakeGh({ baseSha: s.baseSha, headSha: s.headSha, changedFiles: 2 }), script: attributesScript() });
    expect(doc.stageErrors).toContainEqual({ stage: 'facts', cohortId: null, message: STOPPED });
    expect(doc.verdict.label).toBe('incomplete');
    expect(doc.files).toContainEqual({ path: 'src/auth.ts', tier: 'ignored', reason: 'binary file' });
  }, SLOW);

  it('does not for an image under a skimmed folder', async () => {
    const s = await scenario(
      { 'src/pay.ts': 'export const fee = 1;\n' },
      { 'src/assets/logo.png': 'PNG\u0000\u0001\u0002 not text', 'src/pay.ts': 'export const fee = 2;\n' },
    );
    const { doc } = await review({ s, exec: fakeGh({ baseSha: s.baseSha, headSha: s.headSha, changedFiles: 2 }), script: attributesScript() });
    expect(doc.stageErrors).toEqual([]);
    expect(doc.verdict.label).not.toBe('incomplete');
    expect(renderReview(doc)).toContain('\nNot reviewed\n\n- src/assets/logo.png: binary file\n');
  }, SLOW);
});

/** fakeGh, with the pull request's description replaced by `body`. */
function withBody(inner: Exec, body: string): Exec {
  return async (cmd, args, opts) => {
    const res = await inner(cmd, args, opts);
    if (cmd !== 'gh' || !args[1]?.startsWith('repos/') || res.code !== 0) return res;
    return { ...res, stdout: JSON.stringify({ ...JSON.parse(res.stdout), body }) };
  };
}

describe('what a model was not shown is written down', () => {
  describe('an empty diff', () => {
    const EMPTY = 'GitHub lists 3 changed files for this pull request, but the diff Airlock computed is empty. Nothing was reviewed.';

    it('is never a clean review when GitHub says the pull request changes files', async () => {
      const s = await scenario(BASE_FILES, {}); // the head is the base: the diff is empty
      const { doc } = await review({ s, exec: fakeGh({ baseSha: s.baseSha, headSha: s.headSha, changedFiles: 3 }) });
      expect(doc.verdict.label).toBe('incomplete');
      expect(doc.stageErrors).toContainEqual({ stage: 'facts', cohortId: null, message: EMPTY });
      expect(doc.brief.whatItDoes.join(' ')).not.toMatch(/changes no files/);
    });

    it('keeps today\'s result when GitHub agrees that nothing changed', async () => {
      const s = await scenario(BASE_FILES, {});
      const { doc } = await review({ s, exec: fakeGh({ baseSha: s.baseSha, headSha: s.headSha, changedFiles: 0 }) });
      expect(doc.stageErrors).toEqual([]);
      expect(doc.verdict.label).not.toBe('incomplete');
    });

    it('is never checked against GitHub\'s count for an explicit range', async () => {
      const s = await scenario(BASE_FILES, {});
      const { doc } = await review({
        s, exec: fakeGh({ baseSha: s.baseSha, headSha: s.headSha, changedFiles: 3 }), req: { explicit: { baseSha: s.baseSha, headSha: s.headSha } },
      });
      expect(doc.stageErrors).toEqual([]);
    });
  });

  it('collects every limit in the document and prints them under Not shown to the reviewer', async () => {
    const longMoney = `${HEAD_FILES['src/money.ts']}${Array.from({ length: 1600 }, (_, i) => `// note ${i}`).join('\n')}\n`;
    const s = await scenario({ ...BASE_FILES, 'CLAUDE.md': 'r'.repeat(65_000) }, { ...HEAD_FILES, 'src/money.ts': longMoney });
    const exec = withBody(fakeGh({ baseSha: s.baseSha, headSha: s.headSha }), 'b'.repeat(25_000));
    const { doc } = await review({ s, exec });
    const limits = doc.limits ?? [];
    expect(limits).toEqual(expect.arrayContaining([
      'repository rule file CLAUDE.md was not shown: it would take the rule files past 64,000 bytes',
      'mapper: the description was cut at 6,000 of 25,000 characters',
      'brief: the description was cut at 6,000 of 25,000 characters',
      'lenses and the stages after them: the description was cut at 20,000 of 25,000 characters',
    ]));
    expect(limits.some((l) => /^lenses: Money: [\d,]+ of [\d,]+ changed lines were shown \(1 file cut\)$/.test(l))).toBe(true);
    expect(limits.some((l) => /^challenge: A TODO is left in formatMoney: [\d,]+ of [\d,]+ changed lines were shown \(1 file cut\)$/.test(l))).toBe(true);
    const out = renderReview(doc);
    expect(out).toContain('\nNot shown to the reviewer\n\n- repository rule file CLAUDE.md was not shown');
  }, SLOW);

  it('a review that cut nothing has no limits and no such section', async () => {
    const { doc } = await review();
    expect(doc.limits).toEqual([]);
    expect(renderReview(doc)).not.toContain('Not shown to the reviewer');
  }, SLOW);
});

describe('the request is checked before anything runs', () => {
  it.each([
    ['acme', 7, 'The repository must be written as <owner>/<name>, got "acme".'],
    ['acme/..', 7, 'The repository must be written as <owner>/<name>, got "acme/..".'],
    ['acme/app?x=1', 7, 'The repository must be written as <owner>/<name>, got "acme/app?x=1".'],
    ['../app', 7, 'The repository must be written as <owner>/<name>, got "../app".'],
    ['acme/app', 0, 'The pull request number must be a whole number of at least 1, got 0.'],
    ['acme/app', 1.5, 'The pull request number must be a whole number of at least 1, got 1.5.'],
  ])('refuses repository %s with number %s', async (repo, number, message) => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: '', stderr: '', code: 1 }; };
    const runner = createFakeRunner(() => new Error('no request expected'));
    await expect(runReview({ repo, number, packsDir: PACKS_DIR, kitDir: KIT_DIR }, { exec, runner, now: () => NOW })).rejects.toThrow(message);
    expect(calls).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it('uses the title and description given with the request in place of the fetched ones', async () => {
    const { doc, calls } = await review({ req: { prText: { title: 'Title at review', body: 'BODY_AT_REVIEW' } } });
    expect(doc.pr.title).toBe('Title at review');
    expect(doc.pr.body).toBe('BODY_AT_REVIEW');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.material, c.role).not.toContain('Refunds reuse formatMoney.');
      if (c.material.includes('<material label="pull request">')) expect(block(c.material, 'pull request'), c.role).toContain('BODY_AT_REVIEW');
    }
  }, SLOW);
});

describe('a symbolic link in the pull request', () => {
  it('keeps the tier its path gives it, and the facts say where it points', async () => {
    const s = await scenario({ 'docs/rules.md': 'rules\n', 'src/a.ts': 'export const a = 1;\n' }, {});
    await symlink('../docs/rules.md', join(s.remote.dir, 'src/rules.md'));
    await s.remote.write('src/a.ts', 'export const a = 2;\n');
    const head = await s.remote.commit('add a link');
    const { doc } = await review({ s, exec: fakeGh({ baseSha: s.baseSha, headSha: head }) });
    expect(doc.files).toContainEqual({ path: 'src/rules.md', tier: 'skim', reason: 'default' });
    expect(doc.facts).toContainEqual({
      checkId: 'symbolic-link', path: 'src/rules.md', line: null, message: 'src/rules.md is a symbolic link to ../docs/rules.md',
    });
  }, SLOW);

  it('a source file turned into a link to a mock is read by the lenses, with the fact, and listed once', async () => {
    const OPEN = 'export function canEdit(): boolean {\n  return true;\n}\n';
    const s = await scenario({ 'src/auth.ts': AUTH_BASE, 'src/mocks/auth.ts': OPEN }, {});
    await rm(join(s.remote.dir, 'src/auth.ts'));
    await symlink('mocks/auth.ts', join(s.remote.dir, 'src/auth.ts'));
    const head = await s.remote.commit('point auth at the mock');
    const LINKED = rawCandidate({
      severity: 'block', title: 'canEdit now comes from the mock', path: 'src/auth.ts', quote: 'mocks/auth.ts', lineHint: 1,
    });
    const script = scenarioScript({
      mapper: (req: AgentRequest<unknown>) => attributesScript()(req),
      'lens:': (req: AgentRequest<unknown>) => (req.role === 'lens:core/correctness'
        && block(req.material, 'facts')?.includes('src/auth.ts is a symbolic link to mocks/auth.ts')
        ? { candidates: [LINKED], questions: [] }
        : { candidates: [], questions: [] }),
    });
    const { doc, calls } = await review({ s, script, exec: fakeGh({ baseSha: s.baseSha, headSha: head, changedFiles: 1 }) });
    const lensCalls = calls.filter((c) => c.role.startsWith('lens:'));
    expect(lensCalls.length).toBeGreaterThan(0);
    for (const c of lensCalls) {
      expect(block(c.material, 'facts'), c.role).toContain('src/auth.ts is a symbolic link to mocks/auth.ts');
      expect(block(c.material, 'diff'), c.role).toContain('## File: src/auth.ts');
    }
    expect(doc.files).toEqual([{ path: 'src/auth.ts', tier: 'skim', reason: 'default' }]);
    expect(doc.findings.map((f) => f.title)).toEqual(['canEdit now comes from the mock']);
    expect(['approve', 'ready-for-pr2']).not.toContain(doc.verdict.label);
  }, SLOW);
});

describe('a combined lens request at quick depth', () => {
  it('does not lose a finding whose lens id the model wrote without its pack: the schema refuses it and the corrected answer is used', async () => {
    const s = await scenario({ 'src/auth.ts': AUTH_BASE }, { 'src/auth.ts': AUTH_HEAD });
    const answer = (lens: string) => ({ candidates: [{ ...ALWAYS_TRUE, lens }], questions: [] });
    const script = scenarioScript({
      'lens:': (req: AgentRequest<unknown>) => (block(req.material, 'problems with your previous reply') === null
        ? answer('correctness') : answer('core/correctness')),
    });
    const { doc, calls } = await review({ s, req: { depth: 'quick' }, script, wrap: (r) => withRetry(r, 1) });
    expect(calls.filter((c) => c.role === 'lens:combined')).toHaveLength(2);
    expect(doc.findings.map((f) => [f.title, f.source])).toEqual([['canEdit lets everyone edit', { pack: 'core', lens: 'correctness', ruleId: null }]]);
    expect(doc.dropped).toEqual([]);
    expect(doc.verdict.label).not.toBe('approve');
  }, SLOW);
});
