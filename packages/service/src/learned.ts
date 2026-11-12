import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPack, reviewById, selectPacks, type LearnedEntry, type Pack } from '@airlock/engine';
import {
  isRepo, type LearnedKind, type LearnedLine, type LearnedReply, type RemoveLearnedBody, type RemoveLearnedReply,
} from '@airlock/shared';
import {
  assertWritable, DismissError, dismissalsFolder, dismissalsFor, KIT_PACK, LEARNED_CAP, listForChange, replaceFile, serialised,
  writeList, type DismissDeps,
} from './dismissals.js';

const GENERIC_PACK = 'generic';
const fileOf = (kind: LearnedKind): string => (kind === 'wrong' ? 'wrong.md' : 'product-knowledge.md');
const engineKind = (kind: LearnedKind): LearnedEntry['kind'] => (kind === 'wrong' ? 'wrong' : 'intended');
const forNoRepo = (field: string): boolean => field.trim() === '' || field.trim() === '-';
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// The engine's learned-line format (packs/learned.ts): `YYYY-MM-DD · <repo> · <text>`; blank lines and `#` lines are not
// entries. The repository field may be empty or `-` for a line written by hand.
const LINE = /^(\d{4}-\d{2}-\d{2}) · (.*?) · (.+)$/;

/** A learned line as it stands in its file: `date · repo · text` gives back the line exactly. */
interface StoredLine { kind: LearnedKind; date: string; repo: string; text: string }

/** A pack chosen for the repository, with its learned lines read one by one. */
interface ChosenPack { pack: Pack; lines: StoredLine[] }

const storedForm = (line: Pick<StoredLine, 'date' | 'repo' | 'text'>): string => `${line.date} · ${line.repo} · ${line.text}`;

/** Names a line by what it says: the first 16 hexadecimal characters of the SHA-256 of kind, date, repository and text. */
export function learnedKey(kind: LearnedKind, date: string, repo: string, text: string): string {
  return createHash('sha256').update([kind, date, repo, text].join('\n')).digest('hex').slice(0, 16);
}

/**
 * The lines of one learned file, read one by one. A line that is not an entry, or whose repository field is neither a
 * repository name nor empty or `-` (the contract cannot show it), is left out and logged by its file and line number,
 * never its text. A file that cannot be read is logged and gives no lines.
 */
