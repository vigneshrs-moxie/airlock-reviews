import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { changedExports, makeResolver, readSymbols } from '../../src/map/ts-symbols.js';
import { makeChange } from '../helpers/change-repo.js';
import { makeTempRepo, type TempRepo } from '../helpers/temp-repo.js';

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await rm(r.dir, { recursive: true, force: true });
});
async function repo(files: Record<string, string>): Promise<TempRepo> {
  const r = await makeTempRepo();
  repos.push(r);
  for (const [p, t] of Object.entries(files)) await r.write(p, t);
  await r.commit('init');
  return r;
}

const noResolve = (): string | null => null;

describe('readSymbols', () => {
  it('reads named, default and re-exported symbols with line ranges', () => {
    const text = [
      "import { x } from './x.js';",           // 1
      "import './side-effect';",               // 2
      'export function approveSwap(id: string) {', // 3
      '  return id;',                          // 4
      '}',                                     // 5
      'export const a = 1, b = 2;',            // 6
      'export class Box {}',                   // 7
      'export type Id = string;',              // 8
      'export interface Shape {',              // 9
      '  w: number;',                          // 10
      '}',                                     // 11
      'export enum Kind { A }',                // 12
      'const local = 3;',                      // 13
      'export { local, x as renamed };',       // 14
      "export { helper } from './helper.js';", // 15
      'export default function () {}',         // 16
      "const lazy = () => import('./lazy');",  // 17
      "const cjs = require('./cjs');",         // 18
    ].join('\n');
    const resolve = (from: string, spec: string): string | null => (spec.startsWith('./') ? `${spec}@${from}` : null);
    const s = readSymbols('src/m.ts', text, resolve);
    expect(s.imports).toEqual([
      { spec: './x.js', resolved: './x.js@src/m.ts', line: 1 },
      { spec: './side-effect', resolved: './side-effect@src/m.ts', line: 2 },
      { spec: './helper.js', resolved: './helper.js@src/m.ts', line: 15 },
      { spec: './lazy', resolved: './lazy@src/m.ts', line: 17 },
      { spec: './cjs', resolved: './cjs@src/m.ts', line: 18 },
    ]);
    expect(s.exports).toEqual([
      { name: 'approveSwap', startLine: 3, endLine: 5 },
      { name: 'a', startLine: 6, endLine: 6 },
      { name: 'b', startLine: 6, endLine: 6 },
      { name: 'Box', startLine: 7, endLine: 7 },
      { name: 'Id', startLine: 8, endLine: 8 },
      { name: 'Shape', startLine: 9, endLine: 11 },
      { name: 'Kind', startLine: 12, endLine: 12 },
      { name: 'local', startLine: 14, endLine: 14 },
      { name: 'renamed', startLine: 14, endLine: 14 },
      { name: 'helper', startLine: 15, endLine: 15 },
      { name: 'default', startLine: 16, endLine: 16 },
    ]);
  });

  it('records a re-export as both an import and an export', () => {
    const s = readSymbols('a/index.ts', "export { a } from './a.js';\n", () => 'a/a.ts');
    expect(s.imports).toEqual([{ spec: './a.js', resolved: 'a/a.ts', line: 1 }]);
    expect(s.exports).toEqual([{ name: 'a', startLine: 1, endLine: 1 }]);
  });

  it('reads JSX files and returns nothing for other extensions', () => {
    const jsx = readSymbols('ui/Card.jsx', 'export default function Card() { return <div />; }\n', noResolve);
    expect(jsx.exports).toEqual([{ name: 'default', startLine: 1, endLine: 1 }]);
    expect(readSymbols('app.py', 'def run():\n  pass\n', noResolve)).toEqual({ imports: [], exports: [] });
    expect(readSymbols('README.md', "import x from './x'", noResolve)).toEqual({ imports: [], exports: [] });
  });
});

describe('makeResolver', () => {
  it('resolves a relative import and an @/ alias from tsconfig paths', async () => {
    const r = await repo({
      'web/tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
      'web/src/lib/db.ts': 'export const db = 1;\n',
      'web/src/app/page.tsx': 'export default 1;\n',
      'web/src/app/actions.ts': 'export const go = 1;\n',
      'web/src/ui/index.tsx': 'export const Button = 1;\n',
    });
    const resolve = await makeResolver(r.dir, 'web');
    expect(resolve('web/src/app/page.tsx', './actions')).toBe('web/src/app/actions.ts');
    expect(resolve('web/src/app/page.tsx', './actions.js')).toBe('web/src/app/actions.ts');
    expect(resolve('web/src/app/page.tsx', '../ui')).toBe('web/src/ui/index.tsx');
    expect(resolve('web/src/app/page.tsx', '@/lib/db')).toBe('web/src/lib/db.ts');
    expect(resolve('web/src/app/page.tsx', 'react')).toBeNull();
    expect(resolve('web/src/app/page.tsx', './missing')).toBeNull();
    expect(resolve('web/src/app/page.tsx', '../../../../etc/passwd')).toBeNull();
  });

  it('reads a tsconfig with comments and honours baseUrl', async () => {
    const r = await repo({
      'tsconfig.json': [
        '{',
        '  // where the aliases point',
        '  "compilerOptions": {',
        '    "baseUrl": "src", /* trailing comment */',
        '    "paths": { "~lib/*": ["lib/*"] },',
        '  },',
        '}',
      ].join('\n'),
      'src/lib/time.ts': 'export const now = 1;\n',
    });
    const resolve = await makeResolver(r.dir, null);
    expect(resolve('src/a.ts', '~lib/time')).toBe('src/lib/time.ts');
    expect(resolve('src/a.ts', 'lib/time')).toBeNull();
  });

  it('resolves only relative specifiers when there is no tsconfig', async () => {
    const r = await repo({ 'src/lib/time.ts': 'export const now = 1;\n', 'src/a.ts': '' });
    const resolve = await makeResolver(r.dir, null);
    expect(resolve('src/a.ts', './lib/time')).toBe('src/lib/time.ts');
    expect(resolve('src/a.ts', '@/lib/time')).toBeNull();
  });
});

describe('changedExports', () => {
  it('changedExports returns only the function whose lines were edited', async () => {
    const r = await makeTempRepo();
    repos.push(r);
    const before = [
      'export function approveSwap() {',
      '  return 1;',
      '}',
      '',
      'export function declineSwap() {',
      '  return 2;',
      '}',
    ];
    const after = [...before];
    after[5] = '  return 3;';
    const [file] = await makeChange(r, { 'a.ts': `${before.join('\n')}\n` }, { 'a.ts': `${after.join('\n')}\n` });
    const symbols = readSymbols('a.ts', `${after.join('\n')}\n`, noResolve);
    expect(changedExports(symbols, file!)).toEqual(['declineSwap']);
  });

  it('returns every export of an added file', async () => {
    const r = await makeTempRepo();
    repos.push(r);
    const text = 'export const one = 1;\nexport function two() {}\n';
    const [file] = await makeChange(r, { 'keep.txt': 'x\n' }, { 'new.ts': text });
    expect(changedExports(readSymbols('new.ts', text, noResolve), file!)).toEqual(['one', 'two']);
  });
});
