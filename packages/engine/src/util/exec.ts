import { execFile } from 'node:child_process';

export interface ExecResult { stdout: string; stderr: string; code: number }
export interface ExecOptions {
  cwd?: string;
  input?: string;
  maxBuffer?: number;
  /** The command is killed after this long; DEFAULT_EXEC_TIMEOUT_MS when not given. */
  timeoutMs?: number;
  /** Aborting it kills the command, and the call rejects with STOPPED. */
  signal?: AbortSignal;
  /** Variables set for the command, over the process environment; GIT_TERMINAL_PROMPT stays 0 whatever is given. */
  env?: Record<string, string>;
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

/**
 * Runs a command with execFile (never a shell), with GIT_TERMINAL_PROMPT=0 so a credential prompt cannot wait for input,
 * and `env` merged over the process environment.
 * A command still running at its timeout is killed and returns exit code TIMED_OUT with `timed out after <n> s`. Output
 * over `maxBuffer` returns exit code 1 with the reason in stderr. Rejects when the command cannot start or its signal
 * aborts.
 */
export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd, maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
        env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: '0' }, ...(opts.signal ? { signal: opts.signal } : {}),
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
