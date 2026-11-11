import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, pair, pairedOrigin, readOrCreateToken, unpair } from '../src/config.js';

const ORIGIN_A = `chrome-extension://${'a'.repeat(32)}`;
const ORIGIN_B = `chrome-extension://${'b'.repeat(32)}`;
const homes: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'airlock-service-config-'));
  homes.push(home);
  return home;
}

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe('loadConfig', () => {
  it('uses port 4611, the given home, the repository packs folder and the package version', async () => {
    const config = loadConfig({ AIRLOCK_HOME: '/tmp/h' });
    expect(config.port).toBe(4611);
    expect(config.home).toBe('/tmp/h');
    expect(config.packsDir.endsWith('/packs')).toBe(true);
    expect((await stat(config.packsDir)).isDirectory()).toBe(true);
    const own = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(config.version).toBe(own.version);
  });

  it('reads AIRLOCK_PORT and AIRLOCK_PACKS_DIR', () => {
    const config = loadConfig({ AIRLOCK_HOME: '/tmp/h', AIRLOCK_PORT: '5000', AIRLOCK_PACKS_DIR: '/tmp/packs' });
    expect(config.port).toBe(5000);
    expect(config.packsDir).toBe('/tmp/packs');
  });

  it.each(['80', '1023', '65536', 'abc', '4611.5', '', ' 5000', '5000x'])('refuses AIRLOCK_PORT %j', (port) => {
    expect(() => loadConfig({ AIRLOCK_HOME: '/tmp/h', AIRLOCK_PORT: port })).toThrow(/AIRLOCK_PORT/);
  });
});

describe('loadConfig and the environment', () => {
  it('treats an empty AIRLOCK_HOME as unset', () => {
    expect(loadConfig({ AIRLOCK_HOME: '' }).home).toBe(join(homedir(), '.airlock'));
  });

  it('takes the home from the env it was given, not from process.env', () => {
    const before = process.env['AIRLOCK_HOME'];
    process.env['AIRLOCK_HOME'] = '/tmp/from-process';
    try {
      expect(loadConfig({}).home).toBe(join(homedir(), '.airlock'));
      expect(loadConfig({ AIRLOCK_HOME: '/tmp/given' }).home).toBe('/tmp/given');
      expect(loadConfig().home).toBe('/tmp/from-process');
    } finally {
      if (before === undefined) delete process.env['AIRLOCK_HOME']; else process.env['AIRLOCK_HOME'] = before;
    }
  });
});

describe('the pairing token', () => {
  it('creates 64 hex characters with the file at 0600 and the folder at 0700, and reuses it', async () => {
    const home = await tempHome();
    const first = await readOrCreateToken(home);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await mode(join(home, 'service', 'token'))).toBe(0o600);
    expect(await mode(join(home, 'service'))).toBe(0o700);
    expect(await readOrCreateToken(home)).toBe(first);
  });

  it('tightens an existing file with wider permissions and keeps its token', async () => {
    const home = await tempHome();
    const token = 'c'.repeat(64);
    await mkdir(join(home, 'service'), { recursive: true });
    await writeFile(join(home, 'service', 'token'), `${token}\n`);
    await chmod(join(home, 'service', 'token'), 0o644);
    expect(await readOrCreateToken(home)).toBe(token);
    expect(await mode(join(home, 'service', 'token'))).toBe(0o600);
  });

  it('replaces a file that does not hold a token, and leaves no temporary file behind', async () => {
    const home = await tempHome();
    await mkdir(join(home, 'service'), { recursive: true });
    await writeFile(join(home, 'service', 'token'), 'garbage');
    const token = await readOrCreateToken(home);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await readdir(join(home, 'service'))).toEqual(['token']);
  });
});

describe('the paired origin', () => {
  it('is null until an extension pairs', async () => {
    expect(await pairedOrigin(await tempHome())).toBeNull();
  });

  it('records the first origin, accepts it again and refuses another', async () => {
    const home = await tempHome();
    expect(await pair(home, ORIGIN_A)).toBe('paired');
    expect(await pairedOrigin(home)).toBe(ORIGIN_A);
    expect(await mode(join(home, 'service', 'paired-origin'))).toBe(0o600);
    expect(await pair(home, ORIGIN_A)).toBe('already');
    expect(await pair(home, ORIGIN_B)).toBe('other');
    expect(await pairedOrigin(home)).toBe(ORIGIN_A);
    expect(await readdir(join(home, 'service'))).toEqual(['paired-origin']);
  });

  it('unpair forgets it, also when nothing was paired', async () => {
    const home = await tempHome();
    await unpair(home);
    await pair(home, ORIGIN_A);
    await unpair(home);
    expect(await pairedOrigin(home)).toBeNull();
    expect(await pair(home, ORIGIN_B)).toBe('paired');
  });

  it('treats a file with anything but a chrome-extension origin as not paired', async () => {
    const home = await tempHome();
    await mkdir(join(home, 'service'), { recursive: true });
    for (const content of ['https://evil.example', 'chrome-extension://short', `${ORIGIN_A}/x`, '', 'null']) {
      await writeFile(join(home, 'service', 'paired-origin'), content);
      expect(await pairedOrigin(home)).toBeNull();
    }
  });

  it('refuses to record an origin that is not a chrome-extension origin', async () => {
    const home = await tempHome();
    await expect(pair(home, 'https://evil.example')).rejects.toThrow(/chrome-extension/);
    expect(await pairedOrigin(home)).toBeNull();
  });
});
