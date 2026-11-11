import type { Exec } from '../util/exec.js';

export interface GrepHit { path: string; line: number }

/** Whole-word, fixed-string `git grep` over tracked text files, in path then line order. */
export async function gitGrep(exec: Exec, headDir: string, token: string, pathspecs: string[] = []): Promise<GrepHit[]> {
  const args = ['grep', '-n', '-z', '-I', '-w', '-F', '-e', token];
  if (pathspecs.length > 0) args.push('--', ...pathspecs);
  const res = await exec('git', args, { cwd: headDir });
  if (res.code === 1) return [];
  if (res.code !== 0) throw new Error(`git grep ${JSON.stringify(token)} failed (exit ${res.code}): ${res.stderr}`);
  const hits: GrepHit[] = [];
  for (const record of res.stdout.split('\n')) {
    const [path, line] = record.split('\0');
    if (path && line && /^\d+$/.test(line)) hits.push({ path, line: Number(line) });
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
