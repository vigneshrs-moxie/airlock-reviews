#!/usr/bin/env node
import { accessSync, closeSync, constants, openSync, realpathSync, statSync, writeSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanForTerminal, realExec, type EngineDeps, type Exec } from '@airlock/engine';
import { HelloSchema, ServiceStatusSchema, type Hello } from '@airlock/shared';
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
  /** Reads the token file without ever making one; null when there is none. */
  readToken?: (home: string) => Promise<string | null>;
  unpair?: (home: string) => Promise<void>;
  fetch?: typeof fetch;
  exec?: Exec;
  /** The home folder whose `Library/LaunchAgents` holds the plist. */
  home?: string;
  /** Writes a text file (making its folder) with the given mode. */
  writeFile?: (path: string, text: string, mode: number) => Promise<void>;
  /** Sets a file's mode (used to make an existing log file private when it is opened). */
  chmodFile?: (path: string, mode: number) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
  makeDir?: (path: string) => Promise<void>;
  /** The current folder, against which relative AIRLOCK_* paths are resolved at install. */
  cwd?: string;
  /** How long `status` and `install` wait for the service to answer, in milliseconds (5000 by default). */
  timeoutMs?: number;
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

export interface PlistValues { node: string; cli: string; root: string; launchdLog: string; env: Array<[string, string]> }

/** Fills the template. Every value is XML-escaped here, so the template holds no escaping of its own. */
export function renderPlist(template: string, v: PlistValues): string {
  const environment = v.env
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join('\n');
  const fill: Record<string, string> = {
    NODE: escapeXml(v.node), CLI: escapeXml(v.cli), ROOT: escapeXml(v.root), LAUNCHD_LOG: escapeXml(v.launchdLog), ENVIRONMENT: environment,
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name: string) => fill[name] ?? whole);
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
const launchdLogOf = (config: ServiceConfig): string => join(config.home, 'service', 'launchd.log');

async function defaultReadToken(home: string): Promise<string | null> {
  try {
    const text = (await readFile(join(home, 'service', 'token'), 'utf8')).trim();
    return text === '' ? null : text;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

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
  const now = o.now ?? ((): Date => new Date());

  // Under launchd the request log goes to the file AIRLOCK_LOG_FILE names, which this process rotates and opens itself.
  // A failure here never stops the service: it logs to the terminal instead.
  let sink: (text: string) => void = io.out;
  let closeLog = (): void => undefined;
  const logFile = env['AIRLOCK_LOG_FILE'];
  if (logFile !== undefined && logFile !== '') {
    try {
      await rotateLog(logFile);
      const fd = openSync(logFile, 'a', 0o600);
      await (o.chmodFile ?? chmod)(logFile, 0o600);
      sink = (text) => {
        try {
          writeSync(fd, text);
        } catch {
          io.out(text);
        }
      };
      closeLog = () => { try { closeSync(fd); } catch { /* already closed */ } };
    } catch (e) {
      io.err(`The log file ${clean(logFile)} could not be used (${messageOf(e)}). Logging to the terminal instead.\n`);
    }
  }

  const server = (o.createServer ?? createServer)({
    config,
    engine: (o.engineDeps ?? defaultEngineDeps)(),
    now,
    log: (line) => { sink(`${now().toISOString()} ${clean(line)}\n`); },
  });
  try {
    try {
      await server.listen();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        if (env['AIRLOCK_UNDER_LAUNCHD'] === '1') {
          io.err(`Port ${config.port} is already in use, so another copy of Airlock is running. This copy is stopping.\n`);
          return 0;
        }
        io.err(`Port ${config.port} is already in use. Airlock may already be running: ${START_HINT} -- status\n`);
        return 1;
      }
      throw e;
    }
    io.out(`Airlock service is listening on 127.0.0.1:${config.port}.\n`);
    io.out(`Pair the extension with: ${START_HINT} -- token\n`);

    const onSignal = o.onSignal ?? defaultSignals;
    let removers: Array<() => void> = [];
    await new Promise<void>((done) => {
      removers = (['SIGINT', 'SIGTERM'] as const).map((signal) => onSignal(signal, done));
    });
    for (const remove of removers) remove();
    await server.close();
    return 0;
  } finally {
    closeLog();
  }
}

async function token(io: CliIo, o: CliOverrides): Promise<number> {
  const config = (o.loadConfig ?? loadConfig)(o.env ?? process.env);
  io.out(`${await (o.readOrCreateToken ?? readOrCreateToken)(config.home)}\n`);
  return 0;
}

const timeoutSignal = (o: CliOverrides, fallback: number): AbortSignal => AbortSignal.timeout(o.timeoutMs ?? fallback);

