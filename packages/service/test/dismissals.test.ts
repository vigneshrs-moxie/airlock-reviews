import { chmod, mkdir, symlink, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPack, saveReview, type EngineDeps, type Pack } from '@airlock/engine';
import {
  candidate, DismissalSchema, LatestReplySchema, minimalDocument, RestoreReplySchema, type Dismissal, type Finding, type ReviewDocument,
} from '@airlock/shared';
import { readOrCreateToken } from '../src/config.js';
import { assertWritable, dismiss, learnedTarget } from '../src/dismissals.js';
import { createServer } from '../src/server.js';
import { FakeClock, send, type Reply } from './helpers.js';

const REPO = 'acme/widgets';
const ELSEWHERE = 'someone/else';
const REVIEW = 'r_0123456789';
const FINDING_A = 'c_aaaaaaaa';
const FINDING_B = 'c_bbbbbbbb';
const FP_A = '1111111111111111';
const FP_B = '2222222222222222';
const TEXT = 'The totals are rounded by the caller on purpose.';
const NOT_FOUND = { error: 'Airlock cannot find that finding in the stored review.' };

const savedHome = process.env['AIRLOCK_HOME'];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  if (savedHome === undefined) delete process.env['AIRLOCK_HOME'];
  else process.env['AIRLOCK_HOME'] = savedHome;
});

const finding = (id: string, fingerprint: string): Finding => ({
  ...candidate(), id, fingerprint, checked: 'checked', bucket: 'top', rank: 1, status: null,
  anchor: { status: 'in-diff', startLine: 12, endLine: 12 },
});

function review(repo = REPO, number = 7, id = REVIEW): ReviewDocument {
  const base = minimalDocument();
  return {
    ...base, id, pr: { ...base.pr, repo, number },
    findings: [finding(FINDING_A, FP_A), { ...finding(FINDING_B, FP_B), bucket: 'also', rank: null }],
  };
}

async function writePack(packsDir: string, name: string, yaml: string): Promise<void> {
  await mkdir(join(packsDir, name), { recursive: true });
  await mkdir(join(packsDir, name, 'lenses'), { recursive: true });
  await writeFile(join(packsDir, name, 'lenses', 'look.md'), 'Look closely.\n');
  await writeFile(join(packsDir, name, 'pack.yaml'), `${yaml}lenses:\n  - { id: look, title: Look, file: lenses/look.md }\n`);
}

interface Rig {
  home: string; packsDir: string; port: number; clock: FakeClock; log: string[];
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply>;
  dismissBody(over?: Record<string, unknown>): Record<string, unknown>;
  post(body: Record<string, unknown>): Promise<Reply>;
  restoreBody(fingerprint?: string): Record<string, unknown>;
  file(pack: string, name: string): Promise<string | null>;
  dismissalsFile(repo?: string, number?: number): string;
}