async function readLines(packDir: string, kind: LearnedKind, log: (line: string) => void): Promise<StoredLine[]> {
  const file = join(packDir, 'learned', fileOf(kind));
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`the learned file ${file} could not be read: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
    return [];
  }
  const lines: StoredLine[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (raw.trim() === '' || raw.startsWith('#')) return;
    const m = LINE.exec(raw);
    if (m === null) {
      log(`${file}:${i + 1} is not a learned line ("YYYY-MM-DD · <repo> · <text>"), so it is left out`);
      return;
    }
    const repo = m[2]!;
    if (!forNoRepo(repo) && !isRepo(repo)) {
      log(`${file}:${i + 1} names no repository ("owner/name", "-" or nothing), so it is left out`);
      return;
    }
    lines.push({ kind, date: m[1]!, repo, text: m[3]! });
  });
  return lines;
}

/**
 * The pack as the engine loads it but without its learned files. The engine refuses a whole pack for one learned line it
 * cannot read, and the list must still show that pack's other lines. A temporary folder holds a link to every entry of the
 * pack except `learned`; removing it removes only those links.
 */
async function withoutLearned(dir: string): Promise<Pack> {
  const root = resolve(dir);
  const shadow = await mkdtemp(join(tmpdir(), 'airlock-pack-without-learned-'));
  try {
    for (const name of await readdir(root)) {
      if (name !== 'learned') await symlink(join(root, name), join(shadow, name));
    }
    return { ...(await loadPack(shadow)), dir: root, learned: [] };
  } finally {
    await rm(shadow, { recursive: true, force: true });
  }
}

/**
 * The packs chosen for the repository, as the engine's `choosePacks` chooses them (every folder with a `pack.yaml`, in
 * name order, then `selectPacks`), except that a pack whose only fault is a learned line is still chosen. Each comes with
 * its learned lines read one by one. A pack that cannot be loaded for another reason is logged and left out, as the
 * engine does.
 */
async function chosenPacks(packsDir: string, repo: string, log: (line: string) => void): Promise<ChosenPack[]> {
  let names: string[];
  try {
    names = (await readdir(packsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch (err) {
    log(`packs for ${repo}: the packs folder could not be read: ${messageOf(err)}`);
    return [];
  }
  const all: Pack[] = [];
  for (const name of names) {
    const dir = join(packsDir, name);
    if (!(await stat(join(dir, 'pack.yaml')).then((s) => s.isFile(), () => false))) continue;
    try {
      all.push(await loadPack(dir));
    } catch (err) {
      const pack = await withoutLearned(dir).catch(() => null);
      if (pack === null) log(`packs for ${repo}: ${messageOf(err)}`);
      else all.push(pack);
    }
  }
  const chosen: ChosenPack[] = [];
  for (const pack of selectPacks(all, repo)) {
    chosen.push({ pack, lines: [...await readLines(pack.dir, 'wrong', log), ...await readLines(pack.dir, 'product-knowledge', log)] });
  }
  return chosen;
}

/**
 * Whether a review of this repository is given the line: the engine's rule (`learnedFor` in pipeline/packs.ts). A pack
 * used for every repository gives only the lines saved on this repository and those with no repository recorded.
 */
function appliesHere(pack: Pack, line: StoredLine, repo: string): boolean {
  if (pack.id !== GENERIC_PACK) return true;
  return forNoRepo(line.repo) || line.repo.toLowerCase() === repo.toLowerCase();
}

/**
 * Every line of every pack chosen for the repository, newest first. Lines of other repositories in a pack used for every
 * repository are listed too, with `appliesHere` false. A learned line that cannot be read is left out and logged; the
 * pack's other lines are still listed.
 */
export async function listLearned(deps: Pick<DismissDeps, 'config' | 'log'>, repo: string): Promise<LearnedReply> {
  const lines: LearnedLine[] = [];
  for (const { pack, lines: stored } of await chosenPacks(deps.config.packsDir, repo, deps.log)) {
    for (const l of stored) {
      lines.push({
        pack: pack.id, packTitle: pack.title, kind: l.kind, date: l.date, repo: forNoRepo(l.repo) ? null : l.repo, text: l.text,
        key: learnedKey(l.kind, l.date, l.repo, l.text), appliesHere: appliesHere(pack, l, repo), removable: pack.id !== KIT_PACK,
      });
    }
  }
  // Array.prototype.sort is stable: lines of one date keep the order they were read in.
  lines.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { lines, cap: LEARNED_CAP };
}

/** The text without the first line that is exactly `stored` (a line's `\r` aside), or null when there is none. */
function withoutLine(text: string, stored: string): string | null {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.replace(/\r$/, '') === stored);
  if (at < 0) return null;
  lines.splice(at, 1);
  return lines.join('\n');
}

/**
 * Removes the line whose key matches, in the one queue every learned-file write goes through, and clears the link of the
 * dismissal that wrote it (the finding stays dismissed). The line is matched by its stored form, white space at its ends
 * included; of identical lines the first is removed. A line that is no longer there changes nothing.
 */
export async function removeLearnedLine(deps: DismissDeps, body: RemoveLearnedBody): Promise<RemoveLearnedReply> {
  return serialised(async () => {
    const chosen = (await chosenPacks(deps.config.packsDir, body.repo, deps.log)).find((c) => c.pack.id === body.pack);
    if (chosen === undefined) throw new DismissError(404, 'Airlock does not use that pack for this repository.');
    const { pack } = chosen;
    if (pack.id === KIT_PACK) throw new DismissError(403, 'Lines of the team standard cannot be removed here.');
    try {
      await assertWritable(pack, deps.config.packsDir);
    } catch {
      throw new DismissError(403, `Airlock will not change the pack "${pack.id}".`);
    }
    const line = chosen.lines.find((l) => l.kind === body.kind && learnedKey(l.kind, l.date, l.repo, l.text) === body.key);
    if (line === undefined) {
      return { removed: false, note: `That line was no longer in ${pack.title}'s ${fileOf(body.kind)}; nothing was removed.` };
    }
    const file = join(pack.dir, 'learned', fileOf(body.kind));
    const before = await readFile(file, 'utf8').catch(() => null);
    const after = before === null ? null : withoutLine(before, storedForm(line));
    // Only when the file changed by hand between the two reads of this request.
    if (before === null || after === null) {
      return { removed: false, note: 'This line could not be matched exactly in the file; edit the file by hand.' };
    }
    await replaceFile(file, after);
    try {
      await clearLink(deps, pack.id, line);
    } catch (err) {
      await replaceFile(file, before).catch(() => undefined);
      throw err;
    }
    return { removed: true, note: null };
  });
}

/** The line a dismissal wrote, as the engine's `appendLearned` writes it, with the repository its review has. */
const writtenLine = (date: string, repo: string, text: string): string =>
  storedForm({ date, repo, text: text.replace(/\s*[\r\n]+\s*/g, ' ').trim() });

/**
 * Clears `learned` on one dismissal whose own link (pack, kind and date) and line are exactly the removed line: the oldest,
 * when several wrote the same line. Every dismissals file of the line's repository is read without setting anything aside;
 * only the file that changes goes through `listForChange`. Runs inside the queue.
 */
async function clearLink(deps: DismissDeps, packId: string, line: StoredLine): Promise<void> {
  if (forNoRepo(line.repo)) return;
  const { home } = deps.config;
  const folder = await dismissalsFolder(home, line.repo);
  let names: string[];
  try { names = (await readdir(folder)).filter((n) => /^[1-9][0-9]*\.json$/.test(n)); } catch { return; }
  const kind = engineKind(line.kind);
  const removed = storedForm(line);
  let oldest: { number: number; fingerprint: string; at: string } | null = null;
  for (const name of names) {
    const number = Number.parseInt(name, 10);
    for (const d of await dismissalsFor(home, line.repo, number)) {
      if (d.learned === null || d.learned.packId !== packId || d.learned.kind !== kind || d.learned.date !== line.date) continue;
      // The repository as `restore` would write the line back out: the stored review's spelling, else the line's.
      const repo = (await reviewById(line.repo, number, d.reviewId))?.pr.repo ?? line.repo;
      if (writtenLine(d.learned.date, repo, d.text) !== removed) continue;
      const older = oldest === null || d.at < oldest.at || (d.at === oldest.at && number < oldest.number);
      if (older) oldest = { number, fingerprint: d.fingerprint, at: d.at };
    }
  }
  if (oldest === null) return;
  const path = join(folder, `${oldest.number}.json`);
  const list = await listForChange(path, deps.now(), deps.log);
  const target = oldest;
  const at = list.findIndex((d) => d.fingerprint === target.fingerprint && d.at === target.at && d.learned !== null);
  if (at < 0) return;
  await (deps.write ?? writeList)(path, list.map((d, i) => (i === at ? { ...d, learned: null } : d)));
}
