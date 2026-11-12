import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Finding } from '@airlock/shared';
import { splitInstructions } from '../../src/agent/prompt.js';
import { createFakeRunner, failure } from '../../src/agent/fake-runner.js';
import { fingerprint } from '../../src/anchor/fingerprint.js';
import { confirmFixed, FIXED_BY_CODE } from '../../src/rereview/fixed.js';
import { block, ctx, diff, lens, pack } from '../helpers/lens-context.js';
import { earlierFinding } from '../helpers/earlier-finding.js';

const HEAD_PAY = [
  'export function pay(card: string) {',
  '  if (!isValid(card)) throw new Error("invalid card");',
  '  charge(card);',
  '}',
].join('\n');
const HEAD_LOG = ['export function audit(card: string) {', '  logger.info(card);', '}'].join('\n');

let head = '';
let base = '';
beforeEach(async () => {
  head = await mkdtemp(join(tmpdir(), 'airlock-fixed-head-'));
  base = await mkdtemp(join(tmpdir(), 'airlock-fixed-base-'));
  for (const [path, text] of Object.entries({ 'src/pay.ts': HEAD_PAY, 'src/audit.ts': HEAD_LOG })) {
    await mkdir(dirname(join(head, path)), { recursive: true });
    await writeFile(join(head, path), text);
  }
});
afterEach(async () => {
  await rm(head, { recursive: true, force: true });
  await rm(base, { recursive: true, force: true });
});

const files = [diff('src/pay.ts', 0, { hunks: [] }), diff('src/audit.ts', 3)];
const checkCtx = (over = {}) => ctx({ headDir: head, baseDir: base, files, ...over });

const vanishedFix = (over: Partial<Finding> = {}): Finding => earlierFinding({
  id: 'c_fix', severity: 'fix', path: 'src/pay.ts', title: 'An invalid card is charged', quote: 'charge(card); // no check',
  cohortId: null, ...over,
});
const answer = (over: Record<string, unknown> = {}) => ({
  outcome: 'fixed', evidence: { path: 'src/pay.ts', quote: 'if (!isValid(card)) throw new Error("invalid card");' },
  explanation: 'The card is now checked before it is charged.', checked: 'Read src/pay.ts on both sides.', ...over,
});

