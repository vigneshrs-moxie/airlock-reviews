import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { choosePacks, loadPack, reviewById, type LearnedEntry, type Pack } from '@airlock/engine';
import {
  isRepo, type LearnedKind, type LearnedLine, type LearnedReply, type RemoveLearnedBody, type RemoveLearnedReply,
} from '@airlock/shared';
import {
  assertWritable, DismissError, dismissalsFolder, dismissalsFor, KIT_PACK, LEARNED_CAP, listForChange, replaceFile, serialised,
  writeList, type DismissDeps,
} from './dismissals.js';
import { pathsForLog } from './http.js';

const fileOf = (kind: LearnedKind): string => (kind === 'wrong' ? 'wrong.md' : 'product-knowledge.md');
const engineKind = (kind: LearnedKind): LearnedEntry['kind'] => (kind === 'wrong' ? 'wrong' : 'intended');
const serviceKind = (kind: LearnedEntry['kind']): LearnedKind => (kind === 'wrong' ? 'wrong' : 'product-knowledge');
const forNoRepo = (field: string): boolean => field.trim() === '' || field.trim() === '-';
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A learned line as it stands in its file: `date · repo · text` gives back the line exactly. */
interface StoredLine { kind: LearnedKind; date: string; repo: string; text: string; appliesHere: boolean }

/** A pack chosen for the repository, with every learned line it holds. */
interface ChosenPack { pack: Pack; lines: StoredLine[] }

const storedForm = (line: Pick<StoredLine, 'date' | 'repo' | 'text'>): string => `${line.date} · ${line.repo} · ${line.text}`;

/** Names a line by what it says: the first 16 hexadecimal characters of the SHA-256 of kind, date, repository and text. */
export function learnedKey(kind: LearnedKind, date: string, repo: string, text: string): string {
  return createHash('sha256').update([kind, date, repo, text].join('\n')).digest('hex').slice(0, 16);
}

const keyOf = (e: LearnedEntry): string => learnedKey(serviceKind(e.kind), e.date, e.repo, e.text);

/** Where an entry stands, in the engine's own form for a line it left out: `<pack id>/learned/<file>:<line number>`. */
const placeOf = (pack: Pack, e: LearnedEntry): string =>
  `${pack.id}/learned/${fileOf(serviceKind(e.kind))}:${/:(\d+)$/.exec(e.where ?? '')?.[1] ?? '?'}`;

/** Where packs live: the packs folder, and the Airlock home. */
type PackFolders = { packsDir: string; home: string };

/** A message about packs for the log: paths written from the packs folder (`acme/learned/wrong.md`) or the Airlock home, any other of the person's paths hidden. */
const packsLog = (text: string, folders: PackFolders): string => pathsForLog(text, [folders.packsDir, folders.home], [homedir()]);

/**
 * The messages of `choosePacks` that may be logged, each through `packsLog`. The engine's sentence for a learned line
 * whose repository field is not a repository is left out: it holds that hand-written field (the list logs that line by
 * its place in the pack instead).
 */
export function packMessagesForLog(chosen: { packs: readonly Pack[]; errors: ReadonlyArray<{ message: string }> }, folders: PackFolders): string[] {
  const learnedDirs = chosen.packs.map((p) => `${join(p.dir, 'learned')}${sep}`);
  return chosen.errors.filter((e) => !learnedDirs.some((dir) => e.message.startsWith(dir))).map((e) => packsLog(e.message, folders));
}

/**
 * The packs the engine chooses for the repository (`choosePacks`), each with every learned line it holds. The engine gives
 * the pack used for every repository only the lines that apply to this repository; the list shows that pack's other lines
 * too, so each pack is loaded once more whole, and a line applies here when the engine kept it. A line the engine could not
 * read (`learnedProblems`), and a line whose repository field is neither a repository name nor empty or `-` (the contract
 * cannot show it), is left out and logged once by its place in the pack, never its text or an absolute path.
 */
async function chosenPacks(folders: PackFolders, repo: string, log: (line: string) => void): Promise<ChosenPack[]> {
  const chosen = await choosePacks(folders.packsDir, repo);
  for (const message of packMessagesForLog(chosen, folders)) log(`packs for ${repo}: ${message}`);
  const result: ChosenPack[] = [];
  for (const pack of chosen.packs) {
    let whole: Pack;
    try { whole = await loadPack(pack.dir); } catch (err) {
      log(`packs for ${repo}: ${packsLog(messageOf(err), folders)}`);
      continue;
    }
    for (const where of whole.learnedProblems ?? []) {
      log(`packs for ${repo}: ${where} is not a learned line ("YYYY-MM-DD · <repo> · <text>"), so it is left out`);
    }
    const here = new Set(pack.learned.map(keyOf));
    const lines: StoredLine[] = [];
    for (const e of whole.learned) {
      if (!forNoRepo(e.repo) && !isRepo(e.repo)) {
        log(`packs for ${repo}: ${placeOf(whole, e)} names no repository ("owner/name", "-" or nothing), so it is left out`);
        continue;
      }
      lines.push({ kind: serviceKind(e.kind), date: e.date, repo: e.repo, text: e.text, appliesHere: here.has(keyOf(e)) });
    }
    result.push({ pack, lines });
  }
  return result;
}

/**
 * Every line of every pack chosen for the repository, newest first. Lines of other repositories in a pack used for every
 * repository are listed too, with `appliesHere` false. A learned line that cannot be read is left out and logged; the
 * pack's other lines are still listed.
 */
export async function listLearned(deps: Pick<DismissDeps, 'config' | 'log'>, repo: string): Promise<LearnedReply> {
  const lines: LearnedLine[] = [];
  for (const { pack, lines: stored } of await chosenPacks(deps.config, repo, deps.log)) {
    for (const l of stored) {
      lines.push({
        pack: pack.id, packTitle: pack.title, kind: l.kind, date: l.date, repo: forNoRepo(l.repo) ? null : l.repo, text: l.text,
        key: learnedKey(l.kind, l.date, l.repo, l.text), appliesHere: l.appliesHere, removable: pack.id !== KIT_PACK,
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
    const chosen = (await chosenPacks(deps.config, body.repo, deps.log)).find((c) => c.pack.id === body.pack);
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
