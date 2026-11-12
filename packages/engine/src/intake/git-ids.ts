import { TIMED_OUT, type Exec } from '../util/exec.js';

/** A full commit id: 40 (SHA-1) or 64 (SHA-256) hexadecimal characters. */
export const FULL_COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** A branch name git cannot read as an option or as anything but a branch: letters, digits, `.`, `_`, `/`, `-`. */
const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

/** Throws one plain sentence when `name` is not a branch name Airlock can give git. */
export function checkBranchName(name: string): void {
  if (!BRANCH_NAME.test(name) || name.startsWith('-')) {
    throw new Error(`The base branch ${JSON.stringify(name)} is not a branch name Airlock can use.`);
  }
}

/** True when the mirror has the object `spec` names (a commit or a ref); a lookup that timed out throws, since it says nothing. */
export async function inMirror(exec: Exec, mirror: string, spec: string): Promise<boolean> {
  const r = await exec('git', ['--git-dir', mirror, 'rev-parse', '--verify', '--quiet', '--end-of-options', spec]);
  if (r.code === TIMED_OUT) throw new Error(`git rev-parse ${spec}: ${r.stderr}`);
  return r.code === 0;
}
