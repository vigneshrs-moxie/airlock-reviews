import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveReview, type EngineDeps } from '@airlock/engine';
import { candidate, minimalDocument, type Finding, type ReviewDocument } from '@airlock/shared';
import { pair, readOrCreateToken } from '../../src/config.js';
import { createServer } from '../../src/server.js';
import { FakeClock, send, type Reply } from '../helpers.js';

export const REPO = 'acme/widgets';
export const NUMBER = 7;
export const HEAD = 'b'.repeat(40);
export const REVIEW = 'r_0123456789';
export const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
/** Inline at line 12. */
export const FP_A = '1111111111111111';
/** No line GitHub shows. */
export const FP_B = '2222222222222222';
/** Inline over lines 18 to 20, also known as FP_C_ALIAS. */
export const FP_C = '3333333333333333';
export const FP_C_ALIAS = '4444444444444444';
/** Fixed by this review. */
export const FP_D = '5555555555555555';
export const POST_ARGS = ['api', '--method', 'POST', `repos/${REPO}/pulls/${NUMBER}/reviews`, '--input', '-'];
export const POST_LINE = `gh ${POST_ARGS.join(' ')}`;
export const PULL_LINE = `gh api repos/${REPO}/pulls/${NUMBER}`;
export const EXPIRED = 'This preview has expired. Open the preview again.';

export interface ExecResult { stdout: string; stderr: string; code: number }
export interface Call { line: string; args: string[]; input: string | undefined }

const finding = (over: Partial<Finding>): Finding => ({
  ...candidate(), id: 'c_aaaaaaaa', fingerprint: FP_A, checked: 'checked', bucket: 'top', rank: 1, status: null,
  anchor: { status: 'in-diff', startLine: 12, endLine: 12, comment: { line: 12, startLine: null } },
  ...over,
});

export const FINDING_A = finding({ title: 'Total is not rounded', happens: 'It adds @carol to the list.' });
export const FINDING_B = finding({
  id: 'c_bbbbbbbb', fingerprint: FP_B, title: 'The cache is never cleared', path: 'src/cache.ts', bucket: 'also', rank: null,
  anchor: { status: 'outside-diff', startLine: 40, endLine: 41, comment: null },
});
export const FINDING_C = finding({
  id: 'c_cccccccc', fingerprint: FP_C, aliases: [FP_C_ALIAS], title: 'The loop skips the last row', path: 'src/rows.ts', rank: 2,
  anchor: { status: 'in-diff', startLine: 18, endLine: 20, comment: { line: 20, startLine: 18 } },
});
export const FINDING_D = finding({ id: 'c_dddddddd', fingerprint: FP_D, title: 'An old problem now fixed' });

export function review(): ReviewDocument {
  const base = minimalDocument();
  return {
    ...base, id: REVIEW, pr: { ...base.pr, repo: REPO, number: NUMBER, headSha: HEAD, viewer: 'bob' },
    findings: [FINDING_A, FINDING_B, FINDING_C], fixed: [FINDING_D],
  };
}

export const pull = (over: Record<string, unknown> = {}): string => JSON.stringify({
  title: 'Add totals', body: 'Adds totals.', additions: 40, deletions: 10, changed_files: 3,
  html_url: `https://github.com/${REPO}/pull/${NUMBER}`, user: { login: 'alice' }, state: 'open', merged: false,
  base: { ref: 'main', sha: 'a'.repeat(40), repo: { full_name: REPO } },
  head: { ref: 'feature/totals', sha: HEAD, repo: { full_name: REPO } },
  ...over,
});

export const POSTED: ExecResult = {
  stdout: JSON.stringify({ id: 555, html_url: `https://github.com/${REPO}/pull/${NUMBER}#pullrequestreview-555`, state: 'COMMENTED' }),
  stderr: '', code: 0,
};

export interface Rig {
  home: string;
  clock: FakeClock;
  log: string[];
  calls: Call[];
  /** What the fake `gh` answers, by command line; a function is called on each run. */
  answers: Map<string, ExecResult | (() => Promise<ExecResult>)>;
  /** Calls whose command line is the one write. */
  writes(): Call[];
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply>;
  preview(body?: Record<string, unknown>): Promise<Reply>;
  post(previewId: string): Promise<Reply>;
  recordsFile(): string;
  readRecords(): Promise<unknown>;
  writeDismissals(list: unknown[]): Promise<void>;
  writeRecords(list: unknown[]): Promise<void>;
}

const savedHome = process.env['AIRLOCK_HOME'];
const cleanups: Array<() => Promise<void>> = [];

/** Closes every service the tests started and puts AIRLOCK_HOME back. */
export async function cleanUp(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  if (savedHome === undefined) delete process.env['AIRLOCK_HOME'];
  else process.env['AIRLOCK_HOME'] = savedHome;
}

/** The real server, paired with ORIGIN, on a temporary home, with a fake `gh` that never reaches GitHub. */
export async function startService(): Promise<Rig> {
  const home = await mkdtemp(join(tmpdir(), 'airlock-service-posts-'));
  process.env['AIRLOCK_HOME'] = home;
  await saveReview(review());
  const clock = new FakeClock();
  const log: string[] = [];
  const calls: Call[] = [];
  const answers: Rig['answers'] = new Map<string, ExecResult | (() => Promise<ExecResult>)>([
    [PULL_LINE, { stdout: pull(), stderr: '', code: 0 }],
    ['gh api user --jq .login', { stdout: 'bob\n', stderr: '', code: 0 }],
    [POST_LINE, POSTED],
  ]);
  const engine: EngineDeps = {
    exec: async (cmd, args, opts) => {
      const line = [cmd, ...args].join(' ');
      calls.push({ line, args: [...args], input: opts?.input });
      const answer = answers.get(line);
      if (answer === undefined) throw new Error(`no fake answer for ${line}`);
      return typeof answer === 'function' ? answer() : answer;
    },
    runner: { run: () => { throw new Error('no model is asked in these tests'); } },
    now: clock.date,
  };
  const service = createServer({
    config: { port: 0, home, packsDir: join(home, 'packs'), version: '1.0.0' }, engine, now: clock.date,
    log: (l) => log.push(l), timers: clock.timers,
  });
  const { port } = await service.listen();
  const token = await readOrCreateToken(home);
  await pair(home, ORIGIN);
  cleanups.push(async () => { await service.close(); await rm(home, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${token}`, Origin: ORIGIN };
  const call: Rig['call'] = (method, path, body, given) => send(port, method, path, body === undefined
    ? { headers: given ?? headers }
    : { headers: { ...(given ?? headers), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const recordsFile = (): string => join(home, 'posts', 'acme__widgets', `${NUMBER}.json`);
  const writeJson = async (folder: string, list: unknown[]): Promise<void> => {
    await mkdir(join(home, folder, 'acme__widgets'), { recursive: true });
    await writeFile(join(home, folder, 'acme__widgets', `${NUMBER}.json`), JSON.stringify(list));
  };
  return {
    home, clock, log, calls, answers,
    writes: () => calls.filter((c) => c.line === POST_LINE),
    call,
    preview: (body = {}) => call('POST', '/posts/preview', {
      repo: REPO, number: NUMBER, reviewId: REVIEW, items: [{ fingerprint: FP_A }, { fingerprint: FP_B }], ...body,
    }),
    post: (previewId) => call('POST', '/posts', { previewId }),
    recordsFile,
    readRecords: async () => JSON.parse(await readFile(recordsFile(), 'utf8')) as unknown,
    writeDismissals: (list) => writeJson('dismissals', list),
    writeRecords: (list) => writeJson('posts', list),
  };
}
