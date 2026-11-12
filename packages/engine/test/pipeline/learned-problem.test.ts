import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKS_DIR, useReviewHarness } from '../helpers/review-scenario.js';

const SLOW = 20_000;
const { review } = useReviewHarness();

describe('a review whose pack has an unreadable learned line', () => {
  it('goes ahead with the pack, says so in the notes, and is not incomplete for that', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airlock-bad-learned-'));
    await cp(PACKS_DIR, dir, { recursive: true });
    await mkdir(join(dir, 'core', 'learned'), { recursive: true });
    const file = join(dir, 'core', 'learned', 'wrong.md');
    await writeFile(file, '2026-11-01 · - · A good line that reads fine and says dates are kept in UTC.\nSECRET-WORDS typed by hand\n');
    const before = await readFile(file, 'utf8');

    const { doc } = await review({ req: { packsDir: dir } });

    const sentence = 'A learned line could not be read and was left out: core/learned/wrong.md:2.';
    expect(doc.notes?.[0]).toBe(sentence);
    expect((doc.notes ?? []).filter((n) => n.includes('learned line'))).toEqual([sentence]);
    expect(doc.stageErrors.filter((e) => e.stage === 'packs')).toEqual([]);
    expect(doc.verdict.label).not.toBe('incomplete');
    expect(doc.packs.map((p) => p.id)).toContain('core');
    expect(JSON.stringify(doc.notes)).not.toContain('SECRET-WORDS');
    expect(JSON.stringify(doc.notes)).not.toContain(dir);
    expect(await readFile(file, 'utf8')).toBe(before);
  }, SLOW);
});
