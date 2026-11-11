import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ReviewDocumentSchema, type ReviewDocument } from '@airlock/shared';
import { airlockHome, repoSlug } from '../util/paths.js';

const HEAD_RE = /^[0-9a-fA-F]{7,40}$/;
const ID_RE = /^r_[0-9a-fA-F]{10}$/;

/** `<airlockHome>/reviews/<slug>/<number>`. Throws for a repository or number that cannot be a folder name. */
function reviewFolder(repo: string, number: number): string {
  const slug = repoSlug(repo);
  if (/^\.*$/.test(slug)) throw new Error(`Cannot store reviews for the repository "${repo}"`);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Cannot store reviews for pull request number ${number}`);
  return join(airlockHome(), 'reviews', slug, String(number));
}

/**
 * Saves the document as `<airlockHome>/reviews/<slug>/<number>/<headSha>-<id>.json` and returns the path. The file is
 * written under a temporary name in the same folder and then renamed, so a reader never sees half a document. Refuses a
 * document that fails the schema, a head that is not 7 to 40 hex characters and an id that is not `r_` plus 10 hex
 * characters, since both become part of the file name.
 */
export async function saveReview(doc: ReviewDocument): Promise<string> {
  const checked = ReviewDocumentSchema.parse(doc);
  const { headSha } = checked.pr;
  if (!HEAD_RE.test(headSha)) throw new Error(`Cannot store a review whose head is "${headSha}": expected 7 to 40 hex characters`);
  if (!ID_RE.test(checked.id)) throw new Error(`Cannot store a review whose id is "${checked.id}": expected r_ and 10 hex characters`);
  const folder = reviewFolder(checked.pr.repo, checked.pr.number);
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${headSha}-${checked.id}.json`);
  const temporary = join(folder, `.${headSha}-${checked.id}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    const file = await open(temporary, 'wx');
    try {
      await file.writeFile(`${JSON.stringify(checked, null, 2)}\n`);
      await file.sync(); // on disk before the rename makes it visible
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (err) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw err;
  }
  return path;
}

/** The document in `path` with the time it was created, or null when it cannot be read, parsed or checked. */
async function readStored(path: string): Promise<{ doc: ReviewDocument; time: number } | null> {
  try {
    const parsed = ReviewDocumentSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    if (!parsed.success) return null;
    const created = Date.parse(parsed.data.createdAt);
    return { doc: parsed.data, time: Number.isNaN(created) ? (await stat(path)).mtimeMs : created };
  } catch {
    return null;
  }
}

/**
 * The most recently created saved review of the pull request (by `createdAt`, or the file time when that is not a date),
 * only for `headSha` when given. Files that cannot be read, parsed or checked against the schema are skipped. Returns
 * null when there is none; never throws.
 */
export async function latestReview(repo: string, number: number, headSha?: string): Promise<ReviewDocument | null> {
  try {
    const folder = reviewFolder(repo, number);
    const names = (await readdir(folder)).filter((n) => n.endsWith('.json') && !n.startsWith('.')
      && (headSha === undefined || n.startsWith(`${headSha}-`)));
    let best: { doc: ReviewDocument; time: number } | null = null;
    for (const name of names.sort()) {
      const stored = await readStored(join(folder, name));
      if (stored === null || (headSha !== undefined && stored.doc.pr.headSha !== headSha)) continue;
      if (best === null || stored.time > best.time) best = stored;
    }
    return best?.doc ?? null;
  } catch {
    return null;
  }
}
