import { homedir } from 'node:os';
import { join } from 'node:path';

export function airlockHome(): string {
  return process.env.AIRLOCK_HOME ?? join(homedir(), '.airlock');
}

/** A folder name for a repository: `/` becomes `__`, and anything outside letters, digits, `.`, `_` and `-` becomes `_`. */
export function repoSlug(repo: string): string {
  return repo.replaceAll('/', '__').replace(/[^A-Za-z0-9._-]/g, '_');
}
