#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { writeFile as writeFileToDisk } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ReviewEvent } from '@airlock/shared';
import { createSdkRunner } from './agent/sdk-runner.js';
import { withRetry, type AgentRequest, type AgentResult, type AgentRunner } from './agent/runner.js';
import { parseArgs, usage } from './cli-args.js';
import { parsePrRef } from './intake/pr.js';
import { runReview, type EngineDeps, type ReviewRequest } from './pipeline/review.js';
import { cleanForTerminal, renderReview } from './render/terminal.js';
import { realExec } from './util/exec.js';

export interface CliIo { out: (text: string) => void; err: (text: string) => void; color: boolean }
export interface CliOverrides {
  review?: typeof runReview;
  deps?: EngineDeps;
  packsDir?: string;
  writeFile?: (path: string, text: string) => Promise<void>;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The packs folder sits at the repository root, three levels above both src/cli.ts and dist/cli.js. */
function resolvePacksDir(overrides: CliOverrides): string {
  if (overrides.packsDir !== undefined) return overrides.packsDir;
  const fromEnv = process.env['AIRLOCK_PACKS_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return fileURLToPath(new URL('../../../packs', import.meta.url));
}

/** The real runner is built on the first agent call, so a review that never calls an agent never builds it. */
function lazySdkRunner(): AgentRunner {
  let real: AgentRunner | undefined;
  return {
    run<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
      real ??= createSdkRunner();
      return real.run(req);
    },
  };
}

function defaultDeps(): EngineDeps {
  return { exec: realExec, runner: withRetry(lazySdkRunner(), 1), now: () => new Date() };
}

function progressLine(e: ReviewEvent): string | null {
  switch (e.type) {
    case 'stage':
      return e.status === 'error'
        ? `${cleanForTerminal(e.stage)}: error: ${cleanForTerminal(e.detail)}`
        : `${cleanForTerminal(e.stage)}: ${e.status}`;
    case 'map': return `map: ${e.map.cohorts.length} groups`;
    case 'brief': return 'brief: ready';
    case 'done': return null;
  }
}

/** Runs one command and returns the process exit code. Never throws and never calls process.exit. */
export async function main(argv: string[], io: CliIo, overrides: CliOverrides = {}): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  let target: { repo: string; number: number } | undefined;
  try {
    args = parseArgs(argv);
    if (args.command === 'review') target = parsePrRef(args.ref);
  } catch (err) {
    io.err(`${messageOf(err)}\n`);
    return 2;
  }
  if (args.command === 'help' || target === undefined) {
    io.out(`${usage()}\n`);
    return 0;
  }

  const packsDir = resolvePacksDir(overrides);
  if (!existsSync(packsDir)) {
    io.err(`The packs folder was not found at ${packsDir}. Set AIRLOCK_PACKS_DIR to its location.\n`);
    return 1;
  }

  const request: ReviewRequest = { repo: target.repo, number: target.number, depth: args.depth, packsDir };
  if (args.packs !== undefined) request.packIds = args.packs;
  if (args.model !== undefined) request.models = { main: args.model, challenger: args.model, sweep: args.model };
  if (args.base !== undefined && args.head !== undefined) request.explicit = { baseSha: args.base, headSha: args.head };

  const review = overrides.review ?? runReview;
  const deps = overrides.deps ?? defaultDeps();
  let doc;
  try {
    doc = await review(request, deps, (e) => {
      const line = progressLine(e);
      if (line !== null) io.err(`${line}\n`);
    });
  } catch (err) {
    const detail = process.env['AIRLOCK_DEBUG'] === '1' && err instanceof Error && err.stack ? `\n${err.stack}` : '';
    io.err(`Airlock could not review this pull request: ${messageOf(err)}${detail}\n`);
    return 1;
  }

  io.out(renderReview(doc, { color: io.color }));
  if (args.json !== undefined) {
    const write = overrides.writeFile ?? ((path, text) => writeFileToDisk(path, text, 'utf8'));
    try {
      await write(args.json, `${JSON.stringify(doc, null, 2)}\n`);
    } catch (err) {
      io.err(`The review was printed, but the file ${args.json} could not be written: ${messageOf(err)}\n`);
      return 1;
    }
  }
  return 0;
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
  const io: CliIo = {
    out: (t) => { process.stdout.write(t); },
    err: (t) => { process.stderr.write(t); },
    color: process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined,
  };
  process.exitCode = await main(process.argv.slice(2), io);
}
