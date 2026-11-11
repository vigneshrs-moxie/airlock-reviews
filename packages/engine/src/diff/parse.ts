import type { DiffLine, FileDiff, Hunk, ReviewRange } from '@airlock/shared';
import type { Exec } from '../util/exec.js';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Decode a path as git prints it: optionally quoted with C-style escapes, optionally with a trailing tab. */
function unquote(raw: string): string {
  let s = raw.replace(/\t$/, '');
  if (!(s.startsWith('"') && s.endsWith('"') && s.length >= 2)) return s;
  s = s.slice(1, -1);
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' };
  // Build a percent-encoded UTF-8 string so octal byte escapes decode as multi-byte characters.
  let encoded = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch !== '\\') { encoded += encodeURIComponent(ch); continue; }
    const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4))?.[0];
    if (oct !== undefined) {
      encoded += '%' + parseInt(oct, 8).toString(16).padStart(2, '0');
      i += oct.length;
      continue;
    }
    const mapped = simple[s.charAt(i + 1)];
    if (mapped !== undefined) { encoded += encodeURIComponent(mapped); i += 1; } else encoded += '%5C';
  }
  try { return decodeURIComponent(encoded); } catch { return s; }
}

/** Strip the `a/` or `b/` prefix from a `---`/`+++` path; null for /dev/null. */
function stripSide(raw: string): string | null {
  const p = unquote(raw);
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

/** Fallback path from `diff --git a/x b/x` when no ---/+++ or rename lines exist (binary, mode-only). */
function pathFromGitLine(line: string): string {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const m = rest.match(/^"(?:[^"\\]|\\.)*"/);
    if (m) {
      const after = rest.slice(m[0].length).trim();
      return stripSide(after) ?? unquote(m[0]);
    }
  }
  const quotedB = rest.match(/ ("(?:[^"\\]|\\.)*")$/);
  if (quotedB) return stripSide(quotedB[1] ?? '') ?? '';
  // Unquoted: "a/<p> b/<p>" with identical paths unless renamed; split at the middle.
  const mid = (rest.length - 1) / 2;
  if (Number.isInteger(mid) && rest[mid] === ' ') return rest.slice(mid + 1).replace(/^b\//, '');
  const idx = rest.lastIndexOf(' b/');
  return idx >= 0 ? rest.slice(idx + 3) : rest;
}

interface Draft {
  gitLine: string;
  oldPath: string | null | undefined; // undefined: not seen
  newPath: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  hunks: Hunk[];
  additions: number;
  deletions: number;
}

function finish(d: Draft): FileDiff {
  let status: FileDiff['status'] = 'modified';
  if (d.isNew) status = 'added';
  else if (d.isDeleted) status = 'deleted';
  else if (d.renameFrom !== null) status = 'renamed';
  const fallback = pathFromGitLine(d.gitLine);
  const path = status === 'deleted'
    ? (d.oldPath ?? d.renameFrom ?? fallback)
    : (d.newPath ?? d.renameTo ?? fallback);
  return {
    path,
    oldPath: status === 'renamed' ? d.renameFrom : null,
    status,
    binary: d.binary,
    additions: d.additions,
    deletions: d.deletions,
    hunks: d.hunks,
  };
}

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: Draft | null = null;
  let hunk: Hunk | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;
  let oldNo = 0;
  let newNo = 0;

  const flush = (): void => {
    if (cur) files.push(finish(cur));
    cur = null;
    hunk = null;
  };

  for (const line of text.split('\n')) {
    const inHunkBody = hunk !== null && (oldRemaining > 0 || newRemaining > 0);
    if (inHunkBody && cur) {
      const marker = line[0];
      const body = line.slice(1);
      if (marker === '+' && newRemaining > 0) {
        hunk!.lines.push({ kind: 'add', oldNo: null, newNo: newNo++, text: body });
        newRemaining--; cur.additions++;
        continue;
      }
      if (marker === '-' && oldRemaining > 0) {
        hunk!.lines.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: body });
        oldRemaining--; cur.deletions++;
        continue;
      }
      if ((marker === ' ' || line === '') && oldRemaining > 0 && newRemaining > 0) {
        hunk!.lines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: body });
        oldRemaining--; newRemaining--;
        continue;
      }
      if (marker === '\\') continue;
    }
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"

    if (line.startsWith('diff --git ')) {
      flush();
      cur = {
        gitLine: line, oldPath: undefined, newPath: undefined, renameFrom: null, renameTo: null,
        isNew: false, isDeleted: false, binary: false, hunks: [], additions: 0, deletions: 0,
      };
      continue;
    }
    if (!cur) continue;
    const m = HUNK_RE.exec(line);
    if (m && cur.oldPath !== undefined) {
      const oldStart = Number(m[1]);
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      hunk = { oldStart, oldLines, newStart, newLines, header: line, lines: [] as DiffLine[] };
      cur.hunks.push(hunk);
      oldRemaining = oldLines; newRemaining = newLines; oldNo = oldStart; newNo = newStart;
    } else if (line.startsWith('--- ') && hunk === null) cur.oldPath = stripSide(line.slice(4));
    else if (line.startsWith('+++ ') && hunk === null) cur.newPath = stripSide(line.slice(4));
    else if (line.startsWith('new file mode')) cur.isNew = true;
    else if (line.startsWith('deleted file mode')) cur.isDeleted = true;
    else if (line.startsWith('rename from ')) cur.renameFrom = unquote(line.slice('rename from '.length));
    else if (line.startsWith('rename to ')) cur.renameTo = unquote(line.slice('rename to '.length));
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') cur.binary = true;
  }
  flush();
  return files;
}

export async function loadDiff(exec: Exec, cwd: string, range: ReviewRange): Promise<FileDiff[]> {
  const res = await exec('git', ['diff', '--no-color', '-M', '--unified=3', range.baseSha, range.headSha], { cwd, maxBuffer: 256 * 1024 * 1024 });
  if (res.code !== 0) throw new Error(`git diff ${range.baseSha} ${range.headSha} failed (exit ${res.code}): ${res.stderr}`);
  return parseDiff(res.stdout);
}

/** True when newLine is an added or context line inside one of the file's hunks. */
export function lineInDiff(file: FileDiff, newLine: number): boolean {
  return file.hunks.some((h) => h.lines.some((l) => l.newNo === newLine));
}
