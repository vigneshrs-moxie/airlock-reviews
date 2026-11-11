import type { ChangeMap, Claim, FileDiff, PrInfo } from '@airlock/shared';
import { minimalDocument } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import { createFakeRunner } from '../../src/agent/fake-runner.js';
import { buildBrief } from '../../src/brief/brief.js';
import type { BriefInput } from '../../src/brief/brief.js';

const diff = (path: string, status: FileDiff['status'] = 'modified', additions = 3, deletions = 1): FileDiff => ({
  path, oldPath: null, status, binary: false, additions, deletions, hunks: [],
});
const claim = (text: string, verdict: Claim['verdict'] = 'verified'): Claim => ({ text, verdict, evidence: 'src/a.ts:3 does it.' });
const pr: PrInfo = { ...minimalDocument().pr, title: 'Let members pause a plan', body: 'Members can pause for 60 days.' };
const map: ChangeMap = {
  cohorts: [{
    id: 'k1', title: 'Pausing a plan', summary: 'Members pause from the account page.',
    layers: [
      { id: 'k1.l1', title: 'Store', kind: 'data', files: ['db/0042.sql'], dependsOn: [], note: '' },
      { id: 'k1.l2', title: 'Screen', kind: 'screens', files: ['src/page.tsx', 'src/b.ts'], dependsOn: ['k1.l1'], note: '' },
    ],
    neighbours: [], inferredLinks: [],
  }],
  standalone: ['README.md'],
  links: [],
};
const input = (over: Partial<BriefInput> = {}): BriefInput => ({
  pr, map, files: [diff('db/0042.sql', 'added'), diff('src/page.tsx'), diff('README.md')],
  headDir: '/tmp/head', baseDir: '/tmp/base', model: 'claude-opus-5-5', effort: 'high', ...over,
});
const answer = (whatItDoes: string[], claims: Claim[] = []) => ({ whatItDoes, claims });
const labels = (material: string): string[] => [...material.matchAll(/<material label="([^"]*)">/g)].map((m) => m[1]!);

describe('buildBrief', () => {
  it('keeps at most five lines', async () => {
    const runner = createFakeRunner(() => answer(['1', '2', '3', '4', '5', '6', '7']));
    const r = await buildBrief(runner, input());
    expect(r.error).toBeNull();
    expect(r.brief.whatItDoes).toEqual(['1', '2', '3', '4', '5']);
    expect(r.usage).toHaveLength(1);
  });

  it('passes the description as material', async () => {
    const runner = createFakeRunner(() => answer(['x']));
    await buildBrief(runner, input());
    const material = runner.calls[0]!.material;
    expect(material).toContain('Let members pause a plan');
    expect(material).toContain('Members can pause for 60 days.');
  });

  it('returns an empty brief and an error when the agent fails', async () => {
    const runner = createFakeRunner(() => new Error('boom'));
    const r = await buildBrief(runner, input());
    expect(r.brief).toEqual({ whatItDoes: [], claims: [] });
    expect(r.error).toBe('boom');
    expect(r.usage).toHaveLength(1);
  });

  it('sends one brief request with role, directories and settings', async () => {
    const runner = createFakeRunner(() => answer(['x']));
    await buildBrief(runner, input());
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      role: 'brief', cwd: '/tmp/head', extraDirs: ['/tmp/base'], model: 'claude-opus-5-5', effort: 'high',
    });
    expect(runner.calls[0]!.instructions).toMatch(/not-supported/);
  });

  it('orders the material: description, change map outline, changed files', async () => {
    const runner = createFakeRunner(() => answer(['x']));
    await buildBrief(runner, input());
    const material = runner.calls[0]!.material;
    expect(labels(material)).toHaveLength(3);
    const [p, m, f] = labels(material);
    expect(p).toMatch(/pull request/);
    expect(m).toMatch(/change map/);
    expect(f).toMatch(/changed files/);
    const outline = material.slice(material.indexOf('<material label="change map'));
    expect(outline.indexOf('Pausing a plan')).toBeLessThan(outline.indexOf('Members pause from the account page.'));
    expect(outline.indexOf('db/0042.sql')).toBeLessThan(outline.indexOf('src/page.tsx'));
    expect(outline.indexOf('src/page.tsx')).toBeLessThan(outline.indexOf('README.md'));
    expect(material).toContain('db/0042.sql | added | +3 -1');
  });

  it('cuts a long description and says so', async () => {
    const runner = createFakeRunner(() => answer(['x']));
    await buildBrief(runner, input({ pr: { ...pr, body: 'a'.repeat(6_500) } }));
    const material = runner.calls[0]!.material;
    expect(material).toContain('a'.repeat(6_000));
    expect(material).not.toContain('a'.repeat(6_001));
    expect(material).toContain('(description cut at 6000 characters)');
  });

  it('writes down that it cut the description, and nothing when it did not', async () => {
    const runner = createFakeRunner(() => answer(['x']));
    const cut = await buildBrief(runner, input({ pr: { ...pr, body: 'a'.repeat(6_500) } }));
    expect(cut.limits).toEqual(['brief: the description was cut at 6,000 of 6,500 characters']);
    expect((await buildBrief(runner, input())).limits).toEqual([]);
  });

  it('caps the changed file list at 300 lines and says so', async () => {
    const files = Array.from({ length: 305 }, (_, i) => diff(`src/f${String(i).padStart(3, '0')}.ts`));
    const runner = createFakeRunner(() => answer(['x']));
    await buildBrief(runner, input({ files }));
    const material = runner.calls[0]!.material;
    expect(material).toContain('src/f299.ts');
    expect(material).not.toContain('src/f300.ts');
    expect(material).toContain('(5 more files left out)');
  });

  it('says when the description is empty', async () => {
    const runner = createFakeRunner(() => answer(['x']));
    await buildBrief(runner, input({ pr: { ...pr, body: '  ' } }));
    expect(runner.calls[0]!.material).toContain('(no description)');
    expect(runner.calls[0]!.instructions).toMatch(/empty .*claims/i);
  });

  it('keeps at most 12 claims', async () => {
    const claims = Array.from({ length: 15 }, (_, i) => claim(`claim ${i}`));
    const runner = createFakeRunner(() => answer(['x'], claims));
    const r = await buildBrief(runner, input());
    expect(r.brief.claims).toHaveLength(12);
    expect(r.brief.claims[11]!.text).toBe('claim 11');
  });

  it('trims lines and drops blank ones before cutting to five', async () => {
    const runner = createFakeRunner(() => answer(['  a  ', '', '   ', 'b', 'c', 'd', 'e', 'f']));
    const r = await buildBrief(runner, input());
    expect(r.brief.whatItDoes).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
