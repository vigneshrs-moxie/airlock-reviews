import { readFileSync } from 'node:fs';
import type { FileDiff } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import { parseDiff } from '../../src/diff/parse.js';
import { formatForPrompt } from '../../src/diff/format.js';

const fx = (name: string): string => readFileSync(new URL(`../fixtures/diffs/${name}.diff`, import.meta.url), 'utf8');

const one = (name: string): FileDiff => {
  const f = parseDiff(fx(name))[0];
  if (!f) throw new Error(`no file in fixture ${name}`);
  return f;
};

describe('formatForPrompt', () => {
  it('prints new line numbers and blanks for removed lines', () => {
    const file = one('modified-two-hunks');
    const out = formatForPrompt(file).split('\n');
    expect(out[0]).toBe('## File: src/app.ts');
    expect(out[1]).toBe('@@ -10,3 +12,4 @@ function main() {');
    expect(out[2]).toBe('   12   const a = 1;');
    expect(out[3]).toBe('   13 + const b = 2;');
    expect(out).toContain('      - gone();');
  });

  it('notes renames, deletions and binaries', () => {
    expect(formatForPrompt(one('renamed')).split('\n')[0]).toBe('## File: src/after.ts (renamed from src/before.ts)');
    expect(formatForPrompt(one('deleted')).split('\n')[0]).toBe('## File: src/old.ts (deleted)');
    expect(formatForPrompt(one('binary'))).toBe('## File: img/logo.png (binary, not shown)');
  });

  it('truncates at maxLines with a count of the changed lines not shown', () => {
    const file = one('modified-two-hunks');
    const out = formatForPrompt(file, { maxLines: 3 }).split('\n');
    expect(out.at(-1)).toBe('… 3 more changed lines not shown; read the file');
    expect(out.some((l) => l.includes('replaced()'))).toBe(false);
  });

  it('does not truncate when within maxLines', () => {
    const file = one('added');
    expect(formatForPrompt(file, { maxLines: 10 })).not.toContain('not shown');
  });
});
