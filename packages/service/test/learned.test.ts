import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveReview, type EngineDeps } from '@airlock/engine';
import {
  candidate, DismissalSchema, LearnedReplySchema, minimalDocument, RemoveLearnedReplySchema, type Dismissal, type Finding, type LearnedLine,
  type ReviewDocument,
} from '@airlock/shared';
import { pair, readOrCreateToken } from '../src/config.js';
import { dismissalsFolder } from '../src/dismissals.js';
import { createServer } from '../src/server.js';
import { FakeClock, send, type Reply } from './helpers.js';

const REPO = 'acme/widgets';
const OTHER = 'someone/else';
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const REVIEW = 'r_0123456789';
const FINDING = 'c_aaaaaaaa';
const FP = '1111111111111111';
const FINDING_2 = 'c_bbbbbbbb';
const FP_2 = '2222222222222222';
const TEXT = 'The totals are rounded by the caller on purpose.';

const savedHome = process.env['AIRLOCK_HOME'];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  if (savedHome === undefined) delete process.env['AIRLOCK_HOME'];
  else process.env['AIRLOCK_HOME'] = savedHome;
});

const key = (kind: string, date: string, repo: string, text: string): string =>
  createHash('sha256').update([kind, date, repo, text].join('\n')).digest('hex').slice(0, 16);

function review(): ReviewDocument {
  const base = minimalDocument();
  const finding = (id: string, fingerprint: string, rank: number): Finding => ({
    ...candidate(), id, fingerprint, checked: 'checked', bucket: 'top', rank, status: null,
    anchor: { status: 'in-diff', startLine: 12, endLine: 12 },
  });
  return { ...base, id: REVIEW, pr: { ...base.pr, repo: REPO, number: 7 }, findings: [finding(FINDING, FP, 1), finding(FINDING_2, FP_2, 2)] };
}

async function writePack(packsDir: string, name: string, yaml: string, learned: Record<string, string> = {}): Promise<void> {
  await mkdir(join(packsDir, name, 'lenses'), { recursive: true });
  await writeFile(join(packsDir, name, 'lenses', 'look.md'), 'Look closely.\n');
  await writeFile(join(packsDir, name, 'pack.yaml'), `${yaml}lenses:\n  - { id: look, title: Look, file: lenses/look.md }\n`);
  if (Object.keys(learned).length > 0) await mkdir(join(packsDir, name, 'learned'), { recursive: true });
  for (const [file, text] of Object.entries(learned)) await writeFile(join(packsDir, name, 'learned', file), text);
}

