import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { choosePacks, loadPack, removeLearned, appendLearned, type LearnedEntry } from '@airlock/engine';
import { type LearnedKind, type LearnedLine, type LearnedReply, type RemoveLearnedBody, type RemoveLearnedReply } from '@airlock/shared';
import {
  assertWritable, DismissError, dismissalsPath, LEARNED_CAP, KIT_PACK, listForChange, serialised, writeList, type DismissDeps,
} from './dismissals.js';

const kindOf = (kind: LearnedEntry['kind']): LearnedKind => (kind === 'wrong' ? 'wrong' : 'product-knowledge');
const engineKind = (kind: LearnedKind): LearnedEntry['kind'] => (kind === 'wrong' ? 'wrong' : 'intended');
const fileOf = (kind: LearnedKind): string => (kind === 'wrong' ? 'wrong.md' : 'product-knowledge.md');
const forNoRepo = (field: string): boolean => field.trim() === '' || field.trim() === '-';

/** Names a line by what it says: the first 16 hexadecimal characters of the SHA-256 of kind, date, repository and text. */
export function learnedKey(kind: LearnedKind, date: string, repo: string, text: string): string {
  return createHash('sha256').update([kind, date, repo, text].join('\n')).digest('hex').slice(0, 16);
}

/**
 * Every line of every pack chosen for the repository, newest first. Lines of other repositories in a pack used for every
 * repository are listed too, with `appliesHere` false.
 */
export async function listLearned(deps: Pick<DismissDeps, 'config'>, repo: string): Promise<LearnedReply> {
  const chosen = (await choosePacks(deps.config.packsDir, repo)).packs;
  const lines: LearnedLine[] = [];
  for (const pack of chosen) {
    const here = new Set(pack.learned.map((e) => e.where));
    for (const e of (await loadPack(pack.dir)).learned) {
      const kind = kindOf(e.kind);
      lines.push({
        pack: pack.id, packTitle: pack.title, kind, date: e.date, repo: forNoRepo(e.repo) ? null : e.repo, text: e.text,
        key: learnedKey(kind, e.date, e.repo, e.text), appliesHere: here.has(e.where), removable: pack.id !== KIT_PACK,
      });
    }
  }
  // Array.prototype.sort is stable: lines of one date keep the order they were read in.
  lines.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { lines, cap: LEARNED_CAP };
}

/**
 * Removes the line whose key matches, in the one queue every learned-file write goes through, and clears the link of a
 * dismissal that wrote it (the finding stays dismissed). A line that is no longer there changes nothing.
 */
export async function removeLearnedLine(deps: DismissDeps, body: RemoveLearnedBody): Promise<RemoveLearnedReply> {
  return serialised(async () => {
    const chosen = (await choosePacks(deps.config.packsDir, body.repo)).packs.find((p) => p.id === body.pack);
    if (chosen === undefined) throw new DismissError(404, 'Airlock does not use that pack for this repository.');
    if (chosen.id === KIT_PACK) throw new DismissError(403, 'Lines of the team standard cannot be removed here.');
    try {
      await assertWritable(chosen, deps.config.packsDir);
    } catch {
      throw new DismissError(403, `Airlock will not change the pack "${chosen.id}".`);
    }
    const pack = await loadPack(chosen.dir);
    const entry = pack.learned.find((e) => kindOf(e.kind) === body.kind && learnedKey(body.kind, e.date, e.repo, e.text) === body.key);
    const gone = { removed: false, note: `That line was no longer in ${pack.title}'s ${fileOf(body.kind)}; nothing was removed.` };
    if (entry === undefined || !(await removeLearned(pack.dir, entry))) return gone;
    try {
      await clearLink(deps, pack.id, entry);
    } catch (err) {
      await appendLearned(pack.dir, entry).catch(() => undefined);
      throw err;
    }
    return { removed: true, note: null };
  });
}

/** Clears `learned` on the first dismissal that wrote this line. Runs inside the queue. */
async function clearLink(deps: DismissDeps, packId: string, entry: LearnedEntry): Promise<void> {
  if (forNoRepo(entry.repo)) return;
  const sample = await dismissalsPath(deps.config.home, entry.repo, 1);
  const folder = sample.slice(0, sample.lastIndexOf('/'));
  let names: string[];
  try { names = (await readdir(folder)).filter((n) => /^[1-9][0-9]*\.json$/.test(n)); } catch { return; }
  for (const name of names) {
    const path = `${folder}/${name}`;
    const list = await listForChange(path, deps.now(), deps.log);
    const at = list.findIndex((d) => d.learned !== null && d.learned.packId === packId && d.learned.kind === entry.kind
      && d.learned.date === entry.date && d.text === entry.text);
    if (at < 0) continue;
    await (deps.write ?? writeList)(path, list.map((d, i) => (i === at ? { ...d, learned: null } : d)));
    return;
  }
}
