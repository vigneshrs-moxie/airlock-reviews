#!/usr/bin/env node
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanForTerminal, realExec, type EngineDeps, type Exec } from '@airlock/engine';
import { HelloSchema, ServiceStatusSchema } from '@airlock/shared';
import { loadConfig, readOrCreateToken, unpair, type ServiceConfig } from './config.js';
import { createServer, defaultEngineDeps, type ServiceDeps } from './server.js';

export interface CliIo { out: (text: string) => void; err: (text: string) => void }

type Signal = 'SIGINT' | 'SIGTERM';

/** Everything that touches the machine. The defaults are the real ones; tests replace them. */
export interface CliOverrides {
  createServer?: (deps: ServiceDeps) => ReturnType<typeof createServer>;
  engineDeps?: () => EngineDeps;
  loadConfig?: (env: NodeJS.ProcessEnv) => ServiceConfig;
  readOrCreateToken?: (home: string) => Promise<string>;
  unpair?: (home: string) => Promise<void>;
  fetch?: typeof fetch;
  exec?: Exec;
  /** The home folder whose `Library/LaunchAgents` holds the plist. */
  home?: string;
  /** Writes a text file (making its folder) with the given mode. */
  writeFile?: (path: string, text: string, mode: number) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
  makeDir?: (path: string) => Promise<void>;
  uid?: number;
  execPath?: string;
  /** The absolute path of the built cli.js. */
  cliPath?: string;
  /** Registers a handler for a stop signal and returns the function that removes it. */
  onSignal?: (signal: Signal, handler: () => void) => () => void;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

const clean = cleanForTerminal;
const messageOf = (e: unknown): string => clean(e instanceof Error ? e.message : String(e));

export const LABEL = 'com.airlock.service';
const START_HINT = 'npm run service';
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const COMMANDS = ['claude', 'gh', 'git'] as const;

export function usage(): string {
  return [
    'Airlock service: the local service the Airlock extension talks to.',
    '',
    'Usage: npm run service -- <command>',
    '',
    'Commands:',
    '  start       Run the service in this terminal (the default: npm run service)',
    '  token       Print the pairing token (npm run service -- token)',
    '  status      Say whether the service is running and what it found',
    '  unpair      Forget the paired extension so another copy can pair',
    '  install     Start the service at login (npm run service:install)',
    '  uninstall   Stop starting it at login (npm run service:uninstall)',
    '  help        Show this text',
  ].join('\n');
}

const COMMAND_NAMES = ['start', 'token', 'status', 'unpair', 'install', 'uninstall', 'help'] as const;
type Command = (typeof COMMAND_NAMES)[number];

function parse(argv: string[]): Command | { error: string } {
  const [first, ...rest] = argv;
  if (first === undefined) return 'start';
  if (first === '--help' || first === '-h') return rest.length === 0 ? 'help' : { error: 'help takes no arguments.' };
  const command = COMMAND_NAMES.find((c) => c === first);
  if (command === undefined) return { error: `Unknown command "${clean(first)}".` };
  if (rest.length > 0) return { error: `"${command}" takes no arguments.` };
  return command;
}

// ---- the launch agent ----

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export interface PlistValues { node: string; cli: string; root: string; log: string; env: Array<[string, string]> }

/** Fills the template. Every value is XML-escaped here, so the template holds no escaping of its own. */
export function renderPlist(template: string, v: PlistValues): string {
  const environment = v.env
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join('\n');
  const fill: Record<string, string> = {
    NODE: escapeXml(v.node), CLI: escapeXml(v.cli), ROOT: escapeXml(v.root), LOG: escapeXml(v.log), ENVIRONMENT: environment,
  };
  return template.replace(/\{\{([A-Z]+)\}\}/g, (whole, name: string) => fill[name] ?? whole);
}

/** The folder of the first executable file called `name` in `PATH`, or null. No shell is used. */
function findInPath(name: string, pathValue: string): string | null {
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    try {
      const file = join(dir, name);
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return dir;
    } catch {
      // not here
    }
  }
  return null;
}

const unique = (items: string[]): string[] => [...new Set(items)];

const logPathOf = (config: ServiceConfig): string => join(config.home, 'service', 'service.log');

// ---- defaults ----

async function writeWithMode(path: string, text: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { mode });
  await chmod(path, mode);
}

const defaultSignals = (signal: Signal, handler: () => void): (() => void) => {
  process.on(signal, handler);
  return () => { process.off(signal, handler); };
};

