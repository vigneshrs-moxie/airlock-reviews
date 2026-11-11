import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyHoldout } from '../../src/packs/holdout.js';
import { appendLearned, parseLearned, removeLearned } from '../../src/packs/learned.js';
import { loadPack } from '../../src/packs/load.js';
import { selectPacks } from '../../src/packs/select.js';
import type { Pack } from '../../src/packs/types.js';

const fixtures = fileURLToPath(new URL('../fixtures/packs/', import.meta.url));
const sampleDir = join(fixtures, 'sample');
const tmp = () => mkdtemp(join(tmpdir(), 'airlock-pack-'));

function stub(id: string, repos: string[]): Pack {
  return {
    id, title: id, version: 'local', dir: `/x/${id}`, repos, appRoot: null, stageRules: [],
    tiers: { read: [], trust: [], ignore: [] }, siblings: [], linkRules: [], checks: [],
    standards: [], lenses: [], rules: [], learned: [],
  };
}

describe('loadPack', () => {
  it('loads rules with their front matter and body', async () => {
    const pack = await loadPack(sampleDir);
    expect(pack.id).toBe('sample');
    expect(pack.version).toBe('v3');
    expect(pack.dir).toBe(sampleDir);
    expect(pack.appRoot).toBe('app');
    expect(pack.rules.map((r) => r.id)).toEqual(['a-rule', 'b-rule']);
    expect(pack.rules[0]).toMatchObject({
      title: 'Escape output', paths: ['app/**/*.js'], severityFloor: 'fix', sourcePrs: [171],
      origin: 'PR 171', packId: 'sample',
    });
    expect(pack.rules[0]!.body.trim()).toBe('Always escape user output.');
    expect(pack.rules[1]).toMatchObject({ severityFloor: 'note', sourcePrs: [], origin: '' });
    expect(pack.lenses).toEqual([{ id: 'security', title: 'Security', instructions: 'Look for security problems.\n' }]);
    expect(pack.standards.map((s) => [s.name, s.dated])).toEqual([['Conventions', true], ['Style', false]]);
    expect(pack.standards[0]!.text).toContain('Intro line.');
    expect(pack.stageRules).toHaveLength(2);
    expect(pack.checks[0]!.id).toBe('no-console');
    expect(pack.linkRules[0]!.transform).toBe('pascal');
    expect(pack.learned).toEqual([
      { date: '2026-10-19', repo: 'acme/web', kind: 'wrong', text: 'Flagged a thing that was fine' },
      { date: '2026-10-29', repo: 'acme/web', kind: 'intended', text: 'Refunds are manual' },
    ]);
  });

  it('fails with the file name when a rule has no id', async () => {
    await expect(loadPack(join(fixtures, 'broken'))).rejects.toThrow(/rules\/broken\.md/);
  });

  it('accepts a pack with only pack.yaml and lenses', async () => {
    const dir = await tmp();
    await mkdir(join(dir, 'lenses'));
    await writeFile(join(dir, 'pack.yaml'), 'id: min\ntitle: Min\nlenses:\n  - { id: q, title: Q, file: lenses/q.md }\n');
    await writeFile(join(dir, 'lenses', 'q.md'), 'text');
    const pack = await loadPack(dir);
    expect(pack).toMatchObject({
      version: 'local', repos: [], appRoot: null, stageRules: [], siblings: [], linkRules: [], checks: [],
      standards: [], rules: [], learned: [], tiers: { read: [], trust: [], ignore: [] },
    });
    expect(pack.lenses).toHaveLength(1);
  });

  it('fails naming pack.yaml when a required key is missing', async () => {
    const dir = await tmp();
    await writeFile(join(dir, 'pack.yaml'), 'id: x\ntitle: X\n');
    await expect(loadPack(dir)).rejects.toThrow(/pack\.yaml.*lenses/);
  });

  it('fails naming a listed file that does not exist', async () => {
    const dir = await tmp();
    await writeFile(join(dir, 'pack.yaml'), 'id: x\ntitle: X\nlenses:\n  - { id: q, title: Q, file: lenses/gone.md }\n');
    await expect(loadPack(dir)).rejects.toThrow(/lenses\/gone\.md/);
  });

  it('fails naming both files when two rules share an id', async () => {
    const dir = await tmp();
    await cp(sampleDir, dir, { recursive: true });
    await cp(join(dir, 'rules', 'a-rule.md'), join(dir, 'rules', 'copy.md'));
    await expect(loadPack(dir)).rejects.toThrow(/a-rule\.md.*copy\.md|copy\.md.*a-rule\.md/);
  });

  it('fails with file and line number on a bad learned line', async () => {
    const dir = await tmp();
    await cp(sampleDir, dir, { recursive: true });
    await writeFile(join(dir, 'learned', 'wrong.md'), '# h\n\nnot an entry\n');
    await expect(loadPack(dir)).rejects.toThrow(/wrong\.md.*3|3.*wrong\.md/);
  });
});

