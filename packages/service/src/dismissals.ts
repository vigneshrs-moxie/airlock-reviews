import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  appendLearned, choosePacks, loadPack, removeLearned, repoSlug, reviewById, type LearnedEntry, type Pack,
} from '@airlock/engine';
import {
  checkLearnedText, DismissalSchema, type DismissBody, type Dismissal, type RestoreBody, type RestoreReply, type ReviewDocument,
} from '@airlock/shared';
import { z } from 'zod';
import type { ServiceConfig } from './config.js';

/** What `dismiss` and `restore` need from the service. */
export interface DismissDeps {
  config: Pick<ServiceConfig, 'home' | 'packsDir'>;
  now: () => Date;
  log: (line: string) => void;
  /** Saves a pull request's list; atomic by default. Tests replace it to make a save fail. */
  write?: (path: string, list: Dismissal[]) => Promise<void>;
}

/** A refusal with the status the route answers with; the message is for the person. */
export class DismissError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'DismissError';
  }
}

/** The team kit's pack. Must stay equal to the engine's KIT_PACK_ID (pipeline/packs.ts), which is not exported. */
export const KIT_PACK = 'raj-standard';
const GENERIC_PACK = 'generic';
/** The most learned lines one pack may hold of one kind. */
export const LEARNED_CAP = 300;
const NOT_FOUND = 'Airlock cannot find that finding in the stored review.';
const DismissalsFileSchema = z.array(DismissalSchema);

/**
 * The pack that learns from a dismissal: the first selected pack that is neither the team kit's nor `generic`; when there
 * is none, `generic`. Never the team kit's pack. Throws when there is nothing to write to.
 */
export function learnedTarget(packs: Pack[]): Pack {
  const own = packs.find((p) => p.id !== KIT_PACK && p.id !== GENERIC_PACK);
  const target = own ?? packs.find((p) => p.id === GENERIC_PACK);
  if (target === undefined) throw new Error('Airlock found no pack to save what it learned in.');
  return target;
}

/**
 * The pack folder, as it really is on disk (links followed), must sit directly inside the packs folder, also as it really
 * is, and must not be the team kit's.
 */
export async function assertWritable(pack: Pack, packsDir: string): Promise<void> {
  const dir = await realpath(resolve(pack.dir));
  if (dirname(dir) !== await realpath(resolve(packsDir)) || pack.id === KIT_PACK || basename(dir) === KIT_PACK) {
    throw new Error(`Airlock will not write what it learned into the pack "${pack.id}".`);
  }
}

/**
 * Every change, for every pull request, runs one after another: the learned files of a pack are shared by all pull
 * requests, so a per-pull-request queue could lose a line.
 */
let tail: Promise<unknown> = Promise.resolve();
export function serialised<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.catch(() => undefined);
  return run;
}

/**
 * The file for a pull request. A folder that spells the repository in another letter case is the same folder, so a
 * request is matched to it whatever case it uses; a new file gets the repository's own spelling.
 */
export async function dismissalsPath(home: string, repo: string, number: number): Promise<string> {
  const root = join(home, 'dismissals');
  const slug = repoSlug(repo);
  let folder = slug;
  try {
    const names = await readdir(root);
    folder = names.includes(slug) ? slug : names.find((n) => n.toLowerCase() === slug.toLowerCase()) ?? slug;
  } catch { /* no dismissals yet */ }
  return join(root, folder, `${number}.json`);
}

async function readList(path: string): Promise<{ list: Dismissal[]; broken: boolean }> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { list: [], broken: false };
    throw err;
  }
  try {
    const parsed = DismissalsFileSchema.safeParse(JSON.parse(text));
    if (parsed.success) return { list: parsed.data, broken: false };
  } catch { /* not JSON: broken */ }
  return { list: [], broken: true };
}

