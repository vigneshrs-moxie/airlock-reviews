import type { Exec } from '../util/exec.js';

export interface GrepHit { path: string; line: number }

const GREP_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Whole-word, fixed-string `git grep` over tracked text files: one hit per matching line, in path then line order.
 * `-o` keeps the output to the matched word. A result too large for `maxBuffer` throws rather than reading as no match.
 */
export async function gitGrep(
  exec: Exec, headDir: string, token: string, pathspecs: string[] = [], maxBuffer = GREP_MAX_BUFFER,
): Promise<GrepHit[]> {
  const args = ['grep', '-n', '-o', '-z', '-I', '-w', '-F', '-e', token];
  if (pathspecs.length > 0) args.push('--', ...pathspecs);
  const res = await exec('git', args, { cwd: headDir, maxBuffer });
  // realExec reports an overflow as exit 1; a real "no match" exit 1 prints nothing.
  if (res.code === 1 && (res.stdout !== '' || /maxBuffer/i.test(res.stderr))) {
    throw new Error(`git grep ${JSON.stringify(token)}: output overflowed the ${maxBuffer}-byte buffer`);
  }
  if (res.code === 1) return [];
  if (res.code !== 0) throw new Error(`git grep ${JSON.stringify(token)} failed (exit ${res.code}): ${res.stderr}`);
  const hits: GrepHit[] = [];
  let last = '';
  for (const record of res.stdout.split('\n')) {
    const [path, line] = record.split('\0');
    if (!path || !line || !/^\d+$/.test(line)) continue;
    const key = `${path}\0${line}`;
    if (key !== last) hits.push({ path, line: Number(line) }); // -o repeats a line once per match on it
    last = key;
  }
  return hits;
}

/** Every tracked path of the repository at `headDir`. */
export async function trackedFiles(exec: Exec, headDir: string): Promise<string[]> {
  const res = await exec('git', ['ls-files', '-z'], { cwd: headDir });
  if (res.code !== 0) throw new Error(`git ls-files failed (exit ${res.code}): ${res.stderr}`);
  return res.stdout.split('\0').filter((p) => p !== '');
}

/** Commit time in seconds of the last commit touching `path`, or null when it has none. */
export async function lastCommitTime(exec: Exec, headDir: string, path: string): Promise<number | null> {
  const res = await exec('git', ['--literal-pathspecs', 'log', '-1', '--format=%ct', '--', path], { cwd: headDir });
  if (res.code !== 0) throw new Error(`git log ${path} failed (exit ${res.code}): ${res.stderr}`);
  const t = Number(res.stdout.trim());
  return res.stdout.trim() !== '' && Number.isFinite(t) ? t : null;
}
