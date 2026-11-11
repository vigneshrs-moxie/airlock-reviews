import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineDeps, Exec } from '@airlock/engine';
import { main, renderPlist, usage, type CliOverrides } from '../src/cli.js';
import type { ServiceConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

// The default Exec must never be reached: every machine-touching call goes through an override.
vi.mock('@airlock/engine', async (original) => ({
  ...(await original<typeof import('@airlock/engine')>()),
  realExec: vi.fn(() => { throw new Error('the real Exec was reached'); }),
}));
const engine = await import('@airlock/engine');

const TOKEN = 'ab'.repeat(32);
const PORT = 45611;
const ENGINE_DEPS = { exec: vi.fn(), runner: { run: vi.fn() }, now: () => new Date(0) } as unknown as EngineDeps;
const tidy = mkdtempSync(join(tmpdir(), 'airlock-cli-test-'));

interface Call { cmd: string; args: string[] }

function makeRoot(): string {
  return realpathSync(mkdtempSync(join(tidy, 'case-')));
}

/** An executable file named `name` in a new folder. */
function tool(root: string, folder: string, name: string): string {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o755);
  return dir;
}

type Signal = 'SIGINT' | 'SIGTERM';

/**
 * The only way tests build their overrides. Every machine-touching override is supplied (the type demands all of
 * them), and each one either records, fails like "nothing there", or throws when it is pointed outside the temporary
 * folder, so a test that forgets to replace something fails loudly instead of touching the machine.
 */
function harness(options: { exists?: boolean; env?: Record<string, string>; bootstrapFails?: boolean; tools?: string[]; bootoutThrows?: boolean } = {}) {
  const root = makeRoot();
  const airlockHome = join(root, 'airlock-home');
  const fakeHome = join(root, 'fake-home');
  mkdirSync(fakeHome, { recursive: true });
  const repoRoot = join(root, 'repo');
  const cliPath = join(repoRoot, 'packages', 'service', 'dist', 'cli.js');
  if (options.exists !== false) {
    mkdirSync(join(repoRoot, 'packages', 'service', 'dist'), { recursive: true });
    writeFileSync(cliPath, '// built\n');
  }
  const binDirs = (options.tools ?? ['claude', 'gh', 'git']).map((t) => tool(root, `bin-${t}`, t));
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const handlers = new Map<Signal, () => void>();
  const server = { listen: vi.fn(async () => ({ port: PORT, address: '127.0.0.1', family: 'IPv4' })), close: vi.fn(async () => undefined) };
  const created: Array<Parameters<NonNullable<CliOverrides['createServer']>>[0]> = [];
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === 'bootout' && options.bootoutThrows === true) throw new Error('launchctl could not start');
    if (options.bootstrapFails === true && args[0] === 'bootstrap') return { stdout: '', stderr: 'Bootstrap failed: 5\u001b[31m boom\n', code: 5 };
    if (args[0] === 'bootout') return { stdout: '', stderr: 'No such process', code: 3 };
    return { stdout: '', stderr: '', code: 0 };
  };
  const config: ServiceConfig = { port: PORT, home: airlockHome, packsDir: join(root, 'packs'), version: '9.9.9' };
  const env: Record<string, string> = { PATH: binDirs.join(':'), ...options.env };
  const inside = (path: string): string => {
    if (!path.startsWith(`${root}${sep}`)) throw new Error(`a test reached outside its temporary folder: ${path}`);
    return path;
  };
  const createToken = vi.fn(async () => TOKEN);
  const overrides: Required<CliOverrides> = {
    createServer: (deps) => { created.push(deps); return server; },
    engineDeps: () => ENGINE_DEPS,
    loadConfig: () => config,
    readOrCreateToken: createToken,
    readToken: async () => TOKEN,
    unpair: vi.fn(async () => undefined),
    fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
    timeoutMs: 100,
    exec,
    home: fakeHome,
    writeFile: async (path, text, mode) => {
      mkdirSync(dirname(inside(path)), { recursive: true });
      writeFileSync(path, text, { mode });
      chmodSync(path, mode);
    },
    removeFile: async (path) => { rmSync(inside(path), { force: true }); },
    makeDir: async (path) => { mkdirSync(inside(path), { recursive: true }); },
    cwd: root,
    uid: 501,
    execPath: '/opt/node/bin/node',
    cliPath,
    env,
    onSignal: (signal, handler) => { handlers.set(signal, handler); return () => { handlers.delete(signal); }; },
    now: () => new Date('2026-11-11T09:00:00.000Z'),
  };
  const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
  const plist = join(fakeHome, 'Library', 'LaunchAgents', 'com.airlock.service.plist');
  return { root, airlockHome, fakeHome, repoRoot, cliPath, binDirs, out, err, calls, handlers, server, created, overrides, io, plist, config, createToken };
}

