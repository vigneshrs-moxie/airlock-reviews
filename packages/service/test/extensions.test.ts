import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { choosePacks, saveReview, syncKit, type EngineDeps, type ReviewRequest, type runReview } from '@airlock/engine';
import {
  candidate, DismissalSchema, LearnedReplySchema, minimalDocument, PrSummarySchema, RemoveLearnedReplySchema, ServiceEventSchema,
  type Finding, type ReviewDocument, type ReviewEvent,
} from '@airlock/shared';
import { pair, readOrCreateToken } from '../src/config.js';
import { learnedTarget } from '../src/dismissals.js';
import { CLOSE_WAIT_MS } from '../src/runs.js';
import { createServer } from '../src/server.js';
import { FakeClock, openStream, send, until, type Reply } from './helpers.js';

// The Extensions pack, the service and the dismissals together, on the repository's own pack manifests copied into a
// temporary packs folder (their learned lines left behind): nothing here writes to the repository's packs folder.
const PACKS = fileURLToPath(new URL('../../../packs/', import.meta.url));
const REPO = 'Moxie-Pest-Control-Phoenix/scheduling-tool-suite';
const KIT = 'Moxie-Pest-Control-Phoenix/moxie-ext-review-kit';
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const REVIEW = 'r_0123456789';
const FINDING = 'c_aaaaaaaa';
const FP = '1111111111111111';
const TEXT = 'The manifest asks for tabs because the popup reads the active tab on purpose.';
/** The repository's name as GitHub, a link or a person may spell it. */
const SPELLINGS = [REPO, REPO.toLowerCase(), 'MOXIE-PEST-CONTROL-PHOENIX/Scheduling-Tool-Suite'];

type ExecResult = { stdout: string; stderr: string; code: number };

const savedHome = process.env['AIRLOCK_HOME'];
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { delete process.env['AIRLOCK_HOME']; });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  if (savedHome === undefined) delete process.env['AIRLOCK_HOME'];
  else process.env['AIRLOCK_HOME'] = savedHome;
});

const pull = (repo: string): string => JSON.stringify({
  title: 'Ask for the tabs permission', body: 'Reads the active tab.', additions: 30, deletions: 4, changed_files: 2,
  html_url: `https://github.com/${repo}/pull/7`, user: { login: 'builder' },
  base: { ref: 'main', sha: 'a'.repeat(40), repo: { full_name: REPO } },
  head: { ref: 'feature/tabs', sha: 'b'.repeat(40), repo: { full_name: REPO } },
});

function review(): ReviewDocument {
  const base = minimalDocument();
  const finding: Finding = {
    ...candidate(), id: FINDING, fingerprint: FP, path: 'manifest.json', checked: 'checked', bucket: 'top', rank: 1, status: null,
    anchor: { status: 'in-diff', startLine: 4, endLine: 4 },
  };
  return { ...base, id: REVIEW, pr: { ...base.pr, repo: REPO, number: 7 }, packs: [{ id: 'extensions', version: 'v1' }], findings: [finding] };
}

/** The four packs of this repository, manifests, lenses and standards only. */
async function copyPacks(packsDir: string): Promise<void> {
  for (const name of ['extensions', 'raj-standard', 'generic', 'orbit-mine']) {
    await cp(join(PACKS, name), join(packsDir, name), { recursive: true, filter: (src) => basename(src) !== 'learned' });
  }
}

/** Every directory under a pack that holds learned lines, as `<pack>/learned`. */
async function learnedFolders(packsDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of (await readdir(packsDir)).sort()) {
    if ((await readdir(join(packsDir, name))).includes('learned')) found.push(`${name}/learned`);
  }
  return found;
}

interface Launched { req: ReviewRequest; emit: (e: ReviewEvent) => void }

/**
 * A service on a temporary home and packs folder. `gh` is a fake that answers the pull request's reads for the
 * repository in any letter case and refuses everything else, as a Mac with no access to the kit would; `review` stands
 * in for the engine.
 */
