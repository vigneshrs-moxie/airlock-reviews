import { realpathSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';
import type { FileDiff } from '@airlock/shared';
import ts from 'typescript';

export interface FileSymbols {
  imports: { spec: string; resolved: string | null; line: number }[];
  exports: { name: string; startLine: number; endLine: number }[];
}
export type Resolve = (fromPath: string, spec: string) => string | null;

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS, '.mts': ts.ScriptKind.TS, '.cts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.cjs': ts.ScriptKind.JS, '.jsx': ts.ScriptKind.JSX,
};
const RESOLVE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const TS_FOR_JS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

export const isScript = (path: string): boolean => posix.extname(path) in SCRIPT_KINDS;

/** A repository-relative path in normal form, or null when it would leave the repository. */
export function repoPath(path: string): string | null {
  const p = posix.normalize(path.replaceAll('\\', '/'));
  if (p === '..' || p.startsWith('../') || p.startsWith('/')) return null;
  return p === '.' ? '' : p;
}

/** True when the real location of `rel` (after symlinks) lies inside the real `headDir`. */
export async function insideHead(headDir: string, rel: string): Promise<boolean> {
  try {
    const [root, full] = await Promise.all([realpath(headDir), realpath(join(headDir, rel))]);
    return full.startsWith(root + sep);
  } catch {
    return false;
  }
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)));
}

/** Imports and top-level exports of a TypeScript or JavaScript file; empty lists for any other file. */
export function readSymbols(path: string, text: string, resolve: Resolve): FileSymbols {
  const kind = SCRIPT_KINDS[posix.extname(path)];
  if (kind === undefined) return { imports: [], exports: [] };
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const out: FileSymbols = { imports: [], exports: [] };

  const addImport = (spec: ts.Node, at: ts.Node): void => {
    if (!ts.isStringLiteralLike(spec)) return;
    out.imports.push({ spec: spec.text, resolved: resolve(path, spec.text), line: lineOf(at.getStart(sf)) });
  };
  const addExport = (name: string, node: ts.Node): void => {
    out.exports.push({ name, startLine: lineOf(node.getStart(sf)), endLine: lineOf(node.getEnd()) });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) addImport(node.moduleSpecifier, node);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addImport(node.moduleReference.expression, node);
    } else if (ts.isCallExpression(node) && node.arguments[0] !== undefined) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require' && node.arguments.length === 1;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || isRequire) addImport(node.arguments[0], node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) addExport(el.name.text, st);
      } else if (st.exportClause && ts.isNamespaceExport(st.exportClause)) {
        addExport(st.exportClause.name.text, st);
      }
      continue;
    }
    if (ts.isExportAssignment(st)) {
      if (!st.isExportEquals) addExport('default', st);
      continue;
    }
    if (!hasModifier(st, ts.SyntaxKind.ExportKeyword)) continue;
    if (hasModifier(st, ts.SyntaxKind.DefaultKeyword)) {
      addExport('default', st);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) for (const n of bindingNames(d.name)) addExport(n, st);
    } else if (
      (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isTypeAliasDeclaration(st)
        || ts.isInterfaceDeclaration(st) || ts.isEnumDeclaration(st)) && st.name
    ) {
      addExport(st.name.text, st);
    }
  }
  return out;
}

interface Alias { star: boolean; prefix: string; suffix: string; targets: string[] }

/** `compilerOptions.paths` from `<appRoot>/tsconfig.json`, targets made repository-relative. */
function readAliases(headDir: string, appRoot: string | null): Alias[] {
  const dir = repoPath(appRoot ?? '') ?? '';
  const read = (p: string): string | undefined => {
    try {
      return realpathSync(p).startsWith(realpathSync(headDir) + sep) ? ts.sys.readFile(p) : undefined;
    } catch {
      return undefined;
    }
  };
  const { config } = ts.readConfigFile(join(headDir, dir, 'tsconfig.json'), read) as {
    config?: { compilerOptions?: { baseUrl?: unknown; paths?: unknown } };
  };
  const options = config?.compilerOptions;
  if (!options?.paths || typeof options.paths !== 'object') return [];
  const base = posix.join(dir, typeof options.baseUrl === 'string' ? options.baseUrl : '.');
  const aliases: Alias[] = [];
  for (const [key, value] of Object.entries(options.paths as Record<string, unknown>)) {
    const parts = key.split('*');
    if (parts.length > 2 || !Array.isArray(value)) continue;
    const star = parts.length === 2;
    const targets = value
      .filter((t): t is string => typeof t === 'string' && t.split('*').length === parts.length)
      .map((t) => posix.join(base, t));
    aliases.push({ star, prefix: parts[0] ?? '', suffix: star ? parts[1] ?? '' : '', targets });
  }
  // Exact keys first, then the longest prefix, as TypeScript does.
  return aliases.sort((a, b) => Number(a.star) - Number(b.star) || b.prefix.length - a.prefix.length);
}

/** The text matched by the alias's `*` ('' for an exact key), or null when the alias does not apply. */
function matchAlias(a: Alias, spec: string): string | null {
  if (!a.star) return spec === a.prefix ? '' : null;
  if (!spec.startsWith(a.prefix) || !spec.endsWith(a.suffix) || spec.length < a.prefix.length + a.suffix.length) return null;
  return spec.slice(a.prefix.length, spec.length - a.suffix.length);
}

/** Resolves an import to a repository-relative file that exists in `headDir`, or null. */
export async function makeResolver(headDir: string, appRoot: string | null): Promise<Resolve> {
  const root = await realpath(headDir);
  const aliases = readAliases(headDir, appRoot);
  const seen = new Map<string, boolean>();

  const isFile = (rel: string): boolean => {
    let hit = seen.get(rel);
    if (hit === undefined) {
      try {
        const full = join(headDir, rel);
        hit = statSync(full).isFile() && realpathSync(full).startsWith(root + sep);
      } catch {
        hit = false;
      }
      seen.set(rel, hit);
    }
    return hit;
  };

  const tryPath = (raw: string): string | null => {
    const base = repoPath(raw);
    if (base === null || base === '') return null;
    const ext = posix.extname(base);
    const candidates = [
      base,
      ...(TS_FOR_JS[ext] ?? []).map((e) => base.slice(0, -ext.length) + e),
      ...RESOLVE_EXTS.map((e) => base + e),
      ...RESOLVE_EXTS.map((e) => `${base}/index${e}`),
    ];
    return candidates.find(isFile) ?? null;
  };

  return (fromPath, spec) => {
    if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
      return tryPath(posix.join(posix.dirname(fromPath), spec));
    }
    for (const a of aliases) {
      const middle = matchAlias(a, spec);
      if (middle === null) continue;
      for (const t of a.targets) {
        const found = tryPath(t.replace('*', middle));
        if (found) return found;
      }
      return null;
    }
    return null;
  };
}

/** Names of exports touched by added lines; every export of an added file. */
export function changedExports(symbols: FileSymbols, file: FileDiff): string[] {
  if (file.status === 'deleted' || file.binary) return [];
  const added = new Set<number>();
  for (const h of file.hunks) for (const l of h.lines) if (l.kind === 'add' && l.newNo !== null) added.add(l.newNo);
  const touched = symbols.exports.filter((e) => {
    if (file.status === 'added') return true;
    for (let n = e.startLine; n <= e.endLine; n++) if (added.has(n)) return true;
    return false;
  });
  return [...new Set(touched.map((e) => e.name))];
}
