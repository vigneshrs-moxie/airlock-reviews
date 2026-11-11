import { homedir } from 'node:os';
import { join } from 'node:path';

export function airlockHome(): string {
  return process.env.AIRLOCK_HOME ?? join(homedir(), '.airlock');
}

export function repoSlug(repo: string): string {
  return repo.replace('/', '__');
}
