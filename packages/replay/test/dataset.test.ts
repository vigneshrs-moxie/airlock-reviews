import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCases, pickCases, type ReplayCase } from '../src/index.js';

const SHA = /^[0-9a-f]{40}$/;

async function tempFile(content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-replay-'));
  const file = join(dir, 'cases.json');
  await writeFile(file, JSON.stringify(content));
  return file;
}

function sampleCase(over: Partial<ReplayCase> = {}): ReplayCase {
  return {
    id: 'pr1',
    repo: 'owner/repo',
    pr: 1,
    title: 'A change',
    kind: 'positive',
    reviewedAt: '2026-10-30T00:01:00Z',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    lines: 120,
    known: [],
    ...over,
  };
}

describe('the bundled replay dataset', () => {
  it('has nine positive cases and 26 known problems among them', async () => {
    const positive = (await loadCases()).filter((c) => c.kind === 'positive');
    expect(positive.map((c) => c.pr).sort((a, b) => a - b)).toEqual([59, 94, 100, 126, 128, 129, 143, 146, 171]);
    expect(positive.reduce((n, c) => n + c.known.length, 0)).toBe(26);
  });

  it('has eight negative cases with no known problems', async () => {
    const negative = (await loadCases()).filter((c) => c.kind === 'negative');
    expect(negative.map((c) => c.pr).sort((a, b) => a - b)).toEqual([125, 133, 136, 198, 207, 209, 225, 232]);
    for (const c of negative) expect(c.known).toEqual([]);
  });

  it('every case has two 40-character SHAs and an ISO review date', async () => {
    const all = await loadCases();
    expect(all.length).toBeGreaterThan(0);
    for (const c of all) {
      expect(c.headSha).toMatch(SHA);
      expect(c.baseSha).toMatch(SHA);
      expect(c.headSha).not.toBe(c.baseSha);
      expect(new Date(c.reviewedAt).toISOString().slice(0, 19)).toBe(c.reviewedAt.slice(0, 19));
    }
  });

  it('every positive case has a known problem, and every summary is one plain statement of 40 or more characters', async () => {
    for (const c of await loadCases()) {
      if (c.kind === 'positive') expect(c.known.length, c.id).toBeGreaterThan(0);
      for (const k of c.known) {
        expect(k.summary.length, k.id).toBeGreaterThanOrEqual(40);
        expect(k.summary, k.id).not.toContain('?');
        expect(k.comment.trim(), k.id).toBe(k.comment);
        expect(k.comment.length, k.id).toBeGreaterThan(0);
      }
    }
  });

  it('ids are unique across cases and across known problems', async () => {
    const all = await loadCases();
    const caseIds = all.map((c) => c.id);
    expect(new Set(caseIds).size).toBe(caseIds.length);
    const problemIds = all.flatMap((c) => c.known.map((k) => k.id));
    expect(new Set(problemIds).size).toBe(problemIds.length);
  });
});

describe('loadCases', () => {
  it('reads a given file', async () => {
    const file = await tempFile([sampleCase()]);
    expect(await loadCases(file)).toEqual([sampleCase()]);
  });

  it('fails on a bad SHA, naming the case and the field', async () => {
    const file = await tempFile([sampleCase(), sampleCase({ id: 'pr2', pr: 2, headSha: 'abc123' })]);
    await expect(loadCases(file)).rejects.toThrow(/pr2.*headSha/);
  });

  it('fails on a date that is not ISO, naming the case and the field', async () => {
    const file = await tempFile([sampleCase({ reviewedAt: 'Oct 30 2026' })]);
    await expect(loadCases(file)).rejects.toThrow(/pr1.*reviewedAt/);
  });
});

describe('pickCases', () => {
  const all = [
    sampleCase({ id: 'pr1', kind: 'positive', lines: 2000 }),
    sampleCase({ id: 'pr2', kind: 'negative', lines: 10 }),
    sampleCase({ id: 'pr3', kind: 'positive', lines: 2001 }),
    sampleCase({ id: 'pr4', kind: 'secondary', lines: 10 }),
    sampleCase({ id: 'pr5', kind: 'positive', lines: null }),
    sampleCase({ id: 'pr6', kind: 'positive', lines: 5 }),
  ];
  const ids = (cs: ReplayCase[]): string[] => cs.map((c) => c.id);

  it('selects all, positive and negative', () => {
    expect(ids(pickCases(all, 'all'))).toEqual(['pr1', 'pr2', 'pr3', 'pr4', 'pr5', 'pr6']);
    expect(ids(pickCases(all, 'positive'))).toEqual(['pr1', 'pr3', 'pr5', 'pr6']);
    expect(ids(pickCases(all, 'negative'))).toEqual(['pr2']);
  });

  it('pickCases small returns only positive cases of at most 2,000 lines', async () => {
    expect(ids(pickCases(all, 'small'))).toEqual(['pr1', 'pr6']);
    const real = await loadCases();
    const small = pickCases(real, 'small');
    expect(small.length).toBeGreaterThan(0);
    for (const c of small) {
      expect(c.kind).toBe('positive');
      expect(c.lines).not.toBeNull();
      expect(c.lines).toBeLessThanOrEqual(2000);
    }
  });

  it('pickCases accepts a comma-separated list of ids', () => {
    expect(ids(pickCases(all, 'pr6, pr2'))).toEqual(['pr2', 'pr6']);
  });

  it('throws on an unknown id, naming it', () => {
    expect(() => pickCases(all, 'pr1,pr99')).toThrow(/pr99/);
  });
});
