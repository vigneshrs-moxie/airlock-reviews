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
const DOT_GIT = 'Generic line with a .git repository says the cache is cleared every night.';
const SPACED = 'Generic line with a spaced repository says invoices are sent in batches.';
const EMPTY = 'Generic line with an empty repository says weekends are not working days.';

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
  await pack('generic', [], [
    '# Wrong', '', `2026-11-01 · acme/repo-a · ${FROM_A}`, `2026-11-02 · - · ${BY_HAND}`,
    `2026-11-04 · acme/repo-a.git · ${DOT_GIT}`, `2026-11-05 · acme/ repo-a · ${SPACED}`, `2026-11-06 ·  · ${EMPTY}`, '',
  ].join('\n'));
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

describe('a learned line whose repository field is malformed (second round)', () => {
  it('is in no review and is reported with its file and line; - and an empty field are in every review', async () => {
    const dir = await packsFolder();
    for (const repo of ['acme/repo-a', 'acme/repo-b', 'ACME/REPO-A.GIT']) {
      const chosen = await choosePacks(dir, repo);
      const seen = seenBy(chosen.packs);
      for (const text of [DOT_GIT, SPACED]) {
        expect(seen.lenses, repo).not.toContain(text);
        expect(seen.challenger, repo).not.toContain(text);
      }
      for (const text of [BY_HAND, EMPTY]) {
        expect(seen.lenses, repo).toContain(text);
        expect(seen.challenger, repo).toContain(text);
      }
      const file = join(dir, 'generic', 'learned', 'wrong.md');
      expect(chosen.errors.map((e) => [e.stage, e.message])).toEqual([
        ['packs', `${file}:5: the repository "acme/repo-a.git" is not a repository name, "-" or empty, so this line is left out of every review.`],
        ['packs', `${file}:6: the repository "acme/ repo-a" is not a repository name, "-" or empty, so this line is left out of every review.`],
      ]);
    }
  });
});

describe('a learned line that cannot be read', () => {
  it('is left out and named in notes (one sentence, relative place), with no stage error; the pack stays', async () => {
    const dir = await packsFolder();
    await writeFile(join(dir, 'mine', 'learned', 'wrong.md'), `2026-11-03 · acme/repo-a · ${NAMED}\nhand typed SECRET-WORDS\n`);
    const chosen = await choosePacks(dir, 'acme/repo-a');
    // The fixture's generic pack has its own malformed-repository errors; none is about the unreadable line.
    expect(chosen.errors.filter((e) => e.message.includes('mine'))).toEqual([]);
    expect(chosen.notes).toEqual(['A learned line could not be read and was left out: mine/learned/wrong.md:2.']);
    expect(JSON.stringify(chosen.notes)).not.toMatch(/SECRET-WORDS|\/tmp|\/var\//);
    expect(seenBy(chosen.packs).lenses).toContain(NAMED);
  });

  it('has no notes when every line reads, and none for a pack that was not selected', async () => {
    const dir = await packsFolder();
    expect((await choosePacks(dir, 'acme/repo-a')).notes).toEqual([]);
    await writeFile(join(dir, 'mine', 'learned', 'wrong.md'), 'junk\n');
    expect((await choosePacks(dir, 'acme/repo-b')).notes).toEqual([]);
  });
});
