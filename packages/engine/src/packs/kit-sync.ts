import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Exec } from '../util/exec.js';
import { airlockHome } from '../util/paths.js';
import type { Pack } from './types.js';

export const KIT_REPO = 'Moxie-Pest-Control-Phoenix/moxie-review-kit';
export const KIT_FILES = [
  'skills/moxie-review/profile.md',
  'skills/moxie-review/orbit.md',
  'skills/moxie-review/calibration.md',
  'skills/moxie-review/SKILL.md',
];
const BASE_NAMES = KIT_FILES.map((p) => basename(p));

export interface SyncedKit { sha: string; dir: string; stale: boolean }

async function isComplete(dir: string): Promise<boolean> {
  try {
    const names = new Set(await readdir(dir));
    return BASE_NAMES.every((n) => names.has(n));
  } catch { return false; }
}

async function newestCachedKit(root: string): Promise<{ sha: string; dir: string } | null> {
  let names: string[];
  try { names = await readdir(root); } catch { return null; }
  let best: { sha: string; dir: string; time: number } | null = null;
  for (const sha of names) {
    if (sha.startsWith('.')) continue; // download folders in progress
    const dir = join(root, sha);
    if (!(await isComplete(dir))) continue;
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

/** Downloads the team's review kit at one commit into <airlockHome>/kit/<sha>/; never edits the kit repository. */
export async function syncKit(exec: Exec, opts: { ref?: string } = {}): Promise<SyncedKit> {
  const root = join(airlockHome(), 'kit');
  const resolved = await runGh(exec, ['api', `repos/${KIT_REPO}/commits/${opts.ref ?? 'main'}`, '--jq', '.sha']);
  const sha = resolved.stdout.trim();
  if (resolved.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    const cached = await newestCachedKit(root);
    if (cached) return { ...cached, stale: true };
    const why = resolved.code !== 0 ? resolved.stderr.trim() : `unexpected commit value "${sha.slice(0, 80)}"`;
    throw new Error(`The review kit could not be fetched and none is cached: ${why}`);
  }

  const dir = join(root, sha);
  if (await isComplete(dir)) return { sha, dir, stale: false };

  await mkdir(root, { recursive: true });
  const tmp = await mkdtemp(join(root, `.${sha}-`));
  try {
    for (const path of KIT_FILES) {
      const res = await runGh(exec, [
        'api', '-H', 'Accept: application/vnd.github.raw', `repos/${KIT_REPO}/contents/${path}?ref=${sha}`,
      ]);
      if (res.code !== 0) throw new Error(`The review kit could not be fetched (${path}): ${res.stderr.trim()}`);
      await writeFile(join(tmp, basename(path)), res.stdout);
    }
    try {
      await rename(tmp, dir);
    } catch (err) {
      // an incomplete leftover blocks the rename; clear it once and retry
      if (await isComplete(dir)) { await rm(tmp, { recursive: true, force: true }); return { sha, dir, stale: false }; }
      await rm(dir, { recursive: true, force: true });
      try { await rename(tmp, dir); } catch (err2) {
        if (await isComplete(dir)) { await rm(tmp, { recursive: true, force: true }); return { sha, dir, stale: false }; } // another sync finished first
        throw err2 ?? err;
      }
    }
    return { sha, dir, stale: false };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

/** Returns a new pack with the kit's standards attached; the adapter is not changed. */
export async function attachKit(adapter: Pack, kit: { sha: string; dir: string }): Promise<Pack> {
  const standards: Pack['standards'] = [];
  for (const [name, dated] of [['profile.md', false], ['orbit.md', false], ['calibration.md', true]] as const) {
    standards.push({ name, dated, text: await readFile(join(kit.dir, name), 'utf8') });
  }
  return { ...adapter, version: kit.sha, standards };
}