/** True when something on the configured port answers `/hello` as Airlock. */
async function answersHello(config: ServiceConfig, o: CliOverrides): Promise<Hello | null> {
  try {
    const res = await (o.fetch ?? fetch)(`http://127.0.0.1:${config.port}/hello`, { signal: timeoutSignal(o, 5000) });
    const parsed = HelloSchema.safeParse(res.ok ? await res.json() : null);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function status(io: CliIo, o: CliOverrides): Promise<number> {
  const config = (o.loadConfig ?? loadConfig)(o.env ?? process.env);
  const hello = await answersHello(config, o);
  if (hello === null) {
    io.err(`Airlock's service is not running. Start it with: ${START_HINT}\n`);
    return 1;
  }
  // Read-only: the token is read if it exists and never made here.
  const key = await (o.readToken ?? defaultReadToken)(config.home);
  if (key === null) {
    io.err("Airlock's service is running, but no pairing token has been made yet.\n");
    return 1;
  }
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(`http://127.0.0.1:${config.port}/status`, {
      headers: { Authorization: `Bearer ${key}` }, signal: timeoutSignal(o, 15000),
    });
  } catch (e) {
    io.out(`Airlock service is running (version ${clean(hello.version)}).\n`);
    io.out(`The service did not give its details: ${messageOf(e)}\n`);
    return 0;
  }
  if (res.status === 401 || res.status === 403) {
    io.err(`Airlock's service is running, but the pairing token on disk is not the one it is using. Stop it and start it again: ${START_HINT}\n`);
    return 1;
  }
  io.out(`Airlock service is running (version ${clean(hello.version)}).\n`);
  io.out(hello.paired ? 'An extension is paired.\n' : 'No extension is paired.\n');
  let parsed;
  try {
    parsed = ServiceStatusSchema.safeParse(res.ok ? await res.json() : null);
  } catch {
    parsed = { success: false as const };
  }
  if (!parsed.success) {
    io.out('The service did not give its details.\n');
    return 0;
  }
  const s = parsed.data;
  io.out(`Claude: ${s.claude ? 'found and signed in.' : 'not found or not signed in.'}\n`);
  io.out(`GitHub command (gh): ${s.gh ? 'found and signed in.' : 'not found or not signed in.'}\n`);
  if (s.running.length === 0) io.out('No reviews are running.\n');
  else io.out(`Running reviews: ${s.running.map((r) => `${clean(r.repo)}#${r.number}`).join(', ')}\n`);
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
  // Relative paths mean nothing to launchd, so they are made absolute against the current folder first.
  const cwd = o.cwd ?? process.cwd();
  const resolvedEnv: NodeJS.ProcessEnv = { ...env };
  for (const name of ['AIRLOCK_HOME', 'AIRLOCK_PACKS_DIR', 'AIRLOCK_CLAUDE_PATH']) {
    const value = env[name];
    if (value !== undefined && value !== '') resolvedEnv[name] = resolve(cwd, value);
  }
  const config = (o.loadConfig ?? loadConfig)(resolvedEnv);
  const log = logPathOf(config);
  const launchdLog = launchdLogOf(config);
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
    ['AIRLOCK_UNDER_LAUNCHD', '1'],
  ];
  for (const name of ['AIRLOCK_HOME', 'AIRLOCK_PORT', 'AIRLOCK_PACKS_DIR', 'AIRLOCK_CLAUDE_PATH']) {
    const value = resolvedEnv[name];
    if (value !== undefined && value !== '') environment.push([name, value]);
  }
  const execPath = o.execPath ?? process.execPath;
  const named: Array<[string, string]> = [
    ['the Node path', execPath], ['the built cli.js path', cliPath], ['the repository folder', root],
    ['the log path', launchdLog], ...environment,
  ];
  for (const [name, value] of named) {
    if (/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/.test(value)) {
      io.err(`Airlock cannot write ${clean(name)} into the login item because it contains a control character.\n`);
      return 1;
    }
  }
  const template = await readFile(new URL('../launchd/com.airlock.service.plist.template', import.meta.url), 'utf8');
  const text = renderPlist(template, { node: execPath, cli: cliPath, root, launchdLog, env: environment });

  await (o.makeDir ?? ((p) => mkdir(p, { recursive: true, mode: 0o700 }).then(() => undefined)))(dirname(log));
  await (o.writeFile ?? writeWithMode)(plist, text, 0o644);
  await bootout(exec, uid);
  // The agent's own previous copy is gone after bootout; whatever still answers is another copy. Wait up to two
  // seconds for the port to go quiet before deciding.
  const wait = o.timeoutMs ?? 2000;
  const deadline = Date.now() + wait;
  let alreadyRunning = false;
  for (;;) {
    alreadyRunning = (await answersHello(config, { ...o, timeoutMs: wait })) !== null;
    if (!alreadyRunning || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 25));
  }
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
  if (alreadyRunning) {
    io.out(`A copy of Airlock is already running on port ${config.port}, so the login item did not start a second one. It will start Airlock the next time you log in. To switch to it now, stop the running copy and run: ${START_HINT}:install\n`);
  } else {
    io.out('Airlock service now starts at login and is running now.\n');
  }
  io.out(`Its log is ${clean(log)} (start-up problems go to ${clean(launchdLog)}).\n`);
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