async function startService() {
  const home = await mkdtemp(join(tmpdir(), 'airlock-service-learned-'));
  process.env['AIRLOCK_HOME'] = home;
  const packsDir = join(home, 'packs');
  await writePack(packsDir, 'generic', 'id: generic\ntitle: Generic\nrepos: []\n', {
    'wrong.md': `2026-11-01 · ${REPO} · Here line.\n2026-11-03 · ${OTHER} · Elsewhere line.\n2026-11-02 · - · Hand written line.\n`,
  });
  await writePack(packsDir, 'raj-standard', `id: raj-standard\ntitle: Raj standard\nrepos: [${REPO}]\n`, {
    'product-knowledge.md': `2026-10-01 · ${REPO} · Kit knowledge line.\n`,
  });
  await writePack(packsDir, 'acme', `id: acme\ntitle: Acme pack\nrepos: [${REPO}]\n`, {
    'wrong.md': `# notes\n2026-11-05 · ${REPO} · Acme wrong line.\n`,
    'product-knowledge.md': `2026-11-04 · ${REPO} · Acme knowledge line.\n`,
  });
  await saveReview(review());
  const clock = new FakeClock();
  const logs: string[] = [];
  const engine: EngineDeps = {
    exec: async () => { throw new Error('no commands are run in these tests'); },
    runner: { run: () => { throw new Error('the runner is not used in these tests'); } },
    now: clock.date,
  };
  const service = createServer({ config: { port: 0, home, packsDir, version: '1.2.3' }, engine, now: clock.date, log: (line) => { logs.push(line); }, timers: clock.timers });
  const { port } = await service.listen();
  const token = await readOrCreateToken(home);
  await pair(home, ORIGIN);
  cleanups.push(async () => { await service.close(); await rm(home, { recursive: true, force: true }); });
  const auth = { Authorization: `Bearer ${token}`, Origin: ORIGIN };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = auth): Promise<Reply> =>
    send(port, method, path, body === undefined ? { headers } : { headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const lines = async (repo = REPO): Promise<LearnedLine[]> => LearnedReplySchema.parse((await call('GET', `/learned?repo=${repo}`)).json).lines;
  const file = (pack: string, name: string): Promise<string> => readFile(join(packsDir, pack, 'learned', name), 'utf8');
  const dismissals = async (): Promise<Dismissal[]> =>
    ((await call('GET', `/reviews/latest?repo=${REPO}&number=7`)).json as { dismissals: Dismissal[] }).dismissals;
  const dismissOne = (findingId: string, text = TEXT, reason = 'wrong') =>
    call('POST', '/dismissals', { repo: REPO, number: 7, reviewId: REVIEW, findingId, reason, text });
  return { home, packsDir, call, lines, file, clock, token, logs, dismissals, dismissOne };
}

describe('GET /learned', () => {
  it('lists the lines of the chosen packs, newest first, with appliesHere and removable', async () => {
    const s = await startService();
    const r = await s.call('GET', `/learned?repo=${REPO}`);
    expect(r.status).toBe(200);
    const reply = LearnedReplySchema.parse(r.json);
    expect(reply.cap).toBe(300);
    expect(reply.lines.map((l) => [l.pack, l.kind, l.date, l.repo, l.text, l.appliesHere, l.removable])).toEqual([
      ['acme', 'wrong', '2026-11-05', REPO, 'Acme wrong line.', true, true],
      ['acme', 'product-knowledge', '2026-11-04', REPO, 'Acme knowledge line.', true, true],
      ['generic', 'wrong', '2026-11-03', OTHER, 'Elsewhere line.', false, true],
      ['generic', 'wrong', '2026-11-02', null, 'Hand written line.', true, true],
      ['generic', 'wrong', '2026-11-01', REPO, 'Here line.', true, true],
      ['raj-standard', 'product-knowledge', '2026-10-01', REPO, 'Kit knowledge line.', true, false],
    ]);
    expect(reply.lines[0]).toMatchObject({ packTitle: 'Acme pack', key: key('wrong', '2026-11-05', REPO, 'Acme wrong line.') });
    expect(reply.lines[3]!.key).toBe(key('wrong', '2026-11-02', '-', 'Hand written line.'));
  });

  it('a malformed line does not hide its pack: the good lines are listed and removable, and the log names the file and line', async () => {
    const s = await startService();
    const wrong = join(s.packsDir, 'acme', 'learned', 'wrong.md');
    const good = `2026-11-07 · ${REPO} · Good after.`;
    await writeFile(wrong, [
      '# notes', `2026-11-05 · ${REPO} · Acme wrong line.`, 'This is not a learned line, SECRET.', good,
      '2026-11-08 · not a repository · Also SECRET.', '',
    ].join('\n'));
    const lines = await s.lines();
    expect(lines.filter((l) => l.pack === 'acme').map((l) => [l.kind, l.text])).toEqual([
      ['wrong', 'Good after.'], ['wrong', 'Acme wrong line.'], ['product-knowledge', 'Acme knowledge line.'],
    ]);
    expect(lines.some((l) => l.pack === 'generic')).toBe(true);
    // Each malformed line once for the request, by the engine's entry for it (pack, file and line number), never its
    // text and never an absolute path.
    expect(s.logs.filter((l) => l.includes('acme/learned/wrong.md:3'))).toHaveLength(1);
    expect(s.logs.filter((l) => l.includes('acme/learned/wrong.md:5'))).toHaveLength(1);
    expect(s.logs.join('\n')).not.toContain('SECRET');
    expect(s.logs.join('\n')).not.toContain(s.home);
    expect(s.logs.join('\n')).not.toContain(wrong);
    // Listing the lines leaves the pack itself as it was.
    expect(await readFile(join(s.packsDir, 'acme', 'pack.yaml'), 'utf8')).toContain('id: acme');
    expect(await readFile(join(s.packsDir, 'acme', 'lenses', 'look.md'), 'utf8')).toBe('Look closely.\n');

    const target = lines.find((l) => l.text === 'Good after.')!;
    const r = await s.call('POST', '/learned/remove', { repo: REPO, pack: target.pack, kind: target.kind, key: target.key });
    expect(r.json).toEqual({ removed: true, note: null });
    expect(await s.file('acme', 'wrong.md')).toBe([
      '# notes', `2026-11-05 · ${REPO} · Acme wrong line.`, 'This is not a learned line, SECRET.',
      '2026-11-08 · not a repository · Also SECRET.', '',
    ].join('\n'));
    expect(s.logs.join('\n')).not.toContain('SECRET');
  });

  it('logs a malformed line of the pack used for every repository by its entry, never its text or path', async () => {
    const s = await startService();
    const wrong = join(s.packsDir, 'generic', 'learned', 'wrong.md');
    await writeFile(wrong, `2026-11-01 · ${REPO} · Here line.\nNot a line, SECRET.\n2026-11-02 · not a repository SECRET · Bad field.\n`);
    const lines = await s.lines();
    expect(lines.filter((l) => l.pack === 'generic').map((l) => l.text)).toEqual(['Here line.']);
    expect(s.logs.filter((l) => l.includes('generic/learned/wrong.md:2'))).toHaveLength(1);
    expect(s.logs.filter((l) => l.includes('generic/learned/wrong.md:3'))).toHaveLength(1);
    expect(s.logs.join('\n')).not.toContain('SECRET');
    expect(s.logs.join('\n')).not.toContain(s.home);
  });

  it('refuses a missing or malformed repo', async () => {
    const s = await startService();
    expect((await s.call('GET', '/learned')).status).toBe(400);
    expect((await s.call('GET', '/learned?repo=nope')).status).toBe(400);
  });
});

describe('POST /learned/remove', () => {
  const body = (l: LearnedLine, over: Record<string, unknown> = {}) => ({ repo: REPO, pack: l.pack, kind: l.kind, key: l.key, ...over });

  it('deletes exactly the keyed line and clears the dismissal link, leaving the finding dismissed', async () => {
    const s = await startService();
    const made = await s.call('POST', '/dismissals', { repo: REPO, number: 7, reviewId: REVIEW, findingId: FINDING, reason: 'wrong', text: TEXT });
    expect(made.status).toBe(200);
    expect(DismissalSchema.parse(made.json).learned).toMatchObject({ packId: 'acme', kind: 'wrong' });
    const target = (await s.lines()).find((l) => l.text === TEXT)!;
    const r = await s.call('POST', '/learned/remove', body(target));
    expect(r.status).toBe(200);
    expect(RemoveLearnedReplySchema.parse(r.json)).toEqual({ removed: true, note: null });
    expect(await s.file('acme', 'wrong.md')).toBe(`# notes\n2026-11-05 · ${REPO} · Acme wrong line.\n`);
    const latest = (await s.call('GET', `/reviews/latest?repo=${REPO}&number=7`)).json as { dismissals: Dismissal[] };
    expect(latest.dismissals).toHaveLength(1);
    expect(latest.dismissals[0]).toMatchObject({ fingerprint: FP, reason: 'wrong', text: TEXT, learned: null });
    expect((await s.lines()).some((l) => l.text === TEXT)).toBe(false);

    // A restore after the link was cleared leaves the pack alone, even when the same line is back in the file.
    const again = `# notes\n2026-11-05 · ${REPO} · Acme wrong line.\n${DismissalSchema.parse(made.json).learned!.date} · ${REPO} · ${TEXT}\n`;
    await writeFile(join(s.packsDir, 'acme', 'learned', 'wrong.md'), again);
    expect((await s.call('POST', '/dismissals/restore', { repo: REPO, number: 7, fingerprint: FP })).json).toEqual({ restored: true, note: null });
    expect(await s.file('acme', 'wrong.md')).toBe(again);
    expect(await s.dismissals()).toEqual([]);
  });

  it('of two identical lines, removes the first and leaves the other', async () => {
    const s = await startService();
    const twice = `2026-11-05 · ${REPO} · Twice line.`;
    await writeFile(join(s.packsDir, 'acme', 'learned', 'wrong.md'), `# notes\n${twice}\n2026-11-06 · ${REPO} · Between.\n${twice}\n`);
    const both = (await s.lines()).filter((l) => l.text === 'Twice line.');
    expect(both).toHaveLength(2);
    expect(both[0]!.key).toBe(both[1]!.key);
    expect((await s.call('POST', '/learned/remove', body(both[0]!))).json).toEqual({ removed: true, note: null });
    expect(await s.file('acme', 'wrong.md')).toBe(`# notes\n2026-11-06 · ${REPO} · Between.\n${twice}\n`);
  });

  it('with an identical line written by hand, takes the first out and clears exactly one link, the oldest dismissal\'s', async () => {
    const s = await startService();
    const d = s.clock.date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const line = `${today} · ${REPO} · ${TEXT}`;
    const other = `2026-11-05 · ${REPO} · Acme wrong line.`;
    await writeFile(join(s.packsDir, 'acme', 'learned', 'wrong.md'), `# notes\n${line}\n${other}\n`);
    // The older dismissal is on pull request 7 and the newer on 10, so the oldest is not simply the first file read.
    const LATER = 'r_1000000000';
    await saveReview({ ...review(), id: LATER, pr: { ...review().pr, number: 10 } });
    expect((await s.dismissOne(FINDING)).status).toBe(200);
    s.clock.now += 60_000;
    const later = await s.call('POST', '/dismissals', { repo: REPO, number: 10, reviewId: LATER, findingId: FINDING_2, reason: 'wrong', text: TEXT });
    expect(later.status).toBe(200);
    expect(await s.file('acme', 'wrong.md')).toBe(`# notes\n${line}\n${other}\n${line}\n${line}\n`);

    const target = (await s.lines()).find((l) => l.text === TEXT)!;
    expect((await s.call('POST', '/learned/remove', body(target))).json).toEqual({ removed: true, note: null });
    expect(await s.file('acme', 'wrong.md')).toBe(`# notes\n${other}\n${line}\n${line}\n`);
    expect((await s.dismissals())[0]?.learned).toBeNull();
    const onTen = async (): Promise<Dismissal[]> =>
      ((await s.call('GET', `/reviews/latest?repo=${REPO}&number=10`)).json as { dismissals: Dismissal[] }).dismissals;
    expect((await onTen())[0]?.learned).toMatchObject({ packId: 'acme', kind: 'wrong', date: today });

    // The other dismissal still finds its own line; the cleared one then takes nothing out.
    expect((await s.call('POST', '/dismissals/restore', { repo: REPO, number: 10, fingerprint: FP_2 })).json).toEqual({ restored: true, note: null });
    expect(await s.file('acme', 'wrong.md')).toBe(`# notes\n${other}\n${line}\n`);
    expect((await s.call('POST', '/dismissals/restore', { repo: REPO, number: 7, fingerprint: FP })).json).toEqual({ restored: true, note: null });
    expect(await s.file('acme', 'wrong.md')).toBe(`# notes\n${other}\n${line}\n`);
  });

  it('removes a line with white space at its ends by its stored form, and leaves the same line without it', async () => {
    const s = await startService();
    const plain = `2026-11-05 · ${REPO} · Spaced line.`;
    await writeFile(join(s.packsDir, 'acme', 'learned', 'wrong.md'), `# notes\n${plain}\n${plain}   \n2026-11-06 · ${REPO} ·  Leading space.\n`);
    const spaced = (await s.lines()).find((l) => l.text === 'Spaced line.   ')!;
    expect((await s.call('POST', '/learned/remove', body(spaced))).json).toEqual({ removed: true, note: null });
    expect(await s.file('acme', 'wrong.md')).toBe(`# notes\n${plain}\n2026-11-06 · ${REPO} ·  Leading space.\n`);
    const leading = (await s.lines()).find((l) => l.text === ' Leading space.')!;
    expect((await s.call('POST', '/learned/remove', body(leading))).json).toEqual({ removed: true, note: null });
    expect(await s.file('acme', 'wrong.md')).toBe(`# notes\n${plain}\n`);
  });

  it('reads the dismissals of other pull requests without setting an unreadable one aside', async () => {
    const s = await startService();
    expect((await s.dismissOne(FINDING)).status).toBe(200);
    const folder = await dismissalsFolder(s.home, REPO);
    await writeFile(join(folder, '99.json'), 'not json');
    const target = (await s.lines()).find((l) => l.text === TEXT)!;
    expect((await s.call('POST', '/learned/remove', body(target))).json).toEqual({ removed: true, note: null });
    expect(await readFile(join(folder, '99.json'), 'utf8')).toBe('not json');
    expect((await readdir(folder)).sort()).toEqual(['7.json', '99.json']);
    expect((await s.dismissals())[0]?.learned).toBeNull();
  });

  it('removes only the line asked for and leaves other lines and files alone', async () => {
    const s = await startService();
    const lines = await s.lines();
    const here = lines.find((l) => l.text === 'Here line.')!;
    expect((await s.call('POST', '/learned/remove', body(here))).json).toEqual({ removed: true, note: null });
    expect(await s.file('generic', 'wrong.md')).toBe(`2026-11-03 · ${OTHER} · Elsewhere line.\n2026-11-02 · - · Hand written line.\n`);
    expect(await s.file('acme', 'product-knowledge.md')).toBe(`2026-11-04 · ${REPO} · Acme knowledge line.\n`);
  });

  it('says so and changes nothing when the line was edited by hand', async () => {
    const s = await startService();
    const line = (await s.lines()).find((l) => l.text === 'Acme wrong line.')!;
    const edited = `# notes\n2026-11-05 · ${REPO} · Acme wrong line, edited.\n`;
    await writeFile(join(s.packsDir, 'acme', 'learned', 'wrong.md'), edited);
    const r = await s.call('POST', '/learned/remove', body(line));
    expect(r.status).toBe(200);
    expect(RemoveLearnedReplySchema.parse(r.json)).toMatchObject({ removed: false, note: expect.stringContaining('no longer') });
    expect(await s.file('acme', 'wrong.md')).toBe(edited);
  });

  it('cannot remove a line of the team kit', async () => {
    const s = await startService();
    const kit = (await s.lines()).find((l) => l.pack === 'raj-standard')!;
    const r = await s.call('POST', '/learned/remove', body(kit));
    expect(r.status).toBe(403);
    expect(await s.file('raj-standard', 'product-knowledge.md')).toBe(`2026-10-01 · ${REPO} · Kit knowledge line.\n`);
  });

  it('refuses a pack that is not used for the repository', async () => {
    const s = await startService();
    const line = (await s.lines())[0]!;
    expect((await s.call('POST', '/learned/remove', body(line, { pack: 'nowhere' }))).status).toBe(404);
    // A pack that exists, but for another repository.
    const theirs = `2026-11-05 · ${OTHER} · Their line.\n`;
    await writePack(s.packsDir, 'theirs', `id: theirs\ntitle: Theirs\nrepos: [${OTHER}]\n`, { 'wrong.md': theirs });
    expect((await s.lines()).some((l) => l.pack === 'theirs')).toBe(false);
    const r = await s.call('POST', '/learned/remove', { repo: REPO, pack: 'theirs', kind: 'wrong', key: key('wrong', '2026-11-05', OTHER, 'Their line.') });
    expect(r.status).toBe(404);
    expect(await s.file('theirs', 'wrong.md')).toBe(theirs);
  });

  it('refuses a pack or kind that is not valid', async () => {
    const s = await startService();
    const line = (await s.lines())[0]!;
    for (const over of [{ pack: '../acme' }, { pack: 'Acme' }, { pack: '' }, { kind: 'intended' }, { kind: 'Wrong' }]) {
      expect((await s.call('POST', '/learned/remove', body(line, over))).status, JSON.stringify(over)).toBe(400);
    }
    expect(await s.file('acme', 'wrong.md')).toBe(`# notes\n2026-11-05 · ${REPO} · Acme wrong line.\n`);
  });

  it('requires the paired Origin', async () => {
    const s = await startService();
    const line = (await s.lines())[0]!;
    expect((await s.call('POST', '/learned/remove', body(line), { Authorization: `Bearer ${s.token}` })).status).toBe(403);
    expect(await s.file('acme', 'wrong.md')).toContain('Acme wrong line.');
  });
});

describe('a pack with a malformed learned line is still used', () => {
  const MALFORMED = 'This is not a learned line.';
  const GENERIC_BEFORE = `2026-11-01 · ${REPO} · Here line.\n2026-11-03 · ${OTHER} · Elsewhere line.\n2026-11-02 · - · Hand written line.\n`;

  it('a dismissal on that repository writes its line into that pack, not into generic', async () => {
    const s = await startService();
    await writeFile(join(s.packsDir, 'acme', 'learned', 'wrong.md'), `# notes\n${MALFORMED}\n2026-11-05 · ${REPO} · Acme wrong line.\n`);
    const made = await s.dismissOne(FINDING);
    expect(made.status).toBe(200);
    const learned = DismissalSchema.parse(made.json).learned!;
    expect(learned).toMatchObject({ packId: 'acme', kind: 'wrong' });
    expect(await s.file('acme', 'wrong.md')).toBe(
      `# notes\n${MALFORMED}\n2026-11-05 · ${REPO} · Acme wrong line.\n${learned.date} · ${REPO} · ${TEXT}\n`);
    expect(await s.file('generic', 'wrong.md')).toBe(GENERIC_BEFORE);
  });

  it('restoring a dismissal that wrote into that pack takes its line out again', async () => {
    const s = await startService();
    const made = await s.dismissOne(FINDING);
    expect(made.status).toBe(200);
    const { date } = DismissalSchema.parse(made.json).learned!;
    // The person breaks a line of the pack by hand after the dismissal.
    await writeFile(join(s.packsDir, 'acme', 'learned', 'wrong.md'), `# notes\n${MALFORMED}\n2026-11-05 · ${REPO} · Acme wrong line.\n${date} · ${REPO} · ${TEXT}\n`);
    const r = await s.call('POST', '/dismissals/restore', { repo: REPO, number: 7, fingerprint: FP });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ restored: true, note: null });
    expect(await s.file('acme', 'wrong.md')).toBe(`# notes\n${MALFORMED}\n2026-11-05 · ${REPO} · Acme wrong line.\n`);
    expect(await s.dismissals()).toEqual([]);
    expect(await s.file('generic', 'wrong.md')).toBe(GENERIC_BEFORE);
  });
});

