import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { minimalDocument } from '@airlock/shared';
import type { Finding, ReviewDocument } from '@airlock/shared';
import { fingerprint } from '../../src/anchor/fingerprint.js';
import { carryOver, mergeIntoCarried } from '../../src/rereview/carry.js';
import type { AnchoredCandidate } from '../../src/merge/merge.js';
import { makeChange } from '../helpers/change-repo.js';
import { earlierFinding } from '../helpers/earlier-finding.js';
import { makeTempRepo, type TempRepo } from '../helpers/temp-repo.js';

const made: TempRepo[] = [];
afterEach(async () => {
  for (const r of made.splice(0)) await rm(r.dir, { recursive: true, force: true });
});

const prevWith = (findings: Finding[], fixed: Finding[] = []): ReviewDocument =>
  ({ ...minimalDocument(), id: 'r_0123456789', findings, fixed });

const A = 'export function total(price: number, qty: number) {\n  const total = price * qty;\n  return total;\n}\n';
const B = 'export function pay(card: string) {\n  log(card);\n  charge(card);\n}\n';
const OLD = 'export const rate = 0.2;\nexport const tax = (n: number) => n * rate;\nexport const name = "tax";\n';
const D = 'export function drop(list: string[]) {\n  list.length = 0;\n}\n';

async function pushed() {
  const r = await makeTempRepo();
  made.push(r);
  const files = await makeChange(r, { 'src/a.ts': A, 'src/b.ts': B, 'src/old.ts': OLD, 'src/d.ts': D }, {
    'src/b.ts': `// payments\n// see the guide\n${B}`,
    'src/old.ts': null,
    'src/new.ts': OLD,
    'src/d.ts': 'export function drop(list: string[]) {\n  return [];\n}\n',
    'src/other.ts': 'export const x = 1;\n',
  });
  const read = async (path: string): Promise<string | null> => readFile(join(r.dir, path), 'utf8').catch(() => null);
  return { files, read };
}

describe('carryOver', () => {
  it('a quote on the same lines is still open, on other lines moved, in a renamed file moved', async () => {
    const { files, read } = await pushed();
    const same = earlierFinding({ id: 'c_a' });
    const shifted = earlierFinding({
      id: 'c_b', path: 'src/b.ts', quote: 'log(card);', lineHint: 2, title: 'The card number is logged',
      anchor: { status: 'in-diff', startLine: 2, endLine: 2, comment: { line: 2, startLine: null } },
    });
    const renamed = earlierFinding({
      id: 'c_c', path: 'src/old.ts', quote: 'export const tax = (n: number) => n * rate;', lineHint: 2,
      anchor: { status: 'in-diff', startLine: 2, endLine: 2, comment: { line: 2, startLine: null } },
    });
    const gone = earlierFinding({
      id: 'c_d', path: 'src/d.ts', quote: 'list.length = 0;', lineHint: 2,
      anchor: { status: 'in-diff', startLine: 2, endLine: 2, comment: { line: 2, startLine: null } },
    });
    const { open, vanished } = await carryOver(prevWith([same, shifted, renamed, gone]), files, read);

    expect(open.map((f) => [f.id, f.status, f.path, f.anchor.startLine])).toEqual([
      ['c_a', 'still-open', 'src/a.ts', 2],
      ['c_b', 'moved', 'src/b.ts', 4],
      ['c_c', 'moved', 'src/new.ts', 2],
    ]);
    // Still open keeps its earlier place; a moved one gets a new anchor and comment line from the files given.
    expect(open[0]!.anchor).toEqual(same.anchor);
    expect(open[1]!.anchor).toEqual({ status: 'in-diff', startLine: 4, endLine: 4, comment: { line: 4, startLine: null } });
    expect(open[1]!.fingerprint).toBe(shifted.fingerprint);
    // The renamed one's fingerprint changes with its path; the old one stays as an alias.
    expect(open[2]!.fingerprint).toBe(fingerprint({ ...renamed, path: 'src/new.ts' }));
    expect(open[2]!.aliases).toEqual([renamed.fingerprint]);
    expect(vanished.map((f) => f.id)).toEqual(['c_d']);
    // The earlier review's groups belong to its own change map, so a carried finding names none.
    expect([...open, ...vanished].map((f) => f.cohortId)).toEqual([null, null, null, null]);
    expect(vanished[0]).toEqual({ ...gone, cohortId: null });
  });

  it('does not carry the earlier review\'s fixed list', async () => {
    const { files, read } = await pushed();
    const fixedBefore = earlierFinding({ id: 'c_x', status: 'fixed' });
    const { open, vanished } = await carryOver(prevWith([], [fixedBefore]), files, read);
    expect(open).toEqual([]);
    expect(vanished).toEqual([]);
  });

  it('looks for the quote even when the earlier finding had lost its place', async () => {
    const { files, read } = await pushed();
    const lost = earlierFinding({ id: 'c_l', status: 'still-open', anchor: { status: 'not-found', startLine: null, endLine: null, comment: null } });
    const { open } = await carryOver(prevWith([lost]), files, read);
    expect(open.map((f) => [f.status, f.anchor.startLine])).toEqual([['moved', 2]]);
  });

  it('a finding whose file cannot be read has vanished', async () => {
    const { files } = await pushed();
    const { open, vanished } = await carryOver(prevWith([earlierFinding()]), files, async () => null);
    expect(open).toEqual([]);
    expect(vanished.map((f) => f.id)).toEqual(['c_00000001']);
  });
});