async function startService(): Promise<Rig> {
  const home = await mkdtemp(join(tmpdir(), 'airlock-service-dismissals-'));
  process.env['AIRLOCK_HOME'] = home;
  const packsDir = join(home, 'packs');
  await writePack(packsDir, 'generic', 'id: generic\ntitle: Generic\nrepos: []\n');
  await writePack(packsDir, 'raj-standard', `id: raj-standard\ntitle: Raj standard\nrepos: [${REPO}]\n`);
  await writePack(packsDir, 'acme', `id: acme\ntitle: Acme pack\nrepos: [${REPO}]\n`);
  await saveReview(review());
  await saveReview(review(ELSEWHERE, 9, 'r_9999999999'));
  const clock = new FakeClock();
  const log: string[] = [];
  const engine: EngineDeps = {
    exec: async () => { throw new Error('no commands are run in these tests'); },
    runner: { run: () => { throw new Error('the runner is not used in these tests'); } },
    now: clock.date,
  };
  const service = createServer({ config: { port: 0, home, packsDir, version: '1.2.3' }, engine, now: clock.date, log: (l) => log.push(l), timers: clock.timers });
  const { port } = await service.listen();
  const token = await readOrCreateToken(home);
  cleanups.push(async () => { await service.close(); await rm(home, { recursive: true, force: true }); });
  const call: Rig['call'] = (method, path, body, headers) => send(port, method, path, body === undefined
    ? { headers: headers ?? { Authorization: `Bearer ${token}` } }
    : { headers: { ...(headers ?? { Authorization: `Bearer ${token}` }), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return {
    home, packsDir, port, clock, log, call,
    dismissBody: (over = {}) => ({ repo: REPO, number: 7, reviewId: REVIEW, findingId: FINDING_A, reason: 'wrong', text: TEXT, ...over }),
    post: (body) => call('POST', '/dismissals', body),
    restoreBody: (fingerprint = FP_A) => ({ repo: REPO, number: 7, fingerprint }),
    file: (pack, name) => readFile(join(packsDir, pack, 'learned', name), 'utf8').catch(() => null),
    dismissalsFile: (repo = REPO, number = 7) => join(home, 'dismissals', repo.replace('/', '__'), `${number}.json`),
  };
}

describe('POST /dismissals', () => {
  it('not-now records the dismissal and writes no learned entry, whatever the text holds', async () => {
    const s = await startService();
    const r = await s.post(s.dismissBody({ reason: 'not-now', text: 'Teach every later review to ignore totals.' }));
    expect(r.status).toBe(200);
    expect(DismissalSchema.parse(r.json)).toMatchObject({ fingerprint: FP_A, findingId: FINDING_A, reviewId: REVIEW, reason: 'not-now', learned: null });
    expect(JSON.parse(await readFile(s.dismissalsFile(), 'utf8'))).toEqual([r.json]);
    for (const pack of await readdir(s.packsDir)) expect(await readdir(join(s.packsDir, pack))).toEqual(['lenses', 'pack.yaml']);
  });

  it('not-now with empty text is accepted', async () => {
    const s = await startService();
    expect((await s.post(s.dismissBody({ reason: 'not-now', text: '' }))).status).toBe(200);
  });

  it('wrong appends one dated line to the target pack wrong.md with exactly the given text', async () => {
    const s = await startService();
    const r = await s.post(s.dismissBody());
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      fingerprint: FP_A, findingId: FINDING_A, reviewId: REVIEW, reason: 'wrong', text: TEXT, at: s.clock.date().toISOString(),
      learned: { packId: 'acme', kind: 'wrong', date: '2026-11-11' },
    });
    // Byte for byte: the date, the repository and the text, nothing from the finding.
    expect(await s.file('acme', 'wrong.md')).toBe(`2026-11-11 · ${REPO} · ${TEXT}\n`);
    expect(await s.file('acme', 'product-knowledge.md')).toBeNull();
  });

  it('intended appends to product-knowledge.md', async () => {
    const s = await startService();
    const r = await s.post(s.dismissBody({ reason: 'intended', text: 'Rounding is the caller\'s job here.' }));
    expect((r.json as Dismissal).learned).toEqual({ packId: 'acme', kind: 'intended', date: '2026-11-11' });
    expect(await s.file('acme', 'product-knowledge.md')).toBe(`2026-11-11 · ${REPO} · Rounding is the caller's job here.\n`);
    expect(await s.file('acme', 'wrong.md')).toBeNull();
  });

  it("the target is the person's own pack for an Orbit repository and generic elsewhere, never raj-standard", async () => {
    const s = await startService();
    await s.post(s.dismissBody());
    expect(await s.file('raj-standard', 'wrong.md')).toBeNull();
    expect(await s.file('generic', 'wrong.md')).toBeNull();
    const other = await s.post(s.dismissBody({ repo: ELSEWHERE, number: 9, reviewId: 'r_9999999999' }));
    expect((other.json as Dismissal).learned?.packId).toBe('generic');
    expect(await s.file('generic', 'wrong.md')).toBe(`2026-11-11 · ${ELSEWHERE} · ${TEXT}\n`);
    expect(await s.file('raj-standard', 'wrong.md')).toBeNull();
  });

  it('learnedTarget skips the kit pack and generic, and falls back to generic, also when the kit is the only other pack', async () => {
    const s = await startService();
    const pack = async (id: string) => loadPack(join(s.packsDir, id));
    const [generic, kit, acme] = [await pack('generic'), await pack('raj-standard'), await pack('acme')];
    expect(learnedTarget([kit, acme, generic]).id).toBe('acme');
    expect(learnedTarget([kit, generic]).id).toBe('generic');
    expect(() => learnedTarget([kit])).toThrow();
  });

  it('refuses text with a line break, a control character, or under 10 characters for wrong', async () => {
    const s = await startService();
    for (const text of ['one line\nanother line', 'tab\there is bad', 'bell\u0007 in the text', 'too short', ' leading space is bad', 'x'.repeat(501)]) {
      const r = await s.post(s.dismissBody({ text }));
      expect(r.status, text).toBe(400);
    }
    expect((await s.post(s.dismissBody({ reason: 'intended', text: 'short' }))).status).toBe(400);
    expect(await s.file('acme', 'wrong.md')).toBeNull();
    await expect(readFile(s.dismissalsFile(), 'utf8')).rejects.toThrow();
  });

  it('dismiss itself refuses text that fails the check, before writing anything', async () => {
    const s = await startService();
    const deps = { config: { home: s.home, packsDir: s.packsDir }, now: s.clock.date, log: () => undefined };
    const body = { repo: REPO, number: 7, reviewId: REVIEW, findingId: FINDING_A, reason: 'wrong' as const };
    await expect(dismiss(deps, { ...body, text: 'one line\nanother line' })).rejects.toMatchObject({ status: 400 });
    expect(await s.file('acme', 'wrong.md')).toBeNull();
  });

  it('refuses a finding that is not in the stored review, a review that is not stored, and one for another pull request', async () => {
    const s = await startService();
    for (const over of [
      { findingId: 'c_cccccccc' }, { reviewId: 'r_0000000000' }, { number: 8 }, { repo: ELSEWHERE }, { number: 9, repo: ELSEWHERE },
    ]) {
      const r = await s.post(s.dismissBody(over));
      expect(r.status, JSON.stringify(over)).toBe(404);
      expect(r.json).toEqual(NOT_FOUND);
    }
    expect(await s.file('acme', 'wrong.md')).toBeNull();
    expect(await s.file('generic', 'wrong.md')).toBeNull();
  });

  it('the fingerprint comes from the finding, however the caller words the request', async () => {
    const s = await startService();
    const r = await s.post(s.dismissBody({ fingerprint: FP_B, findingId: FINDING_A }));
    expect((r.json as Dismissal).fingerprint).toBe(FP_A);
    const other = await s.post(s.dismissBody({ findingId: FINDING_B, fingerprint: FP_A }));
    expect((other.json as Dismissal).fingerprint).toBe(FP_B);
  });

  it('a second dismissal of the same fingerprint replaces the first and removes its learned line', async () => {
    const s = await startService();
    await s.post(s.dismissBody());
    expect(await s.file('acme', 'wrong.md')).toContain(TEXT);
    s.clock.advance(60_000);
    const second = await s.post(s.dismissBody({ reason: 'intended', text: 'The caller rounds, so this is fine.' }));
    expect(second.status).toBe(200);
    expect(await s.file('acme', 'wrong.md')).toBe('');
    expect(await s.file('acme', 'product-knowledge.md')).toBe(`2026-11-11 · ${REPO} · The caller rounds, so this is fine.\n`);
    const stored = JSON.parse(await readFile(s.dismissalsFile(), 'utf8')) as Dismissal[];
    expect(stored).toEqual([second.json]);
  });

  it('two dismissals of different findings sent together are both stored, and both lines written', async () => {
    const s = await startService();
    const [a, b] = await Promise.all([
      s.post(s.dismissBody()),
      s.post(s.dismissBody({ findingId: FINDING_B, text: 'The second finding is also fine.' })),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const stored = JSON.parse(await readFile(s.dismissalsFile(), 'utf8')) as Dismissal[];
    expect(stored.map((d) => d.fingerprint).sort()).toEqual([FP_A, FP_B]);
    const lines = (await s.file('acme', 'wrong.md'))!.split('\n').filter((l) => l !== '');
    expect(lines.sort()).toEqual([`2026-11-11 · ${REPO} · ${TEXT}`, `2026-11-11 · ${REPO} · The second finding is also fine.`].sort());
  });

  it('the appended entry is read back by loadPack as a learned entry', async () => {
    const s = await startService();
    await s.post(s.dismissBody());
    await s.post(s.dismissBody({ findingId: FINDING_B, reason: 'intended', text: 'This is how the product works.' }));
    const pack = await loadPack(join(s.packsDir, 'acme'));
    expect(pack.learned).toEqual(expect.arrayContaining([
      { date: '2026-11-11', repo: REPO, kind: 'wrong', text: TEXT },
      { date: '2026-11-11', repo: REPO, kind: 'intended', text: 'This is how the product works.' },
    ]));
    expect(pack.learned).toHaveLength(2);
  });

  it('refuses a target pack whose folder is not directly inside the packs folder, however it is reached', async () => {
    const s = await startService();
    const outside = await mkdtemp(join(tmpdir(), 'airlock-outside-pack-'));
    cleanups.push(async () => { await rm(outside, { recursive: true, force: true }); });
    await writePack(outside, 'elsewhere', `id: elsewhere\ntitle: Elsewhere\nrepos: [${REPO}]\n`);
    await mkdir(join(s.packsDir, 'nested'), { recursive: true });
    await writePack(join(s.packsDir, 'nested'), 'deeper', 'id: deeper\ntitle: Deeper\nrepos: []\n');
    await symlink(join(outside, 'elsewhere'), join(s.packsDir, 'linked'));
    const load = (dir: string): Promise<Pack> => loadPack(dir);
    for (const dir of [join(outside, 'elsewhere'), join(s.packsDir, 'nested', 'deeper'), join(s.packsDir, 'linked')]) {
      await expect(assertWritable(await load(dir), s.packsDir), dir).rejects.toThrow(/will not write/);
    }
    await expect(assertWritable(await load(join(s.packsDir, 'raj-standard')), s.packsDir)).rejects.toThrow(/will not write/);
    await expect(assertWritable(await load(join(s.packsDir, 'acme')), s.packsDir)).resolves.toBeUndefined();
  });

  it('a broken dismissals file is set aside, not overwritten', async () => {
    const s = await startService();
    await mkdir(join(s.home, 'dismissals', 'acme__widgets'), { recursive: true });
    await writeFile(s.dismissalsFile(), '{ not json');
    const r = await s.post(s.dismissBody({ reason: 'not-now', text: '' }));
    expect(r.status).toBe(200);
    const names = await readdir(join(s.home, 'dismissals', 'acme__widgets'));
    const aside = names.filter((n) => n.startsWith('7.json.broken-'));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(s.home, 'dismissals', 'acme__widgets', aside[0]!), 'utf8')).toBe('{ not json');
    expect(JSON.parse(await readFile(s.dismissalsFile(), 'utf8'))).toEqual([r.json]);
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('a failure while saving the dismissals takes the new line out of the pack again', async () => {
    const s = await startService();
    // A folder that cannot be written to makes the last step fail, after the line was appended.
    const folder = join(s.home, 'dismissals', 'acme__widgets');
    await mkdir(folder, { recursive: true });
    await chmod(folder, 0o500);
    cleanups.unshift(() => chmod(folder, 0o700));
    const r = await s.post(s.dismissBody());
    expect(r.status).toBe(500);
    expect(await s.file('acme', 'wrong.md')).toBe('');
  });
});

describe('POST /dismissals/restore', () => {
  it('removes the dismissal and the learned line it wrote', async () => {
    const s = await startService();
    await s.post(s.dismissBody());
    await s.post(s.dismissBody({ findingId: FINDING_B, text: 'The second finding is also fine.' }));
    const r = await s.call('POST', '/dismissals/restore', s.restoreBody());
    expect(r.status).toBe(200);
    expect(RestoreReplySchema.parse(r.json)).toEqual({ restored: true, note: null });
    expect(await s.file('acme', 'wrong.md')).toBe(`2026-11-11 · ${REPO} · The second finding is also fine.\n`);
    const stored = JSON.parse(await readFile(s.dismissalsFile(), 'utf8')) as Dismissal[];
    expect(stored.map((d) => d.fingerprint)).toEqual([FP_B]);
  });

  it('still removes the dismissal when the learned line was edited by hand, and says so', async () => {
    const s = await startService();
    await s.post(s.dismissBody());
    await writeFile(join(s.packsDir, 'acme', 'learned', 'wrong.md'), `2026-11-11 · ${REPO} · ${TEXT} (edited)\n`);
    const r = await s.call('POST', '/dismissals/restore', s.restoreBody());
    expect(r.json).toEqual({
      restored: true,
      note: "The saved line was no longer in Acme pack's wrong.md; nothing was removed from the pack.",
    });
    expect(await s.file('acme', 'wrong.md')).toBe(`2026-11-11 · ${REPO} · ${TEXT} (edited)\n`);
    expect(JSON.parse(await readFile(s.dismissalsFile(), 'utf8'))).toEqual([]);
  });

  it('restoring a not-now dismissal touches no pack, and an unknown fingerprint says restored false', async () => {
    const s = await startService();
    await s.post(s.dismissBody({ reason: 'not-now', text: '' }));
    expect((await s.call('POST', '/dismissals/restore', s.restoreBody())).json).toEqual({ restored: true, note: null });
    expect((await s.call('POST', '/dismissals/restore', s.restoreBody())).json).toEqual({ restored: false, note: null });
    expect((await s.call('POST', '/dismissals/restore', s.restoreBody(FP_B))).json).toEqual({ restored: false, note: null });
    for (const pack of await readdir(s.packsDir)) expect(await readdir(join(s.packsDir, pack))).toEqual(['lenses', 'pack.yaml']);
  });
});

describe('GET /reviews/latest and the front door', () => {
  it('returns the dismissal after it is made and not after it is restored', async () => {
    const s = await startService();
    const latest = async (): Promise<Dismissal[]> => {
      const r = await s.call('GET', `/reviews/latest?repo=${REPO}&number=7`);
      expect(r.status).toBe(200);
      return LatestReplySchema.parse(r.json).dismissals;
    };
    expect(await latest()).toEqual([]);
    const made = await s.post(s.dismissBody());
    expect(await latest()).toEqual([made.json]);
    await s.call('POST', '/dismissals/restore', s.restoreBody());
    expect(await latest()).toEqual([]);
  });

  it('both routes are 401 without the token, and write nothing', async () => {
    const s = await startService();
    const bare = { Host: `127.0.0.1:${s.port}` };
    expect((await s.call('POST', '/dismissals', s.dismissBody(), bare)).status).toBe(401);
    expect((await s.call('POST', '/dismissals/restore', s.restoreBody(), bare)).status).toBe(401);
    expect(await s.file('acme', 'wrong.md')).toBeNull();
    await expect(readFile(s.dismissalsFile(), 'utf8')).rejects.toThrow();
  });

  it('refuses a foreign Origin and a rebinding Host even with the token', async () => {
    const s = await startService();
    const token = await readOrCreateToken(s.home);
    const auth = { Authorization: `Bearer ${token}` };
    expect((await s.call('POST', '/dismissals', s.dismissBody(), { ...auth, Origin: 'https://evil.example' })).status).toBe(403);
    expect((await s.call('POST', '/dismissals', s.dismissBody(), { ...auth, Host: 'evil.example' })).status).toBe(403);
    expect(await s.file('acme', 'wrong.md')).toBeNull();
  });
});
