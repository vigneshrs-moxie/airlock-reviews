import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isRepo } from '@airlock/shared';
import type { Exec } from '../util/exec.js';
import { airlockHome, repoSlug } from '../util/paths.js';
import type { KitRef, Pack } from './types.js';

export interface SyncedKit { sha: string; dir: string; stale: boolean }

/** A branch, tag or commit name: parts of letters, digits, `.`, `_` and `-` between single slashes, none starting with `.` or `-`. */
const REF = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
const CONTROL = /\p{Cc}/u;

/**
 * Whether a kit's file path is safe to read from GitHub and to keep in the cache: relative, with no empty, `.` or `..`
 * part, and no backslash, `?`, `#`, `%` or control character (the path is put into the API address as it is, so an
 * encoded `..` is refused too).
 */
function isKitPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || /[\\?#%]/.test(path) || CONTROL.test(path) || !path.isWellFormed()) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** What is wrong with a kit as a manifest names it, as a phrase; null when nothing is. */
export function kitRefProblem(kit: KitRef): string | null {
  if (!isRepo(kit.repo)) return `the repository ${JSON.stringify(kit.repo)} is not <owner>/<name>`;
  if (kit.ref !== undefined && (!REF.test(kit.ref) || kit.ref.includes('..'))) {
    return `the ref ${JSON.stringify(kit.ref)} is not a branch, tag or commit name`;
  }
  if (kit.files.length === 0) return 'it must list at least one file';
  const names = new Set<string>();
  for (const path of kit.files) {
    if (!isKitPath(path)) {
      return `the file path ${JSON.stringify(path)} must be relative, with no "..", "." or empty part and no leading slash, backslash, "?", "#", "%" or control character`;
    }
    // The cache keeps each file under its name, so two files of one name would be one file.
    const name = basename(path);
    if (names.has(name)) return `it lists the file name ${JSON.stringify(name)} twice`;
    names.add(name);
  }
  for (const dated of kit.datedStandards ?? []) {
    if (!kit.files.includes(dated)) return `the dated standard ${JSON.stringify(dated)} is not one of the kit's files`;
  }
  return null;
}

/**
 * Where a kit's copies are cached: <airlockHome>/kit/<repo slug>/<file list key>/, one folder per commit under it. The
 * key is a short hash of the kit's file paths in any order, so two packs that name one kit repository with different
 * files keep separate copies and never replace or delete each other's.
 */
export function kitCacheRoot(kit: KitRef): string {
  const key = createHash('sha256').update(JSON.stringify([...new Set(kit.files)].sort())).digest('hex').slice(0, 12);
  return join(airlockHome(), 'kit', repoSlug(kit.repo), key);
}

async function isComplete(dir: string, names: string[]): Promise<boolean> {
  try {
    const present = new Set(await readdir(dir));
    return names.every((n) => present.has(n));
  } catch { return false; }
}

/** The newest folder under `root` that holds every one of `names`; folders starting with `.` are downloads in progress. */
async function newestCachedKit(root: string, names: string[]): Promise<{ sha: string; dir: string } | null> {
  let shas: string[];
  try { shas = await readdir(root); } catch { return null; }
  let best: { sha: string; dir: string; time: number } | null = null;
  for (const sha of shas) {
    if (sha.startsWith('.')) continue;
    const dir = join(root, sha);
    if (!(await isComplete(dir, names))) continue;
    const time = (await stat(dir)).mtimeMs;
    if (!best || time > best.time) best = { sha, dir, time };
  }
  return best && { sha: best.sha, dir: best.dir };
}

async function runGh(exec: Exec, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try { return await exec('gh', args); } catch (err) {
    return { stdout: '', stderr: (err as Error).message, code: 1 };
  }
}

/**
 * Downloads a kit's files at one commit of `opts.ref`, else the kit's `ref`, else `main`, into
 * kitCacheRoot(kit)/<sha>/, with `gh api` reads only; never edits the kit repository. When the commit or a file
 * cannot be fetched, the newest complete copy of this kit in the cache is used and marked stale; with none, it throws a
 * sentence naming the kit. A kit that fails `kitRefProblem` is refused before anything runs.
 */
export async function syncKit(exec: Exec, kit: KitRef, opts: { ref?: string } = {}): Promise<SyncedKit> {
  const ref = opts.ref ?? kit.ref ?? 'main';
  const problem = kitRefProblem({ ...kit, ref });
  if (problem !== null) throw new Error(`The review kit cannot be used: ${problem}.`);
  const names = kit.files.map((p) => basename(p));
  const root = kitCacheRoot(kit);
  const fallBack = async (why: string): Promise<SyncedKit> => {
    const cached = await newestCachedKit(root, names);
    if (cached) return { ...cached, stale: true };
    throw new Error(`The review kit could not be fetched from ${kit.repo} and none is cached: ${why}`);
  };

  const resolved = await runGh(exec, ['api', `repos/${kit.repo}/commits/${ref}`, '--jq', '.sha']);
  const sha = resolved.stdout.trim();
  if (resolved.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    return fallBack(resolved.code !== 0 ? resolved.stderr.trim() : `unexpected commit value "${sha.slice(0, 80)}"`);
  }

  const dir = join(root, sha);
  if (await isComplete(dir, names)) return { sha, dir, stale: false };

  await mkdir(root, { recursive: true });
  const tmp = await mkdtemp(join(root, `.${sha}-`));
  try {
    for (const path of kit.files) {
      const res = await runGh(exec, [
        'api', '-H', 'Accept: application/vnd.github.raw', `repos/${kit.repo}/contents/${path}?ref=${sha}`,
      ]);
      if (res.code !== 0) {
        // A listed file that is gone (renamed in the kit) or a cut connection: the cache stands in, as for the commit.
        await rm(tmp, { recursive: true, force: true });
        return fallBack(`${path}: ${res.stderr.trim()}`);
      }
      await writeFile(join(tmp, basename(path)), res.stdout);
    }
    try {
      await rename(tmp, dir);
    } catch (err) {
      // an incomplete leftover blocks the rename; clear it once and retry
      if (await isComplete(dir, names)) { await rm(tmp, { recursive: true, force: true }); return { sha, dir, stale: false }; }
      await rm(dir, { recursive: true, force: true });
      try { await rename(tmp, dir); } catch (err2) {
        if (await isComplete(dir, names)) { await rm(tmp, { recursive: true, force: true }); return { sha, dir, stale: false }; } // another sync finished first
        throw err2 ?? err;
      }
    }
    return { sha, dir, stale: false };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Returns a new pack with its kit's files (read from `kit.dir`) attached as standards, in the manifest's order, each named
 * by its file name and dated when the manifest lists it under `datedStandards`; the pack's version is the kit's commit.
 * The adapter is not changed. Throws a sentence naming the kit when a file cannot be read.
 */
export async function attachKit(adapter: Pack, kit: { sha: string; dir: string }): Promise<Pack> {
  const ref = adapter.kit;
  if (ref === undefined) throw new Error(`The pack ${adapter.id} names no review kit.`);
  const dated = new Set(ref.datedStandards ?? []);
  const standards: Pack['standards'] = [];
  for (const path of ref.files) {
    const name = basename(path);
    let text: string;
    try { text = await readFile(join(kit.dir, name), 'utf8'); } catch (err) {
      const why = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'is not there' : `could not be read (${(err as Error).message})`;
      throw new Error(`The review kit ${ref.repo} could not be read from ${kit.dir}: ${name} ${why}.`);
    }
    standards.push({ name, dated: dated.has(path), text });
  }
  return { ...adapter, version: kit.sha, standards };
}
