import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SeveritySchema } from '@airlock/shared';
import { parse } from 'yaml';
import type { StageRule } from '../intake/pr.js';
import { learnedFileName, parseLearned } from './learned.js';
import type { CheckDef, LearnedEntry, LensDef, LinkRule, Pack, Rule } from './types.js';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(o: Obj, key: string, file: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '') throw new Error(`${file}: missing or invalid "${key}"`);
  return v;
}

function strList(o: Obj, key: string, file: string, required = false): string[] {
  const v = o[key];
  if (v === undefined || v === null) {
    if (required) throw new Error(`${file}: missing "${key}"`);
    return [];
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`${file}: "${key}" must be a list of text`);
  return v as string[];
}

function objList(o: Obj, key: string, file: string, required = false): Obj[] {
  const v = o[key];
  if (v === undefined || v === null) {
    if (required) throw new Error(`${file}: missing "${key}"`);
    return [];
  }
  if (!Array.isArray(v) || v.some((x) => !isObj(x))) throw new Error(`${file}: "${key}" must be a list of entries`);
  return v as Obj[];
}

async function readText(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${path}: file not found`);
    throw err;
  }
}

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith('.md')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function parseYaml(text: string, file: string): unknown {
  try { return parse(text); } catch (err) {
    throw new Error(`${file}: invalid YAML (${(err as Error).message})`);
  }
}

function splitFrontMatter(text: string, file: string): { meta: Obj; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!m) throw new Error(`${file}: missing front matter between --- lines`);
  const meta = parseYaml(m[1]!, file);
  if (!isObj(meta)) throw new Error(`${file}: front matter must be a mapping`);
  return { meta, body: m[2] ?? '' };
}

async function loadRule(dir: string, name: string, packId: string): Promise<Rule> {
  const file = `rules/${name}`;
  const label = join(dir, file);
  const { meta, body } = splitFrontMatter(await readText(label), label);
  const paths = strList(meta, 'paths', label, true);
  if (paths.length === 0) throw new Error(`${label}: "paths" must not be empty`);
  const floor = SeveritySchema.safeParse(meta.severityFloor ?? 'note');
  if (!floor.success) throw new Error(`${label}: invalid "severityFloor"`);
  const sourcePrs = meta.sourcePrs ?? [];
  if (!Array.isArray(sourcePrs) || sourcePrs.some((n) => typeof n !== 'number')) {
    throw new Error(`${label}: "sourcePrs" must be a list of numbers`);
  }
  const origin = meta.origin ?? '';
  if (typeof origin !== 'string') throw new Error(`${label}: "origin" must be text`);
  return {
    id: str(meta, 'id', label), title: str(meta, 'title', label), paths, severityFloor: floor.data,
    sourcePrs: sourcePrs as number[], origin, body, packId,
  };
}

export async function loadPack(dir: string): Promise<Pack> {
  const root = resolve(dir);
  const yamlPath = join(root, 'pack.yaml');
  const doc = parseYaml(await readText(yamlPath), yamlPath);
  if (!isObj(doc)) throw new Error(`${yamlPath}: must be a mapping`);

  const id = str(doc, 'id', yamlPath);
  const lensEntries = objList(doc, 'lenses', yamlPath, true);
  const lenses: LensDef[] = [];
  for (const l of lensEntries) {
    lenses.push({
      id: str(l, 'id', yamlPath), title: str(l, 'title', yamlPath),
      instructions: await readText(join(root, str(l, 'file', yamlPath))),
    });
  }
  const standards: Pack['standards'] = [];
  for (const s of objList(doc, 'standards', yamlPath)) {
    standards.push({
      name: str(s, 'name', yamlPath), dated: s.dated === true,
      text: await readText(join(root, str(s, 'file', yamlPath))),
    });
  }

  const rules: Rule[] = [];
  const seen = new Map<string, string>();
  for (const name of await listMarkdown(join(root, 'rules'))) {
    const rule = await loadRule(root, name, id);
    const earlier = seen.get(rule.id);
    if (earlier) throw new Error(`Duplicate rule id "${rule.id}" in rules/${earlier} and rules/${name}`);
    seen.set(rule.id, name);
    rules.push(rule);
  }
  rules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const learned: LearnedEntry[] = [];
  for (const kind of ['wrong', 'intended'] as const) {
    const path = join(root, 'learned', learnedFileName(kind));
    let text: string;
    try { text = await readFile(path, 'utf8'); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    learned.push(...parseLearned(text, kind, path));
  }

  const tiers = isObj(doc.tiers) ? doc.tiers : {};
  const appRoot = doc.appRoot ?? null;
  if (appRoot !== null && typeof appRoot !== 'string') throw new Error(`${yamlPath}: "appRoot" must be text`);
  const version = doc.version;

  return {
    id, title: str(doc, 'title', yamlPath),
    version: version === undefined || version === null ? 'local' : String(version),
    dir: root, repos: strList(doc, 'repos', yamlPath), appRoot,
    stageRules: objList(doc, 'stageRules', yamlPath) as unknown as StageRule[],
    tiers: {
      read: strList(tiers, 'read', yamlPath), trust: strList(tiers, 'trust', yamlPath),
      ignore: strList(tiers, 'ignore', yamlPath),
    },
    siblings: objList(doc, 'siblings', yamlPath).map((s) => ({ id: str(s, 'id', yamlPath), glob: str(s, 'glob', yamlPath) })),
    linkRules: objList(doc, 'linkRules', yamlPath) as unknown as LinkRule[],
    checks: objList(doc, 'checks', yamlPath) as unknown as CheckDef[],
    standards, lenses, rules, learned,
  };
}