describe('selectPacks', () => {
  const all = [stub('generic', []), stub('a', ['acme/web']), stub('b', ['acme/web', 'acme/api']), stub('c', ['other/x'])];

  it('selects packs by repository and always adds generic last', () => {
    expect(selectPacks(all, 'acme/web').map((p) => p.id)).toEqual(['a', 'b', 'generic']);
    expect(selectPacks(all, 'nobody/none').map((p) => p.id)).toEqual(['generic']);
  });

  it('does not add generic twice', () => {
    const list = [stub('generic', ['acme/web']), stub('a', ['acme/web'])];
    expect(selectPacks(list, 'acme/web').map((p) => p.id)).toEqual(['a', 'generic']);
  });

  it('an override list replaces the selection', () => {
    expect(selectPacks(all, 'acme/web', ['c', 'a']).map((p) => p.id)).toEqual(['c', 'a']);
    expect(() => selectPacks(all, 'acme/web', ['zzz'])).toThrow(/zzz/);
  });
});

describe('applyHoldout', () => {
  it('hold-out drops a rule mined from the pull request under test', async () => {
    const pack = await loadPack(sampleDir);
    const out = applyHoldout(pack, { pr: 171, reviewedAt: '2026-11-01' });
    expect(out.rules.map((r) => r.id)).toEqual(['b-rule']);
    expect(pack.rules).toHaveLength(2);
  });

  it('hold-out drops dated entries on or after the review date and keeps earlier ones', async () => {
    const pack = await loadPack(sampleDir);
    const out = applyHoldout(pack, { pr: 1, reviewedAt: '2026-10-29T10:00:00Z' });
    const text = out.standards[0]!.text;
    expect(text).toContain('# Conventions');
    expect(text).toContain('Intro line.');
    expect(text).toContain('2026-10-19 · First convention\ncontinued line');
    expect(text).not.toContain('Second convention');
    expect(out.standards[1]).toEqual(pack.standards[1]);
    expect(out.learned.map((l) => l.date)).toEqual(['2026-10-19']);
    expect(pack.standards[0]!.text).toContain('Second convention');
    expect(pack.learned).toHaveLength(2);
  });
});

describe('learned entries', () => {
  const entry = { date: '2026-11-02', repo: 'acme/web', kind: 'wrong' as const, text: 'line one\nline two' };

  it('appendLearned then removeLearned leaves the file as it was', async () => {
    const dir = await tmp();
    await cp(sampleDir, dir, { recursive: true });
    const file = join(dir, 'learned', 'wrong.md');
    const before = await readFile(file, 'utf8');
    await appendLearned(dir, entry);
    const during = await readFile(file, 'utf8');
    expect(during).toBe(`${before}2026-11-02 · acme/web · line one line two\n`);
    expect(await removeLearned(dir, { ...entry, text: 'line one line two' })).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await removeLearned(dir, entry)).toBe(false);
  });

  it('creates the folder and file when missing', async () => {
    const dir = await tmp();
    await appendLearned(dir, { ...entry, kind: 'intended', text: 'x' });
    expect(await readFile(join(dir, 'learned', 'product-knowledge.md'), 'utf8')).toBe('2026-11-02 · acme/web · x\n');
  });

  it('parseLearned skips comments and blanks', () => {
    expect(parseLearned('# c\n\n2026-01-01 · r/r · t\n', 'wrong', 'f')).toHaveLength(1);
  });
});
