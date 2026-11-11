#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { abortOnExitSignals, cleanForTerminal, createSdkRunner, realExec, syncKit, withRetry } from '@airlock/engine';
import { DepthSchema } from '@airlock/shared';
import { loadCases, pickCases } from './dataset.js';
import type { ReplayCase } from './dataset.js';
import type { RunSummary } from './score.js';
import { coverage, halfInTopWord } from './report.js';
import { checkRunId, EarlierRunFolderError, HOME_FOLDER, loadRun, REPLAY_COMBINE, REPLAY_EFFORTS, runReplay, saveRunReport } from './run.js';
import type { CaseEvent, ReplayDeps } from './run.js';

export interface ReplayCliOverrides { deps?: ReplayDeps; packsDir?: string; kit?: { dir: string; sha: string }; cases?: ReplayCase[] }

type Io = { out: (t: string) => void; err: (t: string) => void };

const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_OUT = fileURLToPath(new URL('../../../replay-work', import.meta.url));
const DEFAULT_PACKS = fileURLToPath(new URL('../../../packs', import.meta.url));

export function usage(): string {
  return [
    'Usage:',
    '  airlock-replay run --cases <selection> [--model <id>] [--depth quick|standard|deep] [--out <dir>] [--run <id>]',
    '                     [--judge-model <id>] [--parallel <n>] [--effort low|medium|high] [--sweep-model <id>]',
    '                     [--combine never|no-read-tier]',
    '  airlock-replay report <runDir>',
    '  airlock-replay help',
    '',
    'Options for run:',
    '  --cases <selection>          all, positive, negative, small, or a comma-separated list of case ids (required)',
    `  --model <id>                 model for every review stage (default ${DEFAULT_MODEL})`,
    '  --depth quick|standard|deep  how thorough each review is (default standard)',
    '  --out <dir>                  where runs are written (default replay-work at the repository root)',
    '  --run <id>                   the run folder name; give an earlier run\'s id to resume it',
    `  --judge-model <id>           model that judges each review (default ${DEFAULT_MODEL})`,
    '  --parallel <n>               pull requests reviewed at once, 1 to 3 (default 1)',
    '  --effort low|medium|high     how hard every model of every review works (default high)',
    '  --sweep-model <id>           model for the rule sweep, in place of --model',
    '  --combine never|no-read-tier one combined lens request for a group with no read-tier file (default never)',
    'A run folder is only resumed with the same model, depth, judge model, kit, effort, sweep model and combine setting.',
    '',
    'report rewrites summary.json and report.md from a run folder without any model call.',
  ].join('\n');
}

class UsageError extends Error {}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Text from outside (errors, case ids, paths) as one line with no terminal control characters. */
const clean = cleanForTerminal;

const defaultDeps = (): ReplayDeps => ({
  exec: realExec, runner: withRetry(createSdkRunner(), 1), now: () => new Date(), signal: abortOnExitSignals(),
});

/** `true` as yes, `false` as no, anything else as it is. */
const word = (value: unknown): string => (value === true ? 'yes' : value === false ? 'no' : String(value));

function parseRun(args: string[]) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        cases: { type: 'string' }, model: { type: 'string' }, depth: { type: 'string' }, out: { type: 'string' },
        run: { type: 'string' }, 'judge-model': { type: 'string' }, parallel: { type: 'string' },
        effort: { type: 'string' }, 'sweep-model': { type: 'string' }, combine: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError(messageOf(err));
  }
  if (values.cases === undefined || values.cases.trim() === '') {
    throw new UsageError('run needs --cases <selection>: all, positive, negative, small or a comma-separated list of case ids.');
  }
  const depth = DepthSchema.safeParse(values.depth ?? 'standard');
  if (!depth.success) throw new UsageError(`--depth must be quick, standard or deep, got "${values.depth}".`);
  const parallel = values.parallel ?? '1';
  if (!/^[1-3]$/.test(parallel)) throw new UsageError(`--parallel must be 1, 2 or 3, got "${parallel}".`);
  const effort = values.effort ?? 'high';
  if (!(REPLAY_EFFORTS as readonly string[]).includes(effort)) throw new UsageError(`--effort must be low, medium or high, got "${values.effort}".`);
  const combine = values.combine ?? 'never';
  if (!(REPLAY_COMBINE as readonly string[]).includes(combine)) throw new UsageError(`--combine must be never or no-read-tier, got "${values.combine}".`);
  for (const flag of ['model', 'judge-model', 'sweep-model'] as const) {
    if (values[flag] !== undefined && values[flag].trim() === '') throw new UsageError(`--${flag} needs a model id.`);
  }
  if (values.run !== undefined) {
    try { checkRunId(values.run); } catch (err) { throw new UsageError(messageOf(err)); }
  }
  return {
    selection: values.cases, model: values.model ?? DEFAULT_MODEL, depth: depth.data, out: resolve(values.out ?? DEFAULT_OUT),
    runId: values.run, judgeModel: values['judge-model'] ?? DEFAULT_MODEL, parallel: Number(parallel),
    effort: effort as (typeof REPLAY_EFFORTS)[number], combine: combine as (typeof REPLAY_COMBINE)[number],
    sweepModel: values['sweep-model'],
  };
}

