import type { Exec } from '../util/exec.js';
import { limiter } from '../util/limit.js';

/** Splits a Markdown table row into cells on unescaped pipes. */
function cells(row: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < row.length; i++) {
    const c = row[i]!;
    if (c === '\\' && row[i + 1] === '|') { cur += '\\|'; i++; } else if (c === '|') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  if (out[0]!.trim() === '') out.shift();
  if (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
  return out;
}

/** Helper names from the second column of the "Helpers that must be used" table. */
export function namedHelpers(orbitMd: string): string[] {
  const lines = orbitMd.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.includes('Helpers that must be used'));
  if (start < 0) return [];
  let i = start + 1;
  while (i < lines.length && !lines[i]!.trim().startsWith('|')) {
    if (/^#{1,6}\s/.test(lines[i]!)) return [];
    i++;
  }
  i += 2; // header row and separator
  const names: string[] = [];
  for (; i < lines.length && lines[i]!.trim().startsWith('|'); i++) {
    const second = cells(lines[i]!.trim())[1];
    if (second === undefined) continue;
    for (const m of second.matchAll(/`([^`]+)`/g)) {
      const id = /^[A-Za-z_$][\w$]*/.exec(m[1]!.trim())?.[0];
      if (id && id.length >= 4 && /[A-Z]/.test(id.slice(1)) && !names.includes(id)) names.push(id);
    }
  }
  return names;
}

/** Names that no file in the base checkout mentions. */
export async function missingHelpers(exec: Exec, baseDir: string, names: string[]): Promise<string[]> {
  const limit = limiter(8);
  const found = await Promise.all(names.map((name) => limit(async () => {
    const res = await exec('git', ['grep', '-l', '-w', '-F', name], { cwd: baseDir });
    if (res.code === 0) return true;
    if (res.code === 1) return false;
    throw new Error(`git grep failed for ${name}: ${res.stderr}`);
  })));
  return names.filter((_, i) => !found[i]);
}
