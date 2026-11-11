import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, link, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServiceConfig { port: number; home: string; packsDir: string; version: string }

export const DEFAULT_PORT = 4611;
const ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export const isExtensionOrigin = (value: string): boolean => ORIGIN_PATTERN.test(value);

function readPort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const port = /^[0-9]{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new RangeError(`AIRLOCK_PORT must be a whole number from 1024 to 65535, got "${raw}"`);
  }
  return port;
}

function ownVersion(): string {
  const text = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const version = (JSON.parse(text) as { version?: unknown }).version;
  if (typeof version !== 'string') throw new Error('packages/service/package.json has no version');
  return version;
}

/** The packs folder sits at the repository root, three levels above both src/config.ts and dist/config.js. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const packs = env['AIRLOCK_PACKS_DIR'];
  const given = env['AIRLOCK_HOME'];
  return {
    port: readPort(env['AIRLOCK_PORT']),
    home: given !== undefined && given !== '' ? given : join(homedir(), '.airlock'),
    packsDir: packs !== undefined && packs !== '' ? packs : fileURLToPath(new URL('../../../packs', import.meta.url)),
    version: ownVersion(),
  };
}

const serviceDir = (home: string): string => join(home, 'service');

async function ensureDir(home: string): Promise<string> {
  const dir = serviceDir(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

/** Writes the whole file under a temporary name in the same folder, then renames it into place. */
async function writeAtomic(dir: string, name: string, content: string): Promise<void> {
  const temporary = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(dir, name));
  } catch (e) {
    await rm(temporary, { force: true });
    throw e;
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** The pairing token: 64 hex characters in `<home>/service/token`, made on first use, readable by this user only. */
export async function readOrCreateToken(home: string): Promise<string> {
  const dir = await ensureDir(home);
  const file = join(dir, 'token');
  // A symbolic link is never followed: it is replaced by a real file, and its target is left alone.
  const isLink = await lstat(file).then((st) => st.isSymbolicLink(), () => false);
  const existing = isLink ? undefined : (await readText(file))?.trim();
  if (existing !== undefined && TOKEN_PATTERN.test(existing)) {
    if (((await stat(file)).mode & 0o077) !== 0) await chmod(file, 0o600);
    return existing;
  }
  const token = randomBytes(32).toString('hex');
  await writeAtomic(dir, 'token', `${token}\n`);
  return token;
}

/** The recorded extension origin, or null when none is recorded or the file holds anything else. */
export async function pairedOrigin(home: string): Promise<string | null> {
  const text = (await readText(join(serviceDir(home), 'paired-origin')))?.trim();
  return text !== undefined && ORIGIN_PATTERN.test(text) ? text : null;
}

export async function pair(home: string, origin: string): Promise<'paired' | 'already' | 'other'> {
  if (!ORIGIN_PATTERN.test(origin)) throw new RangeError('The origin to pair must be a chrome-extension origin.');
  const dir = await ensureDir(home);
  const file = join(dir, 'paired-origin');
  const text = await readText(file);
  const current = text === null ? null : await pairedOrigin(home);
  if (current !== null) return current === origin ? 'already' : 'other';
  if (text !== null) {
    // A file whose content is not a valid origin is replaced.
    await writeAtomic(dir, 'paired-origin', `${origin}\n`);
    return 'paired';
  }
  // `link` fails when the file exists, so of two concurrent pairings only one can place its file.
  const temporary = join(dir, `.paired-origin.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, `${origin}\n`, { mode: 0o600, flag: 'wx' });
    try {
      await link(temporary, file);
      return 'paired';
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      return (await pairedOrigin(home)) === origin ? 'already' : 'other';
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function unpair(home: string): Promise<void> {
  await rm(join(serviceDir(home), 'paired-origin'), { force: true });
}
