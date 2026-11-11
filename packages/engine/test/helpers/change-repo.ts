import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FileDiff } from '@airlock/shared';
import { loadDiff } from '../../src/diff/parse.js';
import { realExec } from '../../src/util/exec.js';
import type { TempRepo } from './temp-repo.js';

const run = promisify(execFile);

/** Writes the files (null deletes one) and commits them with a fixed commit time in seconds. */
export async function commitFiles(repo: TempRepo, files: Record<string, string | null>, msg: string, at?: number): Promise<string> {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) await rm(join(repo.dir, path), { force: true });
    else await repo.write(path, text);
  }
  if (at === undefined) return repo.commit(msg);
  const date = `${at} +0000`;
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  await run('git', ['add', '--all'], { cwd: repo.dir });
  await run('git', ['commit', '-m', msg], { cwd: repo.dir, env });
  return repo.git('rev-parse', 'HEAD');
}

/** The parsed diff between two commits of the repository. */
export function diffOf(repo: TempRepo, baseSha: string, headSha: string): Promise<FileDiff[]> {
  return loadDiff(realExec, repo.dir, { baseSha, headSha, kind: 'full' });
}

/** Commits `base`, then applies `head` on top; the working tree is left at the head commit. */
export async function makeChange(repo: TempRepo, base: Record<string, string | null>, head: Record<string, string | null>): Promise<FileDiff[]> {
  const baseSha = await commitFiles(repo, base, 'base');
  const headSha = await commitFiles(repo, head, 'head');
  return diffOf(repo, baseSha, headSha);
}