/** The two answers, for the last lines a command prints. */
function closingLines(summary: RunSummary, all: ReplayCase[]): string[] {
  const covered = coverage(summary, all);
  return [
    `Half of the known problems in the top list: ${halfInTopWord(summary.meets.halfInTop).toLowerCase()}${covered === null ? '' : `: ${clean(covered)}.`}`,
    `Clean pull requests stay clean: ${word(summary.meets.cleanControls)}`,
  ];
}

function progress(io: Io): (e: CaseEvent) => void {
  return (e) => {
    const id = clean(e.caseId);
    io.err(e.message === undefined ? `${id}: ${e.status}` : `${id}: ${e.status}: ${clean(e.message)}`);
    if (e.score) {
      const s = e.score;
      io.err(`${id}: ${s.inTop}/${s.known} in the top list, ${s.findingsShown} shown, verdict ${s.verdict}`);
    }
  };
}

async function runCommand(args: string[], io: Io, overrides: ReplayCliOverrides): Promise<number> {
  const opts = parseRun(args);
  let all: ReplayCase[];
  try {
    all = overrides.cases ?? await loadCases();
  } catch (err) {
    io.err(clean(messageOf(err)));
    return 1;
  }
  let cases: ReplayCase[];
  try {
    cases = pickCases(all, opts.selection);
  } catch (err) {
    throw new UsageError(messageOf(err));
  }
  if (cases.length === 0) throw new UsageError(`No replay cases selected by "${opts.selection}".`);

  // Replay reviews run with rules withheld: they must never be stored among the person's own reviews.
  const home = join(opts.out, HOME_FOLDER);
  process.env.AIRLOCK_HOME = home;
  io.err(`Replay reviews and clones are kept in ${clean(home)}, apart from your own reviews.`);

  const deps = overrides.deps ?? defaultDeps();
  let kit = overrides.kit;
  if (kit === undefined) {
    try {
      const synced = await syncKit(deps.exec);
      if (synced.stale) io.err(`The review kit could not be refreshed; using the cached version ${clean(synced.sha)}.`);
      kit = { dir: synced.dir, sha: synced.sha };
    } catch (err) {
      io.err(clean(messageOf(err)));
      io.err('Stopping: a replay without the team standard would not measure the real configuration.');
      return 1;
    }
  }

  let summary;
  try {
    summary = await runReplay({
      cases, dataset: all, model: opts.model, depth: opts.depth, outDir: opts.out, packsDir: overrides.packsDir ?? process.env.AIRLOCK_PACKS_DIR ?? DEFAULT_PACKS,
      kitDir: kit.dir, kitSha: kit.sha, judgeModel: opts.judgeModel, parallelCases: opts.parallel,
      effort: opts.effort, combine: opts.combine, ...(opts.sweepModel === undefined ? {} : { sweepModel: opts.sweepModel }),
      ...(opts.runId === undefined ? {} : { runId: opts.runId }),
    }, deps, progress(io));
  } catch (err) {
    io.err(clean(messageOf(err)));
    return err instanceof EarlierRunFolderError ? 2 : 1;
  }

  const unfinished = summary.incompleteCases;
  if (unfinished.length > 0) {
    const n = unfinished.length;
    io.err(`${n} ${n === 1 ? 'case' : 'cases'} did not finish: ${clean(unfinished.join(', '))}. The report lists ${n === 1 ? 'it' : 'them'}.`);
  }
  if (summary.stopped) {
    const n = summary.stopped.notStarted.length;
    io.err(
      `Claude's usage limit was reached during ${clean(summary.stopped.caseId)}. ` +
        `The run stopped there; ${n} ${n === 1 ? 'case was' : 'cases were'} not started. Run the same command again later to continue.`,
    );
  }
  io.out(clean(join(opts.out, summary.runId, 'report.md')));
  for (const line of closingLines(summary, all)) io.out(line);
  return 0;
}

async function reportCommand(args: string[], io: Io, overrides: ReplayCliOverrides): Promise<number> {
  let positionals: string[];
  try {
    ({ positionals } = parseArgs({ args, options: {}, strict: true, allowPositionals: true }));
  } catch (err) {
    throw new UsageError(messageOf(err));
  }
  if (positionals.length !== 1) throw new UsageError('report needs exactly one run folder.');
  const runDir = resolve(positionals[0]!);
  try {
    const cases = overrides.cases ?? await loadCases();
    const { summary, details } = await loadRun(runDir, cases);
    io.out(clean(await saveRunReport(runDir, summary, cases, details)));
    for (const line of closingLines(summary, cases)) io.out(line);
    return 0;
  } catch (err) {
    io.err(clean(messageOf(err)));
    return 1;
  }
}

/**
 * The airlock-replay command. Returns the exit code: 0 when the run finished, 2 for a usage error or a run folder made
 * by an earlier version, 1 otherwise.
 */
export async function main(argv: string[], io: Io, overrides: ReplayCliOverrides = {}): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
        io.err(usage());
        return 2;
      case 'help':
      case '--help':
      case '-h':
        io.out(usage());
        return 0;
      case 'run':
        return await runCommand(rest, io, overrides);
      case 'report':
        return await reportCommand(rest, io, overrides);
      default:
        throw new UsageError(`Unknown command "${command}".`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`${clean(err.message)}\n\n${usage()}`);
      return 2;
    }
    io.err(clean(messageOf(err)));
    return 1;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const code = await main(process.argv.slice(2), {
    out: (t) => process.stdout.write(`${t}\n`),
    err: (t) => process.stderr.write(`${t}\n`),
  });
  process.exitCode = code;
}
