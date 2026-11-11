import type { PrInfo, Stage } from '@airlock/shared';
import { must, type Exec } from '../util/exec.js';

export interface StageRule { base?: string; default?: true; stage: Stage }

export function parsePrRef(ref: string): { repo: string; number: number } {
  const text = ref.trim();
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text);
  if (short) return { repo: short[1]!, number: Number(short[2]) };
  const url = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(text);
  if (url) return { repo: url[1]!, number: Number(url[2]) };
  throw new Error(`Not a pull request reference: ${ref}`);
}

export function detectStage(baseRef: string, rules: StageRule[]): Stage {
  const byBase = rules.find((r) => r.base !== undefined && r.base === baseRef);
  if (byBase) return byBase.stage;
  return rules.find((r) => r.default)?.stage ?? 'other';
}

interface GhPull {
  title: string; body: string | null; additions: number; deletions: number; changed_files: number;
  html_url: string; user: { login: string }; state?: unknown; merged?: unknown;
  base: { ref: string; sha: string; repo: { full_name: string } };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
}

export async function fetchPr(exec: Exec, repo: string, number: number, rules: StageRule[]): Promise<PrInfo> {
  const [pullRes, userRes] = await Promise.all([
    exec('gh', ['api', `repos/${repo}/pulls/${number}`]),
    exec('gh', ['api', 'user', '--jq', '.login']),
  ]);
  const pull = JSON.parse(must(pullRes, `gh api pulls/${number}`)) as GhPull;
  const viewer = must(userRes, 'gh api user').trim();
  return {
    repo, number, title: pull.title, body: pull.body ?? '', author: pull.user.login, viewer,
    baseRef: pull.base.ref, headRef: pull.head.ref, baseSha: pull.base.sha, headSha: pull.head.sha,
    isFork: pull.head.repo?.full_name !== pull.base.repo.full_name,
    additions: pull.additions, deletions: pull.deletions, changedFiles: pull.changed_files,
    url: pull.html_url, stage: detectStage(pull.base.ref, rules),
    ...(typeof pull.state === 'string' ? { state: pull.state } : {}),
    ...(typeof pull.merged === 'boolean' ? { merged: pull.merged } : {}),
  };
}
