import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  appendLearned, choosePacks, removeLearned, repoSlug, reviewById, type LearnedEntry, type Pack,
} from '@airlock/engine';
import {
  checkLearnedText, DismissalSchema, type DismissBody, type Dismissal, type RestoreBody, type RestoreReply,
} from '@airlock/shared';
import { z } from 'zod';
import type { ServiceConfig } from './config.js';

/** What `dismiss` and `restore` need from the service. */
export interface DismissDeps {
  config: Pick<ServiceConfig, 'home' | 'packsDir'>;
  now: () => Date;
  log: (line: string) => void;
}

/** A refusal with the status the route answers with; the message is for the person. */
export class DismissError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'DismissError';
  }
}

export const KIT_PACK = 'raj-standard';
const GENERIC_PACK = 'generic';
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

const dismissalsPath = (home: string, repo: string, number: number): string =>
  join(home, 'dismissals', repoSlug(repo), `${number}.json`);

/** Everything that changes one pull request's file runs one after another. */
const queues = new Map<string, Promise<unknown>>();
function serialised<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
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
    return (await readList(dismissalsPath(home, repo, number))).list;
  } catch {
    return [];
  }
}

/** The stored list for a change: a file that does not parse is renamed aside, not overwritten. */
async function listForChange(path: string, now: Date, log: (line: string) => void): Promise<Dismissal[]> {
  const { list, broken } = await readList(path);
  if (broken) {
    const aside = `${path}.broken-${now.getTime()}`;
    await rename(path, aside);
    log(`the dismissals file ${path} could not be read; it was set aside as ${aside}`);
  }
  return list;
}

async function writeList(path: string, list: Dismissal[]): Promise<void> {
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

/** Takes the line a dismissal wrote out of its pack again. False when the line was no longer there. */
async function removeWritten(deps: DismissDeps, repo: string, old: Dismissal, selected: Pack[]): Promise<{ removed: boolean; pack: Pack | null }> {
  if (old.learned === null) return { removed: true, pack: null };
  const pack = await packById(deps.config.packsDir, repo, old.learned.packId, selected);
  if (pack === null) return { removed: false, pack };
  await assertWritable(pack, deps.config.packsDir);
  const entry: LearnedEntry = { date: old.learned.date, repo, kind: old.learned.kind, text: old.text };
  return { removed: await removeLearned(pack.dir, entry), pack };
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
  const selected = (await choosePacks(deps.config.packsDir, body.repo)).packs;
  const target = learnsLine ? learnedTarget(selected) : null;
  if (target !== null) await assertWritable(target, deps.config.packsDir);

  const record: Dismissal = DismissalSchema.parse({
    fingerprint: finding.fingerprint, findingId: finding.id, reviewId: doc.id, reason: body.reason, text: body.text,
    at: now.toISOString(), learned: target === null ? null : { packId: target.id, kind, date },
  });
  const line: LearnedEntry = { date, repo: doc.pr.repo, kind, text: body.text };

  const path = dismissalsPath(deps.config.home, doc.pr.repo, doc.pr.number);
  return serialised(path, async () => {
    const list = await listForChange(path, now, deps.log);
    const old = list.find((d) => d.fingerprint === record.fingerprint);
    let oldRemoved: { pack: Pack; entry: LearnedEntry } | null = null;
    let written = false;
    try {
      if (old?.learned) {
        const gone = await removeWritten(deps, doc.pr.repo, old, selected);
        if (gone.removed && gone.pack !== null) {
          oldRemoved = { pack: gone.pack, entry: { date: old.learned.date, repo: doc.pr.repo, kind: old.learned.kind, text: old.text } };
        }
      }
      if (target !== null) {
        await appendLearned(target.dir, line);
        written = true;
      }
      await writeList(path, [...list.filter((d) => d.fingerprint !== record.fingerprint), record]);
    } catch (err) {
      // Leave nothing half-done: take the new line out again and put the old one back.
      if (written && target !== null) await removeLearned(target.dir, line).catch(() => undefined);
      if (oldRemoved !== null) await appendLearned(oldRemoved.pack.dir, oldRemoved.entry).catch(() => undefined);
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
  const path = dismissalsPath(deps.config.home, body.repo, body.number);
  return serialised(path, async () => {
    const list = await listForChange(path, deps.now(), deps.log);
    const old = list.find((d) => d.fingerprint === body.fingerprint);
    if (old === undefined) return { restored: false, note: null };
    let note: string | null = null;
    if (old.learned !== null) {
      // The line carries the repository as the stored review has it.
      const doc = await reviewById(body.repo, body.number, old.reviewId);
      const repo = doc?.pr.repo ?? body.repo;
      const selected = (await choosePacks(deps.config.packsDir, body.repo)).packs;
      const { removed, pack } = await removeWritten(deps, repo, old, selected);
      if (!removed) note = `The saved line was no longer in ${pack?.title ?? old.learned.packId}'s ${learnedFile(old.learned.kind)}; nothing was removed from the pack.`;
    }
    await writeList(path, list.filter((d) => d.fingerprint !== body.fingerprint));
    return { restored: true, note };
  });
}