describe('the cap on learned lines', () => {
  it('refuses the 301st line of a kind and writes nothing', async () => {
    const s = await startService();
    const full = Array.from({ length: 300 }, (_, i) => `2026-10-01 · ${REPO} · Line number ${i}.`).join('\n') + '\n';
    await writeFile(join(s.packsDir, 'acme', 'learned', 'wrong.md'), full);
    const r = await s.call('POST', '/dismissals', { repo: REPO, number: 7, reviewId: REVIEW, findingId: FINDING, reason: 'wrong', text: TEXT });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: 'Acme pack already holds 300 learned lines of this kind. Remove some under Packs first.' });
    expect(await s.file('acme', 'wrong.md')).toBe(full);
    const dismissed = (await s.call('GET', `/reviews/latest?repo=${REPO}&number=7`)).json as { dismissals: unknown[] };
    expect(dismissed.dismissals).toEqual([]);
    // The other kind has room.
    expect((await s.call('POST', '/dismissals', { repo: REPO, number: 7, reviewId: REVIEW, findingId: FINDING, reason: 'intended', text: TEXT })).status).toBe(200);
  });

  it('two dismissals racing for the 300th line: one is accepted and the other refused', async () => {
    const s = await startService();
    const full = Array.from({ length: 299 }, (_, i) => `2026-10-01 · ${REPO} · Line number ${i}.`).join('\n') + '\n';
    await writeFile(join(s.packsDir, 'acme', 'learned', 'wrong.md'), full);
    const replies = await Promise.all([s.dismissOne(FINDING, TEXT), s.dismissOne(FINDING_2, 'A second reason that is long enough.')]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    const written = (await s.file('acme', 'wrong.md')).split('\n').filter((l) => l !== '');
    expect(written).toHaveLength(300);
    expect(await s.dismissals()).toHaveLength(1);
  });

  it('the 300th line is accepted', async () => {
    const s = await startService();
    const full = Array.from({ length: 299 }, (_, i) => `2026-10-01 · ${REPO} · Line number ${i}.`).join('\n') + '\n';
    await writeFile(join(s.packsDir, 'acme', 'learned', 'wrong.md'), full);
    expect((await s.call('POST', '/dismissals', { repo: REPO, number: 7, reviewId: REVIEW, findingId: FINDING, reason: 'wrong', text: TEXT })).status).toBe(200);
  });
});