/** Moves a log file above 5 MB to `<file>.1`, replacing an older one. */
async function rotateLog(file: string): Promise<void> {
  try {
    if ((await stat(file)).size > MAX_LOG_BYTES) await rename(file, `${file}.1`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

// ---- commands ----

async function start(io: CliIo, o: CliOverrides): Promise<number> {
  const env = o.env ?? process.env;
  const config = (o.loadConfig ?? loadConfig)(env);
  await (o.readOrCreateToken ?? readOrCreateToken)(config.home);
  const logFile = env['AIRLOCK_LOG_FILE'];
  if (logFile !== undefined && logFile !== '') await rotateLog(logFile);
  const now = o.now ?? ((): Date => new Date());
  const server = (o.createServer ?? createServer)({
    config,
    engine: (o.engineDeps ?? defaultEngineDeps)(),
    now,
    log: (line) => { io.out(`${now().toISOString()} ${clean(line)}\n`); },
  });
  try {
    await server.listen();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      io.err(`Port ${config.port} is already in use. Airlock may already be running: ${START_HINT} -- status\n`);
      return 1;
    }
    throw e;
  }
  io.out(`Airlock service is listening on 127.0.0.1:${config.port}.\n`);
  io.out(`Pair the extension with: ${START_HINT} -- token\n`);

  const onSignal = o.onSignal ?? defaultSignals;
  let removers: Array<() => void> = [];
  await new Promise<void>((resolve) => {
    removers = (['SIGINT', 'SIGTERM'] as const).map((signal) => onSignal(signal, resolve));
  });
  for (const remove of removers) remove();
  await server.close();
  return 0;
}

async function token(io: CliIo, o: CliOverrides): Promise<number> {
  const config = (o.loadConfig ?? loadConfig)(o.env ?? process.env);
  io.out(`${await (o.readOrCreateToken ?? readOrCreateToken)(config.home)}\n`);
  return 0;
}

async function status(io: CliIo, o: CliOverrides): Promise<number> {
  const config = (o.loadConfig ?? loadConfig)(o.env ?? process.env);
  const doFetch = o.fetch ?? fetch;
  const base = `http://127.0.0.1:${config.port}`;
  const notRunning = (): number => {
    io.err(`Airlock's service is not running. Start it with: ${START_HINT}\n`);
    return 1;
  };
  let hello;
  try {
    const res = await doFetch(`${base}/hello`, { signal: AbortSignal.timeout(5000) });
    const parsed = HelloSchema.safeParse(res.ok ? await res.json() : null);
    if (!parsed.success) return notRunning();
    hello = parsed.data;
  } catch {
    return notRunning();
  }
  io.out(`Airlock service is running (version ${clean(hello.version)}).\n`);
  io.out(hello.paired ? 'An extension is paired.\n' : 'No extension is paired.\n');
  try {
    const key = await (o.readOrCreateToken ?? readOrCreateToken)(config.home);
    const res = await doFetch(`${base}/status`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    const parsed = ServiceStatusSchema.safeParse(res.ok ? await res.json() : null);
    if (!parsed.success) {
      io.out('The service did not give its details.\n');
      return 0;
    }
    const s = parsed.data;
    io.out(`Claude: ${s.claude ? 'found and signed in.' : 'not found or not signed in.'}\n`);
    io.out(`GitHub command (gh): ${s.gh ? 'found and signed in.' : 'not found or not signed in.'}\n`);
    if (s.running.length === 0) io.out('No reviews are running.\n');
    else io.out(`Running reviews: ${s.running.map((r) => `${clean(r.repo)}#${r.number}`).join(', ')}\n`);
  } catch (e) {
    io.out(`The service did not give its details: ${messageOf(e)}\n`);
  }
  return 0;
}

async function unpairCommand(io: CliIo, o: CliOverrides): Promise<number> {
  const config = (o.loadConfig ?? loadConfig)(o.env ?? process.env);
  await (o.unpair ?? unpair)(config.home);
  io.out(`The extension is no longer paired. Pair again from the panel with a token from: ${START_HINT} -- token\n`);
  return 0;
}

function launchContext(o: CliOverrides): { exec: Exec; uid: number; plist: string } {
  const uid = o.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error('Airlock cannot tell which user this is, so it cannot talk to launchd.');
  const plist = join(o.home ?? homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  return { exec: o.exec ?? realExec, uid, plist };
}

/** `launchctl bootout`; a failure means nothing was loaded and is ignored. */
async function bootout(exec: Exec, uid: number): Promise<void> {
  try {
    await exec('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
  } catch {
    // nothing was loaded
  }
}

async function install(io: CliIo, o: CliOverrides): Promise<number> {
  const env = o.env ?? process.env;
  const cliPath = o.cliPath ?? fileURLToPath(import.meta.url);
  if (!(await stat(cliPath).then((s) => s.isFile(), () => false))) {
    io.err('Build Airlock first: npm run build\n');
    return 1;
  }
  const { exec, uid, plist } = launchContext(o);
  const config = (o.loadConfig ?? loadConfig)(env);
  const log = logPathOf(config);
  const root = dirname(dirname(dirname(dirname(cliPath))));
  const home = o.home ?? homedir();

  const pathValue = env['PATH'] ?? '';
  const missing: string[] = [];
  const found: string[] = [];
  for (const name of COMMANDS) {
    const dir = findInPath(name, pathValue);
    if (dir === null) missing.push(name);
    else found.push(dir);
  }
  const environment: Array<[string, string]> = [
    ['PATH', unique([...found, ...SYSTEM_PATH]).join(delimiter)],
    ['HOME', home],
    ['AIRLOCK_LOG_FILE', log],
  ];
  for (const name of ['AIRLOCK_HOME', 'AIRLOCK_PORT', 'AIRLOCK_PACKS_DIR']) {
    const value = env[name];
    if (value !== undefined && value !== '') environment.push([name, value]);
  }
  const template = await readFile(new URL('../launchd/com.airlock.service.plist.template', import.meta.url), 'utf8');
  const text = renderPlist(template, { node: o.execPath ?? process.execPath, cli: cliPath, root, log, env: environment });

  await (o.makeDir ?? ((p) => mkdir(p, { recursive: true, mode: 0o700 }).then(() => undefined)))(dirname(log));
  await (o.writeFile ?? writeWithMode)(plist, text, 0o644);
  await bootout(exec, uid);
  let result;
  try {
    result = await exec('launchctl', ['bootstrap', `gui/${uid}`, plist]);
  } catch (e) {
    result = { stdout: '', stderr: messageOf(e), code: 1 };
  }
  if (result.code !== 0) {
    const why = clean(result.stderr.trim() || result.stdout.trim() || `launchctl exited with ${result.code}`);
    io.err(`launchctl could not load the service: ${why}\nThe plist was left in place at ${clean(plist)}.\n`);
    return 1;
  }
  io.out(`Wrote ${clean(plist)}.\n`);
  io.out('Airlock service now starts at login (and is running now).\n');
  io.out(`Its log is ${clean(log)}.\n`);
  for (const name of missing) io.out(`${name} was not found on your PATH: reviews will not work until it is installed.\n`);
  return 0;
}

async function uninstall(io: CliIo, o: CliOverrides): Promise<number> {
  const { exec, uid, plist } = launchContext(o);
  await bootout(exec, uid);
  const existed = await stat(plist).then(() => true, () => false);
  if (existed) await (o.removeFile ?? ((p) => rm(p, { force: true })))(plist);
  io.out(existed
    ? `Stopped the service and removed ${clean(plist)}. It no longer starts at login.\n`
    : `The service was not installed (no ${clean(plist)}). It no longer starts at login.\n`);
  return 0;
}

/** Runs one command and returns the exit code. Never throws and never calls process.exit. */
export async function main(argv: string[], io: CliIo, overrides: CliOverrides = {}): Promise<number> {
  try {
    const command = parse(argv);
    if (typeof command !== 'string') {
      io.err(`${command.error}\n${usage()}\n`);
      return 2;
    }
    switch (command) {
      case 'help': io.out(`${usage()}\n`); return 0;
      case 'start': return await start(io, overrides);
      case 'token': return await token(io, overrides);
      case 'status': return await status(io, overrides);
      case 'unpair': return await unpairCommand(io, overrides);
      case 'install': return await install(io, overrides);
      case 'uninstall': return await uninstall(io, overrides);
    }
  } catch (err) {
    try {
      io.err(`Airlock service failed: ${messageOf(err)}\n`);
    } catch {
      // nothing left to report to
    }
    return 1;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const real = (path: string): string | undefined => {
    try { return realpathSync(path); } catch { return undefined; }
  };
  const self = real(fileURLToPath(import.meta.url));
  const started = real(entry) ?? real(`${entry}.js`);
  return self !== undefined && started === self;
}

if (isEntryPoint()) {
  main(process.argv.slice(2), { out: (t) => { process.stdout.write(t); }, err: (t) => { process.stderr.write(t); } }).then(
    (code) => { process.exitCode = code; },
    (err: unknown) => {
      process.stderr.write(`Airlock service failed: ${messageOf(err)}\n`);
      process.exitCode = 1;
    },
  );
}