describe('confirmFixed', () => {
  it('a vanished fix finding is fixed only when the quoted evidence is found at the head', async () => {
    const found = createFakeRunner(() => answer());
    const yes = await confirmFixed(found, checkCtx(), [vanishedFix()]);
    expect(yes.errors).toEqual([]);
    expect(yes.open).toEqual([]);
    expect(yes.fixed.map((f) => [f.id, f.status])).toEqual([['c_fix', 'fixed']]);
    expect(yes.fixed[0]!.checked).toBe('The card is now checked before it is charged. Proof: src/pay.ts:2 on the head.');

    for (const evidence of [
      { path: 'src/pay.ts', quote: 'if (!isValidCard(card)) return;' }, // not in the file
      { path: 'src/other.ts', quote: 'if (!isValid(card)) throw new Error("invalid card");' }, // not that file
      { path: 'src/pay.ts', quote: '// the card is checked by the caller now' }, // a comment proves nothing
      { path: 'src/pay.ts', quote: '}' }, // too short to prove anything
      { path: '../outside/pay.ts', quote: 'if (!isValid(card)) throw new Error("invalid card");' },
    ]) {
      const runner = createFakeRunner(() => answer({ evidence }));
      const no = await confirmFixed(runner, checkCtx(), [vanishedFix()]);
      expect(no.fixed).toEqual([]);
      expect(no.open.map((f) => [f.id, f.status, f.anchor])).toEqual([
        ['c_fix', 'still-open', { status: 'not-found', startLine: null, endLine: null, comment: null }],
      ]);
      expect(no.errors).toHaveLength(1);
      expect(no.errors[0]).toMatchObject({ stage: 'challenge', cohortId: null });
    }
  });

  it('a vanished finding the check places elsewhere becomes moved and keeps its old fingerprint as an alias', async () => {
    const earlier = vanishedFix({ aliases: ['0123456789abcdef'] });
    const runner = createFakeRunner(() => answer({
      outcome: 'still-open', evidence: { path: 'src/audit.ts', quote: 'logger.info(card);' }, explanation: 'The log moved to audit.',
    }));
    const r = await confirmFixed(runner, checkCtx(), [earlier]);
    expect(r.errors).toEqual([]);
    expect(r.fixed).toEqual([]);
    const moved = r.open[0]!;
    expect(moved).toMatchObject({ id: 'c_fix', status: 'moved', path: 'src/audit.ts', quote: '  logger.info(card);' });
    expect(moved.anchor).toEqual({ status: 'in-diff', startLine: 2, endLine: 2, comment: { line: 2, startLine: null } });
    expect(moved.fingerprint).toBe(fingerprint(moved));
    expect(moved.aliases).toEqual(['0123456789abcdef', earlier.fingerprint]);
  });

  it('a fixed answer quoting the finding\'s own earlier quote is not fixed: the code moved, and it follows the still-open path there', async () => {
    const earlier = vanishedFix({ quote: '  logger.info(card);', title: 'The card number is logged' });
    const runner = createFakeRunner(() => answer({ evidence: { path: 'src/audit.ts', quote: 'logger.info(card);' } }));
    const r = await confirmFixed(runner, checkCtx(), [earlier]);
    expect(r.fixed).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.open.map((f) => [f.status, f.path, f.anchor.startLine])).toEqual([['moved', 'src/audit.ts', 2]]);
    expect(r.open[0]!.aliases).toContain(earlier.fingerprint);
  });

  it('a failed check leaves the finding open, adds a stage error and never marks it fixed', async () => {
    const cases = [
      createFakeRunner(() => failure('the model timed out', 'timeout')),
      createFakeRunner(() => ({ nonsense: true })),
      createFakeRunner(() => answer({ evidence: null })),
      createFakeRunner(() => answer({ outcome: 'still-open', evidence: { path: 'src/pay.ts', quote: 'nowhere(card); // gone' } })),
      createFakeRunner(() => { throw new Error('the runner broke'); }),
    ];
    for (const runner of cases) {
      const r = await confirmFixed(runner, checkCtx(), [vanishedFix({ severity: 'block' })]);
      expect(r.fixed).toEqual([]);
      expect(r.open.map((f) => [f.status, f.anchor.status])).toEqual([['still-open', 'not-found']]);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.stage).toBe('challenge');
      expect(r.errors[0]!.message).toMatch(/^c_fix: /);
    }
    const timedOut = await confirmFixed(cases[0]!, checkCtx(), [vanishedFix()]);
    expect(timedOut.errors[0]!.kind).toBe('timeout');
  });

  it('a vanished note is fixed without a request and says it was not checked further', async () => {
    const runner = createFakeRunner(() => answer());
    const r = await confirmFixed(runner, checkCtx(), [vanishedFix({ id: 'c_n', severity: 'note' }), vanishedFix({ id: 'c_a', severity: 'ask' })]);
    expect(runner.calls).toHaveLength(0);
    expect(r.fixed.map((f) => [f.id, f.status, f.checked])).toEqual([
      ['c_n', 'fixed', FIXED_BY_CODE], ['c_a', 'fixed', FIXED_BY_CODE],
    ]);
    expect(FIXED_BY_CODE).toBe('The quoted code is gone; not checked further.');
  });

  it('a fixed finding is placed nowhere at the head and is in neither list of the review', async () => {
    const runner = createFakeRunner(() => answer());
    const r = await confirmFixed(runner, checkCtx(), [vanishedFix()]);
    expect(r.fixed[0]).toMatchObject({ bucket: 'also', rank: null, anchor: { status: 'not-found', startLine: null, endLine: null, comment: null } });
  });

  it('sends one request per block or fix finding, with the challenger, both worktrees and read tools only', async () => {
    const runner = createFakeRunner(() => answer());
    await confirmFixed(runner, checkCtx(), [vanishedFix({ id: 'c_1' }), vanishedFix({ id: 'c_2', severity: 'block' }), vanishedFix({ id: 'c_3', severity: 'note' })]);
    expect(runner.calls.map((c) => c.role)).toEqual(['challenge:fixed:c_1', 'challenge:fixed:c_2']);
    for (const req of runner.calls) {
      expect(req).toMatchObject({ cwd: head, extraDirs: [base], model: 'claude-opus-5-5', effort: 'high' });
    }
  });

  it('nothing from the pull request is outside a material block in the fixed-check request', async () => {
    const runner = createFakeRunner(() => answer());
    const packs = [pack('core', [lens('boundary')], {
      standards: [{ name: 'calibration.md', text: 'STANDARD_MARKER pauses may run 90 days.', dated: true }],
    })];
    const earlier = vanishedFix({
      title: 'TITLE_MARKER', happens: 'HAPPENS_MARKER', why: 'WHY_MARKER', suggestedChange: 'CHANGE_MARKER', quote: 'QUOTE_MARKER(card);',
      connected: [{ path: 'src/audit.ts', line: 2, role: 'ROLE_MARKER', quote: 'logger.info(card);' }],
    });
    await confirmFixed(runner, checkCtx({ packs, files: [diff('src/pay.ts', 2, { hunks: [] }), diff('src/audit.ts', 3)] }), [earlier]);
    const req = runner.calls[0]!;
    expect(splitInstructions(req.instructions).stage).toMatch(/^Your job is to decide whether one finding from an earlier review/);
    expect(req.instructions).toContain('STANDARD_MARKER');
    for (const marker of ['PR_BODY_MARKER', 'TITLE_MARKER', 'HAPPENS_MARKER', 'WHY_MARKER', 'CHANGE_MARKER', 'QUOTE_MARKER', 'ROLE_MARKER']) {
      expect(req.instructions).not.toContain(marker);
    }
    // Everything in the material is inside a material block: nothing is left once the blocks are taken out.
    expect(req.material.replace(/<material label="[^"]*">\n[\s\S]*?\n<\/material>/g, '').trim()).toBe('');
    const finding = block(req.material, 'earlier finding')!;
    for (const part of ['TITLE_MARKER', 'HAPPENS_MARKER', 'WHY_MARKER', 'CHANGE_MARKER', 'QUOTE_MARKER', 'ROLE_MARKER', 'src/pay.ts']) {
      expect(finding).toContain(part);
    }
    expect(block(req.material, 'pull request')).toContain('PR_BODY_MARKER');
    expect(block(req.material, 'diff')).toContain('src/pay.ts');
  });
});
