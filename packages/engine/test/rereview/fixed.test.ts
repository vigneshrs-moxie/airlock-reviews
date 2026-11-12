import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileDiff, Finding } from '@airlock/shared';
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
/** A guard that was already at the head before the push, in a file the push did not touch. */
const HEAD_GUARD = 'export const guarded = (card: string) => isValid(card) && notExpired(card);\n';

let head = '';
let base = '';
beforeEach(async () => {
  head = await mkdtemp(join(tmpdir(), 'airlock-fixed-head-'));
  base = await mkdtemp(join(tmpdir(), 'airlock-fixed-base-'));
  for (const [path, text] of Object.entries({ 'src/pay.ts': HEAD_PAY, 'src/audit.ts': HEAD_LOG, 'src/guard.ts': HEAD_GUARD })) {
    await mkdir(dirname(join(head, path)), { recursive: true });
    await writeFile(join(head, path), text);
  }
});
afterEach(async () => {
  await rm(head, { recursive: true, force: true });
  await rm(base, { recursive: true, force: true });
});

/** The push added the card check, line 2 of pay.ts; its other lines were already there. */
const PAY_DIFF: FileDiff = diff('src/pay.ts', 1, {
  hunks: [{
    oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, header: '@@ -1,3 +1,4 @@',
    lines: HEAD_PAY.split('\n').map((text, i) => (i === 1
      ? { kind: 'add' as const, oldNo: null, newNo: 2, text }
      : { kind: 'ctx' as const, oldNo: i === 0 ? 1 : i, newNo: i + 1, text })),
  }],
});
const files = [PAY_DIFF, diff('src/audit.ts', 3)];
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
      { path: 'src/pay.ts', quote: 'export function pay(card: string) {' }, // already there: a line the push did not add
      { path: 'src/guard.ts', quote: 'export const guarded = (card: string) => isValid(card) && notExpired(card);' }, // a file the push did not touch
    ]) {
      const runner = createFakeRunner(() => answer({ evidence }));
      const no = await confirmFixed(runner, checkCtx(), [vanishedFix()]);
      expect(no.fixed).toEqual([]);
      expect(no.open.map((f) => [f.id, f.status, f.anchor])).toEqual([
        ['c_fix', 'still-open', { status: 'not-found', startLine: null, endLine: null, comment: null }],
      ]);
      // A proof code refuses is an answer, not a failed stage: the finding stays open and says why.
      expect(no.errors).toEqual([]);
      expect(no.open[0]!.checked).toMatch(/^Airlock could not confirm this was fixed: .+\.$/);
    }
  });

  it('an answer whose proof code refuses leaves the finding open with no place and no stage error, saying why', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [answer({ evidence: null }), 'Airlock could not confirm this was fixed: the check said it is fixed but quoted no code at the head.'],
      [answer({ outcome: 'still-open', evidence: null }), 'Airlock could not confirm this was fixed: the check said it is still open but quoted no code at the head.'],
      [
        answer({ outcome: 'still-open', evidence: { path: 'src/pay.ts', quote: 'nowhere(card); // gone' } }),
        'Airlock could not confirm this was fixed: the check said it is still open in src/pay.ts, but its quote was not found there at the head.',
      ],
      [
        answer({ evidence: { path: 'src/pay.ts', quote: 'if (!isValidCard(card)) return;' } }),
        'Airlock could not confirm this was fixed: the code the check gave as the fix was not found in src/pay.ts at the head.',
      ],
      [
        answer({ evidence: { path: 'src/guard.ts', quote: 'export const guarded = (card: string) => isValid(card) && notExpired(card);' } }),
        'Airlock could not confirm this was fixed: the code the check gave as the fix, in src/guard.ts, was not changed since the last review, and the faulty code was not removed.',
      ],
    ];
    for (const [given, checked] of cases) {
      const r = await confirmFixed(createFakeRunner(() => given), checkCtx(), [vanishedFix({ severity: 'block' })]);
      expect(r.errors).toEqual([]);
      expect(r.fixed).toEqual([]);
      expect(r.open.map((f) => [f.status, f.anchor.status, f.checked])).toEqual([['still-open', 'not-found', checked]]);
    }
  });

  describe('a fix made by deleting the faulty code', () => {
    const LOGGED = "  console.log('pay', card);";
    /** The push deleted the log line from pay.ts; every other line was already there. */
    const DELETED_DIFF: FileDiff = diff('src/pay.ts', 0, {
      additions: 0, deletions: 1,
      hunks: [{
        oldStart: 1, oldLines: 5, newStart: 1, newLines: 4, header: '@@ -1,5 +1,4 @@',
        lines: [
          { kind: 'ctx', oldNo: 1, newNo: 1, text: 'export function pay(card: string) {' },
          { kind: 'del', oldNo: 2, newNo: null, text: LOGGED },
          { kind: 'ctx', oldNo: 3, newNo: 2, text: '  if (!isValid(card)) throw new Error("invalid card");' },
          { kind: 'ctx', oldNo: 4, newNo: 3, text: '  charge(card);' },
          { kind: 'ctx', oldNo: 5, newNo: 4, text: '}' },
        ],
      }],
    });
    const logged = (over: Partial<Finding> = {}): Finding => vanishedFix({ title: 'The card number is logged', quote: LOGGED, ...over });
    const unchanged = { path: 'src/pay.ts', quote: 'export function pay(card: string) {' };
    const deletedCtx = (files: FileDiff[] = [DELETED_DIFF]) => checkCtx({ files });

    it('is fixed when the push deleted every line of the finding\'s quote, with unchanged code at the head as the proof', async () => {
      const runner = createFakeRunner(() => answer({ evidence: unchanged, explanation: 'The log line was deleted.' }));
      const r = await confirmFixed(runner, deletedCtx(), [logged()]);
      expect(r.errors).toEqual([]);
      expect(r.open).toEqual([]);
      expect(r.fixed.map((f) => [f.id, f.status, f.checked])).toEqual([
        ['c_fix', 'fixed', 'The faulty code was removed. The log line was deleted. Proof: src/pay.ts:1 on the head.'],
      ]);
    });

    it('is fixed when the file was renamed and the deleted line is in the renamed file\'s diff', async () => {
      await writeFile(join(head, 'src/payment.ts'), HEAD_PAY);
      const renamed: FileDiff = { ...DELETED_DIFF, path: 'src/payment.ts', oldPath: 'src/pay.ts', status: 'renamed' };
      const runner = createFakeRunner(() => answer({ evidence: { path: 'src/payment.ts', quote: unchanged.quote } }));
      const r = await confirmFixed(runner, deletedCtx([renamed]), [logged()]);
      expect(r.fixed.map((f) => f.checked)).toEqual([expect.stringMatching(/^The faulty code was removed\. .* Proof: src\/payment\.ts:1 on the head\.$/)]);
    });

    it('is not fixed when a line of the quote was not deleted, the deletion is in another file, or the code is still there reformatted', async () => {
      await writeFile(join(head, 'src/fmt.ts'), "export function show(card: string) {\n  console.log(\n    'pay', card);\n}\n");
      const reformatted: FileDiff = diff('src/fmt.ts', 0, {
        hunks: [{
          oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, header: '@@ -1,3 +1,4 @@',
          lines: [
            { kind: 'ctx', oldNo: 1, newNo: 1, text: 'export function show(card: string) {' },
            { kind: 'del', oldNo: 2, newNo: null, text: LOGGED },
            { kind: 'add', oldNo: null, newNo: 2, text: '  console.log(' },
            { kind: 'add', oldNo: null, newNo: 3, text: "    'pay', card);" },
            { kind: 'ctx', oldNo: 3, newNo: 4, text: '}' },
          ],
        }],
      });
      const cases: [Finding, FileDiff[]][] = [
        // Two lines of substance, and the push deleted only one of them.
        [logged({ quote: `${LOGGED}\n  audit.write(card, 'paid');` }), [DELETED_DIFF]],
        // The finding is in audit.ts; the deleted line is in pay.ts.
        [logged({ path: 'src/audit.ts' }), [DELETED_DIFF]],
        // Reformatted onto two lines: the old line is deleted, but the faulty code is still in the file.
        [logged({ path: 'src/fmt.ts' }), [reformatted]],
      ];
      for (const [finding, files] of cases) {
        const r = await confirmFixed(createFakeRunner(() => answer({ evidence: unchanged })), deletedCtx(files), [finding]);
        expect(r.fixed).toEqual([]);
        expect(r.errors).toEqual([]);
        expect(r.open.map((f) => [f.status, f.anchor.status])).toEqual([['still-open', 'not-found']]);
        expect(r.open[0]!.checked).toMatch(/^Airlock could not confirm this was fixed: /);
      }
      const r = await confirmFixed(createFakeRunner(() => answer({ evidence: unchanged })), deletedCtx([reformatted]), [logged({ path: 'src/fmt.ts' })]);
      expect(r.open[0]!.checked).toBe('Airlock could not confirm this was fixed: its quoted code was deleted but is still in src/fmt.ts at the head in another shape.');
    });

    it('is not fixed when the proof is not code found at the head, or is the finding\'s own code', async () => {
      for (const evidence of [
        { path: 'src/pay.ts', quote: '// the log line was deleted' },
        { path: 'src/pay.ts', quote: '}' },
        { path: 'src/pay.ts', quote: 'export function payNow(card: string) {' },
        { path: '../outside/pay.ts', quote: unchanged.quote },
        { path: 'src/pay.ts', quote: LOGGED },
      ]) {
        const r = await confirmFixed(createFakeRunner(() => answer({ evidence })), deletedCtx(), [logged()]);
        expect(r.fixed).toEqual([]);
        expect(r.errors).toEqual([]);
        expect(r.open.map((f) => [f.status, f.anchor.status])).toEqual([['still-open', 'not-found']]);
      }
    });
  });

  describe('what changed since the last review', () => {
    /** The push changed only audit.ts; pay.ts's card check was added before the last review. */
    const since = { files: [diff('src/audit.ts', 3)], rewritten: false };

    it('judges a proof against what changed since the last review, not against the review\'s own diff', async () => {
      // The review's own diff (the whole pull request's) adds the card check; nothing since the last review touched it.
      const r = await confirmFixed(createFakeRunner(() => answer()), checkCtx(), [vanishedFix()], since);
      expect(r.fixed).toEqual([]);
      expect(r.errors).toEqual([]);
      expect(r.open[0]!.checked).toBe(
        'Airlock could not confirm this was fixed: the code the check gave as the fix, in src/pay.ts, was not changed since the last review, and the faulty code was not removed.',
      );
      const yes = await confirmFixed(createFakeRunner(() => answer()), checkCtx(), [vanishedFix()], { files: [PAY_DIFF], rewritten: false });
      expect(yes.fixed.map((f) => f.checked)).toEqual(['The card is now checked before it is charged. Proof: src/pay.ts:2 on the head.']);
    });

    it('shows the model the diff since the last review', async () => {
      const runner = createFakeRunner(() => answer());
      await confirmFixed(runner, checkCtx(), [vanishedFix({ connected: [{ path: 'src/audit.ts', line: 2, role: 'logs it', quote: '' }] })], since);
      const shown = block(runner.calls[0]!.material, 'diff')!;
      expect(shown).toContain('src/audit.ts');
      expect(shown).not.toContain('isValid(card)');
    });

    it('when the branch was rewritten, judges against the whole pull request and says so', async () => {
      const r = await confirmFixed(createFakeRunner(() => answer()), checkCtx(), [vanishedFix()], { files: files, rewritten: true });
      expect(r.fixed.map((f) => f.checked)).toEqual([
        'The card is now checked before it is charged. Proof: src/pay.ts:2 on the head (the branch was rewritten, so this was judged against the whole pull request).',
      ]);
    });
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

  it('a failed request leaves the finding open, adds a stage error and never marks it fixed', async () => {
    const cases = [
      createFakeRunner(() => failure('the model timed out', 'timeout')),
      createFakeRunner(() => ({ nonsense: true })),
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