async function startService(engineReview?: typeof runReview) {
  const home = await mkdtemp(join(tmpdir(), 'airlock-service-extensions-'));
  process.env['AIRLOCK_HOME'] = home;
  const packsDir = join(home, 'packs');
  await copyPacks(packsDir);
  await saveReview(review());
  const clock = new FakeClock();
  const calls: string[][] = [];
  const answer = (args: string[]): ExecResult => {
    const [verb, path] = args;
    const asked = /^repos\/([^/]+\/[^/]+)\/pulls\/7$/.exec(path ?? '');
    if (verb === 'api' && args.length === 2 && asked !== null && asked[1]!.toLowerCase() === REPO.toLowerCase()) {
      return { stdout: pull(asked[1]!), stderr: '', code: 0 };
    }
    if (args.join(' ') === 'api user --jq .login') return { stdout: 'builder\n', stderr: '', code: 0 };
    if (args.join(' ') === 'auth status') return { stdout: '', stderr: 'Logged in to github.com', code: 0 };
    return { stdout: '', stderr: 'gh: Not Found (HTTP 404)', code: 1 };
  };
  const launched: Launched[] = [];
  const held: typeof runReview = (req, _given, onEvent) => new Promise<ReviewDocument>(() => {
    launched.push({ req, emit: (e) => onEvent?.(e) });
  });
  const engine: EngineDeps = {
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd !== 'gh') throw new Error(`unexpected command: ${cmd}`);
      return answer(args);
    },
    runner: { run: () => { throw new Error('no model is asked in these tests'); } },
    now: clock.date,
  };
  const service = createServer({
    config: { port: 0, home, packsDir, version: '1.2.3' }, engine, review: engineReview ?? held, now: clock.date, log: () => undefined,
    timers: clock.timers,
  });
  const { port } = await service.listen();
  const token = await readOrCreateToken(home);
  await pair(home, ORIGIN);
  cleanups.push(async () => {
    const closing = service.close();
    clock.advance(CLOSE_WAIT_MS);
    await closing;
    await rm(home, { recursive: true, force: true });
  });
  const auth = { Authorization: `Bearer ${token}`, Origin: ORIGIN };
  const call = (method: string, path: string, body?: unknown): Promise<Reply> =>
    send(port, method, path, body === undefined ? { headers: auth } : { headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { home, packsDir, port, auth, calls, launched, call };
}

describe('an extension repository with the Extensions pack', () => {
  it('a Wrong or Intended dismissal writes its line into extensions/learned, never the team kit pack nor generic; /learned lists it as removable, and Remove takes it out', async () => {
    const s = await startService();
    expect(learnedTarget((await choosePacks(s.packsDir, REPO)).packs).id).toBe('extensions');

    const wrong = await s.call('POST', '/dismissals', { repo: REPO, number: 7, reviewId: REVIEW, findingId: FINDING, reason: 'wrong', text: TEXT });
    expect(wrong.status).toBe(200);
    expect(DismissalSchema.parse(wrong.json).learned).toEqual({ packId: 'extensions', kind: 'wrong', date: '2026-11-11' });
    const file = (name: string): Promise<string> => readFile(join(s.packsDir, 'extensions', 'learned', name), 'utf8');
    expect(await file('wrong.md')).toBe(`2026-11-11 · ${REPO} · ${TEXT}\n`);
    expect(await learnedFolders(s.packsDir)).toEqual(['extensions/learned']);

    // Dismissed again as Intended: the Wrong line is taken out and the new one goes to the same pack's product knowledge.
    const intended = await s.call('POST', '/dismissals', { repo: REPO, number: 7, reviewId: REVIEW, findingId: FINDING, reason: 'intended', text: TEXT });
    expect(DismissalSchema.parse(intended.json).learned).toEqual({ packId: 'extensions', kind: 'intended', date: '2026-11-11' });
    expect(await file('wrong.md')).toBe('');
    expect(await file('product-knowledge.md')).toBe(`2026-11-11 · ${REPO} · ${TEXT}\n`);
    expect(await learnedFolders(s.packsDir)).toEqual(['extensions/learned']);

    const listed = LearnedReplySchema.parse((await s.call('GET', `/learned?repo=${REPO}`)).json).lines;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      pack: 'extensions', packTitle: 'Extensions', kind: 'product-knowledge', date: '2026-11-11', repo: REPO, text: TEXT,
      appliesHere: true, removable: true,
    });

    const removed = await s.call('POST', '/learned/remove', { repo: REPO, pack: 'extensions', kind: 'product-knowledge', key: listed[0]!.key });
    expect(removed.status).toBe(200);
    expect(RemoveLearnedReplySchema.parse(removed.json)).toEqual({ removed: true, note: null });
    expect(await file('product-knowledge.md')).toBe('');
    expect(LearnedReplySchema.parse((await s.call('GET', `/learned?repo=${REPO}`)).json).lines).toEqual([]);
    // The finding stays dismissed; only its link to the line is gone.
    const latest = (await s.call('GET', `/reviews/latest?repo=${REPO}&number=7`)).json as { dismissals: unknown[] };
    expect(latest.dismissals.map((d) => DismissalSchema.parse(d))).toMatchObject([{ fingerprint: FP, reason: 'intended', learned: null }]);
    // Not one command ran for any of it.
    expect(s.calls).toEqual([]);
  });

  it('/pr and the review start choose Extensions and Generic, not Orbit\'s packs, however the repository is spelled', async () => {
    for (const repo of SPELLINGS) {
      const s = await startService();
      const pr = await s.call('GET', `/pr?repo=${repo}&number=7`);
      expect(pr.status).toBe(200);
      expect(PrSummarySchema.parse(pr.json)).toMatchObject({
        repo, number: 7, stage: 'other', packs: [{ id: 'extensions', title: 'Extensions' }, { id: 'generic', title: 'Generic' }],
      });

      const started = await s.call('POST', '/reviews', { repo, number: 7 });
      expect(started.status).toBe(200);
      const { req } = s.launched[0]!;
      expect(req).toEqual({ repo, number: 7, packsDir: s.packsDir });
      // The engine chooses the packs from that request, as runReview does first.
      expect((await choosePacks(req.packsDir, req.repo, req.packIds)).packs.map((p) => p.id)).toEqual(['extensions', 'generic']);
      // gh was only read from.
      expect(s.calls.every((c) => c[0] === 'gh' && !c.some((a) => ['--method', '-X', '-f', '-F'].includes(a)))).toBe(true);
    }
  });

  it('a kit that cannot be had and has no cached copy: the panel gets the sentence that names the kit, not a generic failure', async () => {
    // The engine's runReview rejects with syncKit's sentence before any model call (its own tests show that); this review
    // does the same from the same pack manifest and the same fake gh, so the service handles the engine's real error.
    const s = await startService(async (req, given, onEvent) => {
      onEvent?.({ type: 'stage', stage: 'packs', status: 'start', detail: '' });
      const kitted = (await choosePacks(req.packsDir, req.repo, req.packIds)).packs.filter((p) => p.kit !== undefined);
      for (const pack of kitted) await syncKit(given.exec, pack.kit!);
      throw new Error('a kit was had');
    });
    const started = await s.call('POST', '/reviews', { repo: REPO, number: 7 });
    const { runId } = started.json as { runId: string };
    const stream = await openStream(s.port, `/reviews/${runId}/events`, s.auth);
    await until(() => stream.ended, 'the run to end');
    const last = ServiceEventSchema.parse(stream.events.at(-1));
    expect(last).toEqual({
      type: 'failed',
      message: `Airlock could not review this pull request: The review kit could not be fetched from ${KIT} and none is cached: gh: Not Found (HTTP 404)`,
    });
    // Only the kit's commit was asked for, as a read, and nothing was cached.
    expect(s.calls).toEqual([['gh', 'api', `repos/${KIT}/commits/main`, '--jq', '.sha']]);
    expect(await readdir(join(s.home, 'kit')).catch(() => [])).toEqual([]);
  });
});
