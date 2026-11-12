import { DepthSchema, type Depth } from '@airlock/shared';

export type CliArgs =
  | {
    command: 'review'; ref: string; depth: Depth; packs?: string[]; model?: string; sweepModel?: string;
    effort?: (typeof EFFORTS)[number]; combine?: 'never' | 'no-read-tier'; json?: string; base?: string; head?: string;
    /** Review what was pushed since the latest stored review (`last`) or the stored review with this id. */
    since?: string;
  }
  | { command: 'help' };

const TAIL = 'Run "airlock help" for usage.';
const VALUE_FLAGS = ['--depth', '--packs', '--model', '--sweep-model', '--effort', '--combine', '--json', '--base', '--head', '--since'] as const;
/** A stored review's id: `r_` and 10 hexadecimal characters. */
const REVIEW_ID = /^r_[0-9a-fA-F]{10}$/;
const COMBINE = ['never', 'no-read-tier'] as const;
const EFFORTS = ['low', 'medium', 'high'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

export function usage(): string {
  return [
    'Usage:',
    '  airlock review <owner/name#n | pull URL> [--depth quick|standard|deep] [--packs a,b] [--model <id>] [--sweep-model <id>]',
    '                 [--effort low|medium|high] [--combine never|no-read-tier] [--base <sha> --head <sha>] [--since last|<review id>]',
    '                 [--json <file>]',
    '  airlock help',
    '',
    'Options:',
    '  --depth quick|standard|deep   how thorough the review is (default standard)',
    '  --packs a,b                   use only these packs, by id',
    '  --model <id>                  model for the main, challenger and sweep stages together',
    '  --sweep-model <id>            model for the rule sweep, in place of --model',
    '  --effort low|medium|high      how hard every model works (default high)',
    '  --combine never|no-read-tier  at standard and deep depth, one combined lens request for a group with no read-tier file (default never)',
    '  --base <sha>                  review from this commit (7 to 40 hex characters; needs --head)',
    '  --head <sha>                  review up to this commit (7 to 40 hex characters; needs --base)',
    '  --since last|<review id>      review only what was pushed since the latest stored review, or since the one with this id',
    '  --json <file>                 also write the review document to this file',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(`${message} ${TAIL}`);
}

function isValueFlag(name: string): name is ValueFlag {
  return (VALUE_FLAGS as readonly string[]).includes(name);
}

function checkSha(flag: string, value: string): string {
  if (!/^[0-9a-fA-F]{7,40}$/.test(value)) fail(`${flag} must be 7 to 40 hexadecimal characters, got "${value}".`);
  return value;
}

export function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') return { command: 'help' };
  if (argv[0] !== 'review') fail(`Unknown command "${argv[0]}".`);

  const rest = argv.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) return { command: 'help' };

  let ref: string | undefined;
  const values: Partial<Record<ValueFlag, string>> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith('-')) {
      if (ref !== undefined) fail(`Unexpected argument "${arg}".`);
      ref = arg;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!isValueFlag(name)) fail(`Unknown option "${name}".`);
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('-')) fail(`${name} needs a value.`);
      value = next;
      i++;
    }
    values[name] = value;
  }
  if (ref === undefined) fail('review needs a pull request, as owner/name#n or a pull URL.');

  const depthText = values['--depth'] ?? 'standard';
  const depth = DepthSchema.safeParse(depthText);
  if (!depth.success) fail(`--depth must be one of quick, standard, deep, got "${depthText}".`);

  const result: Extract<CliArgs, { command: 'review' }> = { command: 'review', ref, depth: depth.data };
  if (values['--packs'] !== undefined) {
    const packs = values['--packs'].split(',').map((p) => p.trim()).filter((p) => p !== '');
    if (packs.length === 0) fail('--packs needs at least one pack id.');
    result.packs = packs;
  }
  if (values['--model'] !== undefined) result.model = values['--model'];
  const sweepModel = values['--sweep-model'];
  if (sweepModel !== undefined) {
    if (sweepModel.trim() === '') fail('--sweep-model needs a model id.');
    result.sweepModel = sweepModel;
  }
  const effort = values['--effort'];
  if (effort !== undefined) {
    if (!(EFFORTS as readonly string[]).includes(effort)) fail(`--effort must be one of ${EFFORTS.join(', ')}, got "${effort}".`);
    result.effort = effort as (typeof EFFORTS)[number];
  }
  const combine = values['--combine'];
  if (combine !== undefined) {
    if (!(COMBINE as readonly string[]).includes(combine)) fail(`--combine must be one of ${COMBINE.join(', ')}, got "${combine}".`);
    result.combine = combine as (typeof COMBINE)[number];
  }
  if (values['--json'] !== undefined) result.json = values['--json'];
  const base = values['--base'];
  const head = values['--head'];
  if (base !== undefined && head === undefined) fail('--base needs --head as well.');
  if (head !== undefined && base === undefined) fail('--head needs --base as well.');
  if (base !== undefined && head !== undefined) {
    result.base = checkSha('--base', base);
    result.head = checkSha('--head', head);
  }
  const since = values['--since'];
  if (since !== undefined) {
    if (since !== 'last' && !REVIEW_ID.test(since)) fail(`--since must be last or a review id (r_ and 10 hexadecimal characters), got "${since}".`);
    if (result.base !== undefined) fail('--since cannot be used with --base and --head.');
    result.since = since;
  }
  return result;
}
