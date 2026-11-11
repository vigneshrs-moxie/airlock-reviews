import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyHoldout, datedEntries } from '../../src/packs/holdout.js';
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
    expect(pack.lenses).toEqual([
      { id: 'security', title: 'Security', instructions: 'Look for security problems.\n', onlyWhenAlone: false },
    ]);
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

describe('loadPack validation', () => {
  async function withYaml(extra: string): Promise<string> {
    const dir = await tmp();
    await mkdir(join(dir, 'lenses'));
    await writeFile(join(dir, 'pack.yaml'), `id: v\ntitle: V\nlenses: []\n${extra}`);
    return dir;
  }
  const std = (dated: string) => `standards:\n  - { name: S, file: s.md${dated} }\n`;

  it.each([['missing', ''], ['yes', ', dated: yes'], ['a string', ', dated: "true"']])(
    'rejects a standard whose dated is %s', async (_n, dated) => {
      const dir = await withYaml(std(dated));
      await writeFile(join(dir, 's.md'), 'x');
      await expect(loadPack(dir)).rejects.toThrow(/pack\.yaml.*"dated" must be true or false/);
    });

  it.each([
    ['tiers', 'tiers: [a]\n'],
    ['tiers', 'tiers: { read: "a" }\n'],
    ['checks', 'checks:\n  - { id: c, kind: bogus, paths: [a], message: m }\n'],
    ['linkRules', 'linkRules:\n  - { id: l, from: f, capture: c, searchIn: [a], detail: d, transform: upper }\n'],
    ['siblings', 'siblings:\n  - { id: s }\n'],
    ['stageRules', 'stageRules:\n  - { stage: pr1 }\n'],
  ])('rejects a malformed %s section', async (section, extra) => {
    const dir = await withYaml(extra);
    await expect(loadPack(dir)).rejects.toThrow(new RegExp(`pack\\.yaml.*${section}`));
  });

  it('reads onlyWhenAlone on a lens and defaults it to false', async () => {
    const dir = await tmp();
    await mkdir(join(dir, 'lenses'));
    await writeFile(join(dir, 'lenses', 'q.md'), 'text');
    await writeFile(join(dir, 'pack.yaml'), [
      'id: v', 'title: V', 'lenses:',
      '  - { id: alone, title: Alone, file: lenses/q.md, onlyWhenAlone: true }',
      '  - { id: always, title: Always, file: lenses/q.md }',
      '  - { id: off, title: Off, file: lenses/q.md, onlyWhenAlone: false }', '',
    ].join('\n'));
    const pack = await loadPack(dir);
    expect(pack.lenses.map((l) => [l.id, l.onlyWhenAlone])).toEqual([['alone', true], ['always', false], ['off', false]]);
  });

  it.each([['yes', 'yes'], ['a string', '"true"'], ['a number', '1'], ['null', 'null'], ['blank', '']])(
    'rejects a lens whose onlyWhenAlone is %s', async (_n, value) => {
      const dir = await tmp();
      await mkdir(join(dir, 'lenses'));
      await writeFile(join(dir, 'lenses', 'q.md'), 'text');
      await writeFile(join(dir, 'pack.yaml'), `id: v\ntitle: V\nlenses:\n  - { id: q, title: Q, file: lenses/q.md, onlyWhenAlone: ${value} }\n`);
      await expect(loadPack(dir)).rejects.toThrow(/pack\.yaml.*"onlyWhenAlone" must be true or false/);
    });

  it('defaults a link rule transform to none', async () => {
    const dir = await withYaml('linkRules:\n  - { id: l, from: f, capture: c, searchIn: [a], detail: d }\n');
    expect((await loadPack(dir)).linkRules[0]!.transform).toBe('none');
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

describe('datedEntries', () => {
  it('splits a dated standard into entries the way the hold-out does, without the date start', () => {
    const text = '# H\nIntro.\n2026-10-29 · First\ncontinued\n\nLoose line\n2026-10-30 · Second\n2026-10-31 · Third\n';
    expect(datedEntries(text)).toEqual([
      { date: '2026-10-29', body: 'First\ncontinued' },
      { date: '2026-10-30', body: 'Second' },
      { date: '2026-10-31', body: 'Third' },
    ]);
  });
});

describe('applyHoldout multi-line entries', () => {
  it('drops continuation lines with the entry and keeps content after the blank line', () => {
    const text = '# H\n2026-10-29 · Dropped\nstill dropped\n\nKept after blank\n2026-10-19 · Early\n';
    const pack = { ...stub('p', []), standards: [{ name: 'S', text, dated: true }] };
    const out = applyHoldout(pack, { pr: 1, reviewedAt: '2026-10-29' });
    expect(out.standards[0]!.text).toBe('# H\n\nKept after blank\n2026-10-19 · Early\n');
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

  it.each([
    ['empty text', { text: '  ' }],
    ['a bad date', { date: '2026-1-2' }],
    ['a newline in the repo', { repo: 'a\nb' }],
    ['a separator in the repo', { repo: 'a · b' }],
  ])('appendLearned rejects %s without touching the file', async (_n, bad) => {
    const dir = await tmp();
    await cp(sampleDir, dir, { recursive: true });
    const file = join(dir, 'learned', 'wrong.md');
    const before = await readFile(file, 'utf8');
    await expect(appendLearned(dir, { ...entry, ...bad })).rejects.toThrow(/learned/i);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('removeLearned finds a line in a CRLF file', async () => {
    const dir = await tmp();
    await mkdir(join(dir, 'learned'));
    const file = join(dir, 'learned', 'wrong.md');
    await writeFile(file, '2026-01-01 · r/r · a\r\n2026-01-02 · r/r · b\r\n');
    expect(await removeLearned(dir, { date: '2026-01-01', repo: 'r/r', kind: 'wrong', text: 'a' })).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('2026-01-02 · r/r · b\r\n');
  });

  it('parseLearned skips comments and blanks', () => {
    expect(parseLearned('# c\n\n2026-01-01 · r/r · t\n', 'wrong', 'f')).toHaveLength(1);
  });
});
