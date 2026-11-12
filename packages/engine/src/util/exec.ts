import { execFile } from 'node:child_process';
import { basename } from 'node:path';

export interface ExecResult { stdout: string; stderr: string; code: number }
export interface ExecOptions {
  cwd?: string;
  input?: string;
  maxBuffer?: number;
  /** The command is killed after this long; DEFAULT_EXEC_TIMEOUT_MS when not given. */
  timeoutMs?: number;
  /** Aborting it kills the command, and the call rejects with STOPPED. */
  signal?: AbortSignal;
  /**
   * Lets a `gh` call that is not a read through. Only the one GitHub write, `sendReview` in the service, sets it; without
   * it, `realExec` refuses such a call before anything is started.
   */
  allowGhWrite?: boolean;
}
export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024;
/** How long a local command (git, gh) may run. */
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
/** How long a clone or fetch may run. */
export const SLOW_EXEC_TIMEOUT_MS = 10 * 60_000;
/** The exit code of a command killed at its timeout, as `timeout(1)` reports it. It is never an answer such as "no match". */
export const TIMED_OUT = 124;
/** What a command stopped by its signal rejects with. */
export const STOPPED = 'The command was stopped.';

/** What `realExec` throws for a `gh` call that is not a read, when the caller has not said it is the one write. */
export const GH_WRITE_REFUSED = 'Airlock does not let this command write to GitHub.';

/** The `gh api` flags that send a body or choose a method other than GET, as a whole argument or its start. */
const GH_WRITE_FLAGS = ['--method', '-X', '-f', '-F', '--field', '--raw-field', '--input'];

/**
 * Whether `gh` with these arguments only reads: `api` first, with no argument that is or starts with a write flag and no
 * `graphql` endpoint (a query and a mutation go the same way), or exactly `auth status`.
 */
export function isGhRead(args: readonly string[]): boolean {
  if (args[0] === 'auth') return args[1] === 'status' && args.length === 2;
  if (args[0] !== 'api') return false;
  return !args.slice(1).some((a) => a === 'graphql' || GH_WRITE_FLAGS.some((flag) => a.startsWith(flag)));
}

/**
 * Runs a command with execFile (never a shell), with GIT_TERMINAL_PROMPT=0 so a credential prompt cannot wait for input.
 * A command still running at its timeout is killed and returns exit code TIMED_OUT with `timed out after <n> s`. Output
 * over `maxBuffer` returns exit code 1 with the reason in stderr. Rejects when the command cannot start or its signal
 * aborts, and, before starting anything, for a `gh` call that is not a read (see `isGhRead`) unless `allowGhWrite` is set.
 */
export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    // Checked here, under every caller: nothing writes to GitHub through gh unless the caller is the one write.
    if (basename(cmd) === 'gh' && opts.allowGhWrite !== true && !isGhRead(args)) {
      reject(new Error(GH_WRITE_REFUSED));
      return;
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd, maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr, code: 0 });
        if (opts.signal?.aborted) return reject(new Error(STOPPED));
        const e = error as Error & { code?: number | string; killed?: boolean };
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ stdout, stderr: stderr || e.message, code: 1 });
        if (e.killed) return resolve({ stdout: '', stderr: `timed out after ${timeoutMs / 1000} s`, code: TIMED_OUT });
        if (typeof e.code === 'number') return resolve({ stdout, stderr, code: e.code });
        reject(error);
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(opts.input);
    }
  });

/** Returns stdout, or throws `${what}: ${stderr}` on a non-zero exit code. */
export function must(result: ExecResult, what: string): string {
  if (result.code !== 0) throw new Error(`${what}: ${result.stderr}`);
  return result.stdout;
}