const all = (h: { out: string[]; err: string[] }): string => [...h.out, ...h.err].join('');
const waitFor = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

afterEach(() => {
  vi.unstubAllEnvs();
  expect(vi.mocked(engine.realExec)).not.toHaveBeenCalled();
});

describe('commands and usage', () => {
  it('help prints the usage and returns 0', async () => {
    const h = harness();
    expect(await main(['help'], h.io, h.overrides)).toBe(0);
    expect(h.out.join('')).toBe(`${usage()}\n`);
    expect(usage()).toContain('npm run service');
  });

  it('an unknown command and extra arguments return 2 and print the usage on err', async () => {
    for (const argv of [['bogus'], ['token', 'extra']]) {
      const h = harness();
      expect(await main(argv, h.io, h.overrides)).toBe(2);
      expect(h.out).toEqual([]);
      expect(h.err.join('')).toContain('npm run service');
    }
  });

  it('no command means start', async () => {
    const h = harness();
    const done = main([], h.io, h.overrides);
    await waitFor(() => h.handlers.has('SIGTERM'));
    expect(h.server.listen).toHaveBeenCalledTimes(1);
    h.handlers.get('SIGTERM')?.();
    expect(await done).toBe(0);
  });
});

describe('start', () => {
  it('prints the two lines, never the token, and returns 0 after SIGTERM once the server is closed', async () => {
    const h = harness();
    let resolved = false;
    const done = main(['start'], h.io, h.overrides).then((c) => { resolved = true; return c; });
    await waitFor(() => h.handlers.has('SIGTERM'));
    expect(resolved).toBe(false);
    expect(h.out.join('')).toBe(
      `Airlock service is listening on 127.0.0.1:${PORT}.\nPair the extension with: npm run service -- token\n`);
    expect(all(h)).not.toContain(TOKEN);
    expect(h.handlers.has('SIGINT')).toBe(true);
    h.handlers.get('SIGTERM')?.();
    expect(await done).toBe(0);
    expect(h.server.close).toHaveBeenCalledTimes(1);
    expect(h.handlers.size).toBe(0);
  });

  it('stops on SIGINT too', async () => {
    const h = harness();
    const done = main(['start'], h.io, h.overrides);
    await waitFor(() => h.handlers.has('SIGINT'));
    h.handlers.get('SIGINT')?.();
    expect(await done).toBe(0);
    expect(h.server.close).toHaveBeenCalledTimes(1);
  });

  it('refuses to run when the port is taken and says which port', async () => {
    const h = harness();
    h.server.listen.mockRejectedValue(Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:45611'), { code: 'EADDRINUSE' }));
    expect(await main(['start'], h.io, h.overrides)).toBe(1);
    expect(h.err.join('')).toBe(`Port ${PORT} is already in use. Airlock may already be running: npm run service -- status\n`);
    expect(h.handlers.size).toBe(0);
  });

  it('under launchd a taken port is a quiet stop with 0, so launchd leaves it stopped', async () => {
    const h = harness({ env: { AIRLOCK_UNDER_LAUNCHD: '1' } });
    h.server.listen.mockRejectedValue(Object.assign(new Error('in use'), { code: 'EADDRINUSE' }));
    expect(await main(['start'], h.io, h.overrides)).toBe(0);
    expect(h.err.join('')).toBe(`Port ${PORT} is already in use, so another copy of Airlock is running. This copy is stopping.\n`);
  });

  it('the request log gets a time stamp, one line per request, and never the token or a header', async () => {
    const h = harness();
    const done = main(['start'], h.io, h.overrides);
    await waitFor(() => h.handlers.has('SIGTERM'));
    const log = h.created[0]?.log;
    log?.('GET /status 200 4ms');
    log?.('POST /x failed: boom\nsecond\u001b[31m line');
    expect(h.out.slice(-2)).toEqual([
      '2026-11-11T09:00:00.000Z GET /status 200 4ms\n',
      '2026-11-11T09:00:00.000Z POST /x failed: boom second[31m line\n',
    ]);
    expect(all(h)).not.toContain(TOKEN);
    expect(all(h)).not.toContain('Authorization');
    expect(h.created[0]?.engine).toBe(ENGINE_DEPS);
    h.handlers.get('SIGTERM')?.();
    await done;
  });

  it('rotates a log file above 5 MB, then writes new lines to the live path while .1 holds the old ones', async () => {
    const h = harness();
    const log = join(h.root, 'service.log');
    writeFileSync(log, Buffer.alloc(5 * 1024 * 1024 + 1));
    writeFileSync(`${log}.1`, 'older');
    h.overrides.env = { ...h.overrides.env, AIRLOCK_LOG_FILE: log };
    const done = main(['start'], h.io, h.overrides);
    await waitFor(() => h.handlers.has('SIGTERM'));
    h.created[0]?.log('GET /x 200 1ms');
    h.handlers.get('SIGTERM')?.();
    expect(await done).toBe(0);
    expect(statSync(`${log}.1`).size).toBe(5 * 1024 * 1024 + 1);
    expect(readFileSync(log, 'utf8')).toBe('2026-11-11T09:00:00.000Z GET /x 200 1ms\n');
    expect(statSync(log).mode & 0o777).toBe(0o600);
    expect(h.out.join('')).not.toContain('GET /x');
  });

  it('appends to a small log file and leaves other files alone', async () => {
    const h = harness();
    const log = join(h.root, 'service.log');
    writeFileSync(log, 'small\n');
    writeFileSync(join(h.root, 'other.log'), Buffer.alloc(5 * 1024 * 1024 + 1));
    h.overrides.env = { ...h.overrides.env, AIRLOCK_LOG_FILE: log };
    const done = main(['start'], h.io, h.overrides);
    await waitFor(() => h.handlers.has('SIGTERM'));
    h.created[0]?.log('GET /y 200 2ms');
    h.handlers.get('SIGTERM')?.();
    await done;
    expect(readFileSync(log, 'utf8')).toBe('small\n2026-11-11T09:00:00.000Z GET /y 200 2ms\n');
    expect(existsSync(`${log}.1`)).toBe(false);
  });

  it('a rotation failure never stops the service: one line says so and logging goes to the terminal', async () => {
    const h = harness();
    const log = join(h.root, 'service.log');
    writeFileSync(log, Buffer.alloc(5 * 1024 * 1024 + 1));
    mkdirSync(`${log}.1`);
    writeFileSync(join(`${log}.1`, 'in-the-way'), 'x');
    h.overrides.env = { ...h.overrides.env, AIRLOCK_LOG_FILE: log };
    const done = main(['start'], h.io, h.overrides);
    await waitFor(() => h.handlers.has('SIGTERM'));
    h.created[0]?.log('GET /z 200 3ms');
    h.handlers.get('SIGTERM')?.();
    expect(await done).toBe(0);
    const lines = h.err.join('').split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('could not be used');
    expect(h.out.join('')).toContain('GET /z 200 3ms');
    expect(h.out.join('')).toContain('is listening');
  });

  it('touches no file without AIRLOCK_LOG_FILE, and logs to the terminal', async () => {
    const h = harness();
    writeFileSync(join(h.root, 'service.log'), Buffer.alloc(5 * 1024 * 1024 + 1));
    const done = main(['start'], h.io, h.overrides);
    await waitFor(() => h.handlers.has('SIGTERM'));
    expect(existsSync(join(h.root, 'service.log.1'))).toBe(false);
    h.handlers.get('SIGTERM')?.();
    await done;
  });

  it('the real request log never holds the token or the Authorization header', async () => {
    const home = join(makeRoot(), 'airlock-home');
    const lines: string[] = [];
    const server = createServer({
      config: { port: 0, home, packsDir: join(home, 'packs'), version: '1.0.0' },
      engine: ENGINE_DEPS, now: () => new Date(0), log: (l) => lines.push(l),
    });
    const { port } = await server.listen();
    try {
      const token = readFileSync(join(home, 'service', 'token'), 'utf8').trim();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      for (const path of ['/hello', '/nothing-here']) {
        await new Promise<void>((resolve, reject) => {
          const req = http.get({ host: '127.0.0.1', port, path, headers: { Authorization: `Bearer ${token}` } }, (res) => {
            res.resume();
            res.on('end', resolve);
          });
          req.on('error', reject);
        });
      }
      await waitFor(() => lines.length >= 2);
      expect(lines.join('\n')).toMatch(/GET \/hello 200 \d+ms/);
      const text = lines.join('\n');
      expect(text).not.toContain(token);
      expect(text.toLowerCase()).not.toContain('authorization');
      expect(text).not.toContain('Bearer');
    } finally {
      await server.close();
    }
  });
});

describe('token', () => {
  it('prints only the token and a newline', async () => {
    const h = harness();
    expect(await main(['token'], h.io, h.overrides)).toBe(0);
    expect(h.out).toEqual([`${TOKEN}\n`]);
    expect(h.err).toEqual([]);
  });
});

describe('status', () => {
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('says in words that it is running, what is signed in, and the running reviews, and never prints the token', async () => {
    const h = harness();
    const seen: Array<{ url: string; auth: string | null }> = [];
    h.overrides.fetch = (async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization');
      seen.push({ url, auth });
      if (url.endsWith('/hello')) return json({ airlock: true, version: '9.9.9', paired: true });
      return json({ version: '9.9.9', claude: true, gh: false, packsDir: '/p', running: [{ runId: 'run_0123456789ab', repo: 'o/r', number: 7 }] });
    }) as typeof fetch;
    expect(await main(['status'], h.io, h.overrides)).toBe(0);
    expect(seen).toEqual([{ url: `http://127.0.0.1:${PORT}/hello`, auth: null }, { url: `http://127.0.0.1:${PORT}/status`, auth: `Bearer ${TOKEN}` }]);
    const text = h.out.join('');
    expect(text).toContain('Airlock service is running (version 9.9.9).');
    expect(text).toContain('An extension is paired.');
    expect(text).toContain('Claude: found and signed in.');
    expect(text).toContain('GitHub command (gh): not found or not signed in.');
    expect(text).toContain('o/r#7');
    expect(all(h)).not.toContain(TOKEN);
  });

  it('says when nothing is paired and nothing is running', async () => {
    const h = harness();
    h.overrides.fetch = (async (url: string) => url.endsWith('/hello')
      ? json({ airlock: true, version: '1.0.0', paired: false })
      : json({ version: '1.0.0', claude: true, gh: true, packsDir: '/p', running: [] })) as typeof fetch;
    expect(await main(['status'], h.io, h.overrides)).toBe(0);
    expect(h.out.join('')).toContain('No extension is paired.');
    expect(h.out.join('')).toContain('No reviews are running.');
  });

  it('returns 1 with the start command when nothing answers or the answer is not Airlock', async () => {
    for (const f of [
      (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
      (async () => json({ hello: 'world' })) as typeof fetch,
    ]) {
      const h = harness();
      h.overrides.fetch = f;
      expect(await main(['status'], h.io, h.overrides)).toBe(1);
      expect(h.err.join('')).toBe("Airlock's service is not running. Start it with: npm run service\n");
      expect(all(h)).not.toContain(TOKEN);
    }
  });
});

describe('status, honestly and read-only', () => {
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const hello = { airlock: true, version: '1.0.0', paired: false };

  it('never calls the token creator', async () => {
    const h = harness();
    h.overrides.fetch = (async (url: string) => url.endsWith('/hello')
      ? json(hello)
      : json({ version: '1.0.0', claude: true, gh: true, packsDir: '/p', running: [] })) as typeof fetch;
    expect(await main(['status'], h.io, h.overrides)).toBe(0);
    expect(h.createToken).not.toHaveBeenCalled();
  });

  it('a 401 or 403 from /status says the token on disk is not the one in use, and returns 1', async () => {
    for (const code of [401, 403]) {
      const h = harness();
      h.overrides.fetch = (async (url: string) => url.endsWith('/hello') ? json(hello) : json({ error: 'no' }, code)) as typeof fetch;
      expect(await main(['status'], h.io, h.overrides)).toBe(1);
      expect(h.err.join('')).toBe(
        "Airlock's service is running, but the pairing token on disk is not the one it is using. Stop it and start it again: npm run service\n");
      expect(all(h)).not.toContain(TOKEN);
      expect(h.createToken).not.toHaveBeenCalled();
    }
  });

  it('with no token file it says none has been made, makes none, and returns 1', async () => {
    const h = harness();
    h.overrides.readToken = async () => null;
    h.overrides.fetch = (async () => json(hello)) as typeof fetch;
    expect(await main(['status'], h.io, h.overrides)).toBe(1);
    expect(h.err.join('')).toBe("Airlock's service is running, but no pairing token has been made yet.\n");
    expect(h.createToken).not.toHaveBeenCalled();
  });

  it('gives up cleanly when the port accepts the connection and never answers', async () => {
    const h = harness();
    h.overrides.timeoutMs = 30;
    h.overrides.fetch = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as typeof fetch;
    expect(await main(['status'], h.io, h.overrides)).toBe(1);
    expect(h.err.join('')).toBe("Airlock's service is not running. Start it with: npm run service\n");
  });
});

describe('unpair', () => {
  it('clears the paired extension and says how to pair again', async () => {
    const h = harness();
    const unpair = vi.fn(async (_home: string) => undefined);
    h.overrides.unpair = unpair;
    expect(await main(['unpair'], h.io, h.overrides)).toBe(0);
    expect(unpair).toHaveBeenCalledWith(h.airlockHome);
    expect(h.out.join('')).toBe(
      'The extension is no longer paired. Pair again from the panel with a token from: npm run service -- token\n');
  });
});

describe('install and uninstall', () => {
  it('writes the plist under the fake home only, mode 0644, and makes the two launchctl calls in order', async () => {
    const h = harness();
    expect(await main(['install'], h.io, h.overrides)).toBe(0);
    expect(existsSync(h.plist)).toBe(true);
    expect(statSync(h.plist).mode & 0o777).toBe(0o644);
    expect(h.calls).toEqual([
      { cmd: 'launchctl', args: ['bootout', 'gui/501/com.airlock.service'] },
      { cmd: 'launchctl', args: ['bootstrap', 'gui/501', h.plist] },
    ]);
    const text = readFileSync(h.plist, 'utf8');
    expect(text).toContain('<string>com.airlock.service</string>');
    expect(text).toContain('<string>/opt/node/bin/node</string>');
    expect(text).toContain(`<string>${h.cliPath}</string>`);
    expect(text).toContain(`<string>${h.repoRoot}</string>`);
    const launchdLog = join(h.airlockHome, 'service', 'launchd.log');
    expect(text).toContain(`<key>StandardOutPath</key>\n  <string>${launchdLog}</string>`);
    expect(text).toContain(`<key>StandardErrorPath</key>\n  <string>${launchdLog}</string>`);
    expect(text).toContain('<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>');
    expect(text).toContain('<key>ThrottleInterval</key>\n  <integer>30</integer>');
    expect(text).toContain('<key>AIRLOCK_UNDER_LAUNCHD</key>\n    <string>1</string>');
    expect(text).toContain(`<key>AIRLOCK_LOG_FILE</key>\n    <string>${join(h.airlockHome, 'service', 'service.log')}</string>`);
    expect(text).toContain(`<key>HOME</key>\n    <string>${h.fakeHome}</string>`);
    expect(text).not.toContain('AIRLOCK_PORT');
    const printed = h.out.join('');
    expect(printed).toContain(h.plist);
    expect(printed).toContain('starts at login');
    expect(printed).toContain(join(h.airlockHome, 'service', 'service.log'));
    expect(existsSync(join(h.airlockHome, 'service'))).toBe(true);
  });

  it('puts the tool folders first in PATH without repeats, and passes on AIRLOCK_* that are set', async () => {
    const h = harness({ env: { AIRLOCK_PORT: '4700', AIRLOCK_PACKS_DIR: '/x/packs' } });
    const shared = tool(h.root, 'bin-shared', 'claude');
    tool(h.root, 'bin-shared', 'gh');
    h.overrides.env = { ...h.overrides.env, PATH: [shared, h.binDirs[2] as string, shared, '/usr/bin'].join(':') };
    await main(['install'], h.io, h.overrides);
    const text = readFileSync(h.plist, 'utf8');
    expect(text).toContain(`<key>PATH</key>\n    <string>${shared}:${h.binDirs[2]}:/usr/bin:/bin:/usr/sbin:/sbin</string>`);
    expect(text).toContain('<key>AIRLOCK_PORT</key>\n    <string>4700</string>');
    expect(text).toContain('<key>AIRLOCK_PACKS_DIR</key>\n    <string>/x/packs</string>');
    expect(text).not.toContain('<key>AIRLOCK_HOME</key>');
  });

  it('resolves AIRLOCK_HOME and AIRLOCK_PACKS_DIR against the current folder and carries AIRLOCK_CLAUDE_PATH', async () => {
    const h = harness({ env: { AIRLOCK_HOME: 'rel/home', AIRLOCK_PACKS_DIR: './packs-here', AIRLOCK_CLAUDE_PATH: '/opt/claude' } });
    expect(await main(['install'], h.io, h.overrides)).toBe(0);
    const text = readFileSync(h.plist, 'utf8');
    expect(text).toContain(`<key>AIRLOCK_HOME</key>\n    <string>${join(h.root, 'rel', 'home')}</string>`);
    expect(text).toContain(`<key>AIRLOCK_PACKS_DIR</key>\n    <string>${join(h.root, 'packs-here')}</string>`);
    expect(text).toContain('<key>AIRLOCK_CLAUDE_PATH</key>\n    <string>/opt/claude</string>');
  });

  it('refuses a value with a control character (not a tab), writes nothing and runs nothing', async () => {
    const h = harness({ env: { AIRLOCK_PACKS_DIR: '/x/pa\nks' } });
    expect(await main(['install'], h.io, h.overrides)).toBe(1);
    expect(h.err.join('')).toBe('Airlock cannot write AIRLOCK_PACKS_DIR into the login item because it contains a control character.\n');
    expect(existsSync(h.plist)).toBe(false);
    expect(h.calls).toEqual([]);
    const tab = harness({ env: { AIRLOCK_PACKS_DIR: '/x/pa\tks' } });
    expect(await main(['install'], tab.io, tab.overrides)).toBe(0);
  });

  it('says when a copy already answers on the port, and still installs', async () => {
    const h = harness();
    h.overrides.fetch = (async () => new Response(JSON.stringify({ airlock: true, version: '1', paired: false }), { status: 200 })) as typeof fetch;
    expect(await main(['install'], h.io, h.overrides)).toBe(0);
    expect(h.out.join('')).toContain(
      `A copy of Airlock is already running on port ${PORT}. The login item is installed and will take over the next time you log in or after that copy stops.`);
    expect(h.calls).toHaveLength(2);
  });

  it('does not say so when nothing answers', async () => {
    const h = harness();
    await main(['install'], h.io, h.overrides);
    expect(h.out.join('')).not.toContain('already running');
  });

  it('tolerates the bootout call throwing, in install and in uninstall', async () => {
    const h = harness({ bootoutThrows: true });
    expect(await main(['install'], h.io, h.overrides)).toBe(0);
    expect(h.calls.map((c) => c.args[0])).toEqual(['bootout', 'bootstrap']);
    expect(await main(['uninstall'], h.io, h.overrides)).toBe(0);
    expect(existsSync(h.plist)).toBe(false);
  });

  it('without a build returns 1, writes nothing and makes no launchctl call', async () => {
    const h = harness({ exists: false });
    expect(await main(['install'], h.io, h.overrides)).toBe(1);
    expect(h.err.join('')).toContain('Build Airlock first: npm run build');
    expect(h.calls).toEqual([]);
    expect(existsSync(h.plist)).toBe(false);
  });

  it('a bootstrap failure returns 1, prints the cleaned message and says the plist was left', async () => {
    const h = harness({ bootstrapFails: true });
    expect(await main(['install'], h.io, h.overrides)).toBe(1);
    const text = h.err.join('');
    expect(text).toContain('boom');
    expect(text).toContain('left in place');
    expect(text).toContain(h.plist);
    expect(text).not.toContain('\u001b');
    expect(existsSync(h.plist)).toBe(true);
  });

  it('a missing claude prints one line and install still goes ahead', async () => {
    const h = harness({ tools: ['gh', 'git'] });
    expect(await main(['install'], h.io, h.overrides)).toBe(0);
    const lines = h.out.join('').split('\n').filter((l) => l.includes('claude'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('reviews will not work until it is installed');
    expect(h.out.join('')).not.toMatch(/gh was not found|git was not found/);
    expect(h.calls).toHaveLength(2);
  });

  it('uninstall boots the agent out, removes only that file, and says what it did', async () => {
    const h = harness();
    await main(['install'], h.io, h.overrides);
    const neighbour = join(h.fakeHome, 'Library', 'LaunchAgents', 'other.plist');
    writeFileSync(neighbour, 'keep');
    h.calls.length = 0;
    h.out.length = 0;
    expect(await main(['uninstall'], h.io, h.overrides)).toBe(0);
    expect(h.calls).toEqual([{ cmd: 'launchctl', args: ['bootout', 'gui/501/com.airlock.service'] }]);
    expect(existsSync(h.plist)).toBe(false);
    expect(readFileSync(neighbour, 'utf8')).toBe('keep');
    expect(h.out.join('')).toContain(h.plist);
  });

  it('uninstall with nothing installed still returns 0 and says so', async () => {
    const h = harness();
    expect(await main(['uninstall'], h.io, h.overrides)).toBe(0);
    expect(h.out.join('')).toContain('was not installed');
  });
});

/** Every opening tag has its closing tag, in order (a stack over the tags; no XML library). */
function expectBalanced(xml: string): void {
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m as unknown as [string, string, string, string];
    if (selfClosing === '/') continue;
    if (closing === '') stack.push(name);
    else expect(stack.pop()).toBe(name);
  }
  expect(stack).toEqual([]);
}

describe('the plist text', () => {
  const template = readFileSync(fileURLToPath(new URL('../launchd/com.airlock.service.plist.template', import.meta.url)), 'utf8');

  it('names absolute paths and escapes & < > " \' in every value', () => {
    const text = renderPlist(template, {
      node: '/opt/n & o/bin/node', cli: '/Users/a b/<x>/dist/cli.js', root: '/Users/a b/<x>', launchdLog: '/h/"q"/it\'s/launchd.log',
      env: [['PATH', '/a&b:/usr/bin'], ['HOME', '/Users/a b']],
    });
    expect(text).toContain('<string>/opt/n &amp; o/bin/node</string>');
    expect(text).toContain('<string>/Users/a b/&lt;x&gt;/dist/cli.js</string>');
    expect(text).toContain('<string>/h/&quot;q&quot;/it&apos;s/launchd.log</string>');
    expect(text).toContain('<string>/a&amp;b:/usr/bin</string>');
    expect(text).not.toMatch(/<string>[^<]*[&](?!amp;|lt;|gt;|quot;|apos;)/);
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(text).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">');
    expect(text).toContain('<plist version="1.0">');
    expectBalanced(text);
    expect(text).toContain('<key>SuccessfulExit</key>\n    <false/>');
    expect(text).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(text).toContain('<string>Background</string>');
  });

  it('install writes escaped, still absolute paths for a folder with & < and a space', async () => {
    const h = harness();
    const odd = join(h.root, 'a & b <c>');
    mkdirSync(join(odd, 'packages', 'service', 'dist'), { recursive: true });
    const cli = join(odd, 'packages', 'service', 'dist', 'cli.js');
    writeFileSync(cli, '//');
    h.overrides.cliPath = cli;
    expect(await main(['install'], h.io, h.overrides)).toBe(0);
    const text = readFileSync(h.plist, 'utf8');
    const escaped = odd.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    expect(text).toContain(`<string>${escaped}/packages/service/dist/cli.js</string>`);
    expect(text).toContain(`<string>${escaped}</string>`);
    expect(text).not.toContain('a & b');
    expectBalanced(text);
  });
});

describe('safety', () => {
  it('an escape sequence in an error message never reaches err raw', async () => {
    const h = harness();
    h.overrides.readOrCreateToken = async () => { throw new Error('bad\u001b[2Jthing\r\nnext\u0007'); };
    expect(await main(['token'], h.io, h.overrides)).toBe(1);
    const text = h.err.join('');
    expect(text).toContain('bad[2Jthing next');
    for (const c of ['\u001b', '\u0007', '\r']) expect(text).not.toContain(c);
  });

  it('a bad start (config error) returns 1 and never throws', async () => {
    const h = harness();
    h.overrides.loadConfig = () => { throw new RangeError('AIRLOCK_PORT must be a whole number'); };
    expect(await main(['start'], h.io, h.overrides)).toBe(1);
    expect(h.err.join('')).toContain('AIRLOCK_PORT');
  });

  it('the test file names no path under the real home folder, and the real Exec was never reached', async () => {
    const real = process.env['HOME'] ?? '';
    expect(real).not.toBe('');
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(source).not.toContain(`${real}/`);
    expect(source).not.toContain(['~', 'Library'].join('/'));
    expect(vi.mocked(engine.realExec)).not.toHaveBeenCalled();
  });
});