describe('carryOver: gone, unreadable and connected places', () => {
  it('a finding whose file the push deleted has vanished', async () => {
    const r = await makeTempRepo();
    made.push(r);
    const files = await makeChange(r, { 'src/a.ts': 'export const total = (price: number, qty: number) => {\n  const total = price * qty;\n};\n', 'src/keep.ts': 'x\n' }, { 'src/a.ts': null });
    expect(files.find((f) => f.path === 'src/a.ts')?.status).toBe('deleted');
    const read = (path: string) => readFile(join(r.dir, path), 'utf8').catch(() => null);
    const r2 = await carryOver(prevWith([earlierFinding()]), files, read);
    expect(r2.open).toEqual([]);
    expect(r2.vanished.map((f) => f.id)).toEqual(['c_00000001']);
    expect(r2.errors).toEqual([]);
  });

  it('a finding whose file exists but cannot be read stays open with no place and a stage error, for any severity', async () => {
    const { files } = await pushed();
    const unreadable = async (path: string): Promise<string | null> => { throw new Error(`${path} is larger than Airlock reads`); };
    for (const severity of ['note', 'block'] as const) {
      const r = await carryOver(prevWith([earlierFinding({ severity })]), files, unreadable);
      expect(r.vanished).toEqual([]);
      expect(r.open.map((f) => [f.status, f.anchor])).toEqual([['still-open', { status: 'not-found', startLine: null, endLine: null, comment: null }]]);
      expect(r.errors).toEqual([{
        stage: 'anchor', cohortId: null,
        message: 'c_00000001: the file src/a.ts could not be read at the head, so this earlier finding stays open.',
      }]);
    }
  });

  it('a still-open finding\'s connected places are anchored again at the new head', async () => {
    const { files, read } = await pushed();
    const f = earlierFinding({ connected: [{ path: 'src/b.ts', line: 2, role: 'the card is logged here', quote: 'log(card);' }] });
    const { open } = await carryOver(prevWith([f]), files, read);
    expect(open[0]!.status).toBe('still-open');
    expect(open[0]!.connected).toEqual([{ path: 'src/b.ts', line: 4, role: 'the card is logged here', quote: '  log(card);' }]);
  });
});

