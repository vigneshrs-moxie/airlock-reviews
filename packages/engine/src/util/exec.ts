import { execFile } from 'node:child_process';

export interface ExecResult { stdout: string; stderr: string; code: number }
export type Exec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; input?: string; maxBuffer?: number },
) => Promise<ExecResult>;

const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024;

/** Runs a command with execFile (never a shell). Rejects only when the command cannot start. */
export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr, code: 0 });
        const e = error as Error & { code?: number | string; killed?: boolean };
        if (typeof e.code === 'number') return resolve({ stdout, stderr, code: e.code });
        if (e.killed || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ stdout, stderr: stderr || e.message, code: 1 });
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
