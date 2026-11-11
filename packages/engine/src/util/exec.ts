export interface ExecResult { stdout: string; stderr: string; code: number }
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string; input?: string; maxBuffer?: number }) => Promise<ExecResult>;
