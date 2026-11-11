import { homedir } from 'node:os';
import { join } from 'node:path';

/** AIRLOCK_HOME, or ~/.airlock when it is unset or empty (an empty one would put Airlock's data in the working folder). */
export function airlockHome(): string {
  const set = process.env.AIRLOCK_HOME;
  return set !== undefined && set !== '' ? set : join(homedir(), '.airlock');
}

/** A folder name for a repository: `/` becomes `__`, and anything outside letters, digits, `.`, `_` and `-` becomes `_`. */
export function repoSlug(repo: string): string {
  return repo.replaceAll('/', '__').replace(/[^A-Za-z0-9._-]/g, '_');
}
