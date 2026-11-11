import { ClaimSchema } from '@airlock/shared';
import type { Brief, ChangeMap, FileDiff, ModelConfig, PrInfo } from '@airlock/shared';
import { z } from 'zod';
import { asMaterial, fill, loadTemplate } from '../agent/prompt.js';
import type { AgentRequest, AgentRunner, AgentUsage } from '../agent/runner.js';

export interface BriefInput {
  pr: PrInfo;
  map: ChangeMap;
  files: FileDiff[];
  headDir: string;
  baseDir: string;
  model: string;
  effort: ModelConfig['effort'];
}

export interface BriefResult {
  brief: Brief;
  usage: AgentUsage[];
  error: string | null;
}

const BriefAnswerSchema = z.object({ whatItDoes: z.array(z.string()), claims: z.array(ClaimSchema) });
type BriefAnswer = z.infer<typeof BriefAnswerSchema>;

const MAX_DESCRIPTION_CHARS = 6_000;
const MAX_FILE_LINES = 300;
const MAX_LINES = 5;
const MAX_CLAIMS = 12;

function describe(pr: PrInfo): string {
  const body = pr.body.trim() === '' ? '(no description)' : pr.body;
  const description = body.length > MAX_DESCRIPTION_CHARS
    ? `${body.slice(0, MAX_DESCRIPTION_CHARS)}\n(description cut at ${MAX_DESCRIPTION_CHARS} characters)`
    : body;
  return `Title: ${pr.title}\n\n${description}`;
}

/** Each cohort's title and summary, its layers in order with their files, then the standalone files. */
function outline(map: ChangeMap): string {
  const lines: string[] = [];
  for (const c of map.cohorts) {
    lines.push(`Cohort: ${c.title}`);
    if (c.summary.trim() !== '') lines.push(`  ${c.summary}`);
    for (const l of c.layers) {
      lines.push(`  Layer: ${l.title} (${l.kind})`);
      for (const f of l.files) lines.push(`    ${f}`);
    }
  }
  if (map.standalone.length > 0) {
    lines.push('Standalone files:');
    for (const f of map.standalone) lines.push(`  ${f}`);
  }
  return lines.length === 0 ? '(none)' : lines.join('\n');
}

function fileList(files: FileDiff[]): string {
  if (files.length === 0) return '(none)';
  const lines = files.slice(0, MAX_FILE_LINES).map((f) => `${f.path} | ${f.status} | +${f.additions} -${f.deletions}`);
  const left = files.length - lines.length;
  if (left > 0) lines.push(`(${left} more files left out)`);
  return lines.join('\n');
}

/** One model call: what the change does, read from the code, and a check of each factual claim in the description. */
export async function buildBrief(runner: AgentRunner, input: BriefInput): Promise<BriefResult> {
  const request: AgentRequest<BriefAnswer> = {
    role: 'brief',
    instructions: fill(await loadTemplate('brief'), {}).trimEnd(),
    material: [
      asMaterial('pull request', describe(input.pr)),
      asMaterial('change map', outline(input.map)),
      asMaterial('changed files', fileList(input.files)),
    ].join('\n\n'),
    schema: BriefAnswerSchema,
    cwd: input.headDir,
    extraDirs: [input.baseDir],
    model: input.model,
    effort: input.effort,
  };

  const result = await runner.run(request);
  if (!result.ok) return { brief: { whatItDoes: [], claims: [] }, usage: [result.usage], error: result.error };

  const whatItDoes = result.output.whatItDoes.map((l) => l.trim()).filter((l) => l !== '').slice(0, MAX_LINES);
  return { brief: { whatItDoes, claims: result.output.claims.slice(0, MAX_CLAIMS) }, usage: [result.usage], error: null };
}
