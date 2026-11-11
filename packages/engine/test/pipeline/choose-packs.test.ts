import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEvidence } from '../../src/challenge/proof.js';
import { learnedDocuments } from '../../src/lenses/context.js';
import { choosePacks } from '../../src/pipeline/packs.js';
import type { Pack } from '../../src/packs/types.js';

// Learned lines long enough to count as recorded decisions for the challenger.
const FROM_A = 'Generic line saved on repository A says this project has no logins at all.';
const BY_HAND = 'Generic line written by hand with no repository says dates are stored in UTC.';
const NAMED = 'Named pack line saved on repository A says refunds are always made by hand.';

async function packsFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-choose-'));
  const pack = async (id: string, repos: string[], wrong: string): Promise<void> => {
    await mkdir(join(dir, id, 'learned'), { recursive: true });
    await mkdir(join(dir, id, 'lenses'));
    await writeFile(join(dir, id, 'lenses', 'q.md'), 'Look closely.');
    await writeFile(join(dir, id, 'pack.yaml'),
      `id: ${id}\ntitle: ${id}\nrepos: [${repos.join(', ')}]\nlenses:\n  - { id: q, title: Q, file: lenses/q.md }\n`);
    await writeFile(join(dir, id, 'learned', 'wrong.md'), wrong);
  };
  await pack('generic', [], `# Wrong\n\n2026-11-01 · acme/repo-a · ${FROM_A}\n2026-11-02 · - · ${BY_HAND}\n`);
  await pack('mine', ['acme/repo-a', 'acme/repo-c'], `2026-11-03 · acme/repo-a · ${NAMED}\n`);
  return dir;
}

/** What the lenses are given as instructions and what the challenger holds as recorded decisions. */
function seenBy(packs: Pack[]): { lenses: string; challenger: string[] } {
  return {
    lenses: learnedDocuments(packs).map((d) => d.text).join('\n'),
    challenger: createEvidence(async () => null, [], packs).records.filter((r) => r.role === 'learned').map((r) => r.text),
  };
}

describe('choosePacks and learned lines', () => {
  it('gives a Generic line saved for repository A to reviews of A only, in any letter case', async () => {
    const dir = await packsFolder();
    const forA = seenBy((await choosePacks(dir, 'acme/repo-a')).packs);
    expect(forA.lenses).toContain(FROM_A);
    expect(forA.challenger).toContain(FROM_A);
    const forUpperA = seenBy((await choosePacks(dir, 'ACME/Repo-A')).packs);
    expect(forUpperA.lenses).toContain(FROM_A);
    expect(forUpperA.challenger).toContain(FROM_A);
    const forB = seenBy((await choosePacks(dir, 'acme/repo-b')).packs);
    expect(forB.lenses).not.toContain(FROM_A);
    expect(forB.challenger).not.toContain(FROM_A);
  });

  it('keeps a Generic line with no repository recorded for every repository', async () => {
    const dir = await packsFolder();
    for (const repo of ['acme/repo-a', 'acme/repo-b']) {
      const seen = seenBy((await choosePacks(dir, repo)).packs);
      expect(seen.lenses).toContain(BY_HAND);
      expect(seen.challenger).toContain(BY_HAND);
    }
  });

  it('leaves a named pack\'s lines alone for each of that pack\'s repositories', async () => {
    const dir = await packsFolder();
    for (const repo of ['acme/repo-a', 'acme/repo-c']) {
      const seen = seenBy((await choosePacks(dir, repo)).packs);
      expect(seen.lenses).toContain(NAMED);
      expect(seen.challenger).toContain(NAMED);
    }
  });

  it('applies the same rule when the packs are named', async () => {
    const dir = await packsFolder();
    const seen = seenBy((await choosePacks(dir, 'acme/repo-b', ['mine', 'generic'])).packs);
    expect(seen.lenses).toContain(NAMED);
    expect(seen.lenses).toContain(BY_HAND);
    expect(seen.lenses).not.toContain(FROM_A);
  });
});