/** The dismissals stored for the pull request; none when there is no file or it cannot be read. */
export async function dismissalsFor(home: string, repo: string, number: number): Promise<Dismissal[]> {
  try {
    return (await readList(await dismissalsPath(home, repo, number))).list;
  } catch {
    return [];
  }
}

/** The stored list for a change: a file that does not parse is renamed aside, not overwritten. */
export async function listForChange(path: string, now: Date, log: (line: string) => void): Promise<Dismissal[]> {
  const { list, broken } = await readList(path);
  if (broken) {
    const aside = `${path}.broken-${now.getTime()}-${randomBytes(4).toString('hex')}`;
    await rename(path, aside);
    log(`the dismissals file ${path} could not be read; it was set aside as ${aside}`);
  }
  return list;
}

/** Writes a list as JSON atomically: a temporary file in the same folder, synced, then renamed over the old one. */
export async function writeList(path: string, list: readonly unknown[]): Promise<void> {
  const folder = dirname(path);
  await mkdir(folder, { recursive: true });
  const temporary = join(folder, `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    const file = await open(temporary, 'wx');
    try {
      await file.writeFile(`${JSON.stringify(list, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (err) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Today's local date as YYYY-MM-DD. */
function localDate(now: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

const learnedFile = (kind: 'wrong' | 'intended'): string => (kind === 'wrong' ? 'wrong.md' : 'product-knowledge.md');

/** The pack a learned line went to: among the selected packs, else by id from the packs folder. */
async function packById(packsDir: string, repo: string, id: string, selected: Pack[]): Promise<Pack | null> {
  const known = selected.find((p) => p.id === id);
  if (known !== undefined) return known;
  return (await choosePacks(packsDir, repo, [id])).packs[0] ?? null;
}

/**
 * Takes the line a dismissal wrote out of its pack again. Refuses (500) when the pack cannot be opened, so a line is never
 * orphaned silently; `removed` is false only when the pack was read and the line was not in it.
 */
async function removeWritten(
  deps: DismissDeps, repo: string, old: Dismissal, selected: Pack[],
): Promise<{ removed: boolean; pack: Pack | null; entry: LearnedEntry | null }> {
  if (old.learned === null) return { removed: true, pack: null, entry: null };
  const pack = await packById(deps.config.packsDir, repo, old.learned.packId, selected);
  if (pack === null) {
    throw new DismissError(500, `Airlock could not open the pack ${old.learned.packId} to undo an earlier line. Fix the pack and try again.`);
  }
  await assertWritable(pack, deps.config.packsDir);
  const entry: LearnedEntry = { date: old.learned.date, repo, kind: old.learned.kind, text: old.text };
  return { removed: await removeLearned(pack.dir, entry), pack, entry };
}

/** The repository as the stored review of an earlier dismissal has it, or the given one when that review is gone. */
async function reviewOf(repo: string, number: number, old: Dismissal): Promise<ReviewDocument | null> {
  return reviewById(repo, number, old.reviewId);
}

/**
 * Records a dismissal of one finding of a stored review. `wrong` and `intended` also write one dated line, exactly
 * `body.text`, into the learned files of the repository's own pack (never the team kit's); `not-now` writes nothing to a
 * pack whatever the text holds. An earlier dismissal of the same finding is replaced and the line it wrote is removed.
 */
export async function dismiss(deps: DismissDeps, body: DismissBody): Promise<Dismissal> {
  const doc = await reviewById(body.repo, body.number, body.reviewId);
  const finding = doc !== null && doc.pr.repo.toLowerCase() === body.repo.toLowerCase() && doc.pr.number === body.number
    ? doc.findings.find((f) => f.id === body.findingId) : undefined;
  if (doc === null || finding === undefined) throw new DismissError(404, NOT_FOUND);

  // Checked again here, immediately before anything is written.
  const problem = checkLearnedText(body.text, body.reason);
  if (problem !== null) throw new DismissError(400, problem);

  const now = deps.now();
  const learnsLine = body.reason !== 'not-now';
  const kind = body.reason === 'wrong' ? 'wrong' : 'intended';
  const date = localDate(now);
  const selected = (await choosePacks(deps.config.packsDir, doc.pr.repo)).packs;
  const target = learnsLine ? learnedTarget(selected) : null;
  if (target !== null) await assertWritable(target, deps.config.packsDir);

  const record: Dismissal = DismissalSchema.parse({
    fingerprint: finding.fingerprint, findingId: finding.id, reviewId: doc.id, reason: body.reason, text: body.text,
    at: now.toISOString(), learned: target === null ? null : { packId: target.id, kind, date },
  });
  const line: LearnedEntry = { date, repo: doc.pr.repo, kind, text: body.text };

  return serialised(async () => {
    const path = await dismissalsPath(deps.config.home, doc.pr.repo, doc.pr.number);
    const list = await listForChange(path, now, deps.log);
    const old = list.find((d) => d.fingerprint === record.fingerprint);
    let removedOld: { pack: Pack; entry: LearnedEntry } | null = null;
    let written = false;
    try {
      if (old?.learned) {
        // The old line carries the repository of the old review.
        const oldRepo = (await reviewOf(body.repo, body.number, old))?.pr.repo ?? doc.pr.repo;
        const gone = await removeWritten(deps, oldRepo, old, selected);
        if (gone.removed && gone.pack !== null && gone.entry !== null) removedOld = { pack: gone.pack, entry: gone.entry };
      }
      if (target !== null) {
        // Counted after the replaced line is out, so replacing a dismissal in a full pack still works.
        const held = (await loadPack(target.dir)).learned.filter((e) => e.kind === kind).length;
        if (held >= LEARNED_CAP) {
          throw new DismissError(409, `${target.title} already holds ${LEARNED_CAP} learned lines of this kind. Remove some under Packs first.`);
        }
        await appendLearned(target.dir, line);
        written = true;
      }
      await (deps.write ?? writeList)(path, [...list.filter((d) => d.fingerprint !== record.fingerprint), record]);
    } catch (err) {
      // Leave nothing half-done: take the new line out again and put the old one back.
      if (written && target !== null) await removeLearned(target.dir, line).catch(() => undefined);
      if (removedOld !== null) await appendLearned(removedOld.pack.dir, removedOld.entry).catch(() => undefined);
      throw err;
    }
    return record;
  });
}

/**
 * Undoes a dismissal: removes it and, when it wrote a learned line, exactly that line. When the line is no longer in the
 * pack the dismissal is still removed and the reply says so.
 */
export async function restore(deps: DismissDeps, body: RestoreBody): Promise<RestoreReply> {
  return serialised(async () => {
    const path = await dismissalsPath(deps.config.home, body.repo, body.number);
    const list = await listForChange(path, deps.now(), deps.log);
    const old = list.find((d) => d.fingerprint === body.fingerprint);
    if (old === undefined) return { restored: false, note: null };
    // The review the dismissal was made on must belong to this pull request.
    const doc = await reviewOf(body.repo, body.number, old);
    if (doc !== null && (doc.pr.repo.toLowerCase() !== body.repo.toLowerCase() || doc.pr.number !== body.number)) {
      return { restored: false, note: null };
    }
    let note: string | null = null;
    if (old.learned !== null) {
      // The line carries the repository as the stored review has it.
      const { removed, pack } = await removeWritten(deps, doc?.pr.repo ?? body.repo, old, (await choosePacks(deps.config.packsDir, body.repo)).packs);
      if (!removed) note = `The saved line was no longer in ${pack?.title ?? old.learned.packId}'s ${learnedFile(old.learned.kind)}; nothing was removed from the pack.`;
    }
    await (deps.write ?? writeList)(path, list.filter((d) => d.fingerprint !== body.fingerprint));
    return { restored: true, note };
  });
}