describe('mergeIntoCarried', () => {
  const carried = earlierFinding({ id: 'c_old', status: 'still-open', aliases: ['aaaaaaaaaaaaaaaa'] });
  const item = (over: Partial<AnchoredCandidate>): AnchoredCandidate => {
    const { fingerprint: _f, checked: _c, bucket: _b, rank: _r, status: _s, aliases: _a, ...plain } = earlierFinding();
    return { ...plain, id: 'c_new', title: 'Raised again', ...over };
  };
  const other = { source: { pack: 'core', lens: 'naming', ruleId: null } };

  it('a new finding with a carried fingerprint or alias is merged into the carried one', () => {
    const byNaming = item({ ...other, quote: 'other code' });
    const cases: [string, AnchoredCandidate, Finding][] = [
      ['its fingerprint is the carried fingerprint', item({}), carried],
      ['its fingerprint is a carried alias', byNaming, { ...carried, aliases: ['aaaaaaaaaaaaaaaa', fingerprint(byNaming)] }],
      ['an alias of it is the carried fingerprint', item({ ...other, quote: 'x', aliases: [carried.fingerprint] }), carried],
      ['an alias of it is a carried alias', item({ ...other, quote: 'y', aliases: ['aaaaaaaaaaaaaaaa'] }), carried],
    ];
    for (const [why, raised, target] of cases) {
      const r = mergeIntoCarried([raised], [target]);
      expect(r.items, why).toEqual([]);
      expect(r.dropped, why).toEqual([{
        candidate: expect.objectContaining({ id: 'c_new' }), stage: 'merge', refutation: null, mergedInto: 'c_old',
        reason: `raised again: the same finding as "${carried.title}" from the last review`,
      }]);
      expect(r.dropped[0]!.candidate, why).not.toHaveProperty('anchor');
      // The carried finding gains the new one's fingerprint (and aliases) as aliases, never its own fingerprint.
      const gained = [...new Set([...target.aliases!, fingerprint(raised), ...(raised.aliases ?? [])])].filter((a) => a !== carried.fingerprint);
      expect(r.carried[0]!.aliases, why).toEqual(gained);
      expect(r.carried[0]!.fingerprint, why).toBe(carried.fingerprint);
    }
  });

  it('takes the more serious severity when the new finding is more serious, and says so in checked', () => {
    const cases: [Finding['severity'], Finding['severity'], string][] = [
      ['fix', 'block', 'Block'], ['ask', 'fix', 'Fix'], ['note', 'block', 'Block'], ['note', 'ask', 'Ask'],
    ];
    for (const [was, now, word] of cases) {
      const target = earlierFinding({ id: 'c_old', severity: was, status: 'still-open', checked: 'Read both callers.' });
      const r = mergeIntoCarried([item({ severity: now, title: 'Worded differently', happens: 'Other words.' })], [target]);
      expect(r.items, `${was} to ${now}`).toEqual([]);
      expect(r.carried[0], `${was} to ${now}`).toMatchObject({
        severity: now, title: target.title, happens: target.happens, path: target.path, quote: target.quote, anchor: target.anchor,
        checked: `Read both callers. Raised again as ${word} in this review.`,
      });
      expect(target.severity, 'the input is not changed').toBe(was);
    }
  });

  it('changes nothing for a repeat that is as serious or less serious', () => {
    for (const [was, now] of [['block', 'fix'], ['fix', 'fix'], ['fix', 'note'], ['ask', 'note']] as const) {
      const target = earlierFinding({ id: 'c_old', severity: was, status: 'still-open' });
      const r = mergeIntoCarried([item({ severity: now })], [target]);
      expect(r.carried[0], `${was} then ${now}`).toMatchObject({ severity: was, checked: target.checked });
    }
  });

  it('leaves a finding that is not the same alone, and does not change its inputs', () => {
    const fresh = item({ ...other, quote: 'something else' });
    const before = structuredClone(carried);
    const r = mergeIntoCarried([fresh], [carried]);
    expect(r.items).toEqual([fresh]);
    expect(r.dropped).toEqual([]);
    expect(r.carried).toEqual([carried]);
    expect(carried).toEqual(before);
  });
});
