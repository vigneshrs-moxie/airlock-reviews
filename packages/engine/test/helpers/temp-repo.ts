import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface TempRepo {
  dir: string;
  git(...args: string[]): Promise<string>;
  write(path: string, text: string): Promise<void>;
  commit(msg: string): Promise<string>;
}

/** A throwaway local git repository on branch main, with commits that work on any machine. */
export async function makeTempRepo(): Promise<TempRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-repo-'));
  const git = async (...args: string[]): Promise<string> => (await run('git', args, { cwd: dir })).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Airlock Test');
  await git('config', 'user.email', 'test@airlock.invalid');
  await git('config', 'commit.gpgsign', 'false');
  return {
    dir,
    git,
    async write(path, text) {
      const full = join(dir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, text);
    },
    async commit(msg) {
      await git('add', '--all');
      await git('commit', '-m', msg);
      return git('rev-parse', 'HEAD');
    },
  };
}
