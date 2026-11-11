import { posix } from 'node:path';
import type { Fact, FileDiff } from '@airlock/shared';
import picomatch from 'picomatch';
import { SYMLINK_MODE } from '../diff/parse.js';
import type { CheckDef, Pack } from '../packs/types.js';

type ReadHead = (path: string) => Promise<string | null>;

const matches = (globs: string[], path: string): boolean => globs.some((g) => picomatch(g, { dot: true })(path));
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(pack: Pack, check: CheckDef, source: string): RegExp {
  try {
    return new RegExp(source);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`pack "${pack.id}" check "${check.id}": invalid pattern ${JSON.stringify(source)}: ${why}`);
  }
}

const inScope = (check: CheckDef, path: string): boolean =>
  matches(check.paths, path) && !matches(check.exceptPaths ?? [], path);

const byPathThenLine = (a: Fact, b: Fact): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : (a.line ?? 0) - (b.line ?? 0);

export async function runChecks(files: FileDiff[], packs: Pack[], readHead: ReadHead): Promise<Fact[]> {
  const cache = new Map<string, Promise<string | null>>();
  const read = (path: string): Promise<string | null> => {
    let hit = cache.get(path);
    if (!hit) { hit = readHead(path); cache.set(path, hit); }
    return hit;
  };

  const out: Fact[] = [];
  for (const pack of packs) {
    for (const check of pack.checks) {
      const facts = await runOne(pack, check, files, read);
      out.push(...facts.sort(byPathThenLine));
    }
  }
  return out;
}

async function runOne(pack: Pack, check: CheckDef, files: FileDiff[], read: ReadHead): Promise<Fact[]> {
  const fact = (path: string, line: number | null, message = check.message): Fact => ({ checkId: check.id, path, line, message });
  const pattern = check.pattern !== undefined ? compile(pack, check, check.pattern) : null;
  // A symbolic link holds a path, not code, so no check reads it.
  const live = files.filter((f) => f.status !== 'deleted' && f.mode !== SYMLINK_MODE);
  const facts: Fact[] = [];

  switch (check.kind) {
    case 'added-line-matches':
      if (!pattern) break;
      for (const f of live.filter((x) => inScope(check, x.path))) {
        for (const hunk of f.hunks) {
          for (const l of hunk.lines) {
            if (l.kind === 'add' && l.newNo !== null && pattern.test(l.text)) facts.push(fact(f.path, l.newNo));
          }
        }
      }
      break;
    case 'file-pair': {
      const triggers = live.filter((f) => matches(check.paths, f.path));
      const missing = (check.requires ?? []).some((r) => !files.some((f) => matches([r.path], f.path)));
      if (missing) for (const f of triggers) facts.push(fact(f.path, null));
      break;
    }
    case 'new-file-requires':
      for (const f of live.filter((x) => x.status === 'added' && matches(check.paths, x.path))) {
        const folder = posix.dirname(f.path);
        const dir = posix.basename(folder);
        const above = posix.dirname(folder);
        const parent = folder === '.' || above === '.' ? '' : posix.basename(above);
        for (const req of check.requires ?? []) {
          const target = req.path.replaceAll('{self}', f.path).replaceAll('{parent}', parent).replaceAll('{dir}', dir);
          const text = await read(target);
          const wanted = req.pattern !== undefined
            ? compile(pack, check, req.pattern.replaceAll('{parent}', escapeRegExp(parent)).replaceAll('{dir}', escapeRegExp(dir)))
            : null;
          if (text === null || (wanted !== null && !wanted.test(text))) {
            facts.push(fact(f.path, null, `${check.message} (missing in ${target})`));
          }
        }
      }
      break;
    case 'file-touched':
      for (const f of files.filter((x) => inScope(check, x.path))) facts.push(fact(f.path, null));
      break;
  }
  return facts;
}
