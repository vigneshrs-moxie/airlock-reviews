import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCases, pickCases, type KnownProblem, type ReplayCase } from '../src/index.js';

const SHA = /^[0-9a-f]{40}$/;

/** A description entry as capture-descriptions.mjs writes it. */
const description = (id: string) => ({ title: `Title of ${id} then`, body: `Body of ${id} then.`, editedAfterReview: 0, renamedAfterReview: 0 });

/**
 * Writes cases.json into a new folder, with a descriptions.json beside it holding an entry for every case id in
 * `content` (or the given `descriptions`).
 */
async function tempFile(content: unknown, descriptions?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-replay-'));
  const file = join(dir, 'cases.json');
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  const ids = Array.isArray(content) ? content.map((c: { id?: unknown }) => c.id).filter((id): id is string => typeof id === 'string') : [];
  await writeFile(join(dir, 'descriptions.json'), JSON.stringify(descriptions ?? Object.fromEntries(ids.map((id) => [id, description(id)]))));
  return file;
}

/** What loadCases returns for a case record: the record plus its description at review time. */
const loaded = (c: Omit<ReplayCase, 'titleAtReview' | 'bodyAtReview'>): ReplayCase =>
  ({ ...c, titleAtReview: description(c.id).title, bodyAtReview: description(c.id).body });

function sampleProblem(over: Partial<KnownProblem> = {}): KnownProblem {
  return {
    id: 'C1',
    path: 'src/a.ts',
    line: 10,
    summary: 'A guard keys on one field while the store keys on another, so the guard never fires.',
    comment: 'why does this key on the other field',
    reviewerSeverity: 'change',
    crossFile: true,
    ...over,
  };
}

function sampleCase(over: Partial<ReplayCase> = {}): Omit<ReplayCase, 'titleAtReview' | 'bodyAtReview'> {
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

  it('marks only the answered questions with no underlying defect as defect: false', async () => {
    const problems = (await loadCases()).flatMap((c) => c.known);
    const notDefects = problems.filter((k) => k.defect === false);
    expect(notDefects.map((k) => k.id).sort()).toEqual(['C1', 'C15', 'C9', 'pr59-2']);
    for (const k of notDefects) expect(k.reviewerSeverity, k.id).toBe('question');
    for (const k of problems) expect(typeof k.defect, k.id).toBe('boolean');
  });

  it('every case has its title and description as they stood at review time', async () => {
    const all = await loadCases();
    const descriptions = JSON.parse(await readFile(fileURLToPath(new URL('../dataset/descriptions.json', import.meta.url)), 'utf8')) as
      Record<string, { title: string; body: string }>;
    for (const c of all) {
      expect(descriptions[c.id], c.id).toBeDefined();
      expect(c.titleAtReview, c.id).toBe(descriptions[c.id]!.title);
      expect(c.bodyAtReview, c.id).toBe(descriptions[c.id]!.body);
      expect(c.titleAtReview.length, c.id).toBeGreaterThan(0);
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
  it('reads a given file and the descriptions beside it', async () => {
    const file = await tempFile([sampleCase()]);
    expect(await loadCases(file)).toEqual([loaded(sampleCase())]);
  });

  it('fails when a case has no description entry, naming the case and the script to run', async () => {
    const file = await tempFile([sampleCase(), sampleCase({ id: 'pr2', pr: 2 })], { pr1: description('pr1') });
    await expect(loadCases(file)).rejects.toThrow(/pr2.*descriptions\.json.*capture-descriptions\.mjs/);
  });

  it('fails when there is no descriptions.json, naming the script to run', async () => {
    const file = await tempFile([sampleCase()]);
    await rm(join(file, '..', 'descriptions.json'));
    await expect(loadCases(file)).rejects.toThrow(/pr1.*capture-descriptions\.mjs/);
  });

  it('fails on a bad SHA, naming the case and the field', async () => {
    const file = await tempFile([sampleCase(), sampleCase({ id: 'pr2', pr: 2, headSha: 'abc123' })]);
    await expect(loadCases(file)).rejects.toThrow(/pr2.*headSha/);
  });

  it('defaults defect to true and keeps an explicit false', async () => {
    const file = await tempFile([sampleCase({ known: [sampleProblem(), sampleProblem({ id: 'C2', defect: false })] })]);
    const [first] = await loadCases(file);
    expect(first?.known.map((k) => k.defect)).toEqual([true, false]);
  });

  it('fails on malformed JSON, naming the file', async () => {
    const file = await tempFile('[{"id": "pr1",');
    await expect(loadCases(file)).rejects.toThrow(file);
  });

  it('rejects a duplicate case id, naming it', async () => {
    const file = await tempFile([sampleCase({ id: 'pr7' }), sampleCase({ id: 'pr7' })]);
    await expect(loadCases(file)).rejects.toThrow(/duplicate replay case id pr7/);
  });

  it('rejects a duplicate known-problem id across cases, naming it', async () => {
    const file = await tempFile([
      sampleCase({ id: 'pr1', known: [sampleProblem({ id: 'C5' })] }),
      sampleCase({ id: 'pr2', known: [sampleProblem({ id: 'C5' })] }),
    ]);
    await expect(loadCases(file)).rejects.toThrow(/duplicate known-problem id C5/);
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
  ].map(loaded);
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
