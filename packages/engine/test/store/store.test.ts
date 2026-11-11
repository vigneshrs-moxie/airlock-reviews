import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { minimalDocument, type ReviewDocument } from '@airlock/shared';
import { latestReview, saveReview } from '../../src/store/store.js';

let home: string;
let saved: string | undefined;
beforeEach(async () => {
  saved = process.env.AIRLOCK_HOME;
  home = await mkdtemp(join(tmpdir(), 'airlock-store-'));
  process.env.AIRLOCK_HOME = home;
});
afterEach(async () => {
  if (saved === undefined) delete process.env.AIRLOCK_HOME;
  else process.env.AIRLOCK_HOME = saved;
  await rm(home, { recursive: true, force: true });
});

const HEAD = 'b'.repeat(40);
const OTHER_HEAD = 'c'.repeat(40);

function doc(id: string, createdAt: string, headSha = HEAD, repo = 'acme/widgets'): ReviewDocument {
  const d = minimalDocument();
  return { ...d, id, createdAt, pr: { ...d.pr, repo, headSha } };
}

const folder = (): string => join(home, 'reviews', 'acme__widgets', '1');

describe('saveReview', () => {
  it('writes the document under the repository, number, head and id, and leaves no temporary file', async () => {
    const d = doc('r_0123456789', '2026-11-10T00:00:00.000Z');
    const path = await saveReview(d);
    expect(path).toBe(join(folder(), `${HEAD}-r_0123456789.json`));
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(d);
    expect(await readdir(folder())).toEqual([`${HEAD}-r_0123456789.json`]);
  });

  it('turns every character outside letters, digits, dot, dash and underscore of the repository into _', async () => {
    const path = await saveReview(doc('r_0123456789', '2026-11-10T00:00:00.000Z', HEAD, 'acme co/wid gets+1'));
    expect(path).toBe(join(home, 'reviews', 'acme_co__wid_gets_1', '1', `${HEAD}-r_0123456789.json`));
  });

  it('refuses a head or an id that is not safe as a file name, and an invalid document', async () => {
    await expect(saveReview(doc('r_0123456789', 'x', '../../etc'))).rejects.toThrow(/head/);
    await expect(saveReview(doc('r_0123456789', 'x', 'abc12'))).rejects.toThrow(/head/);
    await expect(saveReview(doc('r_0123456789', 'x', 'g'.repeat(40)))).rejects.toThrow(/head/);
    await expect(saveReview(doc('../r_0123456789', 'x'))).rejects.toThrow(/id/);
    await expect(saveReview(doc('r_012345678', 'x'))).rejects.toThrow(/id/);
    await expect(saveReview(doc('review-1', 'x'))).rejects.toThrow(/id/);
    await expect(saveReview({ ...doc('r_0123456789', 'x'), schemaVersion: 2 } as unknown as ReviewDocument)).rejects.toThrow();
  });

  it('accepts a short head of 7 characters', async () => {
    const path = await saveReview(doc('r_0123456789', 'x', 'abc1234'));
    expect(path.endsWith('abc1234-r_0123456789.json')).toBe(true);
  });
});

describe('latestReview', () => {
  it('returns null when nothing was saved for the pull request', async () => {
    expect(await latestReview('acme/widgets', 1)).toBeNull();
    expect(await latestReview('acme/widgets', 1, HEAD)).toBeNull();
  });

  it('returns the most recently created document, by createdAt, optionally for one head', async () => {
    await saveReview(doc('r_000000000a', '2026-11-10T09:00:00.000Z'));
    await saveReview(doc('r_000000000b', '2026-11-10T11:00:00.000Z'));
    await saveReview(doc('r_000000000c', '2026-11-10T10:00:00.000Z', OTHER_HEAD));
    await saveReview(doc('r_000000000d', '2026-11-10T08:00:00.000Z'));
    expect((await latestReview('acme/widgets', 1))?.id).toBe('r_000000000b');
    expect((await latestReview('acme/widgets', 1, OTHER_HEAD))?.id).toBe('r_000000000c');
    expect((await latestReview('acme/widgets', 1, HEAD))?.id).toBe('r_000000000b');
    expect(await latestReview('acme/widgets', 1, 'd'.repeat(40))).toBeNull();
    expect(await latestReview('acme/widgets', 2)).toBeNull();
  });

  it('falls back to the file time when createdAt is not a date', async () => {
    const older = await saveReview(doc('r_000000000a', 'not a date'));
    const newer = await saveReview(doc('r_000000000b', 'also not a date'));
    await utimes(older, new Date('2026-11-10T12:00:00Z'), new Date('2026-11-10T12:00:00Z'));
    await utimes(newer, new Date('2026-11-09T12:00:00Z'), new Date('2026-11-09T12:00:00Z'));
    expect((await latestReview('acme/widgets', 1))?.id).toBe('r_000000000a');
  });

  it('skips files that do not parse or do not match the schema, and never throws', async () => {
    await saveReview(doc('r_000000000a', '2026-11-10T09:00:00.000Z'));
    await writeFile(join(folder(), `${HEAD}-r_00000000ff.json`), '{ not json');
    await writeFile(join(folder(), `${HEAD}-r_00000000ee.json`), JSON.stringify({ ...doc('r_00000000ee', '2027-01-01T00:00:00.000Z'), verdict: 'nope' }));
    await mkdir(join(folder(), `${HEAD}-r_00000000dd.json`));
    await writeFile(join(folder(), 'notes.txt'), 'hello');
    expect((await latestReview('acme/widgets', 1))?.id).toBe('r_000000000a');
    await writeFile(join(folder(), `${HEAD}-r_000000000a.json`), 'broken now');
    expect(await latestReview('acme/widgets', 1)).toBeNull();
  });
});
