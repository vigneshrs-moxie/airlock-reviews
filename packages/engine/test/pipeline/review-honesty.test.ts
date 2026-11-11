import { describe, expect, it } from 'vitest';
import type { AgentRequest } from '../../src/agent/runner.js';
import { renderReview } from '../../src/render/terminal.js';
import type { Exec } from '../../src/util/exec.js';
import { block, rawCandidate } from '../helpers/lens-context.js';
import { BASE_FILES, fakeGh, HEAD_FILES, scenarioScript, useReviewHarness } from '../helpers/review-scenario.js';

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

/** fakeGh, with the pull request's description replaced by `body`. */
function withBody(inner: Exec, body: string): Exec {
  return async (cmd, args, opts) => {
    const res = await inner(cmd, args, opts);
    if (cmd !== 'gh' || !args[1]?.startsWith('repos/') || res.code !== 0) return res;
    return { ...res, stdout: JSON.stringify({ ...JSON.parse(res.stdout), body }) };
  };
}

describe('what a model was not shown is written down', () => {
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
